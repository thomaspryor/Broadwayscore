'use strict';
/**
 * Start dates for West End historical rows built from WhatsOnStage listings
 * (BRO-5080).
 *
 * A WOS listing with no preview_date carries the FIRST PERFORMANCE in
 * opening_date, not the press night. The backfill stored it as openingDate:
 * a sourced sample audit found 61 of 85 sampled 2018-24 rows showing a first
 * preview as opening night (data/audit/fact-check/we-historical-*).
 *
 * wosStartDates() is the write rule: with no preview date, the WOS date is
 * the first performance; it is written to both fields with the unconfirmed
 * source 'whatsonstage-first-performance' (date-source-confidence.js), the
 * collapsed shape enrich-west-end-dates.js --fix-unconfirmed already corrects
 * from the review cluster.
 *
 * pressNightFromReviewMode() repairs rows already written. Most UK outlets'
 * stored publishDate is the day AFTER press night (measured on the adjudicated
 * sample: WhatsOnStage 36/53, Standard 36/51, Guardian 19/34 on +1), so the
 * press night is the single most common review date minus one day. On the 48
 * sampled rows where it fires it matched the sourced press night on 39.
 *
 * Pure, no I/O (CLAUDE.md §15): scripts/lib/we-historical-dates.test.mjs.
 */

const WOS_FIRST_PERFORMANCE_SOURCE = 'whatsonstage-first-performance';
const MODE_INFERENCE_SOURCE = 'inferred-from-reviews-mode';
// BRO-5851: a first performance kept as openingDate after a sourced search
// found no press night (a transfer or reopening with none, or none on
// record). Still unconfirmed, so a press-night source may overwrite it; the
// season audit accepts it where it refuses WOS_FIRST_PERFORMANCE_SOURCE.
const NO_PRESS_NIGHT_FOUND_SOURCE = 'first-performance-no-press-night-found';
// BRO-6450: a Theatricalia venue history gives the first performance only,
// written collapsed like WOS_FIRST_PERFORMANCE_SOURCE and repaired the same
// way (enrich-west-end-dates.js --fix-unconfirmed, from the review cluster).
const THEATRICALIA_FIRST_PERFORMANCE_SOURCE = 'theatricalia-first-performance';
const DAY_MS = 86400000;
const MAX_PREVIEW_DAYS = 42;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** WOS opening_date when it is a plausible press night after a known first preview, else null. */
function plausibleOpeningDate(l) {
  if (!l.openingDate || !l.previewsStartDate) return null;
  const gapDays = (Date.parse(l.openingDate) - Date.parse(l.previewsStartDate)) / DAY_MS;
  return gapDays > 0 && gapDays <= MAX_PREVIEW_DAYS ? l.openingDate : null;
}

/**
 * The start dates a WOS listing supports.
 * @param {{previewsStartDate?: string|null, openingDate?: string|null}} l
 * @returns {{previewsStartDate: string|null, openingDate: string|null, openingDateSource: string|null}}
 */
function wosStartDates(l) {
  if (!l.previewsStartDate && l.openingDate) {
    return { previewsStartDate: l.openingDate, openingDate: l.openingDate, openingDateSource: WOS_FIRST_PERFORMANCE_SOURCE };
  }
  const opening = plausibleOpeningDate(l);
  return { previewsStartDate: l.previewsStartDate || null, openingDate: opening, openingDateSource: opening ? 'whatsonstage' : null };
}

/**
 * Press night = the single most common review publish date (1-60 days after
 * the first performance) minus one day. Needs >= 3 reviews on that date and
 * no tie for the top, else null: a smeared or thin set is not a press night.
 * @param {string} firstPerformance YYYY-MM-DD
 * @param {Array<{publishDate?: string}>} reviews this show's reviews
 */
function pressNightFromReviewMode(firstPerformance, reviews) {
  const start = Date.parse(firstPerformance);
  if (Number.isNaN(start)) return null;
  const count = new Map();
  for (const r of reviews || []) {
    const d = typeof r.publishDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.publishDate) ? r.publishDate.slice(0, 10) : null;
    if (!d) continue;
    const gap = (Date.parse(d) - start) / DAY_MS;
    if (gap < 1 || gap > 60) continue;
    count.set(d, (count.get(d) || 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!top.length || top[0][1] < 3 || (top[1] && top[1][1] === top[0][1])) return null;
  const press = isoDay(Date.parse(top[0][0]) - DAY_MS);
  // A cluster of same-night reviews lands the minus-one rule on a Sunday (School
  // of Rock: 14 Nov 2016 -> Sunday 13 Nov). No West End press night is on a Sunday.
  return new Date(`${press}T00:00:00Z`).getUTCDay() === 0 ? null : press;
}

/**
 * Repair for a row already written with the first performance as openingDate:
 * we-historical:wos, no previewsStartDate, openingDate from WOS.
 * @returns {Array<{field: string, oldValue: any, newValue: any}>} empty when the row is not in the class
 */
function repairWosOpening(show, reviews) {
  if (!show || show.discoverySource !== 'we-historical:wos') return [];
  if (show.previewsStartDate || !show.openingDate || show.openingDateSource !== 'whatsonstage') return [];
  const first = show.openingDate;
  const press = pressNightFromReviewMode(first, reviews);
  const changes = [{ field: 'previewsStartDate', oldValue: null, newValue: first }];
  if (press && press !== first) {
    changes.push({ field: 'openingDate', oldValue: first, newValue: press });
    changes.push({ field: 'openingDateSource', oldValue: 'whatsonstage', newValue: MODE_INFERENCE_SOURCE });
  } else if (!press) {
    changes.push({ field: 'openingDateSource', oldValue: 'whatsonstage', newValue: WOS_FIRST_PERFORMANCE_SOURCE });
  }
  // press === first: the first performance WAS the press night (no previews); keep 'whatsonstage'.
  return changes;
}

/**
 * Repair for a Theatricalia-built row (BRO-6450): openingDate === previewsStartDate
 * === the first performance, source 'theatricalia-first-performance'. Only a
 * clear review-date mode moves it; with no cluster the row is left alone (the
 * season audit keeps flagging it until a sourced press night or a searched-none
 * marker exists). Never guesses a date.
 * @returns {Array<{field: string, oldValue: any, newValue: any}>} empty when the row is not in the class or no press night is supported
 */
function repairTheatricaliaOpening(show, reviews) {
  if (!show || show.openingDateSource !== THEATRICALIA_FIRST_PERFORMANCE_SOURCE) return [];
  if (!show.openingDate || show.previewsStartDate !== show.openingDate) return [];
  const press = pressNightFromReviewMode(show.openingDate, reviews);
  if (!press || press === show.openingDate) return [];
  return [
    { field: 'openingDate', oldValue: show.openingDate, newValue: press },
    { field: 'openingDateSource', oldValue: THEATRICALIA_FIRST_PERFORMANCE_SOURCE, newValue: MODE_INFERENCE_SOURCE },
  ];
}

module.exports = {
  WOS_FIRST_PERFORMANCE_SOURCE, MODE_INFERENCE_SOURCE, NO_PRESS_NIGHT_FOUND_SOURCE, THEATRICALIA_FIRST_PERFORMANCE_SOURCE,
  plausibleOpeningDate, wosStartDates, pressNightFromReviewMode, repairWosOpening, repairTheatricaliaOpening,
};
