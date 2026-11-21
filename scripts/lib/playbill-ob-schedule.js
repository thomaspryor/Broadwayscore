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
 *   - parsePlaybillOBSchedule(html) → [{ title, venue, firstPreview, opening, source }]
 *   - scrapePlaybillOBData()        → same shape; performs the fetch
 *   - extractVenue(plain)           → venue string from a tag-stripped block, or null
 *   - checkSilentRot(entries, html) → side-effect: process.exitCode=1 if rot detected
 *
 * Logging note: this lib does NOT log on success — callers handle their own
 * messaging. It only logs on warnings/failures (parser sanity checks).
 */

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./scraper');

const PLAYBILL_OB_URL = 'https://playbill.com/article/schedule-of-upcoming-off-broadway-shows-2';
// Broadway's equivalent announced-schedule article. Broadway discovery never
// read this; it ran off TodayTix, which only lists shows already ON SALE, so
// announced-but-unticketed shows were structurally invisible (owner, 2026-08-13).
const PLAYBILL_BROADWAY_URL = 'https://playbill.com/article/schedule-of-upcoming-and-announced-broadway-shows';
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
  // `(\d{1,2})(?!\d)` — the day must NOT be followed by another digit.
  // Playbill writes month-year-only entries for shows without a firm date
  // ("First Preview: February 2027"). Without the lookahead, \d{1,2} bit the
  // first two digits of the YEAR: "February 2027" parsed as day 20 of Feb in
  // the current year → 2026-02-20, a confidently wrong date in the past for a
  // show that has not been scheduled (Three Days of Rain, 2026-08-13).
  // A month with no day is not a date we have; return null and let the caller
  // show TBA.
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?!\d)(?:,\s*(\d{4}))?/i);
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
 * Extract the venue from a tag-stripped, newline-split show block.
 * Playbill's format puts the venue as the first bullet line after the title:
 *   TITLE
 *   • Classic Stage Company/Lynn F. Angelson Theater
 *   • First Preview: April 30, 2026
 *   • Opening: May 18, 2026
 * Labeled lines (First Preview:, Director:, Cast: …) are skipped; if no
 * unlabeled bullet line exists, returns null and the caller falls back to TBA.
 */
function extractVenue(plain) {
  // Broadway's schedule article labels the venue explicitly on a <br> line
  // ("Theatre: James Earl Jones Theatre") instead of using the Off-Broadway
  // bullet format. Without this branch every Broadway entry parsed with a null
  // venue, which downstream treats as "venue TBA" — a silent quality loss on
  // rows that DO state their theatre (2026-08-13).
  const labelled = plain.match(/^\s*Theatre:\s*(.+?)\s*$/mi);
  if (labelled) {
    const v = labelled[1]
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (v && v.length >= 3 && v.length <= 120) return v;
  }
  for (const raw of plain.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('•')) continue;
    let text = line.replace(/^•\s*/, '');
    // If a missed <br> merged several bullet fields onto one line, keep only
    // the first field — the venue is always the first bullet after the title.
    text = text.split('•')[0];
    text = text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&(?:rsquo;|#8217;)/gi, '’')
      .replace(/&(?:lsquo;|#8216;)/gi, '‘')
      .replace(/\s+/g, ' ').trim();
    // Labeled metadata field — match on known label keywords before the
    // colon rather than "any colon": real venues can contain colons
    // ("A.R.T./New York Theatres: Jeffrey and Paula Gural Theatre").
    const LABEL_RE = /^[^:•]{0,40}\b(preview|opening|opens?|writers?|playwright|book|music|lyrics|director|choreograph\w*|cast|composer|producer|adapt\w*|design\w*|conceived|based on)\b[^:•]{0,20}:/i;
    if (!text || LABEL_RE.test(text)) continue;
    if (text.length < 3 || text.length > 120) continue;
    return text;
  }
  return null;
}

/**
 * Parse Playbill's OB schedule article into entries:
 *   [{ title, venue, firstPreview, opening, source: 'playbill' }, ...]
 *
 * Structure: each show block lives inside one <p>, with <br>-separated lines.
 * Splitting on <strong>...<a>TITLE</a>...</strong> chunks the document.
 */
function parsePlaybillOBSchedule(html, { market = 'Off-Broadway' } = {}) {
  // Distinguish a genuine soft-404 (page removed, HTTP 200 per fetchPage —
  // see memory/feedback_aggregator_soft_404.md) from a real selector/layout
  // change, so a future break here doesn't need the same re-investigation
  // this class of bug took on lortel.org/currently-playing/ (2026-07-22,
  // see scripts/enrich-off-broadway-dates.js parseLortelCurrentlyPlaying).
  if (html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : null;
    if (pageTitle && /page not found/i.test(pageTitle)) {
      console.warn(`  WARNING: Playbill schedule page soft-404s ("${pageTitle}") — the page has been removed or moved, not a layout change.`);
      return [];
    }
  }
  if (!validatePageTitle(html, market)) {
    console.warn(`  WARNING: Playbill ${market} schedule page title did not match — refusing to parse`);
    return [];
  }

  // Playbill wraps schedule titles in TWO different shapes, sometimes on the
  // same page:
  //   <strong><a href=…>TITLE</a></strong>          — bare text in the anchor
  //   <a href=…><strong>TITLE</strong></a>          — title nested inside
  //   <strong><a href=…><strong>TITLE</strong></a></strong>
  // The original regex required bare text ([^<]) directly inside the anchor, so
  // it silently dropped every entry of the second shape. On the Broadway
  // schedule that was most of the article — Wanted, Galileo, 860, Inter Alia
  // and others parsed to nothing while 18 other shows parsed fine, which is
  // exactly the kind of partial success that never trips an "empty result"
  // alarm (owner, 2026-08-13). Match the anchor, then strip inner tags.
  // The emphasis is load-bearing and MUST stay in the pattern. Matching a bare
  // <a> would turn this into an "any link" parser: a linked venue, cast member
  // or production company inside a show's block would end that show's segment
  // and then claim the date lines that follow as its own — silently writing a
  // person's name and someone else's dates into Off-Broadway enrichment, which
  // shares this parser. So require <strong> on one side or the other, which is
  // what distinguishes a schedule title from an in-body link, while accepting
  // either nesting order.
  const titleRe = /(?:<strong>\s*<a[^>]*>\s*(?:<strong>\s*)?([^<]{2,160}?)\s*(?:<\/strong>\s*)?<\/a>|<a[^>]*>\s*<strong>\s*([^<]{2,160}?)\s*<\/strong>\s*<\/a>)/g;
  const titleMatches = [];
  let tm;
  while ((tm = titleRe.exec(html)) !== null) {
    // Two alternation branches, so the title is in whichever group matched.
    titleMatches.push({ title: (tm[1] ?? tm[2] ?? '').trim(), index: tm.index });
  }
  const entries = [];
  for (let i = 0; i < titleMatches.length; i++) {
    const { title, index } = titleMatches[i];
    const nextIndex = titleMatches[i + 1]?.index ?? Math.min(index + 5000, html.length);
    const segment = html.slice(index, nextIndex);
    const plain = segment.replace(/<br[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
    const fpMatch = plain.match(/First Preview[s]?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?!\d)(?:,\s*\d{4})?)/i);
    const openMatch = plain.match(/Open(?:s|ing)?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?!\d)(?:,\s*\d{4})?)/i);
    if (!fpMatch && !openMatch) continue;
    entries.push({
      title,
      venue: extractVenue(plain),
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
async function scrapePlaybillBroadwayData() {
  const result = await fetchPage(PLAYBILL_BROADWAY_URL, { tier: 1 });
  const html = result?.content || '';
  if (!html) {
    console.warn('WARNING: Failed to fetch Playbill Broadway schedule');
    return { entries: [], html: '' };
  }
  // 'Broadway' also matches the Off-Broadway title, so the Broadway article is
  // validated on its full distinctive phrase instead of the bare market word.
  const entries = parsePlaybillOBSchedule(html, { market: 'Announced Broadway' });
  return { entries, html };
}

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
  PLAYBILL_BROADWAY_URL,
  scrapePlaybillBroadwayData,
  extractVenue,
  parsePlaybillOBSchedule,
  scrapePlaybillOBData,
  checkSilentRot,
};
