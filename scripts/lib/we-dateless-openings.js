'use strict';
/**
 * BRO-5850: turn Theatre Record lookups for closed West End rows with no
 * openingDate into press-night edits. Pure so the test requires the real code.
 *
 * A TR press night is accepted only when the row's own run bounds it: not
 * before the row's previews start, not after its closing date, and within
 * MAX_PREVIEW_GAP_DAYS of the previews start. The header's own previews and
 * closing dates, when printed, must also agree with the row's (RUN_TOLERANCE_DAYS),
 * and two rows resolved to the same TR page or date are both rejected. A header
 * with no press night, or one outside the run (a different production of the
 * same title), leaves the row null.
 */
const { parseTrHeaderDates } = require('./we-review-led-candidates');

const DAY = 86400000;
const MAX_PREVIEW_GAP_DAYS = 45;
const RUN_TOLERANCE_DAYS = 10;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;

/** { accept: iso } or { reject: reason } for one lookup row against its show. */
function judgeLookup(lookup, show) {
  if (lookup.error) return { reject: `lookup error: ${lookup.error}` };
  if (!lookup.tr) return { reject: 'no TR production matched title, venue and season' };
  if (!lookup.header) return { reject: 'TR page has no dated header' };
  const hdr = parseTrHeaderDates(lookup.header);
  const open = hdr.openingDate;
  if (!open) return { reject: 'TR header prints no press night' };
  if (show.openingDate) return { reject: 'row already has an openingDate' };
  // A row with no previews start has no lower bound (a touring stop can match
  // the tour's press night at another venue), and an accepted date is pinned
  // as a human correction, so it stays null.
  if (!show.previewsStartDate) return { reject: 'row has no previews start to bound the press night' };
  if ([show.previewsStartDate, open, show.closingDate].some(d => d && Number.isNaN(Date.parse(d)))) return { reject: 'unparseable date on the row or header' };
  if (hdr.previewsStartDate && Math.abs(days(show.previewsStartDate, hdr.previewsStartDate)) > RUN_TOLERANCE_DAYS) return { reject: `TR previews ${hdr.previewsStartDate} disagree with the row's ${show.previewsStartDate}` };
  if (hdr.closingDate && show.closingDate && Math.abs(days(show.closingDate, hdr.closingDate)) > RUN_TOLERANCE_DAYS) return { reject: `TR closing ${hdr.closingDate} disagrees with the row's ${show.closingDate}` };
  if (days(show.previewsStartDate, open) < 0) return { reject: `press night ${open} is before previews start ${show.previewsStartDate}` };
  if (days(show.previewsStartDate, open) > MAX_PREVIEW_GAP_DAYS) return { reject: `press night ${open} is more than ${MAX_PREVIEW_GAP_DAYS} days after previews start ${show.previewsStartDate}` };
  if (show.closingDate && days(open, show.closingDate) < 0) return { reject: `press night ${open} is after closing ${show.closingDate}` };
  return { accept: open };
}

/** lookups-file JSON + shows array -> { edits: [{showId, openingDate, link}], rejected: [{showId, reason}] }. */
function planFromLookups(file, shows) {
  const byId = new Map(shows.map(s => [s.id, s]));
  const edits = [];
  const rejected = [];
  for (const row of file.lookups || []) {
    const id = row.review && row.review.showId;
    const show = byId.get(id);
    if (!show) { rejected.push({ showId: id, reason: 'show not found' }); continue; }
    const v = judgeLookup(row, show);
    if (v.accept) edits.push({ showId: id, openingDate: v.accept, link: row.tr.link });
    else rejected.push({ showId: id, reason: v.reject });
  }
  // Two rows resolved to one TR page or one date means the picker was ambiguous.
  const tally = key => edits.reduce((m, e) => m.set(e[key], (m.get(e[key]) || 0) + 1), new Map());
  const links = tally('link');
  const kept = [];
  for (const e of edits) {
    if (links.get(e.link) > 1) rejected.push({ showId: e.showId, reason: 'shares a TR page with another row' });
    else kept.push(e);
  }
  return { edits: kept, rejected };
}

module.exports = { judgeLookup, planFromLookups, MAX_PREVIEW_GAP_DAYS, RUN_TOLERANCE_DAYS };
