/**
 * Shared helpers for the 5 precursor-ceremony Wikipedia scrapers
 * (scrape-{drama-desk,outer-critics,drama-league,nydcc,pulitzer}.js).
 *
 * Why per-category page wikitext instead of JSDOM HTML (like scrape-tony-awards.js):
 *   - Drama Desk / OCC / Drama League each have stable per-category Wikipedia
 *     pages with one master table covering every ceremony year. One fetch per
 *     category beats fetching one HTML page per ceremony year.
 *   - Pulitzer Prize for Drama is a single master page.
 *   - NY Drama Critics' Circle is a single master page (winners only).
 *   - Wikitext is more stable than rendered HTML across re-skins.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const USER_AGENT = 'BroadwayScorecardBot/1.0 (broadway-scorecard project; precursor-awards-scraper)';
const RATE_LIMIT_MS = 600;
const PRECURSORS_DIR = path.join(__dirname, '..', '..', 'data', 'precursors');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error on ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchWikitext(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2`;
  const data = await fetchJson(url);
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;
  return page?.revisions?.[0]?.slots?.main?.content || null;
}

/** Strip wikitext markup, return clean plaintext suitable for title comparison. */
function cleanWikiText(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<\/?(?:br|small|nowiki|sup|sub|s|i|b|center|span)[^>]*>/gi, ' ')
    // Drop reference-only templates first
    .replace(/\{\{(?:efn|sfn|cite|citation|harvnb|nbsp)[^{}]*\}\}/gi, '')
    // [[link|text]] → text, [[link]] → link
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/'{2,5}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&ndash;/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Match a wikitable block: {| ... class="wikitable" ... |}.
 *  Returns array of table-body strings (without the outer {| ... |}). */
function extractTables(wikitext) {
  const tables = [];
  let i = 0;
  while (i < wikitext.length) {
    const open = wikitext.indexOf('{|', i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 2;
    while (j < wikitext.length && depth > 0) {
      const nextOpen = wikitext.indexOf('{|', j);
      const nextClose = wikitext.indexOf('|}', j);
      if (nextClose === -1) { j = wikitext.length; break; }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        j = nextOpen + 2;
      } else {
        depth--;
        j = nextClose + 2;
      }
    }
    const block = wikitext.slice(open, j);
    if (/class="[^"]*wikitable/i.test(block.slice(0, 200))) {
      tables.push(block);
    }
    i = j;
  }
  return tables;
}

/** Split a wikitable into rows on `|-` separators. */
function splitRows(table) {
  return table.split(/\n\s*\|-+/);
}

/** True if a wikitext row carries a winner highlight: explicit background color,
 *  the {{nom}}/{{won}} templates, or a leading bold cell. */
function rowIsWinner(rowText) {
  if (/style\s*=\s*"[^"]*background\s*[:#][^"]*"/i.test(rowText)) {
    // Many tables use the SAME background for ALL data rows (alternating row
    // shading) — only treat it as a winner marker if the color is a known
    // highlight palette (light blue/gold/cream commonly used on Wikipedia).
    if (/background\s*[:#]\s*(?:#B0C4DE|#FAEB86|#FAE7B5|#EEDD82|#F5F5DC|#FFFACD|#FFF8DC|#FFFFCC|#FFE4B5|lightsteelblue|gold|khaki)/i.test(rowText)) {
      return true;
    }
  }
  if (/\{\{(?:won|winner)\b/i.test(rowText)) return true;
  return false;
}

/** Pull the year out of a row. Looks for a leading 4-digit cell. */
function extractYear(rowText) {
  // Match: |[[2024 in theatre|2024]] OR | 2024 OR | rowspan=2 | 2024
  const m = rowText.match(/^\s*\|\s*(?:rowspan\s*=\s*"?\d+"?\s*\|\s*)?(?:\[\[)?([12]\d{3})(?:[\s|\]a-z–-])/);
  if (m) return parseInt(m[1], 10);
  // Also catch ! 2024 (header-style)
  const m2 = rowText.match(/!\s*(?:scope\s*=\s*"row"\s*\|\s*)?(?:\[\[)?([12]\d{3})/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

/** Extract show titles from a row by italic markup ''Title''. Filters out
 *  obvious non-title tokens (Year, Production, etc). */
function extractItalicTitles(rowText) {
  const titles = [];
  const re = /''([^']{2,200}?)''/g;
  let m;
  while ((m = re.exec(rowText)) !== null) {
    const raw = m[1];
    const cleaned = cleanWikiText(raw)
      .replace(/\s*\((?:musical|play|opera|ballet|revival)\)\s*$/i, '')
      .trim();
    if (!cleaned || cleaned.length < 2) continue;
    if (/^(?:year|production|musical|play|nominee|winner|results?|note|ref)s?$/i.test(cleaned)) continue;
    titles.push(cleaned);
  }
  return titles;
}

/** Normalize titles for comparison/dedup. Mirrors the matcher in
 *  scripts/lib/title-match.js — lowercased, punctuation collapsed. */
function normalizeForCompare(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Atomically write a precursor JSON file to data/precursors/{name}.json.
 *  Wraps payload in { _meta, data } envelope. Sorted/stable for git diffs.
 *
 *  Safety: if `currentEntryCount` is provided AND the new payload has fewer
 *  entries than the existing file by more than 5%, the write is rejected
 *  unless `force` is true. Parsing failures shouldn't silently wipe data. */
function writePrecursorJson(name, data, opts = {}) {
  const fp = path.join(PRECURSORS_DIR, `${name}.json`);
  let oldCount = 0;
  let existing = null;
  if (fs.existsSync(fp)) {
    try {
      existing = JSON.parse(fs.readFileSync(fp, 'utf8'));
      oldCount = countEntries(existing.data);
    } catch (_) { /* ignore */ }
  }

  // Merge with existing categories that the current scraper doesn't cover.
  // Scrapers typically only handle the 4 main per-category Wikipedia pages
  // (e.g. Drama Desk Outstanding Musical / Play / Revival Musical / Revival
  // Play). Baseline files often include additional categories (Direction,
  // Choreography, Performance, etc.) that were hand-curated. Without this
  // merge, every scraper run wiped those categories.
  // For array-valued payloads (Pulitzer), preserve entries by year that
  // aren't in the new write.
  let mergedData = data;
  if (existing && existing.data) {
    if (Array.isArray(data) && Array.isArray(existing.data)) {
      const newYears = new Set(data.map((e) => e.year));
      const preserved = existing.data.filter((e) => !newYears.has(e.year));
      mergedData = [...data, ...preserved].sort((a, b) => (a.year || 0) - (b.year || 0));
    } else if (!Array.isArray(data) && typeof data === 'object' && data !== null) {
      mergedData = { ...existing.data, ...data };
    }
  }

  const newCount = countEntries(mergedData);
  const shrink = oldCount > 0 ? (oldCount - newCount) / oldCount : 0;
  if (shrink > 0.05 && !opts.force) {
    throw new Error(
      `Refusing to write ${name}.json: entry count would shrink ${oldCount} → ${newCount} ` +
      `(${(shrink * 100).toFixed(1)}% drop). Use --force to override.`
    );
  }
  const out = {
    _meta: {
      source: 'Wikipedia',
      scrapedAt: new Date().toISOString(),
      ...opts.meta,
    },
    data: mergedData,
  };
  if (opts.dryRun) {
    console.log(`[dry-run] would write ${fp} (${newCount} entries, was ${oldCount})`);
    return { fp, newCount, oldCount, written: false };
  }
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(out, null, 2) + '\n');
  return { fp, newCount, oldCount, written: true };
}

function countEntries(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    return Object.values(data).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  }
  return 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  fetchWikitext,
  cleanWikiText,
  extractTables,
  splitRows,
  rowIsWinner,
  extractYear,
  extractItalicTitles,
  normalizeForCompare,
  writePrecursorJson,
  sleep,
  RATE_LIMIT_MS,
  PRECURSORS_DIR,
};
