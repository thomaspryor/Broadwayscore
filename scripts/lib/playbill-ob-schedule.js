'use strict';

/**
 * Playbill Off-Broadway schedule scraper + parser.
 *
 * Used by:
 *   - scripts/enrich-off-broadway-dates.js  (existing — date enrichment)
 *   - scripts/discover-new-shows.js         (new — show discovery)
 *
 * The scraper hits Playbill's "Schedule of Upcoming Off-Broadway Shows" article,
 * which Playbill maintains as the canonical heads-up for OB openings. The article
 * lists every announced production with first-preview/opening dates and venue.
 *
 * Functions exported:
 *   - parsePlaybillOBSchedule(html) → [{ title, firstPreview, opening, source }]
 *   - scrapePlaybillOBData()        → same shape; performs the fetch
 *   - checkSilentRot(entries, html) → side-effect: process.exitCode=1 if rot detected
 *
 * Logging note: this lib does NOT log on success — callers handle their own
 * messaging. It only logs on warnings/failures (parser sanity checks).
 */

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./scraper');

const PLAYBILL_OB_URL = 'https://playbill.com/article/schedule-of-upcoming-off-broadway-shows-2';
const LAST_SUCCESS_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'playbill-ob-last-success.json');
const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SILENT_ROT_HTML_THRESHOLD = 5000;

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07',
  aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

function parseUSDate(text, defaultYear) {
  if (!text) return null;
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = m[2].padStart(2, '0');
  const year = m[3] || String(defaultYear || new Date().getFullYear());
  if (!month) return null;
  const y = parseInt(year, 10);
  const currentYear = new Date().getFullYear();
  if (y < currentYear - 5 || y > currentYear + 5) return null;
  return `${year}-${month}-${day}`;
}

function validatePageTitle(html, expectedTitleSubstring) {
  if (!html) return false;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return false;
  return m[1].toLowerCase().includes(expectedTitleSubstring.toLowerCase());
}

/**
 * Parse Playbill's OB schedule article into entries:
 *   [{ title, firstPreview, opening, source: 'playbill' }, ...]
 *
 * Structure: each show block lives inside one <p>, with <br>-separated lines.
 * Splitting on <strong>...<a>TITLE</a>...</strong> chunks the document.
 */
function parsePlaybillOBSchedule(html) {
  if (!validatePageTitle(html, 'Off-Broadway')) {
    console.warn('  WARNING: Playbill OB schedule page title did not match — refusing to parse');
    return [];
  }

  const titleRe = /<strong>\s*<a[^>]*>([^<]{2,160})<\/a>\s*<\/strong>/g;
  const titleMatches = [];
  let tm;
  while ((tm = titleRe.exec(html)) !== null) {
    titleMatches.push({ title: tm[1].trim(), index: tm.index });
  }
  const entries = [];
  for (let i = 0; i < titleMatches.length; i++) {
    const { title, index } = titleMatches[i];
    const nextIndex = titleMatches[i + 1]?.index ?? Math.min(index + 5000, html.length);
    const segment = html.slice(index, nextIndex);
    const plain = segment.replace(/<br\s*\/?>(?=)/gi, '\n').replace(/<[^>]+>/g, ' ');
    const fpMatch = plain.match(/First Preview[s]?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    const openMatch = plain.match(/Open(?:s|ing)?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    if (!fpMatch && !openMatch) continue;
    entries.push({
      title,
      firstPreview: fpMatch ? parseUSDate(fpMatch[1]) : null,
      opening: openMatch ? parseUSDate(openMatch[1]) : null,
      source: 'playbill',
    });
  }
  return entries.filter(e => e.firstPreview || e.opening);
}

/**
 * Fetch + parse in one call. Returns [] on fetch failure (logs warning).
 * Does NOT log success — caller decides how to announce.
 */
async function scrapePlaybillOBData() {
  const result = await fetchPage(PLAYBILL_OB_URL, { tier: 1 });
  const html = result?.content || '';
  if (!html) {
    console.warn('WARNING: Failed to fetch Playbill OB schedule');
    return { entries: [], html: '' };
  }
  const entries = parsePlaybillOBSchedule(html);
  return { entries, html };
}

/**
 * Silent-rot guard. Call after a scrape attempt. Updates timestamp on success;
 * exits 1 if 0 entries + non-empty HTML and no successful scrape in 24h.
 *
 * Returns 'ok' | 'grace' | 'rotted'.
 */
function checkSilentRot({ entries, html }) {
  const hasEntries = entries.length > 0;
  const hasContent = html.length >= SILENT_ROT_HTML_THRESHOLD;

  if (hasEntries) {
    try {
      fs.mkdirSync(path.dirname(LAST_SUCCESS_PATH), { recursive: true });
      fs.writeFileSync(LAST_SUCCESS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), entryCount: entries.length }, null, 2));
    } catch (e) {
      console.warn(`WARNING: Failed to write Playbill last-success timestamp: ${e.message}`);
    }
    return 'ok';
  }

  if (!hasContent) {
    // Fetch failure — not a parser rot. Let the caller treat this as transient.
    return 'ok';
  }

  // 0 entries with full HTML — parser potentially rotted.
  let lastSuccessMs = 0;
  try {
    const data = JSON.parse(fs.readFileSync(LAST_SUCCESS_PATH, 'utf8'));
    lastSuccessMs = new Date(data.timestamp).getTime();
  } catch {
    // No record yet — treat as fresh failure (start grace clock now).
    try {
      fs.mkdirSync(path.dirname(LAST_SUCCESS_PATH), { recursive: true });
      fs.writeFileSync(LAST_SUCCESS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), entryCount: 0, firstFailureAt: new Date().toISOString() }, null, 2));
    } catch {}
    console.warn('::warning::Playbill OB parser returned 0 entries with full HTML — first observed failure, starting 24h grace window');
    return 'grace';
  }

  const ageMs = Date.now() - lastSuccessMs;
  if (ageMs > GRACE_WINDOW_MS) {
    console.error(`::error::Playbill OB parser returned 0 entries for >24h (last success ${new Date(lastSuccessMs).toISOString()}) — likely DOM change. Aborting.`);
    process.exitCode = 1;
    return 'rotted';
  }

  console.warn(`::warning::Playbill OB parser returned 0 entries with full HTML — within ${Math.round(GRACE_WINDOW_MS/3600000)}h grace window (last success ${new Date(lastSuccessMs).toISOString()})`);
  return 'grace';
}

module.exports = {
  PLAYBILL_OB_URL,
  parsePlaybillOBSchedule,
  scrapePlaybillOBData,
  checkSilentRot,
};
