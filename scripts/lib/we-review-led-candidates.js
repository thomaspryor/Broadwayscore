'use strict';

/**
 * WE historical backfill: review-led candidates (BRO-5031).
 *
 * discover-historical-shows-we.js builds candidates only from WhatsOnStage
 * listings. When WOS reviewed a West End production but never listed it
 * (Company at the Gielgud 2018, the NT's Antony and Cleopatra, the Pinter at
 * the Pinter season), the review lands in the candidates file's
 * `unlistedReviews` and nothing ever promotes it.
 *
 * This module turns those reviews into dated candidates using Theatre Record:
 *   1. selectLookups(): which unlisted reviews are worth a TR lookup (London
 *      market only, West End venue, in season, not a concert or screening).
 *   2. pickTrForReview(): which TR search result is the reviewed production
 *      (title + same venue family + TR issue month near the review).
 *   3. parseTrHeaderDates(): the run dates printed on TR's production page.
 *   4. buildReviewLedCandidates(): candidate rows with decisions, deduped
 *      against shows.json, in the same shape discovery writes.
 *
 * Dates come ONLY from Theatre Record. The review's own date is used to pick
 * which TR production is the reviewed one, never as a show date: reviews land
 * weeks after a first preview, and a press-night guess from a review date
 * would put the date guards' window in the wrong place.
 *
 * The TR lookup itself needs a TR login (GitHub secret), so it runs in CI
 * (scripts/resolve-we-unlisted-tr.js, we-historical-tr-resolve.yml) and saves
 * raw search results and header text to
 * data/audit/we-historical-review-led-<season>.json. Everything here is pure
 * and runs locally against that file.
 */

// venue-write-guard-ok: venues here are audit-log and candidate fields; shows.json gets the venue only through sanitizeVenueForWrite in promote-historical-we.js buildShowEntry.
const { titlesMatch } = require('./title-normalization');
const { normalizeTitle } = require('./title-match');
const { venuesMatch } = require('./deduplication');
const { isWestEndVenue } = require('./venue-classification');
const { isDateInSeason, getSeasonForDate } = require('./we-seasons');
const { venueFamily, decideWeHistoricalPromotion } = require('./we-historical-corroboration');
const { archiveMonth, monthIndex } = require('./tr-production-pick');
const { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle } = require('./venue-title-dedup-pool');

const DAY_MS = 86400000;
const WOS_LONDON_MARKET = 83;

// Reviewed, but not a play or musical run: concerts, screenings, magic and
// variety bills. (Panto and kids' shows go through the approvals file after
// the hand check; their titles say nothing.)
const NON_THEATRE_TITLE = /\b(in concert|concert|on screen|live on screen|screening|gala)\b|\billusionists\b|\bderren brown\b/i;

/**
 * "”The Doctor”" → "The Doctor". Theatre Record files a leading article
 * after the title ("Lehman Trilogy (The)", "Birthday Party, The"); put it back
 * in front so the row's title and id match every other source (BRO-5851).
 */
function cleanReviewTitle(title) {
  const t = String(title || '').replace(/[“”„"]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?)(?:,?\s*\((The|A|An)\)|,\s*(The|A|An))$/);
  return m ? `${m[2] || m[3]} ${m[1]}` : t;
}

const sameVenueFamily = (a, b) => !!a && !!b && (venuesMatch(a, b) || venueFamily(a) === venueFamily(b));

/**
 * Unlisted reviews worth a TR lookup, one per title + venue family.
 * WOS tags each review post with markets; Edinburgh's Royal Lyceum reviews
 * ("Red Dust Road at the Lyceum Theatre") carry no London tag, and the
 * Lyceum name alone passes isWestEndVenue.
 * @returns {{lookups: Array, dropped: Array<{title: string, reason: string}>}}
 */
function selectLookups(unlistedReviews, season) {
  const lookups = [];
  const dropped = [];
  for (const r of unlistedReviews || []) {
    const title = cleanReviewTitle(r.title);
    const drop = reason => dropped.push({ title, venue: r.venue, reason });
    if (!Array.isArray(r.market) || !r.market.includes(WOS_LONDON_MARKET)) { drop('WOS review not tagged London'); continue; }
    if (!r.venue || !isWestEndVenue(r.venue)) { drop('not a West End venue'); continue; }
    if (!r.date || !isDateInSeason(r.date, season)) { drop('review outside season'); continue; }
    if (NON_THEATRE_TITLE.test(title)) { drop('concert/screening/magic title'); continue; }
    if (lookups.some(l => normalizeTitle(l.title) === normalizeTitle(title) && sameVenueFamily(l.venue, r.venue))) { drop('duplicate review'); continue; }
    lookups.push({ title, venue: r.venue, date: r.date, url: r.url });
  }
  return { lookups, dropped };
}

/**
 * TR link → months since year 0. HTML-era links carry the issue month
 * (/archive/2024/10/16980-oedipus). PDF-era links carry volume and issue
 * (/archive/volume/39/dest/22_dear_evan_hansen): volume 1 is 1981, and
 * there are 26 fortnightly issues a year, so issue N is about month
 * N × 12 / 26. Checked on real links: Dear Evan Hansen (opened 2019-11-19)
 * is 39/22, A Taste of Honey (Trafalgar, 2019-10) 39/21-23.
 */
function trIssueMonth(link) {
  const r = trIssueMonthRange(link);
  return r && r.lo === r.hi ? r.lo : null;
}

/**
 * TR link → { lo, hi } month indices it can belong to, or null. Page-numbered
 * PDF-era links (/archive/volume/38/page/924, the 2018 volume) carry only the
 * volume year, so they span that whole year: The Height of the Storm
 * (Wyndham's, Oct 2018) is 38/page/924 and The Cane (Royal Court, Dec 2018)
 * 38/page/1132 (BRO-5031). The title + London venue family + year still pin
 * the production; its dates come from the TR header, never from this.
 */
function trIssueMonthRange(link) {
  const html = archiveMonth(link);
  if (html != null) return { lo: html, hi: html };
  const s = String(link || '');
  const m = s.match(/\/archive\/volume\/(\d+)\/dest\/(\d+)_/);
  if (m) {
    const year = 1980 + Number(m[1]);
    const issue = Number(m[2]);
    if (!(issue >= 1 && issue <= 27)) return null;
    const mi = year * 12 + Math.min(11, Math.floor(((issue - 1) * 12) / 26));
    return { lo: mi, hi: mi };
  }
  const p = s.match(/\/archive\/volume\/(\d+)\/page\/\d+/);
  if (!p) return null;
  const year = 1980 + Number(p[1]);
  return { lo: year * 12, hi: year * 12 + 11 };
}


/**
 * The TR search result that is the reviewed production, or null.
 * Needs: title match, London venue, the review's venue family, and a TR issue
 * from 3 months before to 1 month after the review (reviews follow press
 * night; PDF-era issue months are approximate). Closest issue wins.
 * @param {Array<{title: string, venue: string, link: string}>} results
 * @param {{title: string, venue: string, date: string}} review
 * @param {{isLondonVenue: (v: string, context: {pdfEra: boolean}) => boolean}} opts
 */
function pickTrForReview(results, review, opts = {}) {
  const { isLondonVenue = () => true } = opts;
  const rm = monthIndex(review.date);
  if (rm == null) return null;
  const hits = (results || [])
    .filter(r => r && titlesMatch(r.title, review.title))
    .filter(r => isLondonVenue(r.venue, { pdfEra: /\/volume\//.test(r.link || '') }) && (sameVenueFamily(trVenueName(r.venue), review.venue) || (review.source === 'tr-az' && !review.venue)))
    .map(r => ({ r, m: trIssueMonthRange(r.link) }))
    .filter(x => x.m != null && x.m.hi >= rm - 3 && x.m.lo <= rm + 1)
    .map(x => ({ r: x.r, d: rm < x.m.lo ? x.m.lo - rm : rm > x.m.hi ? rm - x.m.hi : 0, w: x.m.hi - x.m.lo }))
    .sort((a, b) => a.d - b.d || a.w - b.w);
  if (!hits.length) return null;
  // Two different productions equally close (e.g. two page links in one
  // volume year) cannot be told apart, so neither one's dates are used.
  if (hits.length > 1 && hits[1].d === hits[0].d && hits[1].w === hits[0].w && hits[1].r.link !== hits[0].r.link) return null;
  return hits[0].r;
}

/**
 * "Gielgud Theatre, London" → "Gielgud Theatre"; PDF-era "London, Old Vic" →
 * "Old Vic"; "Olivier, National Theatre, London" kept whole for venueFamily.
 */
function trVenueName(v) {
  const s = String(v || '')
    .replace(/^\s*London\s*,\s*/i, '')
    .replace(/,?\s*London(\s+[A-Z]{1,2}\d+\w*)?\s*$/i, '').trim();
  return /national theatre|lyttelton|dorfman|olivier/i.test(s) ? s : s.replace(/,.*$/, '').trim();
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DASH = '\\s*(?:[–—-]|to|until)\\s*';

function iso(y, mon, d) {
  const m = MONTHS[String(mon).slice(0, 3).toLowerCase()];
  const yy = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  if (!m || !(Number(d) >= 1 && Number(d) <= 31) || !(yy >= 1981 && yy <= 2100)) return null;
  const s = `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

const DATE_RX = new RegExp(`\\d{1,2}\\s+${MON}`, 'i');

const SNIP_D = `\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}`;
const SNIP_DAY = '(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?\\s+)?';
const SNIP_SEP = '\\s*(?:[–—-]|to)\\s*';
const SNIP_RX = new RegExp([
  // A label may run straight into a range ("Opened 17 Oct 2018 – 30 Mar 2019"):
  // keep the range end with it, or the close date is lost.
  `\\b(?:previews?|first preview|opened|opening night|opening|press night|press|until|closes|closing|ends|final performance)\\b\\s*(?:on|from|:)?\\s*${SNIP_DAY}${SNIP_D}(?:\\s+\\d{4})?(?:${SNIP_SEP}${SNIP_DAY}${SNIP_D}\\s+\\d{4})?`,
  `${SNIP_DAY}${SNIP_D}(?:\\s+\\d{4})?${SNIP_SEP}${SNIP_DAY}${SNIP_D}\\s+\\d{4}`,
  `\\b\\d{1,2}${SNIP_SEP}${SNIP_D}\\s+\\d{4}`,
].join('|'), 'gi');

/**
 * The date phrases in one line ("Previews from 26 Sep 2018",
 * "26 September 2018 – 30 March 2019"), and nothing around them.
 */
function dateSnippets(line) {
  return (String(line || '').match(SNIP_RX) || []).map(s => s.replace(/\s+/g, ' ').trim());
}

/**
 * The factual part of a TR production header: the title line, then only the
 * date phrases found in the lines after it. The lookup file is public, so no
 * other text is kept: on a two-column PDF page any line can be review prose.
 * Venue and author are not needed (the venue comes from the search result).
 */
/** Genres inferred from an A-Z title, so the non-theatre gate still fires for rows with no WOS genre. */
function azTitleGenres(title) {
  const t = String(title || '');
  if (/\b(ENO|OPERA|OPERATTA|ROYAL BALLET|BALLET)\b/i.test(t)) return ['opera'];
  if (/\b(IMPROVISED|IMPROV|PANTO|PANTOMIME|CONCERT|IN CONCERT|GRUFFALO|STAND-?UP)\b/i.test(t)) return ['children'];
  return [];
}

function headerFacts(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const keep = [];
  lines.forEach((l, i) => {
    if (i === 0 && l.length <= 120 && !DATE_RX.test(l)) keep.push(l);
    else for (const s of dateSnippets(l)) if (!keep.includes(s)) keep.push(s);
  });
  return keep.slice(0, 12).join('\n') || null;
}

/**
 * Run dates from a TR production header (HTML page header or the PDF block
 * under the production's title). Labelled dates win over a bare range:
 *   "Previews from 26 Sep 2018" / "Opened 17 October 2018" / "Press night: …"
 *   "Until 22 Dec 2018" / "Closes 5 Jan 2019"
 *   "26 September 2018 – 30 March 2019"   run (first → last performance)
 *   "26 September – 22 December 2018"     same, year given once
 *   "1 – 22 December 2018"                same, month given once
 * A range is read within one line only. Returns nulls for what it can't
 * find; never guesses.
 * @returns {{previewsStartDate: string|null, openingDate: string|null, closingDate: string|null}}
 */
function parseTrHeaderDates(text) {
  const t = String(text || '').replace(/ /g, ' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  const out = { previewsStartDate: null, openingDate: null, closingDate: null };
  const D = `(\\d{1,2})[ \\t]+${MON}`;
  const SEP = '[ \\t]*(?:[–—-]|to)[ \\t]*';
  const DAY = '(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?[ \\t]+)?';
  let range = null;
  let m;
  if ((m = t.match(new RegExp(`${DAY}${D}[ \\t]+(\\d{4})${SEP}${DAY}${D}[ \\t]+(\\d{4})`, 'i')))) {
    range = { start: iso(m[3], m[2], m[1]), end: iso(m[6], m[5], m[4]) };
  } else if ((m = t.match(new RegExp(`${DAY}${D}${SEP}${DAY}${D}[ \\t]+(\\d{4})`, 'i')))) {
    const endYear = Number(m[5]);
    const startYear = MONTHS[m[2].slice(0, 3).toLowerCase()] > MONTHS[m[4].slice(0, 3).toLowerCase()] ? endYear - 1 : endYear;
    range = { start: iso(startYear, m[2], m[1]), end: iso(endYear, m[4], m[3]) };
  } else if ((m = t.match(new RegExp(`(?:^|[^\\d])(\\d{1,2})${SEP}${D}[ \\t]+(\\d{4})`, 'i')))) {
    range = { start: iso(m[4], m[3], m[1]), end: iso(m[4], m[3], m[2]) };
  }
  const label = (rx) => {
    const x = t.match(new RegExp(`\\b(?:${rx})\\b[ \\t]*(?:on|from|:)?[ \\t]*${DAY}${D}(?:[ \\t]+(\\d{4}))?`, 'i'));
    return x ? { d: x[1], mon: x[2], y: x[3] || null } : null;
  };
  const yearFor = (x, fallback) => x.y || fallback;
  const fallbackYear = (range?.start || range?.end || '').slice(0, 4) || null;
  const previews = label('previews?|first preview');
  const opened = label('opened|opening night|opening|press night|press');
  const closes = label('until|closes|closing|ends|final performance');
  if (previews && yearFor(previews, fallbackYear)) out.previewsStartDate = iso(yearFor(previews, fallbackYear), previews.mon, previews.d);
  if (opened && yearFor(opened, fallbackYear)) out.openingDate = iso(yearFor(opened, fallbackYear), opened.mon, opened.d);
  if (closes && closes.y) out.closingDate = iso(closes.y, closes.mon, closes.d);
  if (range) {
    // A range starting on press night is the press-night-to-close run, not
    // the first preview.
    if (!out.previewsStartDate && range.start && range.start !== out.openingDate) out.previewsStartDate = range.start;
    if (!out.closingDate) out.closingDate = range.end;
  }
  // Yearless press night in a run spanning New Year falls after the first preview.
  if (opened && !opened.y && out.openingDate && out.previewsStartDate && out.openingDate < out.previewsStartDate) {
    out.openingDate = iso(Number(out.openingDate.slice(0, 4)) + 1, opened.mon, opened.d);
  }
  const start = out.previewsStartDate || out.openingDate;
  if (out.closingDate && start && out.closingDate < start) out.closingDate = null;
  if (out.openingDate && ((out.previewsStartDate && out.openingDate < out.previewsStartDate) || (out.closingDate && out.openingDate > out.closingDate))) out.openingDate = null;
  return out;
}

/**
 * Is a candidate start inside an existing London row's run (a reopening or a
 * re-review of a continuing production, e.g. Phantom at Her Majesty's 2021)?
 * Title-only: venues get renamed (Her → His Majesty's).
 */
function findContinuingRun(shows, title, startDate) {
  const start = Date.parse(startDate);
  if (Number.isNaN(start)) return null;
  return shows.find(s => s.market === 'west-end' && normalizeTitle(s.title) === normalizeTitle(title) && (() => {
    const sStart = Date.parse(s.previewsStartDate || s.openingDate || '');
    if (Number.isNaN(sStart) || sStart >= start - 7 * DAY_MS) return false;
    const sEnd = Date.parse(s.closingDate || '');
    if (Number.isNaN(sEnd)) return s.status !== 'closed';
    return sEnd + 30 * DAY_MS >= start;
  })()) || null;
}

/**
 * WOS files NT reviews under "National Theatre"; shows.json names the stage
 * ("Lyttelton Theatre"), which TR's venue carries ("National Theatre -
 * Lyttelton Theatre, London", "London, Olivier, National Theatre").
 */
function ntStageVenue(reviewVenue, trVenue) {
  if (!/\bnational\b/i.test(reviewVenue || '')) return null;
  const m = String(trVenue || '').match(/\b(Olivier|Lyttelton|Dorfman)\b/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} Theatre` : null;
}

/** London theatres went dark the evening of 16 March 2020. */
const LONDON_COVID_DARK = '2020-03-16';

/**
 * Lookup rows (from the CI resolver) → candidates with decisions.
 * @param {{season: string, lookups: Array<{review: object, tr?: object|null, header?: string|null, error?: string}>,
 *          shows: Array, today?: string}} input
 */
function buildReviewLedCandidates({ season, lookups, shows, today }) {
  const pool = buildVenueTitlePool(shows);
  const westEndIds = new Set(shows.filter(s => s.market === 'west-end').map(s => s.id));
  const candidates = [];
  for (const row of lookups || []) {
    const review = row.review || {};
    const base = {
      title: cleanReviewTitle(row.tr?.title && /[a-z]/.test(row.tr.title) ? row.tr.title : review.title),
      // an A-Z row from the 2015 layout has no venue of its own: the TR production page supplies it (BRO-6298)
      venue: ntStageVenue(review.venue, row.tr?.venue) || review.venue
        || (review.source === 'tr-az' && row.tr ? trVenueName(row.tr.venue) : null),
      // an A-Z row has no WOS genre; opera, kids' and improv titles are screened out by title instead
      genres: review.source === 'tr-az' ? azTitleGenres(review.title) : [],
      season,
      // an A-Z row (BRO-6298) is a listing in Theatre Record's own A-Z of London productions, not a WOS review
      signals: [review.source === 'tr-az' ? 'tr-az' : 'wos-review'],
      origin: 'review-led',
      sourceUrls: { wosReview: review.url, ...(row.tr?.link ? { theatreRecord: row.tr.link } : {}) },
    };
    const no = reason => candidates.push({ ...base, previewsStartDate: null, openingDate: null, closingDate: null,
      inShowsJson: null, decision: { promotable: false, persistent: false, reason } });
    if (!row.tr) { no(row.error || 'no Theatre Record production matched'); continue; }
    const dates = parseTrHeaderDates(row.header);
    if (!dates.previewsStartDate && !dates.openingDate) { no('no dates on the Theatre Record production page'); continue; }
    if (isIssuePeriod(dates)) { no('Theatre Record issue period, not a run'); continue; }
    const c = { ...base, ...dates };
    const startDate = c.previewsStartDate || c.openingDate;
    // A page link spans its whole volume year, so a same-title production
    // that began after this review can tie on month distance (BRO-5031).
    if (Number.isNaN(Date.parse(startDate)) || (c.closingDate && Number.isNaN(Date.parse(c.closingDate)))) {
      no('unreadable Theatre Record date'); continue;
    }
    if (review.date && Date.parse(startDate) > Date.parse(review.date) + 14 * DAY_MS) {
      no('Theatre Record production starts after the review'); continue;
    }
    // ...and one that had already closed is an earlier production.
    if (review.date && c.closingDate && Date.parse(review.date) > Date.parse(c.closingDate) + 30 * DAY_MS) {
      no('Theatre Record production closed before the review'); continue;
    }
    // A run that began in the late summer before its first review belongs to
    // the season it started in; no other season's lookups will ever see it.
    // Same date decideWeHistoricalPromotion() checks: press night first.
    const seasonDate = c.openingDate || c.previewsStartDate;
    if (!isDateInSeason(seasonDate, season)) {
      const startSeason = getSeasonForDate(seasonDate);
      if (startSeason && Number(startSeason.slice(0, 4)) === Number(season.slice(0, 4)) - 1) c.season = startSeason;
    }
    // TR prints the scheduled close; London theatres went dark on 16 March
    // 2020, so a run that straddles it ended then (as the WE rows in
    // shows.json are dated).
    if (startDate < LONDON_COVID_DARK && c.closingDate > LONDON_COVID_DARK) {
      c.scheduledClosingDate = c.closingDate;
      c.closingDate = LONDON_COVID_DARK;
    }
    const dupOpts = { withinYears: 1, startDate, venueEquals: sameVenueFamily };
    const existing = findExactDuplicate(pool, c.title, c.venue, dupOpts)
      || pool.find(s => s.startDate && westEndIds.has(s.id) && normalizeTitle(s.title) === normalizeTitle(c.title)
        && Math.abs(Date.parse(s.startDate) - Date.parse(startDate)) <= 7 * DAY_MS)
      || findContinuingRun(shows, c.title, startDate);
    const subtitleOf = !existing && findSubtitleDuplicateTitle(pool, c.title, c.venue, dupOpts);
    c.inShowsJson = existing ? (existing.id || existing.title) : (subtitleOf || null);
    c.decision = c.inShowsJson
      ? { promotable: false, persistent: true, reason: `already in shows.json: ${c.inShowsJson}` }
      : decideWeHistoricalPromotion(c, { today });
    candidates.push(c);
  }
  return candidates;
}

/**
 * True for a bare range that is one TR issue (a whole calendar month, or its
 * first or second half) with no press night: the 2018 TR PDFs print "Issue
 * 17-18 Openings 1-30 September 2018" beside each title, and that banner read
 * as a run (Antony and Cleopatra, NT 2018, ran 18 Sep 2018 to 19 Jan 2019;
 * BRO-5031). Single issues cover half a month.
 */
function isIssuePeriod(d) {
  if (!d || d.openingDate || !d.previewsStartDate || !d.closingDate) return false;
  const [y, m, from] = d.previewsStartDate.split('-').map(Number);
  const [y2, m2, to] = d.closingDate.split('-').map(Number);
  if (y2 !== y || m2 !== m) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (from === 1 && (to === last || to === 14 || to === 15))
    || ((from === 15 || from === 16) && to === last);
}

/** Where the CI resolver saves TR lookups for a season. */
function reviewLedPath(root, season) {
  return require('path').join(root, 'data', 'audit', `we-historical-review-led-${season}.json`);
}

module.exports = {
  NON_THEATRE_TITLE,
  reviewLedPath,
  cleanReviewTitle,
  selectLookups,
  trIssueMonth,
  trIssueMonthRange,
  isIssuePeriod,
  trVenueName,
  pickTrForReview,
  parseTrHeaderDates,
  headerFacts,
  azTitleGenres,
  dateSnippets,
  findContinuingRun,
  buildReviewLedCandidates,
};
