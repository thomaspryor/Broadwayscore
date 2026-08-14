'use strict';

/**
 * Playbill Broadway schedule scraper + parser.
 *
 * Mirrors scripts/lib/playbill-ob-schedule.js for Off-Broadway, but targets
 * Playbill's "Schedule of Upcoming and Announced Broadway Shows" article.
 * Unlike the OB article (bullet-point venue, positional heuristic), the
 * Broadway article labels every field explicitly (`Theatre:`, `First
 * Preview:`, `Opening:`), so parsing is line-prefix matching, not a
 * positional guess.
 *
 * The article has three tiers, in document order:
 *   1. Dated productions — Theatre + First Preview (+ Opening once confirmed)
 *   2. "ANNOUNCED ... WITHOUT CONFIRMED DATE OR VENUE" — partial info only
 *      (e.g. "First Preview: February 2027", no day, sometimes no venue)
 *   3. "IN THE WORKS" — speculative titles with a Creative Team but no dates
 *      or venue at all.
 * Entries from tier 3 carry neither a venue nor any preview-date text, so
 * they're dropped automatically — no separate boundary detection needed.
 *
 * Functions exported:
 *   - parsePlaybillBroadwaySchedule(html) → [{ title, url, venue, firstPreview,
 *       firstPreviewApprox, opening, source }]
 *   - scrapePlaybillBroadwayData()        → same shape; performs the fetch
 *   - checkSilentRot(entries, html)       → side-effect: process.exitCode=1 if rot detected
 */

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./scraper');

const PLAYBILL_BROADWAY_URL = 'https://playbill.com/article/schedule-of-upcoming-and-announced-broadway-shows';
const LAST_SUCCESS_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'playbill-broadway-last-success.json');
const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SILENT_ROT_HTML_THRESHOLD = 5000;

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07',
  aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:rsquo;|#8217;)/gi, '’')
    .replace(/&(?:lsquo;|#8216;)/gi, '‘')
    .replace(/&(?:mdash;|#8212;)/gi, '—')
    .replace(/&(?:ndash;|#8211;)/gi, '–');
}

// "November 8, 2026" -> "2026-11-08". Requires a day; month-only text
// ("February 2027") deliberately does not match — that's the caller's
// firstPreviewApprox path.
function parseUSDate(text) {
  if (!text) return null;
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),\s*(\d{4})/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = m[2].padStart(2, '0');
  const y = parseInt(m[3], 10);
  const currentYear = new Date().getFullYear();
  if (y < currentYear - 5 || y > currentYear + 5) return null;
  return `${m[3]}-${month}-${day}`;
}

function validatePageTitle(html, expectedTitleSubstring) {
  if (!html) return false;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return false;
  return m[1].toLowerCase().includes(expectedTitleSubstring.toLowerCase());
}

/**
 * Parse Playbill's Broadway schedule article into entries:
 *   [{ title, url, venue, firstPreview, firstPreviewApprox, opening, source: 'playbill-broadway' }, ...]
 *
 * Structure: each production is `<a href="URL" ... target="_blank">[<strong>]
 * TITLE[</strong>]</a>` (title in ALL CAPS) followed by `<br>`-separated,
 * explicitly labeled lines up to the next production's anchor.
 */
function parsePlaybillBroadwaySchedule(html) {
  if (html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : null;
    if (pageTitle && /page not found/i.test(pageTitle)) {
      console.warn(`  WARNING: Playbill Broadway schedule page soft-404s ("${pageTitle}") — the page has been removed or moved, not a layout change.`);
      return [];
    }
  }
  if (!validatePageTitle(html, 'Broadway Shows')) {
    console.warn('  WARNING: Playbill Broadway schedule page title did not match — refusing to parse');
    return [];
  }

  const titleRe = /<a\s+href="([^"]+)"[^>]*target="_blank">\s*(?:<strong>)?([A-Z][A-Z0-9 ,&.'’!:\-]{1,90}?)(?:<\/strong>)?\s*<\/a>/g;
  const matches = [];
  let m;
  while ((m = titleRe.exec(html)) !== null) {
    matches.push({ href: m[1], title: decodeEntities(m[2]).trim(), start: m.index, end: m.index + m[0].length });
  }

  const entries = [];
  for (let i = 0; i < matches.length; i++) {
    const { href, title, end } = matches[i];
    const nextStart = matches[i + 1] ? matches[i + 1].start : Math.min(end + 3000, html.length);
    const segment = html.slice(end, nextStart);
    const lines = segment
      .split(/<br\s*\/?>/i)
      .map(l => decodeEntities(l.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    let venue = null, firstPreview = null, firstPreviewApprox = null, opening = null;
    for (const line of lines) {
      let mm;
      if ((mm = line.match(/^Theatre:\s*(.+)/i))) {
        venue = mm[1].trim();
      } else if ((mm = line.match(/^First Previews?:\s*(.+)/i))) {
        firstPreview = parseUSDate(mm[1]);
        if (!firstPreview) firstPreviewApprox = mm[1].trim();
      } else if ((mm = line.match(/^Opening:\s*(.+)/i))) {
        opening = parseUSDate(mm[1]);
      }
    }

    // Tier-3 "IN THE WORKS" entries have neither a venue nor any preview
    // signal — that's the boundary, not a separate section-header check.
    if (!venue && !firstPreview && !firstPreviewApprox) continue;

    entries.push({
      title,
      url: href,
      venue,
      firstPreview,
      firstPreviewApprox,
      opening,
      source: 'playbill-broadway',
    });
  }
  return entries;
}

/**
 * Fetch + parse in one call. Returns [] on fetch failure (logs warning).
 * Does NOT log success — caller decides how to announce.
 */
async function scrapePlaybillBroadwayData() {
  const result = await fetchPage(PLAYBILL_BROADWAY_URL);
  const html = result?.content || '';
  if (!html) {
    console.warn('WARNING: Failed to fetch Playbill Broadway schedule');
    return { entries: [], html: '' };
  }
  const entries = parsePlaybillBroadwaySchedule(html);
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
      console.warn(`WARNING: Failed to write Playbill Broadway last-success timestamp: ${e.message}`);
    }
    return 'ok';
  }

  if (!hasContent) {
    return 'ok';
  }

  let lastSuccessMs = 0;
  try {
    const data = JSON.parse(fs.readFileSync(LAST_SUCCESS_PATH, 'utf8'));
    lastSuccessMs = new Date(data.timestamp).getTime();
  } catch {
    try {
      fs.mkdirSync(path.dirname(LAST_SUCCESS_PATH), { recursive: true });
      fs.writeFileSync(LAST_SUCCESS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), entryCount: 0, firstFailureAt: new Date().toISOString() }, null, 2));
    } catch {}
    console.warn('::warning::Playbill Broadway parser returned 0 entries with full HTML — first observed failure, starting 24h grace window');
    return 'grace';
  }

  const ageMs = Date.now() - lastSuccessMs;
  if (ageMs > GRACE_WINDOW_MS) {
    console.error(`::error::Playbill Broadway parser returned 0 entries for >24h (last success ${new Date(lastSuccessMs).toISOString()}) — likely DOM change. Aborting.`);
    process.exitCode = 1;
    return 'rotted';
  }

  console.warn(`::warning::Playbill Broadway parser returned 0 entries with full HTML — within ${Math.round(GRACE_WINDOW_MS / 3600000)}h grace window (last success ${new Date(lastSuccessMs).toISOString()})`);
  return 'grace';
}

// Playbill's Broadway schedule article renders every title in ALL CAPS.
// Convert to sentence-style title case ("MUCH ADO ABOUT NOTHING" ->
// "Much Ado About Nothing") to match shows.json's existing title convention
// — lowercases minor words (a/an/the/and/...) except the first.
//
// Word-boundary triggers are deliberately narrow: whitespace, `:`, `!`, `-`.
// Apostrophes/curly-quotes are NOT boundaries — "COAL MINER'S DAUGHTER" must
// stay "Coal Miner's Daughter", not "Coal Miner'S Daughter" (the bug an
// earlier version of this function had before /code-review caught it).
const TITLE_CASE_MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'in', 'on', 'at', 'for', 'to', 'from', 'with', 'as', 'by']);
function titleCaseFromAllCaps(title) {
  if (!title || title !== title.toUpperCase()) return title;
  return title
    .toLowerCase()
    .split(' ')
    .map((word, i) => {
      if (i > 0 && TITLE_CASE_MINOR_WORDS.has(word)) return word;
      return word.replace(/(^|[:!-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
    })
    .join(' ');
}

module.exports = {
  PLAYBILL_BROADWAY_URL,
  parsePlaybillBroadwaySchedule,
  scrapePlaybillBroadwayData,
  checkSilentRot,
  parseUSDate,
  titleCaseFromAllCaps,
};
