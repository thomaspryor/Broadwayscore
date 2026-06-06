#!/usr/bin/env node
const https = require('https');

/**
 * IBDB Cast Scraper Module
 *
 * Extracts Opening Night Cast and Current Cast from IBDB production pages.
 * Reuses IBDB URL discovery from ibdb-dates.js.
 *
 * IBDB HTML structure for cast tabs:
 *   <div id="OpeningNightCast">
 *     <div class="row mobile-a-align">
 *       <div class="col m4 s12">
 *         <a href="/broadway-cast-staff/{slug}-{personId}">Actor Name</a>
 *         <div class="role_status">Broadway debut</div>  <!-- optional -->
 *       </div>
 *       <div class="col m4 s12">
 *         Role Name
 *         <div class="role_status"></div>
 *       </div>
 *       <div class="col m4 s12">
 *         <span class="role_dates">Jul 13, 2015 - Jul 09, 2016</span>
 *         <div class="role_status">Alternate</div>  <!-- optional -->
 *       </div>
 *     </div>
 *   </div>
 *
 * Status flags found: "Broadway debut", "at some performances", "Alternate"
 */

const { JSDOM } = require('jsdom');
const { fetchPage } = require('./scraper');
const { isLondonMarket } = require('./venue-classification');
const { GEMINI_FLASH, GPT4O_MINI } = require('./models');

const RATE_LIMIT_MS = 1500;

/**
 * Fetch raw HTML from an IBDB production page.
 * Tries ScrapingBee with premium proxy first, falls back to shared scraper.
 *
 * @param {string} url - IBDB production URL
 * @returns {Promise<string|null>} Raw HTML content or null
 */
async function fetchIBDBPageHTML(url) {
  let content = null;

  // Try ScrapingBee with premium proxy + JS render
  try {
    const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;
    if (scrapingBeeKey) {
      const apiUrl = `https://app.scrapingbee.com/api/v1/?` +
        `api_key=${scrapingBeeKey}` +
        `&url=${encodeURIComponent(url)}` +
        `&premium_proxy=true` +
        `&render_js=true`;

      const resp = await fetch(apiUrl);
      if (resp.ok) {
        content = await resp.text();
        if (content && content.includes('OpeningNightCast')) {
          return content;
        }
        // If page loaded but no cast tabs, may be wrong page or redirected
        if (content && !content.includes('broadway-cast-staff')) {
          console.log(`  ⚠️  Page loaded but no cast data found (may be redirected)`);
        }
      }
    }
  } catch (e) {
    console.log(`  ⚠️  ScrapingBee page fetch failed: ${e.message}`);
  }

  // Fallback: shared scraper
  if (!content || !content.includes('broadway-cast-staff')) {
    try {
      const pageResult = await fetchPage(url, { renderJs: true });
      content = pageResult.content;
    } catch (e) {
      console.log(`  ⚠️  Scraper fallback failed: ${e.message}`);
      return null;
    }
  }

  return content;
}

/**
 * Extract IBDB person ID from a cast/staff href.
 * Pattern: /broadway-cast-staff/{name-slug}-{numericId}
 *
 * @param {string} href - e.g. "/broadway-cast-staff/lin-manuel-miranda-459893"
 * @returns {string|null} e.g. "459893"
 */
function extractPersonId(href) {
  if (!href) return null;
  const match = href.match(/broadway-cast-staff\/.*?-(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Parse cast members from an IBDB cast section DOM element.
 *
 * @param {Element} sectionEl - The DOM element for a cast section (e.g., #OpeningNightCast)
 * @returns {Array<{name: string, role: string, ibdbPersonId?: string, flags?: string[]}>}
 */
function parseCastSection(sectionEl) {
  if (!sectionEl) return [];

  const cast = [];
  const rows = sectionEl.querySelectorAll('.row.mobile-a-align');

  for (const row of rows) {
    const cols = row.querySelectorAll('.col');
    if (cols.length < 2) continue;

    // Column 1: Actor name + optional status (Broadway debut, etc.)
    const nameLink = cols[0].querySelector('a[href*="broadway-cast-staff"]');
    if (!nameLink) continue;

    const name = nameLink.textContent.trim();
    if (!name) continue;

    const ibdbPersonId = extractPersonId(nameLink.getAttribute('href'));

    // Collect flags from role_status divs in all columns
    const flags = [];
    for (const col of cols) {
      const statusDivs = col.querySelectorAll('.role_status');
      for (const div of statusDivs) {
        const text = div.textContent.trim();
        if (text) flags.push(text);
      }
    }

    // Column 2: Role name (text content minus the role_status div)
    let role = '';
    if (cols[1]) {
      // Clone to avoid modifying DOM
      const roleCol = cols[1].cloneNode(true);
      // Remove role_status divs from clone to get clean role text
      const statusDivs = roleCol.querySelectorAll('.role_status');
      for (const div of statusDivs) div.remove();
      role = roleCol.textContent.trim();
    }

    if (!role) role = 'Ensemble'; // IBDB sometimes has blank roles for ensemble

    const member = { name, role };
    if (ibdbPersonId) member.ibdbPersonId = ibdbPersonId;
    if (flags.length > 0) member.flags = flags;

    cast.push(member);
  }

  return cast;
}

/**
 * Extract Opening Night Cast and Current Cast from an IBDB production page.
 *
 * @param {string} url - IBDB production URL
 * @returns {Promise<{openingNightCast: Array, currentCast: Array|null, ibdbUrl: string}>}
 */
async function extractCastFromIBDBPage(url) {
  console.log(`  📄 Fetching IBDB cast: ${url}`);

  const result = {
    openingNightCast: [],
    currentCast: null,
    replacements: null,
    ibdbUrl: url
  };

  const content = await fetchIBDBPageHTML(url);
  if (!content) {
    console.log(`  ❌ Failed to fetch IBDB page`);
    return result;
  }

  // Need HTML content for DOM parsing
  if (!content.includes('<html') && !content.includes('<div')) {
    console.log(`  ⚠️  Content is not HTML — cannot parse cast tabs`);
    return result;
  }

  let dom;
  try {
    dom = new JSDOM(content);
  } catch (e) {
    console.log(`  ⚠️  Failed to parse HTML: ${e.message}`);
    return result;
  }

  const doc = dom.window.document;

  // Check for homepage redirect (production not found)
  const bodyText = doc.body.textContent || '';
  if (bodyText.includes('Opening Nights in History') && !bodyText.includes('Opening Date')) {
    console.log(`  ⚠️  IBDB page redirected to homepage (production not found)`);
    return result;
  }

  // Extract production title for validation
  const titleEl = doc.querySelector('h1.iblock');
  result.pageTitle = titleEl ? titleEl.textContent.trim() : null;

  // Parse Opening Night Cast
  const oncSection = doc.getElementById('OpeningNightCast');
  if (oncSection) {
    result.openingNightCast = parseCastSection(oncSection);
    console.log(`  ✅ Opening Night Cast: ${result.openingNightCast.length} member(s)`);
  } else {
    console.log(`  ⚠️  No OpeningNightCast section found`);
  }

  // Parse Current Cast (may not exist for closed shows)
  const ccSection = doc.getElementById('CurrentCast');
  if (ccSection) {
    const currentCast = parseCastSection(ccSection);
    if (currentCast.length > 0) {
      result.currentCast = currentCast;
      console.log(`  ✅ Current Cast: ${result.currentCast.length} member(s)`);
    }
  }

  // Parse Replacements (actors who joined after opening night)
  const replSection = doc.getElementById('Replacements');
  if (replSection) {
    const replacements = parseCastSection(replSection);
    if (replacements.length > 0) {
      result.replacements = replacements;
      console.log(`  ✅ Replacements: ${result.replacements.length} member(s)`);
    }
  }

  // Safety check: warn on unusually large casts (>60 members likely parsing error)
  if (result.openingNightCast.length > 60) {
    console.log(`  ⚠️  WARNING: ${result.openingNightCast.length} OBC members — unusually large, check for parsing errors`);
  }

  return result;
}

/**
 * Use LLM to validate whether two show titles refer to the same production.
 * Uses Gemini Flash (cheapest) with fallback to OpenAI.
 * Returns null if no LLM is available.
 */
async function llmValidateTitleMatch(ourTitle, ibdbTitle) {
  const prompt = `Do these two titles refer to the same theater production? Answer ONLY "yes" or "no".

Title 1: "${ourTitle}"
Title 2: "${ibdbTitle}"`;

  // Try Gemini first (cheapest)
  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await new Promise((resolve, reject) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const body = JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 10 }
        });
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const json = JSON.parse(data);
                resolve(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
              } catch (e) { reject(e); }
            } else { reject(new Error(`Gemini HTTP ${res.statusCode}`)); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      const answer = String(result).trim().toLowerCase();
      if (answer.startsWith('yes')) return true;
      if (answer.startsWith('no')) return false;
    } catch (e) {
      // Fall through to next provider
    }
  }

  // Fallback to OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const result = await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          model: GPT4O_MINI,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 10,
          temperature: 0
        });
        const req = https.request('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const json = JSON.parse(data);
                resolve(json.choices?.[0]?.message?.content || '');
              } catch (e) { reject(e); }
            } else { reject(new Error(`OpenAI HTTP ${res.statusCode}`)); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      const answer = String(result).trim().toLowerCase();
      if (answer.startsWith('yes')) return true;
      if (answer.startsWith('no')) return false;
    } catch (e) {
      // Fall through
    }
  }

  return null; // No LLM available
}

/**
 * Look up cast for a single show from IBDB.
 * Uses searchIBDB + findBestProduction from ibdb-dates.js for URL discovery,
 * then extracts cast from the page.
 *
 * @param {string} title - Show title
 * @param {Object} options
 * @param {number} [options.openingYear] - Approximate opening year
 * @param {string} [options.venue] - Theatre venue name
 * @param {string} [options.ibdbUrl] - Pre-known IBDB URL (skips search)
 * @returns {Promise<{openingNightCast: Array, currentCast: Array|null, ibdbUrl: string|null, found: boolean}>}
 */
async function lookupIBDBCast(title, options = {}) {
  const { searchIBDB, findBestProduction } = require('./ibdb-dates');

  const notFound = {
    openingNightCast: [],
    currentCast: null,
    ibdbUrl: null,
    found: false
  };

  // IBDB is Broadway-only — skip for off-broadway and west-end shows
  if (options.category && (options.category === 'off-broadway' || isLondonMarket(options.category))) {
    console.log(`  ⏭️  Skipping IBDB lookup for ${options.category} show "${title}" (IBDB is Broadway-only)`);
    return notFound;
  }

  try {
    let bestMatch;

    // Use stored IBDB URL if available (skip search)
    if (options.ibdbUrl) {
      console.log(`  📎 Using stored IBDB URL: ${options.ibdbUrl}`);
      bestMatch = { url: options.ibdbUrl, title, year: null };
    } else {
      // Search for IBDB production page
      const searchResults = await searchIBDB(title, options);

      if (searchResults.length === 0) {
        console.log(`  ❌ No IBDB results found for "${title}"`);
        return notFound;
      }

      bestMatch = findBestProduction(searchResults, { ...options, title });
    }

    if (!bestMatch) {
      console.log(`  ❌ No suitable IBDB production found for "${title}"`);
      return notFound;
    }

    // Extract cast from the page
    const castData = await extractCastFromIBDBPage(bestMatch.url);

    if (castData.openingNightCast.length === 0) {
      console.log(`  ❌ No OBC extracted from IBDB page for "${title}"`);
      return { ...notFound, ibdbUrl: bestMatch.url };
    }

    // Title validation: skip when using a pre-known stored URL (already verified by prior lookup)
    const usingStoredUrl = !!options.ibdbUrl;
    if (!castData.pageTitle) {
      if (!usingStoredUrl) {
        console.log(`  ⚠️  Could not extract IBDB page title — rejecting to prevent mismatch`);
        return { ...notFound, ibdbUrl: bestMatch.url, titleMismatch: true };
      }
      console.log(`  ℹ️  Could not extract page title — skipping title check (pre-known URL)`);
    }
    if (castData.pageTitle) {
      const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '').trim();
      const ourTitle = normalize(title);
      const ibdbTitle = normalize(castData.pageTitle);
      // Fast path: substring match → accept, but only if shorter title is ≥50% of longer
      // (avoids "Nine" matching "Nine to Five", "Once" matching "Once Upon a Time")
      const shorter = ourTitle.length < ibdbTitle.length ? ourTitle : ibdbTitle;
      const longer = ourTitle.length < ibdbTitle.length ? ibdbTitle : ourTitle;
      const isSubstringMatch = longer.includes(shorter) && shorter.length >= longer.length * 0.5;
      if (!isSubstringMatch) {
        // Check word overlap for fast reject/accept
        const ourWords = new Set(ourTitle.match(/[a-z]{3,}/g) || []);
        const ibdbWords = new Set(ibdbTitle.match(/[a-z]{3,}/g) || []);
        const overlap = Array.from(ourWords).filter(w => ibdbWords.has(w)).length;
        const maxWords = Math.max(ourWords.size, ibdbWords.size);
        const overlapRatio = maxWords > 0 ? overlap / maxWords : 0;

        if (overlapRatio >= 0.7) {
          // High overlap — accept without LLM
        } else if (overlapRatio < 0.1) {
          // Very low overlap — reject without LLM
          console.log(`  ⚠️  IBDB title mismatch: "${castData.pageTitle}" vs "${title}" — skipping`);
          return { ...notFound, ibdbUrl: bestMatch.url, titleMismatch: true };
        } else {
          // Ambiguous range — use LLM to decide
          const llmResult = await llmValidateTitleMatch(title, castData.pageTitle);
          if (llmResult === false) {
            console.log(`  ⚠️  LLM rejected title match: "${castData.pageTitle}" vs "${title}" — skipping`);
            return { ...notFound, ibdbUrl: bestMatch.url, titleMismatch: true };
          } else if (llmResult === true) {
            console.log(`  ✅ LLM confirmed title match: "${castData.pageTitle}" ≈ "${title}"`);
          } else {
            // No LLM available — fall back to conservative heuristic (reject if <30%)
            if (overlapRatio < 0.3) {
              console.log(`  ⚠️  IBDB title mismatch (no LLM): "${castData.pageTitle}" vs "${title}" — skipping`);
              return { ...notFound, ibdbUrl: bestMatch.url, titleMismatch: true };
            }
          }
        }
      }
    }

    return {
      openingNightCast: castData.openingNightCast,
      currentCast: castData.currentCast,
      replacements: castData.replacements,
      ibdbUrl: bestMatch.url,
      found: true
    };

  } catch (e) {
    console.log(`  ⚠️  IBDB cast lookup failed for "${title}": ${e.message}`);
    return notFound;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  fetchIBDBPageHTML,
  extractPersonId,
  parseCastSection,
  extractCastFromIBDBPage,
  lookupIBDBCast,
  RATE_LIMIT_MS
};
