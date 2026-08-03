'use strict';

/**
 * stateless-candidates.js — Coverage Verdict S2 (task #906), scope item 4.
 *
 * The plan's one-paragraph promise is "every review the system knows about for
 * a show gets exactly ONE visible state". S2 shipped the machinery that assigns
 * those states (censusVerdict().candidates, stamped into
 * data/audit/show-review-gap.json by gap-audit-merge.js). This module is the
 * monitor for that machinery: it re-derives the set of URLs the audit itself
 * knows about for a show and reports any that the verdict left WITHOUT a state.
 * A monitor that never covers its own output is how a silently-broken producer
 * hides (see feedback_monitor_must_cover_own_output) — that is the whole reason
 * this exists as a separate reader rather than an assertion inside the producer.
 *
 * WARN-ONLY BY CONSTRUCTION. Nothing here throws, exits, or gates. The plan
 * forbids a hard fail until the report has been clean for two weeks AND the
 * failure is behind the COVERAGE_GATE_DISABLED kill switch, so there is
 * deliberately no strict/fail mode to accidentally turn on. A show with no
 * verdict yet (`no-verdict`) is INFORMATIONAL, never a finding: verdicts appear
 * only after the audit re-runs, and the fail-open rule says a missing verdict
 * must behave exactly like today.
 *
 * Pure — no clock reads, no fs, no network. The caller passes `now`.
 */

// The candidate vocabulary S2 shipped: 'live' plus t1-ledger's classifyCell()
// states. Kept as a literal set rather than imported so a future t1-ledger
// state addition surfaces HERE as "unknown state" (a visible, reviewable
// finding) instead of being silently blessed by the monitor that exists to
// catch exactly that drift.
const KNOWN_CANDIDATE_STATES = new Set([
  'live', 'GAP', 'IN_FLIGHT', 'SUPPRESSED', 'CIRCUIT_OPEN', 'NO_REVIEW_EXPECTED',
]);

const DEFAULT_WINDOW_DAYS = 30;

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Every review URL the gap audit knows about for one show, in the same three
 * buckets the audit itself computes: aggregator-listed URLs, `missing` (listed
 * but not in review-texts), and `flaggedMisses` (present but rejected by a
 * guard). Deduped, empty strings dropped.
 * @returns {Set<string>}
 */
function knownUrlsFor(result) {
  const urls = new Set();
  for (const u of asArray(result && result.aggregatorListedUrls)) {
    if (typeof u === 'string' && u) urls.add(u);
  }
  for (const bucket of ['missing', 'flaggedMisses']) {
    for (const m of asArray(result && result[bucket])) {
      if (m && typeof m.url === 'string' && m.url) urls.add(m.url);
    }
  }
  return urls;
}

/**
 * Outlets the audit knows reviewed the show but for which it never resolved a
 * URL (`citedNoUrl`). These can only be matched to a candidate by outletId.
 * @returns {Set<string>}
 */
function knownUrllessOutletsFor(result) {
  const ids = new Set();
  for (const c of asArray(result && result.citedNoUrl)) {
    if (c && c.outletId) ids.add(c.outletId);
  }
  return ids;
}

/**
 * Audit ONE show's verdict for stateless candidates.
 *
 * @param {object} result  one audit-show-review-gap.js per-show result, as
 *   merged (and verdict-stamped) by gap-audit-merge.js
 * @returns {{showId, openingDate, verdict, hasVerdict, knownCount, statedCount,
 *   statelessUrls:string[], statelessOutlets:string[], unknownStates:Array<{url,outletId,state}>}}
 */
function auditShowCandidates(result) {
  const showId = (result && result.showId) || null;
  const openingDate = (result && result.openingDate) || null;
  const cv = result && result.censusVerdict;
  // `no-census-yet` counts as "no verdict" for reporting: censusVerdict()
  // returns an EMPTY candidates array by construction in that state, so a show
  // the audit reached with only citedNoUrl rows (WE-reference path, no
  // aggregator URLs) would otherwise report every cited outlet stateless
  // forever — a finding no producer change could ever clear. Ignorance about a
  // show is not a defect in the state machine.
  const hasVerdict = !!(cv && typeof cv === 'object' && cv.verdict !== 'no-census-yet');
  const candidates = asArray(cv && cv.candidates);

  const statedUrls = new Set();
  const statedOutlets = new Set();
  const unknownStates = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const stated = typeof c.state === 'string' && KNOWN_CANDIDATE_STATES.has(c.state);
    if (!stated) {
      unknownStates.push({ url: c.url || '', outletId: c.outletId || null, state: c.state == null ? null : c.state });
      // A candidate carrying an unrecognized state is NOT counted as covering
      // its URL — an unreadable state is the same failure as no state at all.
      continue;
    }
    if (c.url) statedUrls.add(c.url);
    if (c.outletId) statedOutlets.add(c.outletId);
  }

  const knownUrls = knownUrlsFor(result);
  const knownOutlets = knownUrllessOutletsFor(result);
  const statelessUrls = [...knownUrls].filter((u) => !statedUrls.has(u));
  const statelessOutlets = [...knownOutlets].filter((o) => !statedOutlets.has(o));

  const knownCount = knownUrls.size + knownOutlets.size;
  return {
    showId,
    openingDate,
    verdict: (cv && cv.verdict) || null,
    hasVerdict,
    knownCount,
    // How many of the KNOWN identities carry a state — not the raw candidate
    // count. A verdict may legitimately hold candidates the gap audit never
    // listed (the census reaches sources the audit result doesn't enumerate),
    // and counting those would let extra candidates paper over a missing one.
    statedCount: hasVerdict ? knownCount - statelessUrls.length - statelessOutlets.length : 0,
    candidateCount: candidates.length,
    // A show whose verdict has not been computed yet reports ZERO findings:
    // fail-open means "not computed" behaves exactly like today, and a
    // pre-#906 audit file would otherwise light up every single row.
    statelessUrls: hasVerdict ? statelessUrls : [],
    statelessOutlets: hasVerdict ? statelessOutlets : [],
    unknownStates,
  };
}

/**
 * Is this show inside the "recently opened" report window?
 * Future-dated openings are out of window (nothing to state yet); an absent or
 * unparseable openingDate is NOT silently skipped — it lands in the
 * `unknownDate` bucket (the plan's explicit unknown-date rule; 377 such shows
 * exist).
 * @returns {'in-window'|'out-of-window'|'unknown-date'}
 */
function windowStatus(result, { now, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const raw = result && result.openingDate;
  const openedMs = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(openedMs)) return 'unknown-date';
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return 'unknown-date';
  const ageDays = (nowMs - openedMs) / 86400000;
  if (ageDays < 0) return 'out-of-window';
  return ageDays <= windowDays ? 'in-window' : 'out-of-window';
}

/**
 * Build the whole warn-only report.
 *
 * @param {Array} results  audit.results from data/audit/show-review-gap.json
 * @param {object} opts { now: ISO string (required), windowDays }
 * @returns {{windowDays, now, examined, findings:Array, noVerdict:Array,
 *   unknownDate:Array, totals:{shows, statelessUrls, statelessOutlets, unknownStates}}}
 */
function reportStatelessCandidates(results, opts = {}) {
  const windowDays = opts.windowDays == null ? DEFAULT_WINDOW_DAYS : opts.windowDays;
  const now = opts.now;
  const findings = [];
  const noVerdict = [];
  const unknownDate = [];
  let examined = 0;

  for (const r of asArray(results)) {
    if (!r || !r.showId) continue;
    const status = windowStatus(r, { now, windowDays });
    if (status === 'unknown-date') {
      // Reported, never warned: an undated show cannot be "recently opened",
      // but silently dropping it is exactly the blindness this monitor exists
      // to prevent.
      unknownDate.push({ showId: r.showId, hasVerdict: !!(r.censusVerdict) });
      continue;
    }
    if (status === 'out-of-window') continue;
    examined++;
    const a = auditShowCandidates(r);
    if (!a.hasVerdict) { noVerdict.push({ showId: a.showId, openingDate: a.openingDate, verdict: a.verdict }); continue; }
    if (a.statelessUrls.length || a.statelessOutlets.length || a.unknownStates.length) findings.push(a);
  }

  const totals = {
    shows: findings.length,
    statelessUrls: findings.reduce((n, f) => n + f.statelessUrls.length, 0),
    statelessOutlets: findings.reduce((n, f) => n + f.statelessOutlets.length, 0),
    unknownStates: findings.reduce((n, f) => n + f.unknownStates.length, 0),
  };

  // `checked` is the only number that licenses a green tick: `examined` counts
  // in-window shows, but a show with no verdict (or `no-census-yet`) was never
  // actually checked. Reporting "✓ everything carries a state" off `examined`
  // printed a green tick on a run where all 8 in-window shows had no verdict at
  // all — a monitor claiming success for work it never did.
  const checked = examined - noVerdict.length;
  return { windowDays, now, examined, checked, findings, noVerdict, unknownDate, totals };
}

module.exports = {
  KNOWN_CANDIDATE_STATES,
  DEFAULT_WINDOW_DAYS,
  knownUrlsFor,
  knownUrllessOutletsFor,
  auditShowCandidates,
  windowStatus,
  reportStatelessCandidates,
};
