/**
 * Weekly grosses integrity rules (BRO-4988).
 *
 * Every rule is a pure function over data/grosses-history.json (and, where a
 * rule needs it, shows.json). Each returns an array of findings:
 *   { rule, week, slug?, detail }
 * The runner (scripts/check-grosses-integrity.js) runs them after every
 * grosses ingest and reports findings that touch the weeks under check, so
 * the decades of older rows never re-alert every Tuesday.
 *
 * Rules:
 *   week-key-not-sunday   a week key that is not a Sunday
 *   week-missing          a 7-day gap between consecutive recent week keys
 *   week-overdue          the newest stored week is older than the newest
 *                         week the League has published (plus a day's grace)
 *   total-mismatch        stored rows' gross sum or show count differs from
 *                         the published League "Week's Total" saved by the
 *                         scraper in history._meta.weekTotals
 *   show-dropout          a show in last week's data absent this week while
 *                         shows.json does not say it closed
 *   duplicate-gross       the same show's gross identical to the dollar in
 *                         two weeks
 *   flat-gross-run        3+ consecutive weeks within 0.5% of each other
 *                         while capacity is below 99% (a sold-out house
 *                         legitimately grosses the same)
 *   capacity-capped       4+ consecutive weeks at exactly 100% with the same
 *                         attendance: the source capped, the real figure is
 *                         lost (Wicked 2025: 100%/15,408 for 35 weeks)
 *   zero-perf-gross       performances 0 with gross above 0
 *   negative-value        gross, capacity, ATP or attendance below zero.
 *                         Capacity ABOVE 100% is real (standing room) and is
 *                         never flagged or capped: Wicked's 2025 run stored at
 *                         exactly 100% is the defect, not 101.3%.
 *   seats-offered-missing seatsOffered absent on a row with attendance and
 *                         capacity (repair: grosses-history-repair.js)
 *   wow-jump              gross moved more than WOW_RATIO either way week
 *                         over week on two full weeks
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Gross sum within 0.5% (plus $1 per row for rounding) of the published total.
const TOTAL_REL_TOLERANCE = 0.005;
const FLAT_RUN_WEEKS = 3;
const FLAT_RUN_TOLERANCE = 0.005;
const FLAT_RUN_MAX_CAPACITY = 99;
const CAPPED_RUN_WEEKS = 4;
// A show playing 7+ performances both weeks is a full week; a gross moving
// more than this factor between two full weeks is a parsing or matching error
// far more often than a real swing (holiday weeks top out near 1.8x).
const WOW_RATIO = 2.5;
const FULL_WEEK_PERFS = 7;

// Weeks with no League figures, known and accepted: COVID shutdown, and two
// weeks missing from the Playbill archive the history was backfilled from.
// checkMissingWeeks() never reports a week inside these ranges.
const KNOWN_GAPS = [
  ['2014-02-01', '2014-03-31'],
  ['2018-03-01', '2018-04-30'],
  ['2020-03-08', '2021-08-22'],
];
const inKnownGap = (week) => KNOWN_GAPS.some(([from, to]) => week >= from && week <= to);

const isoToMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isRow = (e) => e && typeof e === 'object' && !Array.isArray(e);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isSunday(key) {
  return ISO_DATE_RE.test(key || '') && new Date(isoToMs(key)).getUTCDay() === 0;
}

function sortedWeekKeys(history) {
  return Object.keys(history?.weeks || {}).filter((k) => ISO_DATE_RE.test(k)).sort();
}

/** Week keys that are not Sundays. */
function checkWeekKeys(history) {
  return Object.keys(history?.weeks || {})
    .filter((k) => !isSunday(k))
    .map((k) => ({ rule: 'week-key-not-sunday', week: k, detail: `week key ${k} is not a Sunday` }));
}

/**
 * Gaps between consecutive week keys on or after `since` (YYYY-MM-DD).
 * Before 2020 the history has known holes and 2020-03..2021-09 had no
 * performances, so callers pass a recent `since`.
 */
function checkMissingWeeks(history, { since } = {}) {
  // An off-Sunday key (a BWW-era Monday) still holds its week: count it as
  // that Sunday, or one bad key reads as two defects (key + missing week).
  const keys = [...new Set(sortedWeekKeys(history).map(sundayOf))].filter((k) => !since || k >= since);
  const out = [];
  for (let i = 1; i < keys.length; i++) {
    const gapDays = (isoToMs(keys[i]) - isoToMs(keys[i - 1])) / DAY_MS;
    for (let d = 7; d < gapDays; d += 7) {
      const week = new Date(isoToMs(keys[i - 1]) + d * DAY_MS).toISOString().slice(0, 10);
      if (inKnownGap(week)) continue;
      out.push({ rule: 'week-missing', week, detail: `no history for week ending ${week} (between ${keys[i - 1]} and ${keys[i]})` });
    }
  }
  return out;
}

/** The Sunday a YYYY-MM-DD date belongs to (Mon-Wed: before, Thu-Sat: after). */
function sundayOf(iso) {
  if (!ISO_DATE_RE.test(iso || '')) return iso;
  const dow = new Date(isoToMs(iso)).getUTCDay();
  if (dow === 0) return iso;
  return new Date(isoToMs(iso) + (dow <= 3 ? -dow : 7 - dow) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The newest stored week is behind the newest week already published. Gap
 * checks only see holes between stored weeks, so a scrape that silently
 * stored nothing would otherwise pass. `graceHours` absorbs the source's
 * release lag on the Tuesday run (Wednesday's retry then flags it).
 */
function checkWeekOverdue(history, now, { graceHours = 24 } = {}) {
  const { latestPublishableWeek } = require('./parse-playbill-grosses');
  const keys = sortedWeekKeys(history);
  if (!keys.length || !(now instanceof Date)) return [];
  const newest = sundayOf(keys[keys.length - 1]);
  const due = latestPublishableWeek(new Date(now.getTime() - graceHours * 60 * 60 * 1000));
  if (newest >= due) return [];
  return [{ rule: 'week-overdue', week: due, detail: `week ending ${due} is out but the newest stored week is ${newest}` }];
}

/** The history key holding the week ending `sunday` (itself, or a key within 3 days). */
function historyKeyFor(history, sunday) {
  if (history?.weeks?.[sunday]) return sunday;
  return Object.keys(history?.weeks || {}).find((k) => ISO_DATE_RE.test(k)
    && Math.abs(isoToMs(k) - isoToMs(sunday)) <= 3 * DAY_MS) || null;
}

/**
 * Save the source's published "Week's Total" for a week into
 * history._meta.weekTotals, keyed by the week's Sunday. Called by the
 * scraper beside every history write; a source with no total writes nothing.
 * @param {object} history
 * @param {string} week - YYYY-MM-DD (any day of the week)
 * @param {{ gross?: number|null, showCount?: number|null, source?: string }} total
 * @returns {boolean} whether a total was recorded
 */
function recordPublishedTotal(history, week, { gross = null, showCount = null, source = '' } = {}) {
  if (!history || !ISO_DATE_RE.test(week || '')) return false;
  if (num(gross) == null && num(showCount) == null) return false;
  history._meta = history._meta || {};
  const totals = { ...(history._meta.weekTotals || {}) };
  totals[sundayOf(week)] = { gross: num(gross), showCount: num(showCount), source, recordedAt: new Date().toISOString() };
  const sorted = {};
  for (const k of Object.keys(totals).sort()) sorted[k] = totals[k];
  history._meta.weekTotals = sorted;
  return true;
}

/**
 * Stored rows vs the published League "Week's Total" the scraper saved in
 * history._meta.weekTotals[sunday] = { gross, showCount, source }.
 * Weeks with no saved total are skipped (older weeks predate saving it).
 */
function checkWeekTotals(history) {
  const totals = history?._meta?.weekTotals || {};
  const out = [];
  for (let [week, t] of Object.entries(totals)) {
    const key = historyKeyFor(history, week);
    const rows = Object.values(history?.weeks?.[key] || {}).filter(isRow);
    if (!key) {
      out.push({ rule: 'total-mismatch', week, detail: `published total saved for ${week} but the week has no rows` });
      continue;
    }
    // Report under the stored key so a findings scope built from history
    // keys still sees a total saved under its Sunday beside an off-Sunday key.
    week = key;
    const sum = rows.reduce((s, r) => s + (num(r.gross) || 0), 0);
    const pubGross = num(t?.gross);
    if (pubGross != null && pubGross > 0) {
      const diff = Math.abs(sum - pubGross);
      if (diff > pubGross * TOTAL_REL_TOLERANCE + rows.length) {
        out.push({ rule: 'total-mismatch', week, detail: `rows sum to $${sum.toLocaleString('en-US')} but the published total is $${pubGross.toLocaleString('en-US')} (${((diff / pubGross) * 100).toFixed(1)}% off)` });
      }
    }
    const pubCount = num(t?.showCount);
    if (pubCount != null && pubCount !== rows.length) {
      out.push({ rule: 'total-mismatch', week, detail: `${rows.length} shows stored but the published list has ${pubCount}` });
    }
  }
  return out;
}

/**
 * The newest week has no published total to check its rows against: the
 * week came from the BWW fallback (no "Week's Total" on that page) or the
 * Playbill total failed to parse. Report tier: the rows may be fine, but
 * the total rule could not run.
 */
function checkTotalRecorded(history, week) {
  if (!week) return [];
  const totals = history?._meta?.weekTotals || {};
  if (totals[sundayOf(week)] || totals[week]) return [];
  return [{ rule: 'total-not-recorded', week, detail: 'no published League total saved for this week, so the rows could not be checked against it' }];
}

/**
 * Shows present the week before `week` but absent in `week`, where
 * shows.json gives no closing date on or before `week`.
 */
function checkDropouts(history, shows, week) {
  const keys = sortedWeekKeys(history);
  const idx = keys.indexOf(week);
  if (idx < 1) return [];
  const prev = history.weeks[keys[idx - 1]] || {};
  const cur = history.weeks[week] || {};
  const bySlug = new Map((shows || []).map((s) => [s.slug, s]));
  const out = [];
  for (const slug of Object.keys(prev)) {
    if (cur[slug]) continue;
    const show = bySlug.get(slug);
    const closing = show?.closingDate;
    if (closing && ISO_DATE_RE.test(closing.slice(0, 10)) && closing.slice(0, 10) <= week) continue;
    out.push({
      rule: 'show-dropout', week, slug,
      detail: show
        ? `in ${keys[idx - 1]} but missing from ${week}; shows.json closingDate is ${closing || 'unset'} (status ${show.status || 'unset'})`
        : `in ${keys[idx - 1]} but missing from ${week}; slug not in shows.json`,
    });
  }
  return out;
}

/** Per-slug rows in week order: [{ week, entry }]. */
function rowsBySlug(history) {
  const map = new Map();
  for (const week of sortedWeekKeys(history)) {
    for (const [slug, entry] of Object.entries(history.weeks[week] || {})) {
      if (!isRow(entry)) continue;
      if (!map.has(slug)) map.set(slug, []);
      map.get(slug).push({ week, entry });
    }
  }
  return map;
}

/** Consecutive = the next stored week for the slug is exactly 7 days on. */
const nextWeek = (a, b) => isoToMs(b) - isoToMs(a) === 7 * DAY_MS;

/**
 * Identical gross to the dollar in two of a show's weeks, and runs of
 * FLAT_RUN_WEEKS+ consecutive weeks within FLAT_RUN_TOLERANCE while every
 * week's capacity is below FLAT_RUN_MAX_CAPACITY.
 */
function checkRepeatedGrosses(history) {
  const out = [];
  for (const [slug, rows] of rowsBySlug(history)) {
    const seen = new Map();
    for (const { week, entry } of rows) {
      const g = num(entry.gross);
      if (!g || g <= 0) continue;
      if (seen.has(g)) {
        out.push({ rule: 'duplicate-gross', week, slug, detail: `gross $${g.toLocaleString('en-US')} identical to week ${seen.get(g)}` });
      } else {
        seen.set(g, week);
      }
    }
    let run = [];
    const flush = () => {
      if (run.length >= FLAT_RUN_WEEKS) {
        out.push({ rule: 'flat-gross-run', week: run[run.length - 1].week, slug, weeks: run.map((r) => r.week), detail: `${run.length} consecutive weeks within ${FLAT_RUN_TOLERANCE * 100}% ($${num(run[0].entry.gross).toLocaleString('en-US')}..) at capacity below ${FLAT_RUN_MAX_CAPACITY}%: ${run[0].week}..${run[run.length - 1].week}` });
      }
    };
    for (const r of rows) {
      const g = num(r.entry.gross);
      const cap = num(r.entry.capacity);
      const eligible = g > 0 && cap != null && cap < FLAT_RUN_MAX_CAPACITY;
      const prev = run[run.length - 1];
      if (eligible && prev && nextWeek(prev.week, r.week) && Math.abs(g - num(run[0].entry.gross)) <= num(run[0].entry.gross) * FLAT_RUN_TOLERANCE) {
        run.push(r);
        continue;
      }
      flush();
      run = eligible ? [r] : [];
    }
    flush();
  }
  return out;
}

/**
 * CAPPED_RUN_WEEKS+ consecutive weeks at exactly 100% capacity with the same
 * attendance: the source capped the figure, and the true over-100% value
 * (standing room) is lost. Capacity above 100% is legitimate and kept.
 */
function checkCappedCapacity(history) {
  const out = [];
  for (const [slug, rows] of rowsBySlug(history)) {
    let run = [];
    const flush = () => {
      if (run.length >= CAPPED_RUN_WEEKS) {
        out.push({ rule: 'capacity-capped', week: run[run.length - 1].week, slug, weeks: run.map((r) => r.week), detail: `${run.length} consecutive weeks at exactly 100% with attendance ${run[0].entry.attendance}: ${run[0].week}..${run[run.length - 1].week} (source capped; real capacity lost)` });
      }
    };
    for (const r of rows) {
      const capped = r.entry.capacity === 100 && num(r.entry.attendance) > 0;
      const prev = run[run.length - 1];
      if (capped && prev && nextWeek(prev.week, r.week) && r.entry.attendance === run[0].entry.attendance) {
        run.push(r);
        continue;
      }
      flush();
      run = capped ? [r] : [];
    }
    flush();
  }
  return out;
}

/** Per-row shape checks: zero performances with a gross, missing seatsOffered. */
function checkRowShape(history, weeks) {
  const out = [];
  for (const week of weeks) {
    for (const [slug, e] of Object.entries(history?.weeks?.[week] || {})) {
      if (!isRow(e)) continue;
      if (e.performances === 0 && num(e.gross) > 0) {
        out.push({ rule: 'zero-perf-gross', week, slug, detail: `performances 0 with gross $${e.gross.toLocaleString('en-US')}` });
      }
      const negative = ['gross', 'capacity', 'atp', 'attendance'].filter((f) => num(e[f]) != null && e[f] < 0);
      if (negative.length) {
        out.push({ rule: 'negative-value', week, slug, detail: negative.map((f) => `${f} ${e[f]}`).join(', ') });
      }
      if (e.seatsOffered == null && num(e.attendance) > 0 && num(e.capacity) > 0) {
        out.push({ rule: 'seats-offered-missing', week, slug, detail: `seatsOffered missing (attendance ${e.attendance}, capacity ${e.capacity}%)` });
      }
    }
  }
  return out;
}

/** Week-over-week gross moves beyond WOW_RATIO between two full weeks. */
function checkWowJumps(history) {
  const out = [];
  for (const [slug, rows] of rowsBySlug(history)) {
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (!nextWeek(a.week, b.week)) continue;
      const ga = num(a.entry.gross);
      const gb = num(b.entry.gross);
      if (!(ga > 0 && gb > 0)) continue;
      if (!(a.entry.performances >= FULL_WEEK_PERFS && b.entry.performances >= FULL_WEEK_PERFS)) continue;
      const ratio = gb / ga;
      if (ratio > WOW_RATIO || ratio < 1 / WOW_RATIO) {
        out.push({ rule: 'wow-jump', week: b.week, slug, detail: `gross $${ga.toLocaleString('en-US')} (${a.week}) -> $${gb.toLocaleString('en-US')} (${b.week}), ${ratio.toFixed(2)}x on full weeks` });
      }
    }
  }
  return out;
}

/**
 * Run every rule. `weeks` (default: the latest week) scopes the result: a
 * finding is kept when its week, or any week of its run, is in `weeks`.
 * `missingSince` bounds the gap check (default: 8 weeks before the earliest
 * checked week).
 * @returns {Array<{rule:string, week:string, slug?:string, detail:string}>}
 */
function checkGrossesIntegrity(history, shows, { weeks, missingSince, now } = {}) {
  const keys = sortedWeekKeys(history);
  const scope = weeks && weeks.length ? weeks : keys.slice(-1);
  const inScope = new Set(scope);
  const earliest = [...scope].sort()[0];
  const since = missingSince || (earliest ? new Date(isoToMs(earliest) - 8 * 7 * DAY_MS).toISOString().slice(0, 10) : undefined);
  const all = [
    ...checkWeekKeys(history),
    ...checkMissingWeeks(history, { since }),
    ...checkWeekOverdue(history, now),
    ...checkWeekTotals(history),
    ...checkTotalRecorded(history, keys[keys.length - 1]),
    ...scope.flatMap((w) => checkDropouts(history, shows, w)),
    ...checkRepeatedGrosses(history),
    ...checkCappedCapacity(history),
    ...checkRowShape(history, scope),
    ...checkWowJumps(history),
  ];
  return all.filter((f) => f.rule === 'week-key-not-sunday' || f.rule === 'week-missing' || f.rule === 'week-overdue'
    || inScope.has(f.week) || (f.weeks || []).some((w) => inScope.has(w)));
}

module.exports = {
  KNOWN_GAPS,
  isSunday,
  sundayOf,
  recordPublishedTotal,
  checkWeekKeys,
  checkMissingWeeks,
  checkWeekOverdue,
  checkWeekTotals,
  checkTotalRecorded,
  checkDropouts,
  checkRepeatedGrosses,
  checkCappedCapacity,
  checkRowShape,
  checkWowJumps,
  checkGrossesIntegrity,
  constants: { TOTAL_REL_TOLERANCE, FLAT_RUN_WEEKS, FLAT_RUN_TOLERANCE, FLAT_RUN_MAX_CAPACITY, CAPPED_RUN_WEEKS, WOW_RATIO, FULL_WEEK_PERFS },
};
