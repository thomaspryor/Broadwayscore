'use strict';

// Recoupment-timing ground truth (BRO-5073). A show that announced
// recoupment gives the model a dated, running-show test: replay the model on
// the weeks played up to the announcement, with the recoupment hidden, and it
// should read about 100%. Months earlier it should read under 100.
//
//   at-recoup  window ending on the announcement date. Truth [85, 115]:
//              producers announce once cumulative net operating profit has
//              repaid the capitalization, usually within a few weeks of the
//              recouping week (so a hit is a little past 100 by the time it is
//              announced), and the running-show model divides by cap plus a
//              3-week reserve, so it reads a little under 100 at the true
//              recoupment (about 85-95 for a musical whose cap is 30-60 weeks
//              of running cost). 85..115 covers both.
//   26w / 52w  26 and 52 weeks before the window: truth < 100 (the weak
//              bound). Skipped when the show had not started by then.
//
// The announcement date is the recoupedDate (YYYY-MM or YYYY-MM-DD). A
// month-only date is tightened to a day when the cited source names one in
// that month ("Hollywood Reporter (Nov 29, 2011): ..."). The window is the
// two weeks before a day (announcements refer to the books of the prior
// week or two) and the whole month for a month. A year-only date is too
// coarse to test. A show that closed before the window (it recouped
// later, from a tax credit or tour profits) keeps only the earlier
// checkpoints that fall inside its run. The model is scored on the interval between its values at
// the window's two ends: inside when that interval touches the band.
//
// Pure functions; the CLI is scripts/backtest-recoupment-ground-truth.js --timing.

const { truthClassOf, creditBasis } = require('./recoupment-ground-truth');
const { optsWithCapEstimate } = require('./cap-comparables');
const { hasNoInvestorsToRepay } = require('./commercial-designations');

const RECOUP_BAND = [85, 115];
const EARLIER_WEEKS = [26, 52];
const DAY_WINDOW_DAYS = 14;
const DAY_MS = 86400000;
// Fields that say the show recouped. Hidden from the replayed model.
const RECOUP_FIELDS = ['recouped', 'recoupedDate', 'recoupedSource', 'recoupedTruthClass', 'recoupedWeeks', 'modelRecouped'];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SOURCE_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;

const iso = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * The announcement date, as precisely as the record allows.
 * @returns {null | { date: string, precision: 'day'|'month' }}
 */
function announcementDate(comm) {
  const d = comm && typeof comm.recoupedDate === 'string' ? comm.recoupedDate : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: d, precision: 'day' };
  if (!/^\d{4}-\d{2}$/.test(d)) return null;
  for (const m of String(comm.recoupedSource || '').matchAll(SOURCE_DATE)) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const day = Number(m[2]);
    const cand = `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (cand.slice(0, 7) === d && day >= 1 && day <= 31 && !Number.isNaN(Date.parse(cand))) return { date: cand, precision: 'day' };
  }
  return { date: `${d}-01`, precision: 'month' };
}

/** [from, to] ISO dates the announcement may refer to. */
function recoupWindow(ann) {
  if (!ann) return null;
  if (ann.precision === 'day') return [iso(Date.parse(ann.date) - DAY_WINDOW_DAYS * DAY_MS), ann.date];
  const [y, m] = ann.date.split('-').map(Number);
  return [ann.date, iso(Date.UTC(y, m, 0))]; // day 0 of the next month = last day of this one
}

/** A copy of the record with every recoupment field removed. */
function hideRecoupment(comm) {
  const out = { ...comm };
  for (const f of RECOUP_FIELDS) delete out[f];
  return out;
}

/**
 * Checkpoints for one recouped record, or null when it cannot be tested.
 * @returns {null | { truthClass: string, truthClassFrom: string, creditBasis: string, announcement: object, checkpoints: Array<{ label: string, from: string, to: string, lo: number, hi: number }> }}
 */
function timingTruth(comm, show, { lagWeeks = 0 } = {}) {
  if (!comm || comm.recouped !== true || !comm.recoupedSource) return null;
  const announcement = announcementDate(comm);
  const win = recoupWindow(announcement);
  if (!win) return null;
  // lagWeeks (shadow, coordinator 2026-10-11): producers may announce after
  // the show actually recouped. Truth becomes "crossed 100 somewhere in
  // [window start - lag, window end]": at least 85 at the announcement, at
  // most 115 at the lag start, and under 100 the 26/52 weeks before that.
  const lagMs = lagWeeks * 7 * DAY_MS;
  // Recouped after closing (tax credit, tour profits): the announcement is
  // not a running-show test; earlier checkpoints inside the run still are.
  const close = show && show.closingDate ? Date.parse(show.closingDate) : Infinity;
  const afterClose = close < Date.parse(win[0]);
  const start = show && Date.parse(show.previewsStartDate || show.openingDate || '');
  const checkpoints = afterClose ? [] : [{ label: 'at-recoup', from: win[0], to: win[1], lo: RECOUP_BAND[0], hi: lagWeeks > 0 ? Infinity : RECOUP_BAND[1] }];
  const lagStart = Date.parse(win[0]) - lagMs;
  if (lagWeeks > 0 && !afterClose && Number.isFinite(start) && lagStart > start) checkpoints.push({ label: 'lag-start', from: iso(lagStart), to: iso(lagStart), lo: -Infinity, hi: RECOUP_BAND[1] });
  for (const w of EARLIER_WEEKS) {
    const at = lagStart - w * 7 * DAY_MS;
    if (Number.isFinite(start) && at > start && at <= close) checkpoints.push({ label: `${w}w-before`, from: iso(at), to: iso(at), lo: -Infinity, hi: 99.99 });
  }
  if (!checkpoints.length) return null;
  return { ...truthClassOf(comm, 'recouped', comm.recoupedSource), creditBasis: creditBasis(comm, comm.recoupedSource, 'recouped'), announcement, checkpoints };
}

/** Points between the model interval [a, b] and the truth band; 0 when they touch. */
function windowError(a, b, truth) {
  if (typeof a !== 'number' || typeof b !== 'number' || !truth) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi < truth.lo) return truth.lo - hi;
  if (lo > truth.hi) return lo - truth.hi;
  return 0;
}

/**
 * Weekly-history rows for one production up to a date: how many fall in its
 * own run, and how many come from before its first preview (an earlier
 * production sharing the grosses key).
 */
function historyCoverage(weekly, show, asOf) {
  const start = show && (show.previewsStartDate || show.openingDate);
  let own = 0;
  let before = 0;
  for (const d of Object.keys(weekly || {})) {
    if (d > asOf) continue;
    if (start && Date.parse(d) < Date.parse(start) - 7 * DAY_MS) before++;
    else own++;
  }
  return { own, before };
}

/**
 * The model as it stood on asOf, with the tier it would have had then (a
 * show's run so far, not its eventual length, decides long-run treatment).
 * libs: { classifyTier, calculateRecoupment } from the model under test;
 * opts: shadow options for the new side (--opt).
 * @returns {{ tier: string, result: object|null }}
 */
function modelAt(libs, show, comm, lookup, asOf, opts = {}) {
  const slug = show.slug || show.id;
  const allTime = lookup.getGrossesAllTime(slug, show.id);
  const closing = show.closingDate && show.closingDate < asOf ? show.closingDate : asOf;
  opts = optsWithCapEstimate(opts, show, comm); // shadow, BRO-5849
  const tier = libs.classifyTier({ ...show, closingDate: closing }, comm, allTime, opts);
  if (tier !== 'weekly-model') return { tier, result: null };
  const result = libs.calculateRecoupment(show, comm, allTime, lookup.getWeeklyData(slug, show.id), { ...opts, asOf });
  if (!result || result.error) return { tier: 'ai-estimated', result: null };
  return { tier, result };
}

/**
 * Would the site have shown the model bar on that date if running-show bars
 * were enabled? Mirrors displaysModel (a running show with a model that is
 * not low quality and not ai-estimated, not a nonprofit) and then
 * modelDisplayGuard with the launch flag on.
 */
function displayableAt({ comm, tier, result, playedWeeks }, guard) {
  if (!result || tier === 'ai-estimated' || !comm || hasNoInvestorsToRepay(comm)) return false;
  // A replay has no cumulative grosses (they cannot be cut at a date), which
  // alone drops a reported-cost record to 'low'; the site had them then.
  const quality = result.dataQuality === 'low' && result.weeklyFixedCostSource === 'reported' ? 'medium' : result.dataQuality;
  if (quality === 'low') return false;
  const pct = [result.recoupmentPctLow, result.recoupmentPctCentral, result.recoupmentPctHigh];
  return guard.modelDisplayGuard({ pct, playedWeeks, independent: guard.independentEstimate(comm), running: true, runningEnabled: true }).show;
}

module.exports = {
  announcementDate, recoupWindow, hideRecoupment, timingTruth, windowError, historyCoverage, modelAt, displayableAt,
  RECOUP_BAND, EARLIER_WEEKS, RECOUP_FIELDS,
};
