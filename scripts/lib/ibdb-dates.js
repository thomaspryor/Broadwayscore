#!/usr/bin/env node
/**
 * IBDB Date Lookup Module
 *
 * Extracts preview dates, opening dates, and closing dates from IBDB
 * (Internet Broadway Database) production pages.
 *
 * IBDB has separate "1st Preview" and "Opening Date" fields, unlike
 * Broadway.org which only has an ambiguous "Begins:" field.
 *
 * Uses Google SERP to find IBDB production URLs, then ScrapingBee
 * with premium proxy to extract dates from production pages.
 */

const { JSDOM } = require('jsdom');
const { fetchPage, cleanup } = require('./scraper');
const { isLondonMarket } = require('./venue-classification');
const { serpQuery } = require('./url-discovery');

const IBDB_BASE = 'https://www.ibdb.com';
const RATE_LIMIT_MS = 1500;

/**
 * Search for IBDB production page URLs via Google SERP
 * @param {string} title - Show title
 * @param {Object} options
 * @param {number} [options.openingYear] - Narrow results to a specific year
 * @returns {Promise<Array<{url: string, title: string, year: string|null}>>}
 */
async function searchIBDB(title, options = {}) {
  const { openingYear } = options;

  // Build Google search query
  const yearStr = openingYear ? ` ${openingYear}` : '';
  const query = `site:ibdb.com/broadway-production "${title}"${yearStr}`;

  console.log(`  🔍 Searching IBDB: ${query}`);

  try {
    const serpResults = await serpQuery(query);
    if (serpResults) {
      const results = serpResults
        .filter(r => r.url && r.url.includes('/broadway-production/'))
        .map(r => ({
          url: r.url,
          title: r.title || '',
          year: extractYearFromUrl(r.url)
        }));
      if (results.length > 0) {
        console.log(`  ✅ Found ${results.length} IBDB production URL(s) via SERP`);
        return results;
      }
    }
  } catch (e) {
    console.log(`  ⚠️  SERP search failed: ${e.message}`);
  }

  // No fallback URL construction — IBDB bare slugs (without numeric production IDs)
  // always redirect to the homepage. Only real SERP results have valid URLs.
  console.log(`  📎 No SERP results for "${title}" — cannot construct IBDB URL without production ID`);
  return [];
}

/**
 * Extract year from IBDB production URL
 * IBDB URLs end with a numeric ID, not a year, but sometimes the title has a year
 */
function extractYearFromUrl(url) {
  // IBDB production URLs: /broadway-production/title-slug-123456
  // The number is an internal ID, not a year
  // Try to extract year from the title portion
  const match = url.match(/\/broadway-production\/.*?(\d{4})/);
  if (match) {
    const year = parseInt(match[1]);
    if (year >= 1850 && year <= 2030) return String(year);
  }
  return null;
}

/**
 * Extract dates from an IBDB production page
 * @param {string} url - Full IBDB production URL
 * @returns {Promise<{previewsStartDate: string|null, openingDate: string|null, closingDate: string|null, theatre: string|null, ibdbUrl: string}>}
 */
async function extractDatesFromIBDBPage(url) {
  console.log(`  📄 Fetching IBDB page: ${url}`);

  const result = {
    previewsStartDate: null,
    openingDate: null,
    closingDate: null,
    theatre: null,
    ibdbUrl: url
  };

  let content = null;

  // Try ScrapingBee with premium proxy (works reliably based on testing)
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
      }
    }
  } catch (e) {
    console.log(`  ⚠️  ScrapingBee page fetch failed: ${e.message}`);
  }

  // Fallback: shared scraper
  if (!content) {
    try {
      const pageResult = await fetchPage(url);
      content = pageResult.content;
    } catch (e) {
      console.log(`  ⚠️  Scraper fallback failed: ${e.message}`);
      return result;
    }
  }

  if (!content) return result;

  // Normalize content to plain text for regex matching
  // IBDB pages may come as HTML or markdown depending on scraper
  let text = content;
  if (content.includes('<html') || content.includes('<div')) {
    // HTML content - extract text via JSDOM
    try {
      const dom = new JSDOM(content);
      text = dom.window.document.body.textContent || '';
    } catch (e) {
      // Fall through with raw content
    }
  }

  // Check if we got redirected to homepage (page not found)
  if (text.includes('Opening Nights in History') && !text.includes('Opening Date')) {
    console.log(`  ⚠️  IBDB page redirected to homepage (production not found)`);
    return result;
  }

  // Date pattern: month day, year (e.g., "Nov 12, 2024" or "November 12, 2024")
  const datePattern = '([A-Z][a-z]{2,8}\\s+\\d{1,2},\\s*\\d{4})';

  // Opening Date - try multiple formats seen in IBDB pages
  const openingPatterns = [
    new RegExp('Opening Date\\s*' + datePattern),
    new RegExp('Open Date:\\s*' + datePattern),
    new RegExp('Opening Date[\\s\\S]{0,20}?' + datePattern)
  ];
  for (const pat of openingPatterns) {
    const m = text.match(pat);
    if (m) {
      result.openingDate = parseIBDBDate(m[1]);
      if (result.openingDate) break;
    }
  }

  // 1st Preview
  const previewPatterns = [
    new RegExp('1st Preview\\s*' + datePattern),
    new RegExp('1st Preview[\\s\\S]{0,20}?' + datePattern),
    new RegExp('Previews?\\s+' + datePattern)
  ];
  for (const pat of previewPatterns) {
    const m = text.match(pat);
    if (m) {
      result.previewsStartDate = parseIBDBDate(m[1]);
      if (result.previewsStartDate) break;
    }
  }

  // Closing Date
  const closingPatterns = [
    new RegExp('Closing Date\\s*' + datePattern),
    new RegExp('Close Date:\\s*' + datePattern),
    new RegExp('Closing Date[\\s\\S]{0,20}?' + datePattern)
  ];
  for (const pat of closingPatterns) {
    const m = text.match(pat);
    if (m) {
      result.closingDate = parseIBDBDate(m[1]);
      if (result.closingDate) break;
    }
  }

  // Theatre - from text near "Theatres" heading
  const theatreMatch = text.match(/Theatres?\s*([A-Z][A-Za-z\s']+Theatre)/);
  if (theatreMatch) {
    result.theatre = theatreMatch[1].trim();
  }

  // Show type extraction: IBDB classifies productions as "Musical" or "Play"
  // Look for these classifications in the page text (typically near the top)
  const topText = text.slice(0, 2000);
  const hasMusical = /\bMusical\b/.test(topText);
  const hasPlay = /\bPlay\b/.test(topText);
  if (hasMusical && !hasPlay) {
    result.showType = 'musical';
  } else if (hasPlay && !hasMusical) {
    result.showType = 'play';
  } else {
    // Both or neither found — leave as null for caller to decide
    result.showType = null;
  }

  // Creative team extraction
  result.creativeTeam = extractCreativeTeamFromText(text);

  return result;
}

/**
 * Validate whether a string looks like a real creative team member name.
 * Rejects garbled text, sentence fragments, award references, and other non-name strings.
 *
 * @param {string} name - Name to validate
 * @returns {boolean} true if the name looks valid
 */
function isValidCreativeTeamName(name) {
  if (!name || typeof name !== 'string') return false;

  // Normalize whitespace before checking
  const normalized = name.replace(/\s{2,}/g, ' ').trim();

  // Reject names longer than 70 characters. This leaves room for legitimate
  // multi-person design/orchestration credits like "SCK Sound Design, Walter
  // Trarbach and Andrew Keister" (52 chars). Phrase rules below catch junk
  // regardless of length.
  if (normalized.length > 70) return false;

  // Reject multi-word names that start with lowercase (sentence fragments like "of Disney")
  // Single-word lowercase names are allowed (e.g. "dots" scenic-design collective, "beyoncé")
  if (/^[a-z]/.test(normalized) && /\s/.test(normalized)) return false;

  // Reject names starting with prepositions (never valid creative-team members).
  // Kept narrow: "Or" is a Hebrew first name (Or Matias), "But" is never a sentence start.
  // "The"/"A"/"An" are allowed — band/collective names like "The Avett Brothers".
  if (/^(For|With|In|On|At|By|From|Of|And)\s/i.test(normalized)) return false;

  // Reject sentence fragments: period followed by space and lowercase letter
  if (/\.\s+[a-z]/.test(normalized)) return false;

  // Reject sentence fragment indicators (common sentence words as whole words).
  // Case-sensitive — capitalized "Will" is a common first name (Will Butler, Will Van Dyke),
  // but lowercase "will" in the middle of a name indicates a sentence fragment.
  const sentenceWords = /\b(is|are|was|were|has|have|had|will|shall|may|might|must|should|could|would)\b/;
  if (sentenceWords.test(normalized)) return false;

  // Reject award references — credit phrases and bare award labels, not first names.
  // Matches: "Tony Award", "Oscar Winner", "Grammy Nominee", "Pulitzer Prize", "Lifetime Achievement".
  // Preserves first names: "Tony Kushner", "Oscar Hammerstein II", "Tony Taccone", "Tony Meola".
  if (/^(Tony|Oscar|Emmy|Grammy|Pulitzer|Obie|Olivier|Drama Desk)(\s+(Award|Winner|Nominee|Prize|nominated|winning))?$/i.test(normalized)) return false;
  if (/^Lifetime Achievement$/i.test(normalized)) return false;
  // Credit-phrase prefixes that leaked from TodayTix / IBDB blurbs:
  // "Tony Award winner Alex Timbers", "Oscar-winning director John Doe", "Pulitzer Prize winner"
  if (/^(Tony|Oscar|Emmy|Grammy|Pulitzer|Obie|Olivier)\s+(Award|Prize)\s+(winner|winning|nominee|nominated|recipient)\b/i.test(normalized)) return false;
  if (/^(Tony|Oscar|Emmy|Grammy|Pulitzer|Obie|Olivier)[-\s](winning|winner|nominated|nominee)\b/i.test(normalized)) return false;
  if (/\b(Award|Prize)\s+(winner|winning|recipient)\b/i.test(normalized)) return false;
  if (/based on the novel by/i.test(normalized)) return false;
  if (/and musical supervision/i.test(normalized)) return false;
  if (/\bfocused on\b/i.test(normalized)) return false;
  if (/\bof new works\b/i.test(normalized)) return false;
  if (/\band actress on\b/i.test(normalized)) return false;
  if (/\bfor giving\b/i.test(normalized)) return false;
  if (/\bfor the West End\b/i.test(normalized)) return false;
  if (/\bthis person\b/i.test(normalized)) return false;
  if (/\bat Roundabout\b/i.test(normalized)) return false;
  if (/\bof the company\b/i.test(normalized)) return false;
  if (/\bFranklin Shepard\b/i.test(normalized)) return false;

  // Reject single words longer than 20 characters (likely garbled text)
  const words = normalized.split(/\s+/);
  if (words.length === 1 && normalized.length > 20) return false;

  // Reject names containing numbers (real names don't have digits)
  if (/\d/.test(normalized)) return false;

  return true;
}

/**
 * Extract creative team members from IBDB page text.
 * IBDB credits are semicolon-separated entries like:
 *   "Directed by Saheem Ali; Choreographed by Patricia Delgado and Justin Peck; Book by Marco Ramirez"
 *   "Scenic Design by Arnulfo Maldonado; Musical Supervisor: Dean Sharenow"
 *
 * @param {string} text - Plain text content of the IBDB page
 * @returns {Array<{name: string, role: string}>}
 */
function extractCreativeTeamFromText(text) {
  const creativeTeam = [];
  const seen = new Set(); // Prevent duplicates (by normalized name+role)
  const musicAndLyricsNames = new Set(); // Track "Music & Lyrics" names to suppress standalone Music/Lyrics

  // Role patterns: [regex, role label]
  // Order matters — "Music and Lyrics by" must come before "Music by" and "Lyrics by"
  // Playwright patterns: "Written by", "Adapted by", genre-prefixed "play by", standalone "By"
  // Standalone "By" uses case-SENSITIVE match (no 'i' flag) to avoid matching "Directed by" etc.
  const rolePatterns = [
    [/Music and Lyrics by\s+([^;:\n]+)/gi, 'Music & Lyrics'],
    [/Written by\s+([^;:\n]+)/gi, 'Playwright'],
    [/Adapted by\s+([^;:\n]+)/gi, 'Playwright'],
    [/(?:play|drama|comedy|farce|thriller|mystery|revue) by\s+([^;:\n]+)/gi, 'Playwright'],
    [/(?:^|;\s*)By\s+([A-Z][^;:\n]+)/gm, 'Playwright'],
    [/Original Score by\s+([^;:\n]+)/gi, 'Original Score'],
    [/Directed by\s+([^;:\n]+)/gi, 'Director'],
    [/Choreograph(?:ed|y) by\s+([^;:\n]+)/gi, 'Choreographer'],
    [/Book by\s+([^;:\n]+)/gi, 'Book'],
    [/Scenic Design by\s+([^;:\n]+)/gi, 'Scenic Design'],
    [/Costume Design by\s+([^;:\n]+)/gi, 'Costume Design'],
    [/Lighting Design by\s+([^;:\n]+)/gi, 'Lighting Design'],
    [/Sound Design by\s+([^;:\n]+)/gi, 'Sound Design'],
    [/Music (?:orchestrated|Orchestrated) by\s+([^;:\n]+)/gi, 'Orchestrations'],
    [/Orchestrations by\s+([^;:\n]+)/gi, 'Orchestrations'],
    [/Musical Supervisor:\s*([^;:\n]+)/gi, 'Music Supervision'],
    [/Musical Director:\s*([^;:\n]+)/gi, 'Music Direction'],
    [/Music direction by\s+([^;:\n]+)/gi, 'Music Direction'],
    [/Lyrics by\s+([^;:\n]+)/gi, 'Lyrics'],
    [/(?:^|[;.\n]\s*)Music by\s+([^;:\n]+)/gi, 'Music'],
  ];

  // Roles that appear in song-level credits on IBDB — only take first match
  const firstMatchOnly = new Set(['Lyrics', 'Music', 'Music & Lyrics', 'Playwright']);

  for (const [pattern, role] of rolePatterns) {
    let match;
    let matchedOnce = false;
    while ((match = pattern.exec(text)) !== null) {
      // For music/lyrics roles, only take the first match (show-level credit)
      // to avoid picking up per-song credits from the Songs section
      if (firstMatchOnly.has(role) && matchedOnce) continue;

      const rawName = match[1].trim()
        // Collapse excess whitespace (IBDB HTML tables produce wide gaps)
        .replace(/\s{2,}/g, ' ')
        // Strip trailing punctuation/junk
        .replace(/[.,;:\s]+$/, '')
        // Strip parenthetical suffixes like "(includes projections)"
        .replace(/\s*\(.*$/, '')
        // Strip unbalanced trailing parentheses (song credit artifacts)
        .replace(/\)+$/, '')
        // Strip common IBDB trailing noise
        .replace(/\s+Based on\b.*$/i, '')
        .replace(/\s+Originally\b.*$/i, '')
        .replace(/\s+Additional\b.*$/i, '')
        // Final whitespace normalization
        .replace(/\s{2,}/g, ' ')
        .trim();

      if (!rawName || rawName.length < 2 || rawName.length > 100) continue;

      // Skip if this looks like a non-name (dates, numbers, etc.)
      if (/^\d/.test(rawName) || /\d{4}/.test(rawName)) continue;

      // Skip song credit boilerplate like "(Unless otherwise noted)"
      if (/^unless\b/i.test(rawName)) continue;

      // Validate name quality
      if (!isValidCreativeTeamName(rawName)) continue;

      // Track "Music & Lyrics" names so we skip redundant standalone Lyrics/Music
      if (role === 'Music & Lyrics') {
        musicAndLyricsNames.add(rawName.toLowerCase());
      }

      // Skip standalone "Lyrics" or "Music" if same person already credited for "Music & Lyrics"
      if ((role === 'Lyrics' || role === 'Music') && musicAndLyricsNames.has(rawName.toLowerCase())) {
        continue;
      }

      // Deduplicate by normalized name+role (case-insensitive, whitespace-collapsed)
      const normalizedName = rawName.toLowerCase().replace(/\s{2,}/g, ' ').trim();
      const key = `${role}::${normalizedName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      creativeTeam.push({ name: rawName, role });
      matchedOnce = true;
    }
  }

  // Safety guard: if more than 15 entries extracted, the regex likely ran on
  // wrong text (e.g., full cast list or song credits). Return empty array.
  if (creativeTeam.length > 15) {
    return [];
  }

  // Guard: if >3 entries share the same role, truncate to the first entry for
  // that role. This catches cases where regex matched biography/song credits.
  const roleCounts = {};
  for (const entry of creativeTeam) {
    roleCounts[entry.role] = (roleCounts[entry.role] || 0) + 1;
  }
  const bloatedRoles = new Set(
    Object.entries(roleCounts)
      .filter(([, count]) => count > 3)
      .map(([role]) => role)
  );
  if (bloatedRoles.size > 0) {
    const seenRoles = {};
    return creativeTeam.filter(entry => {
      if (!bloatedRoles.has(entry.role)) return true;
      seenRoles[entry.role] = (seenRoles[entry.role] || 0) + 1;
      return seenRoles[entry.role] <= 1;
    });
  }

  return creativeTeam;
}

/**
 * Parse IBDB date string (e.g., "Nov 12, 2024") to ISO format "2024-11-12"
 */
function parseIBDBDate(dateStr) {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr.trim());
    if (isNaN(parsed.getTime())) return null;
    return parsed.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Extract production title from an IBDB URL slug.
 * /broadway-production/burn-the-floor-485387 → "burn the floor"
 * /broadway-production/the-24-hour-plays-2009-485386 → "the 24 hour plays 2009"
 */
function extractTitleFromIBDBUrl(url) {
  // Handle all production URL types: broadway, off-broadway, tour
  const prodMatch = url.match(/\/(broadway-production|off-broadway-production|tour-production)\/(.+)/);
  const slug = prodMatch ? prodMatch[2] : (url.split('/broadway-production/')[1] || '');
  // Strip trailing numeric IBDB ID (3+ digits at end)
  return slug.replace(/-\d{3,}$/, '').replace(/-/g, ' ').trim();
}

/**
 * Normalize a title for IBDB matching comparison.
 * Strips articles, punctuation, possessives, and SERP suffixes.
 */
function normalizeForTitleMatch(title) {
  return title
    .toLowerCase()
    .replace(/\s*\|.*$/, '')           // Remove "| IBDB" SERP suffix
    .replace(/\s*[-–]\s*broadway\s+production\b/i, '') // Remove "- Broadway Production"
    .replace(/\s*\(.*?\)/g, '')        // Remove parentheticals
    .replace(/[''']s\b/g, 's')        // Possessive 's → s (before punctuation strip)
    .replace(/['''`]/g, '')            // Remove apostrophes (keep contractions: ain't → aint)
    .replace(/[.:!?,/&]/g, ' ')        // Other punctuation → spaces (preserves compound words)
    .replace(/^(the|a|an)\s+/i, '')    // Remove leading articles
    .replace(/[^a-z0-9\s]/g, '')       // Remove remaining non-alphanumeric
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score how well a candidate IBDB result matches the expected show title.
 * Returns: +15 (exact), +12 (containment), +8 (strong overlap), 0 (weak),
 *          -10 (no overlap = clear mismatch)
 */
function titleMatchScore(searchTitle, candidateUrl, candidateSerpTitle) {
  const search = normalizeForTitleMatch(searchTitle);
  const fromUrl = normalizeForTitleMatch(extractTitleFromIBDBUrl(candidateUrl));
  const fromSerp = normalizeForTitleMatch(candidateSerpTitle || '');

  // Check both URL slug and SERP title, use best
  for (const candidate of [fromUrl, fromSerp]) {
    if (!candidate) continue;
    if (search === candidate) return 15;                                     // Exact
    if (candidate.includes(search) || search.includes(candidate)) return 12; // Containment
  }

  // Word overlap (Jaccard) on URL slug
  if (fromUrl) {
    // Keep single-char digits (important for shows like "13", "9 to 5")
    const wordsA = new Set(search.split(/\s+/).filter(w => w.length > 1 || /\d/.test(w)));
    const wordsB = new Set(fromUrl.split(/\s+/).filter(w => w.length > 1 || /\d/.test(w)));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard >= 0.5) return 8;    // Strong partial match

    // Character-level check for accent/diacritical differences AND weak word overlap
    // (e.g., "les miserables" vs "les misrables" — IBDB drops accented chars)
    // Also catches hyphenated titles: "court martial" vs "courtmartial"
    const longer = Math.max(search.length, fromUrl.length);
    if (longer > 0) {
      let common = 0;
      const bChars = fromUrl.split('');
      for (const ch of search) {
        const idx = bChars.indexOf(ch);
        if (idx !== -1) { common++; bChars.splice(idx, 1); }
      }
      const charSim = common / longer;
      if (charSim > 0.75) return 5;   // Close character match (accent/hyphen differences)
      if (charSim > 0.5) return 0;    // Marginal, neutral
    }

    if (jaccard > 0) return 0;        // Some word overlap but poor character match = neutral
    return -10;                        // Zero overlap = clear mismatch
  }
  return 0;
}

/**
 * Find the best matching production from search results
 * @param {Array} results - Search results from searchIBDB
 * @param {Object} options
 * @param {string} [options.title] - Expected show title (strongest signal)
 * @param {number} [options.openingYear] - Expected opening year
 * @param {string} [options.venue] - Expected venue name
 * @returns {Object|null} Best matching result
 */
function findBestProduction(results, options = {}) {
  if (!results || results.length === 0) return null;

  const { openingYear, venue, title } = options;

  // Score each result
  const scored = results.map(r => {
    let score = 0;

    // Title match (strongest signal — prevents wrong-production matches)
    if (title) {
      score += titleMatchScore(title, r.url, r.title);
    }

    // Year match
    if (openingYear && r.year) {
      if (String(r.year) === String(openingYear)) score += 10;
      else if (Math.abs(parseInt(r.year) - openingYear) <= 1) score += 5;
    }

    // Prefer non-guessed URLs
    if (!r.isGuessed) score += 3;

    // Venue match in title
    if (venue && r.title && r.title.toLowerCase().includes(venue.toLowerCase())) {
      score += 5;
    }

    // Recent productions score higher (likely more relevant)
    if (r.year) {
      const y = parseInt(r.year);
      if (y >= 2020) score += 2;
      else if (y >= 2010) score += 1;
    }

    return { ...r, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Reject if best candidate doesn't have a positive title signal.
  // Old threshold was -5, which let neutral/wrong matches through.
  if (title) {
    const best = scored[0];
    const titleScore = titleMatchScore(title, best.url, best.title);

    // Must have at least some positive title evidence (score >= 5)
    if (titleScore < 5) {
      console.log(`  ⛔ Best IBDB result has weak title match (titleScore=${titleScore}) for "${title}" — rejecting`);
      return null;
    }

    // Year gate: if year differs by >2, require near-exact title match (>= 12)
    if (openingYear && best.year) {
      const yearGap = Math.abs(parseInt(best.year) - openingYear);
      if (yearGap > 2 && titleScore < 12) {
        console.log(`  ⛔ IBDB result year ${best.year} is ${yearGap} years off from ${openingYear}, and title match is weak (${titleScore}) — rejecting`);
        return null;
      }
    }
  }

  return scored[0];
}

/**
 * Look up dates for a single show from IBDB
 * @param {string} title - Show title
 * @param {Object} options
 * @param {number} [options.openingYear] - Approximate opening year
 * @param {string} [options.venue] - Theatre venue name
 * @returns {Promise<{previewsStartDate: string|null, openingDate: string|null, closingDate: string|null, ibdbUrl: string|null, found: boolean}>}
 */
async function lookupIBDBDates(title, options = {}) {
  const notFound = {
    previewsStartDate: null,
    openingDate: null,
    closingDate: null,
    creativeTeam: [],
    ibdbUrl: null,
    found: false
  };

  try {
    let bestMatch;

    // Step 0: If a stored IBDB URL exists, use it directly (skip search)
    if (options.ibdbUrl) {
      console.log(`  📎 Using stored IBDB URL: ${options.ibdbUrl}`);
      bestMatch = { url: options.ibdbUrl, title: title, year: null };
    } else {
      // Step 1: Search for IBDB production page
      const searchResults = await searchIBDB(title, options);

      if (searchResults.length === 0) {
        console.log(`  ❌ No IBDB results found for "${title}"`);
        return notFound;
      }

      // Step 2: Find best matching production (title-aware scoring)
      bestMatch = findBestProduction(searchResults, { ...options, title });
    }

    if (!bestMatch) {
      console.log(`  ❌ No suitable IBDB production found for "${title}"`);
      return notFound;
    }

    // Step 3: Extract dates from the production page
    const dates = await extractDatesFromIBDBPage(bestMatch.url);

    if (!dates.openingDate && !dates.previewsStartDate) {
      console.log(`  ❌ No dates extracted from IBDB page for "${title}"`);
      return { ...notFound, ibdbUrl: bestMatch.url, creativeTeam: dates.creativeTeam || [] };
    }

    // Step 4: PRODUCTION YEAR VALIDATION GATE
    // Prevents wrong-production matching (e.g., 1988 Chess instead of 2025 Chess)
    // This is the primary defense against ALL creative team role contamination.
    if (options.openingYear && dates.openingDate) {
      const ibdbYear = parseInt(dates.openingDate.split('-')[0]);
      const expectedYear = options.openingYear;
      const yearDiff = Math.abs(ibdbYear - expectedYear);

      if (yearDiff > 1) {
        console.log(`  ⛔ WRONG PRODUCTION: IBDB page year (${ibdbYear}) differs from expected (${expectedYear}) by ${yearDiff} years`);
        console.log(`     Rejecting creative team data to prevent contamination`);
        console.log(`     URL: ${bestMatch.url}`);
        return notFound;
      }

      if (yearDiff === 1) {
        console.log(`  ⚠️  IBDB year (${ibdbYear}) differs from expected (${expectedYear}) by 1 year — allowing (year-boundary tolerance)`);
      }
    } else if (!options.openingYear) {
      // No expected year — require title match on the scraped page as minimum validation
      // (This catches discover-new-shows.js calls where openingDate may not exist yet)
      console.log(`  ⚠️  No opening year for "${title}" — cannot validate IBDB production match`);
    }

    console.log(`  ✅ IBDB dates for "${title}":`);
    if (dates.previewsStartDate) console.log(`     1st Preview: ${dates.previewsStartDate}`);
    if (dates.openingDate) console.log(`     Opening: ${dates.openingDate}`);
    if (dates.closingDate) console.log(`     Closing: ${dates.closingDate}`);
    if (dates.creativeTeam && dates.creativeTeam.length > 0) {
      console.log(`     Creative team: ${dates.creativeTeam.length} role(s)`);
    }

    return {
      previewsStartDate: dates.previewsStartDate,
      openingDate: dates.openingDate,
      closingDate: dates.closingDate,
      creativeTeam: dates.creativeTeam || [],
      showType: dates.showType || null,
      ibdbUrl: dates.ibdbUrl,
      found: true
    };

  } catch (e) {
    console.log(`  ⚠️  IBDB lookup failed for "${title}": ${e.message}`);
    return notFound;
  }
}

/**
 * Batch lookup IBDB dates for multiple shows with rate limiting
 * @param {Array<{title: string, openingYear?: number, venue?: string}>} shows
 * @param {Object} options
 * @param {number} [options.rateLimitMs=1500] - Delay between requests
 * @param {number} [options.maxConcurrent=1] - Max concurrent requests
 * @returns {Promise<Map<string, Object>>} Map of title -> date results
 */
async function batchLookupIBDBDates(shows, options = {}) {
  const { rateLimitMs = RATE_LIMIT_MS } = options;
  const results = new Map();

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    console.log(`\n📌 [${i + 1}/${shows.length}] Looking up "${show.title}"...`);

    const dates = await lookupIBDBDates(show.title, {
      openingYear: show.openingYear,
      venue: show.venue,
      ibdbUrl: show.ibdbUrl || null
    });

    results.set(show.title, dates);

    // Rate limit between requests (skip after last one)
    if (i < shows.length - 1) {
      await sleep(rateLimitMs);
    }
  }

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check IBDB for prior productions of a given title to detect revivals.
 * Uses SERP to find production pages — if multiple distinct productions exist,
 * the current show is a revival. Does NOT scrape individual pages.
 *
 * @param {string} title - Show title to check
 * @param {Object} options
 * @param {number} [options.currentYear] - Year of the current production
 * @returns {Promise<{isRevival: boolean, priorProductionCount: number, urls: string[], confidence: string}>}
 */
async function checkIBDBForPriorProductions(title, options = {}) {
  const notFound = { isRevival: false, priorProductionCount: 0, urls: [], confidence: 'none' };

  // Guard: skip short/generic titles
  if (!title || title.length < 5) {
    console.log(`  ⏭️  Skipping "${title}" — title too short for IBDB revival check`);
    return notFound;
  }

  // Guard: skip revues, concerts, galas, benefits
  if (/\b(revue|concert|in concert|gala|benefit|celebration)\b/i.test(title)) {
    console.log(`  ⏭️  Skipping "${title}" — appears to be a revue/concert/gala`);
    return notFound;
  }

  try {
    // Search IBDB for production pages matching this title
    // Two targeted queries work better than one broad query — Google returns
    // cast/staff pages for site:ibdb.com, drowning out production pages.
    const prodPaths = [
      'ibdb.com/broadway-production',
      'ibdb.com/off-broadway-production'
    ];

    let results = [];

    for (const prodPath of prodPaths) {
      const query = `site:${prodPath} "${title}"`;
      console.log(`  🔍 Revival check SERP: ${query}`);

      try {
        const serpResults = await serpQuery(query);
        if (serpResults) {
          const pageResults = serpResults
            .filter(r => r.url && (r.url.includes('/broadway-production/') || r.url.includes('/off-broadway-production/') || r.url.includes('/tour-production/')))
            .map(r => ({ url: r.url, title: r.title || '' }));
          results.push(...pageResults);
        }
      } catch (e) {
        console.log(`  ⚠️  SERP search failed: ${e.message}`);
      }

      // Rate limit between SERP calls
      if (prodPath !== prodPaths[prodPaths.length - 1]) {
        await sleep(500);
      }
    }

    if (results.length === 0) {
      console.log(`  📎 No IBDB production results for "${title}"`);
      return notFound;
    }

    // Filter to results that actually match the title
    // Stricter than general titleMatchScore: require exact or near-exact match
    // to prevent "The Unknown" matching "The Unknown Soldier and His Wife"
    const validResults = results.filter(r => {
      const score = titleMatchScore(title, r.url, r.title);
      if (score < 8) return false;

      // Additional check: the URL slug title must be close in length to our title
      // This prevents short titles from matching longer, unrelated titles
      const urlTitle = extractTitleFromIBDBUrl(r.url);
      const normSearch = normalizeForTitleMatch(title);
      const normUrl = normalizeForTitleMatch(urlTitle);

      // If slug is >50% longer than our title, it's likely a different show
      if (normUrl.length > normSearch.length * 1.5 && normSearch.length < 20) {
        return false;
      }
      // If our title is >50% longer than slug, also suspicious
      if (normSearch.length > normUrl.length * 1.5 && normUrl.length < 20) {
        return false;
      }

      return true;
    });

    // Deduplicate by URL (SERP can return same page twice)
    const uniqueUrls = [...new Set(validResults.map(r => r.url))];

    console.log(`  📊 IBDB results: ${results.length} raw, ${validResults.length} title-matched, ${uniqueUrls.length} unique production URLs`);

    if (uniqueUrls.length === 0) {
      return notFound;
    }

    // Check if any SERP title explicitly says "Revival"
    const revivalResults = validResults.filter(r =>
      /–\s.*revival/i.test(r.title) || /\bRevival\b/.test(r.title)
    );

    // For OB/WE shows: finding ANY Broadway production page means the show existed
    // on Broadway before → current production is likely a revival (unless it's a transfer)
    const showCategory = options.showCategory || '';
    const isNonBroadway = showCategory === 'off-broadway' || isLondonMarket(showCategory);
    const hasBroadwayUrl = validResults.some(r => r.url.includes('/broadway-production/'));

    // Helper: check if a production is a transfer (not a revival)
    // Transfer = our show predates the IBDB production, OR the IBDB production
    // was still running when our show opened (concurrent = transfer, not revival)
    async function isTransferNotRevival(ibdbUrl) {
      if (!options.currentYear) return { isTransfer: false };
      try {
        const pageDates = await extractDatesFromIBDBPage(ibdbUrl);
        if (pageDates.openingDate) {
          const ibdbYear = parseInt(pageDates.openingDate.split('-')[0]);
          // Our show predates the IBDB production → we're the original
          if (options.currentYear < ibdbYear) {
            console.log(`  ➡️  Transfer detected: our show (${options.currentYear}) predates IBDB production (${ibdbYear})`);
            return { isTransfer: true, ibdbYear };
          }
          // IBDB production was still running when our show opened → concurrent transfer
          // But only if the production is recent (within 10 years) — old shows without
          // closing dates are just missing data, not "still running"
          if (!pageDates.closingDate && (options.currentYear - ibdbYear) <= 10) {
            console.log(`  ➡️  Transfer detected: Broadway production (${ibdbYear}) still running — concurrent with our ${showCategory} show`);
            return { isTransfer: true, ibdbYear };
          }
          const closingYear = parseInt(pageDates.closingDate.split('-')[0]);
          if (closingYear >= options.currentYear) {
            console.log(`  ➡️  Transfer detected: Broadway production closed ${closingYear}, same year or after our show (${options.currentYear})`);
            return { isTransfer: true, ibdbYear };
          }
          return { isTransfer: false, ibdbYear };
        }
      } catch (e) {
        console.log(`  ⚠️  Transfer check failed: ${e.message}`);
      }
      return { isTransfer: false };
    }

    if (uniqueUrls.length >= 2) {
      // Multiple distinct production pages — strong revival signal
      // But check for transfer first (for OB/WE shows)
      if (isNonBroadway && hasBroadwayUrl) {
        // Find the most recent Broadway production URL and check transfer
        const bwayUrl = validResults.find(r => r.url.includes('/broadway-production/'))?.url;
        if (bwayUrl) {
          const transferCheck = await isTransferNotRevival(bwayUrl);
          if (transferCheck.isTransfer) {
            return {
              isRevival: false,
              priorProductionCount: uniqueUrls.length,
              urls: uniqueUrls,
              confidence: 'high',
              isTransfer: true
            };
          }
        }
      }

      console.log(`  🔄 Revival detected: ${uniqueUrls.length} prior IBDB productions for "${title}"`);
      for (const u of uniqueUrls) console.log(`     ${u}`);
      return {
        isRevival: true,
        priorProductionCount: uniqueUrls.length,
        urls: uniqueUrls,
        confidence: 'high'
      };
    }

    // Single production page found
    if (uniqueUrls.length === 1) {
      // For Broadway shows: check if the SERP title says "Revival"
      if (!isNonBroadway) {
        if (revivalResults.length > 0) {
          console.log(`  🔄 Revival detected: IBDB title says "Revival" for "${title}"`);
          console.log(`     ${uniqueUrls[0]}`);
          return {
            isRevival: true,
            priorProductionCount: 1,
            urls: uniqueUrls,
            confidence: 'high'
          };
        }
        console.log(`  ➡️  Single IBDB production for "${title}" — title says "Original", not a revival`);
        return { isRevival: false, priorProductionCount: 1, urls: uniqueUrls, confidence: 'medium' };
      }

      // For OB/WE shows: any Broadway production page = prior existence
      if (hasBroadwayUrl) {
        const transferCheck = await isTransferNotRevival(uniqueUrls[0]);
        if (transferCheck.isTransfer) {
          return {
            isRevival: false,
            priorProductionCount: 1,
            urls: uniqueUrls,
            confidence: 'high',
            isTransfer: true
          };
        }
        if (transferCheck.ibdbYear) {
          console.log(`  🔄 Revival detected: Broadway production (${transferCheck.ibdbYear}) predates our ${showCategory} show (${options.currentYear})`);
        } else {
          console.log(`  🔄 Revival likely: Broadway production exists for "${title}" (${showCategory} show)`);
        }
        console.log(`     ${uniqueUrls[0]}`);
        return {
          isRevival: true,
          priorProductionCount: 1,
          urls: uniqueUrls,
          confidence: transferCheck.ibdbYear ? 'high' : 'medium'
        };
      }

      // OB production page found for OB show — could be current production
      console.log(`  ➡️  Single non-Broadway IBDB production for "${title}" — inconclusive`);
      return { isRevival: false, priorProductionCount: 1, urls: uniqueUrls, confidence: 'low' };
    }

    return notFound;

  } catch (e) {
    console.log(`  ⚠️  IBDB revival check failed for "${title}": ${e.message}`);
    return notFound;
  }
}

module.exports = {
  searchIBDB,
  extractDatesFromIBDBPage,
  extractCreativeTeamFromText,
  isValidCreativeTeamName,
  findBestProduction,
  lookupIBDBDates,
  batchLookupIBDBDates,
  parseIBDBDate,
  extractTitleFromIBDBUrl,
  normalizeForTitleMatch,
  titleMatchScore,
  checkIBDBForPriorProductions
};
