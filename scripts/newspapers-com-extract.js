#!/usr/bin/env node
/**
 * Newspapers.com Review Extraction — Search + OCR Pipeline
 *
 * Searches newspapers.com for Broadway reviews in scanned newspaper archives,
 * extracts OCR text via network interception, and creates review seed files.
 *
 * Requires a persistent browser profile with active newspapers.com login.
 * Run `node scripts/paywall-browser-login.js --site=newspapers` first.
 *
 * Usage:
 *   # Search + extract for a show (both Daily News and Newsday)
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022
 *
 *   # Search one paper only
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --paper=dailynews
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --paper=newsday
 *
 *   # Search only (don't extract OCR)
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --search-only
 *
 *   # Extract OCR from a known image ID
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --image=123456 --paper=dailynews --critic="Joe Dziemianowicz"
 *
 *   # Batch: process multiple shows from a file (one show ID per line)
 *   node scripts/newspapers-com-extract.js --shows-file=/tmp/shows.txt
 *
 *   # Wider date search (default is opening ± 3 days)
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --date-range=7
 */

const fs = require('fs');
const path = require('path');
const { heuristicClassify } = require('./lib/non-review-patterns');
const { GPT4O } = require('./lib/models');

// ─── Configuration ───────────────────────────────────────────────────────────

const PROFILE_DIR = '/tmp/newspapers-browser-profile';

const PAPERS = {
  dailynews: {
    name: 'New York Daily News',
    outletId: 'nydailynews',
    outlet: 'New York Daily News',
    searchName: 'Daily News',
    resultName: 'Daily News',
    location: 'new york',
    critics: [
      { name: 'Chris Jones', years: [2017, 2026] },
      { name: 'Joe Dziemianowicz', years: [2005, 2017] },
      { name: 'Howard Kissel', years: [1985, 2005] },
      { name: 'Douglas Watt', years: [1970, 1985] },
    ],
  },
  newsday: {
    name: 'Newsday',
    outletId: 'newsday',
    outlet: 'Newsday',
    searchName: 'Newsday',
    resultName: 'Newsday',
    location: null, // Newsday name is unique enough
    critics: [
      { name: 'Barbara Schuler', years: [2015, 2026] },
      { name: 'Linda Winer', years: [1987, 2017] },
    ],
  },
  latimes: {
    name: 'Los Angeles Times',
    outletId: 'latimes',
    outlet: 'Los Angeles Times',
    searchName: 'Los Angeles Times',
    resultName: 'The Los Angeles Times',
    location: 'los angeles',
    critics: [
      { name: 'Charles McNulty', years: [2005, 2026] },
    ],
  },
  chicagotribune: {
    name: 'Chicago Tribune',
    outletId: 'chicagotribune',
    outlet: 'Chicago Tribune',
    searchName: 'Chicago Tribune',
    resultName: 'Chicago Tribune',
    location: 'chicago',
    critics: [
      { name: 'Chris Jones', years: [2002, 2026] },
    ],
  },
  philinquirer: {
    name: 'Philadelphia Inquirer',
    outletId: 'philadelphia-inquirer',
    outlet: 'Philadelphia Inquirer',
    searchName: 'Philadelphia Inquirer',
    resultName: 'The Philadelphia Inquirer',
    location: 'philadelphia',
    critics: [
      { name: 'Howard Shapiro', years: [2000, 2015] },
    ],
  },
  nypost: {
    name: 'New York Post',
    outletId: 'nypost',
    outlet: 'New York Post',
    searchName: 'New York Post',
    resultName: 'New York Post',
    location: 'new york',
    critics: [
      { name: 'Johnny Oleksinski', years: [2017, 2026] },
      { name: 'Elisabeth Vincentelli', years: [2010, 2017] },
      { name: 'Clive Barnes', years: [1977, 2008] },
    ],
  },
  usatoday: {
    name: 'USA Today',
    outletId: 'usatoday',
    outlet: 'USA Today',
    searchName: 'USA TODAY',
    resultName: 'USA TODAY',
    location: null,
    critics: [
      { name: 'Elysa Gardner', years: [2000, 2015] },
    ],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const arg = args.find(a => a.startsWith(`--${prefix}=`));
    return arg ? arg.split('=').slice(1).join('=') : null;
  };
  return {
    show: get('show'),
    showsFile: get('shows-file'),
    paper: get('paper'),
    image: get('image'),
    critic: get('critic'),
    dateRange: parseInt(get('date-range') || '3', 10),
    searchOnly: args.includes('--search-only'),
    verbose: args.includes('--verbose'),
    // Drive a remote Browserbase stealth browser (bypasses Cloudflare) and inject
    // the saved newspapers.com session cookies for subscription auth. Local
    // Playwright Chrome fails newspapers.com's Cloudflare Turnstile.
    browserbase: args.includes('--browserbase') || process.env.BROWSERBASE_ENABLED === 'true',
    // Local real-Chrome on this machine's residential IP (Cloudflare passes here),
    // authed via the full cookie bundle in data/cookies/np-full.json.
    local: args.includes('--local'),
    // Get page text by downloading the page JPG and OCR'ing it with GPT-4o vision
    // (newspapers.com's old /ocr/ text endpoint is gone).
    vision: args.includes('--vision'),
    // Re-extract even if a (possibly wrong-production) file already exists.
    force: args.includes('--force'),
  };
}

function loadShow(showId) {
  const shows = JSON.parse(fs.readFileSync('data/shows.json', 'utf8')).shows;
  const show = shows.find(s => s.id === showId);
  if (!show) throw new Error(`Show not found: ${showId}`);
  if (!show.openingDate) throw new Error(`Show ${showId} has no opening date`);
  return show;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function dateRange(openingDate, rangeDays) {
  const d = new Date(openingDate);
  // Reviews typically appear the day after opening, but search a range
  const start = new Date(d);
  start.setDate(start.getDate() - 1); // day before opening
  const end = new Date(d);
  end.setDate(end.getDate() + rangeDays);
  return { start: formatDate(start), end: formatDate(end) };
}

function likelyCritic(paper, year) {
  for (const c of paper.critics) {
    if (year >= c.years[0] && year <= c.years[1]) return c.name;
  }
  return null;
}

function makeSeedFilename(outletId, criticName) {
  const slug = (criticName || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
  return `${outletId}--${slug}-bway.json`;
}

/**
 * Parse a human-readable date string like "April 25, 2022" into "2022-04-25".
 */
function parseDateStr(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Quick relevance check: does the OCR text mention the show title?
 * OCR is garbled, so we check for individual words from the title.
 */
function isRelevantOcr(ocrText, showTitle) {
  if (!ocrText || !showTitle) return false;
  const words = showTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const textLower = ocrText.toLowerCase();
  // At least half the significant title words should appear
  const matches = words.filter(w => textLower.includes(w));
  return matches.length >= Math.ceil(words.length / 2);
}

function seedFileExists(showId, outletId) {
  const dir = path.join('data', 'review-texts', showId);
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir);
  return files.some(f => f.startsWith(`${outletId}--`) && f.endsWith('.json'));
}

// Best-effort text extraction from newspapers.com's /api/article/page response.
// Shape is undocumented; harvest text from the likely fields and fall back to
// collecting the longest string values anywhere in the payload.
function harvestArticleText(json) {
  if (!json) return '';
  if (typeof json.ocr === 'string' && json.ocr.length) return json.ocr;
  const out = [];
  const arr = json.articles || json.data || json.results || (Array.isArray(json) ? json : null);
  if (Array.isArray(arr)) {
    for (const a of arr) {
      if (!a || typeof a !== 'object') continue;
      const t = a.text || a.ocr || a.content || a.body || a.fullText || a.transcription || '';
      if (typeof t === 'string' && t.length) out.push(t);
      if (Array.isArray(a.lines)) out.push(a.lines.map(l => (typeof l === 'string' ? l : (l && (l.text || l.value)) || '')).join(' '));
    }
  }
  if (out.join('').length > 40) return out.join('\n\n');
  // Fallback: recursively gather long strings (>60 chars) from the payload.
  const strings = [];
  (function walk(o, depth) {
    if (depth > 6 || o == null) return;
    if (typeof o === 'string') { if (o.length > 60) strings.push(o); return; }
    if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
    if (typeof o === 'object') Object.values(o).forEach(x => walk(x, depth + 1));
  })(json, 0);
  return strings.join('\n\n');
}

// Download the full page as JPG (subscriber "Save as JPG") and OCR it with
// GPT-4o vision, extracting only the target show's review. Returns text or ''.
// newspapers.com's old /ocr/ text API is gone, so the scanned image is the
// only source; the page renders as positioned <img> tiles (no DOM text).
async function extractViaDownloadOcr(page, imageId, showTitle, verbose) {
  const tmp = require('os').tmpdir();
  const jpgPath = path.join(tmp, `np-page-${imageId}.jpg`);
  try {
    await page.goto(`https://www.newspapers.com/image/${imageId}/`, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const title = await page.title().catch(() => '');
    if (/just a moment|attention required/i.test(title)) { if (verbose) console.log('    CF blocked image page'); return ''; }
    await page.locator('button:has-text("Print/Download"), a:has-text("Print/Download")').first().click().catch(() => {});
    await page.waitForTimeout(1500);
    await page.locator('text=Entire Page').first().click().catch(() => {});
    await page.waitForTimeout(2000);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 40000 }).catch(() => null),
      page.locator('button:has-text("Save as JPG"), a:has-text("Save as JPG")').first().click().catch(() => {}),
    ]);
    if (!download) { if (verbose) console.log('    no JPG download produced'); return ''; }
    await download.saveAs(jpgPath);
    const size = fs.existsSync(jpgPath) ? fs.statSync(jpgPath).size : 0;
    if (verbose) console.log(`    downloaded page JPG: ${size} bytes`);
    if (size < 20000) return { text: '', byline: null };
    return await visionOcrShowReview(jpgPath, showTitle, verbose);
  } catch (e) {
    if (verbose) console.log(`    download/ocr error: ${e.message}`);
    return { text: '', byline: null };
  } finally {
    try { if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath); } catch (e) {}
    // clean band crops
    for (let i = 1; i <= 6; i++) { const b = jpgPath.replace('.jpg', `-b${i}.jpg`); try { if (fs.existsSync(b)) fs.unlinkSync(b); } catch (e) {} }
  }
}

// Split a tall page JPG into legible horizontal bands and OCR each with GPT-4o,
// asking only for the target show's theater review. Concatenate the hits.
async function visionOcrShowReview(jpgPath, showTitle, verbose) {
  const { execSync } = require('child_process');
  // get dimensions
  let w = 0, h = 0;
  try {
    const out = execSync(`sips -g pixelWidth -g pixelHeight "${jpgPath}"`, { encoding: 'utf8' });
    w = +(out.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0;
    h = +(out.match(/pixelHeight:\s*(\d+)/) || [])[1] || 0;
  } catch (e) {}
  const bandH = 1500, overlap = 200;
  const bands = [];
  if (h && w) {
    for (let y = 0; y < h; y += (bandH - overlap)) {
      const bh = Math.min(bandH, h - y);
      if (bh < 300) break;
      const bp = jpgPath.replace('.jpg', `-b${bands.length + 1}.jpg`);
      try { execSync(`sips -c ${bh} ${w} --cropOffset ${y} 0 "${jpgPath}" --out "${bp}" >/dev/null 2>&1`); bands.push(bp); } catch (e) {}
    }
  }
  if (!bands.length) bands.push(jpgPath);
  const parts = [];
  let byline = null;
  for (const bp of bands) {
    let t = await gpt4oOcr(bp, showTitle, verbose);
    if (!t || /^NONE\b/i.test(t.trim())) continue;
    // pull the BYLINE: line GPT-4o was asked to prepend
    const bm = t.match(/^\s*BYLINE:\s*(.+)$/im);
    if (bm) {
      const b = bm[1].trim();
      if (!byline && b && !/^unknown$/i.test(b)) byline = b.replace(/^by\s+/i, '').trim();
      t = t.replace(/^\s*BYLINE:.*$/im, '').trim();
    }
    if (t.length > 120) parts.push(t);
  }
  const joined = parts.join('\n\n');
  if (verbose) console.log(`    vision OCR: ${parts.length}/${bands.length} bands had the review, ${joined.length} chars, byline=${byline || '?'}`);
  return { text: joined, byline };
}

async function gpt4oOcr(imgPath, showTitle, verbose) {
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const prompt = `This is a slice of a scanned newspaper page. I want ONLY a CRITICAL THEATER REVIEW of the production "${showTitle}" — a critic's evaluation with opinions/verdict on the show's quality, performances, staging, songs, etc.

Output the review body verbatim, starting with "BYLINE: <critic name>" on the first line if a byline is visible (else "BYLINE: unknown").

Output exactly NONE if this slice has no such review — in particular, return NONE for: box-office/ticket/business stories, advance "buzz"/preview pieces published before opening, casting news, interviews, event listings, photo captions, or articles that merely mention "${showTitle}" without critically evaluating it.`;
  const body = { model: GPT4O, max_tokens: 3000, messages: [{ role: 'user', content: [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'high' } },
  ] }] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: JSON.stringify(body),
      });
      if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 3000 * attempt)); continue; }
      const j = await r.json();
      if (!r.ok) { if (verbose) console.log(`    gpt-4o error: ${JSON.stringify(j).slice(0, 150)}`); return ''; }
      // strip any markdown code-fence wrapper GPT-4o adds (```plaintext ... ```)
      return (j.choices[0].message.content || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
    } catch (e) { if (verbose) console.log(`    gpt-4o fetch error: ${e.message}`); await new Promise(res => setTimeout(res, 2000)); }
  }
  return '';
}

// ─── OCR Extraction ──────────────────────────────────────────────────────────

/**
 * Extract OCR text from a newspapers.com image page by intercepting the /ocr/ API response.
 * Returns the raw OCR text (one word per line, may be garbled from multi-column layout).
 */
async function extractOcrFromImage(page, imageId, verbose) {
  return new Promise(async (resolve) => {
    let ocrText = '';
    let ocrReceived = false;

    const handler = async (response) => {
      const url = response.url();
      // newspapers.com now serves article text from /api/article/page/{id}/articles
      // (older builds used /ocr/{id}). Match either, for this image.
      const isArticleApi = url.includes('/api/article/page/') && url.includes(String(imageId));
      const isLegacyOcr = url.includes('/ocr/') && url.includes(String(imageId));
      if (isArticleApi || isLegacyOcr) {
        try {
          const json = await response.json();
          if (verbose && isArticleApi) console.log(`    article-api raw keys: ${JSON.stringify(Object.keys(json)).slice(0, 200)}`);
          const text = isLegacyOcr ? (json.ocr || '') : harvestArticleText(json);
          if (text && text.length) {
            ocrText = text;
            ocrReceived = true;
            if (verbose) console.log(`    text intercepted: ${ocrText.length} chars (${isArticleApi ? 'article-api' : 'ocr'})`);
          }
        } catch (e) {
          if (verbose) console.log(`    parse error: ${e.message}`);
        }
      }
    };

    page.on('response', handler);

    try {
      await page.goto(`https://www.newspapers.com/image/${imageId}/`, {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      });
    } catch (e) {
      console.log(`    Navigation error: ${e.message}`);
    }

    // Wait up to 12 seconds for OCR response
    for (let i = 0; i < 24; i++) {
      if (ocrReceived) break;
      await page.waitForTimeout(500);
    }

    if (!ocrReceived) {
      // The viewer often loads article text only on interaction. Since the
      // session is authenticated, call the article API directly from the page
      // (same-origin → carries auth + any in-page access token).
      if (verbose) console.log('    No passive intercept — calling article API directly...');
      try {
        const direct = await page.evaluate(async (id) => {
          const res = await fetch(`/api/article/page/${id}/articles`, { headers: { accept: 'application/json' } });
          if (!res.ok) return { status: res.status, body: (await res.text()).slice(0, 120) };
          return { status: 200, json: await res.json() };
        }, imageId);
        if (direct.status === 200 && direct.json) {
          const t = harvestArticleText(direct.json);
          if (t && t.length) { ocrText = t; ocrReceived = true; if (verbose) console.log(`    direct article API: ${t.length} chars`); }
          else if (verbose) console.log(`    direct article API: 200 but no text harvested. keys=${JSON.stringify(Object.keys(direct.json)).slice(0,160)}`);
        } else if (verbose) {
          console.log(`    direct article API → ${direct.status} ${direct.body || ''}`);
        }
      } catch (e) {
        if (verbose) console.log(`    direct article API error: ${e.message}`);
      }
    }

    page.off('response', handler);
    resolve(ocrText);
  });
}

/**
 * Reconstruct raw OCR into readable paragraphs.
 * OCR from newspapers.com comes as one-word-per-line with column garbling.
 * This does basic cleanup; the LLM scorer handles the rest.
 */
function reconstructOcr(rawOcr) {
  if (!rawOcr) return '';

  // Join words that are on consecutive lines (likely same paragraph)
  const lines = rawOcr.split('\n');
  const paragraphs = [];
  let current = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    } else {
      current.push(trimmed);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }

  return paragraphs.join('\n\n');
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Search newspapers.com for a show review in a specific paper.
 * Returns array of search result objects with image IDs and snippets.
 */
async function searchForReview(page, showTitle, paperConfig, dateStart, dateEnd, verbose) {
  // Clean show title for search:
  // - Remove year suffixes
  // - Remove subtitles after colon (search for main title only)
  // - Clean special characters
  let searchTitle = showTitle
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"');

  // For titles with colons/subtitles, use just the main title (before colon)
  // "Pretty Woman: The Musical" → "Pretty Woman"
  // "Tina: The Tina Turner Musical" → "Tina Turner" (handled below)
  if (searchTitle.includes(':')) {
    searchTitle = searchTitle.split(':')[0].trim();
  }

  // For very short or generic titles, add "musical" or "Broadway" outside quotes
  // to disambiguate. e.g., "Tina" → search for "Tina" + musical
  const isShortTitle = searchTitle.length <= 6;

  // newspapers.com URL format: /search/results/ with keyword=, date-start=, date-end= (hyphens)
  // p_title= filter is UNRELIABLE — instead, include paper name in keyword to surface results
  // from that paper. Without this, max-10 results get crowded out by other papers.
  const extra = isShortTitle ? ' musical' : '';
  const keyword = encodeURIComponent(`"${searchTitle}"${extra} "${paperConfig.searchName}"`);
  const url = `https://www.newspapers.com/search/results/?keyword=${keyword}&date-start=${dateStart}&date-end=${dateEnd}`;

  console.log(`  Searching: ${searchTitle} in ${paperConfig.name} (${dateStart} to ${dateEnd})`);
  if (verbose) console.log(`  URL: ${url}`);

  try {
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log(`  Navigation error: ${e.message}`);
    return [];
  }

  // Wait for search results to load
  await page.waitForTimeout(6000);

  // Check if logged in (search without login shows "0 matches" or login prompt)
  const needsLogin = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text.includes('Sign in') && text.includes('newspapers.com account')
      || text.includes('0 results');
  });

  if (needsLogin) {
    console.log('  WARNING: May not be logged in. Run paywall-browser-login.js --site=newspapers first.');
  }

  // Extract search results using newspapers.com's specific DOM structure
  const results = await page.evaluate(() => {
    const items = [];
    // Each result is a div with class containing "ArticleResult" and id = imageId
    const resultDivs = document.querySelectorAll('[class*="ArticleResult"]');

    for (const div of resultDivs) {
      const imageId = div.id;
      if (!imageId || !/^\d+$/.test(imageId)) continue;

      // The details link has class containing "NewspageDetails"
      // Format: "Paper Name • Page X DayOfWeek, Month DD, YYYYCity, State"
      const detailsLink = div.querySelector('[class*="NewspageDetails"]');
      const detailsText = detailsLink ? detailsLink.textContent.trim() : '';

      // Parse paper name (before •)
      const parts = detailsText.split('•');
      const paper = parts[0] ? parts[0].trim() : '';
      const rest = parts[1] ? parts[1].trim() : '';

      // Extract page number
      const pageMatch = rest.match(/Page\s+([A-Z]?\d+)/i);
      const pageNum = pageMatch ? pageMatch[1] : '';

      // Extract date (format: "DayOfWeek, Month DD, YYYY")
      const dateMatch = rest.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\w+\s+\d+,\s+\d{4})/);
      const dateStr = dateMatch ? dateMatch[1] : '';

      // Extract location — appears after the date: "...April 25, 2022New York, New York"
      const locationMatch = detailsText.match(/\d{4}([A-Z][\w\s]+,\s*[\w\s]+?)(?:\d|$)/);
      const location = locationMatch ? locationMatch[1].trim() : '';

      items.push({ imageId, paper, pageNum, dateStr, location, fullDetails: detailsText });
    }

    return items;
  });

  // Filter results to match the target paper by result name + location
  // Generic names like "Daily News" appear in many papers (Naples, Beauregard, etc.)
  const filtered = results.filter(r => {
    if (!r.paper) return true;
    const paperLower = r.paper.toLowerCase();
    const locationLower = (r.location || '').toLowerCase();

    // Check paper name matches
    const nameMatch = paperLower.includes(paperConfig.resultName.toLowerCase())
      || paperConfig.resultName.toLowerCase().includes(paperLower);

    if (!nameMatch) return false;

    // If a location filter is configured, verify it too (handles "Naples Daily News" etc.)
    if (paperConfig.location) {
      return locationLower.includes(paperConfig.location);
    }
    return true;
  });

  if (filtered.length < results.length) {
    console.log(`  Filtered: ${results.length} total → ${filtered.length} matching ${paperConfig.name}`);
    if (verbose) {
      const excluded = results.filter(r => !filtered.includes(r));
      for (const r of excluded.slice(0, 5)) {
        console.log(`    Excluded: Image ${r.imageId} from "${r.paper}" (${r.location || '?'}, ${r.dateStr})`);
      }
    }
  }

  if (filtered.length === 0 && results.length > 0) {
    const papers = [...new Set(results.map(r => `${r.paper} (${r.location || '?'})`))].join(', ');
    console.log(`  No results matching ${paperConfig.name} from New York — found: ${papers}`);
  }

  const finalResults = filtered.length > 0 ? filtered : [];

  console.log(`  Found ${finalResults.length} search results`);
  return finalResults;
}

// ─── Save ────────────────────────────────────────────────────────────────────

function saveSeedFile(showId, paperConfig, criticName, imageId, publishDate, rawOcr, reconstructedText) {
  const dir = path.join('data', 'review-texts', showId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filename = makeSeedFilename(paperConfig.outletId, criticName);
  const filepath = path.join(dir, filename);

  // Don't overwrite existing files with text
  if (fs.existsSync(filepath)) {
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (existing.fullText && existing.fullText.length > 100) {
      console.log(`  File already exists with text: ${filepath}`);
      return filepath;
    }
  }

  const seed = {
    showId,
    outletId: paperConfig.outletId,
    outlet: paperConfig.outlet,
    criticName: criticName || 'Unknown',
    url: `https://www.newspapers.com/image/${imageId}/`,
    publishDate: publishDate || null,
    fullText: reconstructedText,
    isFullReview: true,
    source: 'newspapers-com-ocr',
    productionNote: `OCR extracted from scanned ${paperConfig.name} page via newspapers.com.`,
    title: null,
    fetchMethod: 'newspapers-com-extract',
    textFetchedAt: new Date().toISOString(),
    ocrRawLength: rawOcr.length,
    ocrReconstructedLength: reconstructedText.length,
    newspapersComImageId: imageId,
  };

  fs.writeFileSync(filepath, JSON.stringify(seed, null, 2) + '\n');
  console.log(`  Saved: ${filepath} (${reconstructedText.length} chars)`);
  return filepath;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function processShow(page, showId, opts) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${showId}`);
  console.log('='.repeat(60));

  // Load show data
  let show;
  try {
    show = loadShow(showId);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    return { showId, status: 'error', error: e.message };
  }

  const openYear = new Date(show.openingDate).getFullYear();
  const { start, end } = dateRange(show.openingDate, opts.dateRange);

  console.log(`  Title: ${show.title}`);
  console.log(`  Opening: ${show.openingDate}`);
  console.log(`  Search range: ${start} to ${end}`);

  // Determine which papers to search
  const papersToSearch = opts.paper
    ? [PAPERS[opts.paper]].filter(Boolean)
    : Object.values(PAPERS);

  if (opts.paper && !PAPERS[opts.paper]) {
    console.log(`ERROR: Unknown paper "${opts.paper}". Options: ${Object.keys(PAPERS).join(', ')}`);
    return { showId, status: 'error', error: `Unknown paper: ${opts.paper}` };
  }

  const results = { showId, papers: {} };

  for (const paper of papersToSearch) {
    console.log(`\n--- ${paper.name} ---`);

    // Check if we already have a review from this outlet (--force bypasses; the
    // existing file may be a wrong-production placeholder we want to supersede).
    if (!opts.force && seedFileExists(showId, paper.outletId)) {
      console.log(`  Already have a review file for ${paper.outletId} — skipping`);
      results.papers[paper.outletId] = { status: 'skipped', reason: 'exists' };
      continue;
    }

    // If a specific image ID was provided, extract directly
    if (opts.image && opts.paper) {
      console.log(`  Extracting OCR from image ${opts.image}...`);
      const rawOcr = await extractOcrFromImage(page, opts.image, opts.verbose);

      if (!rawOcr) {
        console.log('  No OCR text received. Image may be blank or session expired.');
        results.papers[paper.outletId] = { status: 'no-ocr' };
        continue;
      }

      const text = reconstructOcr(rawOcr);
      console.log(`  OCR: ${rawOcr.length} raw chars -> ${text.length} reconstructed chars`);
      console.log(`  Preview: ${text.slice(0, 200).replace(/\n/g, ' ')}...`);

      // Same non-review gate as the search path — a manually-supplied image ID
      // must not bypass it (weather/sports/junk pages never get saved).
      const nonReviewImg = heuristicClassify(text);
      if (nonReviewImg && nonReviewImg.confidence === 'high') {
        console.log(`  REJECTED — non-review content (${nonReviewImg.type}): ${String(nonReviewImg.evidence).slice(0, 70)}`);
        results.papers[paper.outletId] = { status: 'rejected-non-review', imageId: opts.image, type: nonReviewImg.type };
        continue;
      }

      const criticName = opts.critic || likelyCritic(paper, openYear) || 'Unknown';
      saveSeedFile(showId, paper, criticName, opts.image, null, rawOcr, text);
      results.papers[paper.outletId] = { status: 'extracted', imageId: opts.image, chars: text.length };
      continue;
    }

    // Search for the review
    const searchResults = await searchForReview(page, show.title, paper, start, end, opts.verbose);

    if (searchResults.length === 0) {
      console.log(`  No results found for ${show.title} in ${paper.name}`);
      results.papers[paper.outletId] = { status: 'not-found' };
      continue;
    }

    // Display search results
    console.log(`\n  Search results:`);
    for (let i = 0; i < searchResults.length; i++) {
      const r = searchResults[i];
      const info = [r.paper, r.pageNum ? `p.${r.pageNum}` : '', r.dateStr].filter(Boolean).join(', ');
      console.log(`    [${i}] Image ${r.imageId} — ${info || r.fullDetails.slice(0, 100)}`);
    }

    if (opts.searchOnly) {
      results.papers[paper.outletId] = { status: 'search-only', count: searchResults.length };
      continue;
    }

    // Try each search result until we find a relevant one
    let extracted = false;
    for (let ri = 0; ri < Math.min(searchResults.length, 6); ri++) {
      const candidate = searchResults[ri];
      console.log(`\n  Trying result [${ri}]: Image ${candidate.imageId} (${candidate.paper || '?'}, ${candidate.dateStr || '?'})...`);
      let rawOcr, text, visionByline = null;
      if (opts.vision) {
        const vr = await extractViaDownloadOcr(page, candidate.imageId, show.title, opts.verbose);
        text = (vr && vr.text) || '';
        visionByline = vr && vr.byline;
        rawOcr = text;
        if (!text) { console.log('    No review text via vision OCR (or not a review).'); continue; }
        console.log(`    Vision OCR: ${text.length} chars${visionByline ? ` — byline: ${visionByline}` : ''}`);
      } else {
        rawOcr = await extractOcrFromImage(page, candidate.imageId, opts.verbose);
        if (!rawOcr) { console.log('    No OCR text received.'); continue; }
        text = reconstructOcr(rawOcr);
        console.log(`    OCR: ${rawOcr.length} raw → ${text.length} reconstructed chars`);
      }

      // Quality checks
      if (text.length < 100) {
        console.log(`    Too short (${text.length} chars) — skipping`);
        continue;
      }

      // Relevance check: does it mention the show?
      if (!isRelevantOcr(text, show.title)) {
        console.log(`    Not relevant (no mention of "${show.title}") — skipping`);
        console.log(`    Preview: ${text.slice(0, 150).replace(/\n/g, ' ')}...`);
        continue;
      }

      console.log(`    Relevant: mentions "${show.title}"`);
      console.log(`    Preview: ${text.slice(0, 200).replace(/\n/g, ' ')}...`);

      // Hard gate: never save wrong-page newspaper OCR (weather/sports/listings)
      // or other non-review content. Same classifier as the CI non-review audit.
      const nonReview = heuristicClassify(text);
      if (nonReview && nonReview.confidence === 'high') {
        console.log(`    REJECTED — non-review content (${nonReview.type}): ${String(nonReview.evidence).slice(0, 70)}`);
        continue;
      }

      // Prefer the byline GPT-4o read off the page; fall back to the era-guess.
      const criticName = opts.critic || visionByline || likelyCritic(paper, openYear) || 'Unknown';
      const publishDate = parseDateStr(candidate.dateStr);
      saveSeedFile(showId, paper, criticName, candidate.imageId, publishDate, rawOcr, text);
      results.papers[paper.outletId] = { status: 'extracted', imageId: candidate.imageId, chars: text.length };
      extracted = true;
      break;
    }

    if (!extracted) {
      console.log(`  Could not find a relevant review in ${searchResults.length} results`);
      results.papers[paper.outletId] = { status: 'not-relevant', tried: Math.min(searchResults.length, 6) };
    }

    // Delay between papers to avoid rate limiting
    await page.waitForTimeout(3000);
  }

  return results;
}

async function main() {
  const opts = parseArgs();

  if (!opts.show && !opts.showsFile && !opts.image) {
    console.error('Newspapers.com Review Extraction Pipeline');
    console.error('');
    console.error('Usage:');
    console.error('  node scripts/newspapers-com-extract.js --show=SHOW_ID [options]');
    console.error('');
    console.error('Options:');
    console.error('  --show=ID          Show ID from shows.json');
    console.error('  --shows-file=FILE  File with one show ID per line');
    console.error('  --paper=NAME       Paper: dailynews, newsday (default: both)');
    console.error('  --image=ID         Extract specific newspapers.com image ID');
    console.error('  --critic=NAME      Override critic name');
    console.error('  --date-range=N     Days after opening to search (default: 3)');
    console.error('  --search-only      Search only, don\'t extract OCR');
    console.error('  --verbose          Extra debug output');
    console.error('');
    console.error('Prerequisites:');
    console.error('  node scripts/paywall-browser-login.js --site=newspapers');
    process.exit(1);
  }

  // Check profile exists (only for the legacy local-profile mode; --local and
  // --browserbase carry their own auth).
  if (!opts.local && !opts.browserbase && !fs.existsSync(PROFILE_DIR)) {
    console.error(`No browser profile at ${PROFILE_DIR}`);
    console.error('Run first: node scripts/paywall-browser-login.js --site=newspapers');
    process.exit(1);
  }

  // Collect show IDs to process
  let showIds = [];
  if (opts.show) {
    showIds = [opts.show];
  } else if (opts.showsFile) {
    showIds = fs.readFileSync(opts.showsFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    console.log(`Loaded ${showIds.length} shows from ${opts.showsFile}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Newspapers.com Review Extraction Pipeline');
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Shows: ${showIds.length}`);
  console.log(`Papers: ${opts.paper || 'all (' + Object.values(PAPERS).map(p => p.name).join(', ') + ')'}`);
  console.log(`Mode: ${opts.searchOnly ? 'search only' : 'search + extract'}`);
  console.log('='.repeat(60));

  const { chromium } = require('playwright');

  let context, page, browser = null;

  if (opts.local) {
    // Local real Chrome on this machine's residential IP — Cloudflare is far more
    // lenient here than on datacenter/proxy IPs. Auth via the full cookie bundle
    // (incl. httpOnly session tokens) exported from the logged-in Browserbase
    // context to data/cookies/np-full.json. Requires `--vision` for text.
    const cookieFile = path.join('data', 'cookies', 'np-full.json');
    if (!fs.existsSync(cookieFile)) throw new Error(`--local needs ${cookieFile} (full auth cookie bundle).`);
    const raw = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    const skipCf = new Set(['cf_clearance', '__cf_bm', '_cfuvid']); // IP/UA-bound; let local Chrome mint fresh
    const cookies = (Array.isArray(raw) ? raw : raw.cookies || []).filter(c => !skipCf.has(c.name)).map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
      httpOnly: !!c.httpOnly, secure: c.secure !== false,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    }));
    console.log(`\nLaunching local Chrome (residential IP) with ${cookies.length} auth cookies...`);
    const opt = { headless: false, channel: 'chrome', viewport: { width: 1400, height: 1700 }, acceptDownloads: true, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'], locale: 'en-US', timezoneId: 'America/New_York' };
    try { context = await chromium.launchPersistentContext('/tmp/np-local-extract-profile', opt); }
    catch (e) { console.log(`  real Chrome unavailable (${e.message.split('\n')[0]}); bundled chromium`); delete opt.channel; context = await chromium.launchPersistentContext('/tmp/np-local-extract-profile', opt); }
    await context.addCookies(cookies);
    page = context.pages()[0] || await context.newPage();
  } else if (opts.browserbase) {
    // Remote Browserbase stealth browser bypasses newspapers.com's Cloudflare
    // Turnstile. Subscription auth comes from a PERSISTENT Browserbase context
    // that was logged in once via scripts/newspapers-browserbase-login.js —
    // Safari cookie injection does NOT work (macOS Tahoe hides the httpOnly auth
    // cookies, and newspapers.com issues a per-view image-access token that only
    // a genuinely logged-in session can mint).
    const ctxFile = path.join('data', 'collection-state', 'browserbase-newspapers-context.json');
    if (!fs.existsSync(ctxFile)) {
      throw new Error(`--browserbase needs a logged-in context. Run: node scripts/newspapers-browserbase-login.js (one-time login).`);
    }
    const contextId = JSON.parse(fs.readFileSync(ctxFile, 'utf8')).contextId;
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set');
    console.log(`\nCreating Browserbase session on persistent context ${contextId}...`);
    const resp = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': apiKey },
      body: JSON.stringify({ projectId, proxies: true, browserSettings: { context: { id: contextId, persist: false }, solveCaptchas: true } }),
    });
    if (!resp.ok) throw new Error(`Browserbase session create failed: ${resp.status} ${await resp.text()}`);
    const session = await resp.json();
    console.log(`  session ${session.id} → connecting...`);
    browser = await chromium.connectOverCDP(session.connectUrl);
    context = browser.contexts()[0] || await browser.newContext();
    page = context.pages()[0] || await context.newPage();
  } else {
    console.log('\nLaunching browser (headed — required for newspapers.com)...');
    // Real installed Chrome (channel: 'chrome') — bundled Chrome-for-Testing
    // fails newspapers.com's Cloudflare Turnstile. Must match paywall-browser-login.js.
    const npLaunchOpts = {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'en-US',
      timezoneId: 'America/New_York',
    };
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, { ...npLaunchOpts, channel: 'chrome' });
    } catch (err) {
      console.log(`  → real Chrome unavailable (${err.message.split('\n')[0]}); using bundled chromium`);
      context = await chromium.launchPersistentContext(PROFILE_DIR, npLaunchOpts);
    }
    page = context.pages()[0] || await context.newPage();
  }

  // Quick login check
  console.log('Verifying login...');
  await page.goto('https://www.newspapers.com/', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const loggedIn = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text.includes('My Account') || text.includes('account') || !text.includes('Sign In');
  });
  if (!loggedIn) {
    console.log('WARNING: May not be logged in. Results may be empty.');
  } else {
    console.log('Login verified.');
  }

  // Process each show
  const allResults = [];
  for (let i = 0; i < showIds.length; i++) {
    if (showIds.length > 1) {
      console.log(`\n[${'='.repeat(20)} ${i + 1}/${showIds.length} ${'='.repeat(20)}]`);
    }

    const result = await processShow(page, showIds[i], opts);
    allResults.push(result);

    // Save progress after each show
    fs.writeFileSync('/tmp/newspapers-extract-progress.json', JSON.stringify(allResults, null, 2));

    // Delay between shows
    if (i < showIds.length - 1) {
      await page.waitForTimeout(5000);
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(60)}`);
  console.log('EXTRACTION SUMMARY');
  console.log('='.repeat(60));

  let totalExtracted = 0;
  let totalNotFound = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const r of allResults) {
    const statuses = Object.values(r.papers || {});
    const extracted = statuses.filter(s => s.status === 'extracted' || s.status === 'extracted-fallback').length;
    const notFound = statuses.filter(s => s.status === 'not-found' || s.status === 'no-ocr' || s.status === 'too-short').length;
    const skipped = statuses.filter(s => s.status === 'skipped').length;

    totalExtracted += extracted;
    totalNotFound += notFound;
    totalSkipped += skipped;
    if (r.status === 'error') totalErrors++;

    const statusStr = Object.entries(r.papers || {})
      .map(([outlet, s]) => `${outlet}: ${s.status}${s.chars ? ` (${s.chars} chars)` : ''}`)
      .join(', ');
    console.log(`  ${r.showId}: ${statusStr || r.error || 'no papers processed'}`);
  }

  console.log(`\nTotals: ${totalExtracted} extracted, ${totalNotFound} not found, ${totalSkipped} skipped, ${totalErrors} errors`);
  console.log(`Progress saved to /tmp/newspapers-extract-progress.json`);

  await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  console.log('\nDone. Browser closed.');
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
