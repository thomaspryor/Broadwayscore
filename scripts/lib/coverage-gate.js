/**
 * Coverage Verdict — kill switch + blast-radius guard (S0, task #902).
 *
 * Two primitives every verdict producer/consumer shares. Both are FAIL-OPEN by
 * construction (plan rule 1: a missing, stale or UNKNOWN verdict never
 * suppresses a score, never blocks an email, never fails CI hard). If either
 * helper can't reach a confident answer it returns the permissive one.
 *
 * Plan: ~/Documents/claude-outputs/coverage-verdict-system-plan-2026-08-02.md
 *
 * Kill switch
 *   COVERAGE_GATE_DISABLED=1|true|yes → every verdict-driven gate is a no-op.
 *   One env var, read through one helper, so "disable the coverage system"
 *   is a single lever rather than N grep-and-hope edits.
 *
 * Blast-radius guard
 *   Editorial-drift-guard pattern: a run that flips >5% of shows' coverage
 *   state is far more likely to be a broken input (dead SERP provider, empty
 *   census, bad checkout) than 200 shows genuinely changing at once. Refuse
 *   the write and alert instead of persisting the damage.
 *
 *   Guard rails that keep it from firing on legitimate small runs:
 *     - needs >= minSample shows present in BOTH snapshots (a `--show=X` run
 *       compares 1 show; 1/1 = 100% and would trip every time)
 *     - needs >= minChanged shows actually changed (see below)
 *     - shows absent from either side are ignored (added/pruned != changed)
 *     - COVERAGE_BLAST_RADIUS_OVERRIDE=1 forces the write through, for the
 *       real mass-change case (a big ingest run healing many shows at once)
 *
 *   WHY minChanged EXISTS (2026-08-09, "Audit Aggregator Review Gap" red 13x
 *   in 3 days; cards #431 / #1030 / #1125):
 *   audit-show-review-gap.js is time-budget partial — a scheduled run audits
 *   whatever slice fits the budget, typically ~22 shows, not the full 207. A
 *   percentage threshold has no meaning at that denominator: 5% of 22 is 1.1
 *   shows, so ANY run where two shows genuinely changed coverage state read as
 *   a 9.1% "blast radius" and refused to write. The audit then rolled back its
 *   freshness stamps and exited 1, every hour, while the real coverage data it
 *   had just computed was thrown away.
 *   The failure mode this guard is FOR — dead SERP provider, empty census,
 *   partial checkout — does not flip two shows. It flips essentially the whole
 *   batch (80-100%). So requiring an absolute floor as well as a percentage
 *   costs nothing in detection and removes the entire small-denominator false
 *   positive class. minSample alone could not do this: raising it would make
 *   every partial run unjudgeable rather than correctly judged.
 *
 *   WHY isRiskyChange EXISTS (2026-08-26, BRO-513, recurred from an identical
 *   16.7% refusal on 2026-08-03): once a batch is large enough to clear
 *   minSample/minChanged, the guard still fired at a steady ~17-21% — nowhere
 *   near the "essentially the whole batch" signature above, and not a broken
 *   input either. The individual show diffs (abigails-party-west-end-2026,
 *   jeeves-takes-charge-west-end-2026, …) showed genuinely NEW aggregator-
 *   listed URLs the show didn't have before, flipping complete → incomplete —
 *   the census doing its job as new roundups/blog posts publish. Shows opening
 *   in the same week cluster these discoveries naturally; nothing was broken.
 *
 *   The bare verdict label alone can't distinguish that from the actual
 *   failure mode (adversarial ship-check review, task #902 follow-up): a
 *   broken/partial review-texts checkout makes audit-show-review-gap.js's
 *   loadDirFiles() return [] for EVERY show, so outlets that were previously
 *   `live` also read as newly `missing` — ALSO complete → incomplete, same
 *   verdict transition as the benign new-gap-discovery case above, but this
 *   IS the dead-SERP-provider/empty-census/partial-checkout class the guard
 *   exists to catch. A verdict-only isRiskyChange would have let that through
 *   right alongside the benign case. review-gap's call therefore doesn't
 *   diff the verdict string at all — it diffs `liveCount`/`candidateCount`
 *   (already computed per show by censusVerdictFor) and calls a transition
 *   risky iff EITHER count went down: real collected coverage disappeared, or
 *   a previously-known gap silently disappeared from view (the same
 *   vacuous-truth trap, one layer up — a dead SERP provider makes a KNOWN
 *   gap list vanish, not just fail to grow). A verdict word changing while
 *   both counts hold or grow is the audit doing its job and is never risky.
 */

'use strict';

function envTrue(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} true when every coverage-verdict gate must no-op.
 */
function coverageGateDisabled(env = process.env) {
  return envTrue(env.COVERAGE_GATE_DISABLED);
}

/**
 * Fail-open wrapper for any verdict-driven gate.
 *
 * Call sites read as: `if (coverageGateAllows(() => verdict === 'incomplete')) { ...gate... }`
 * — kill switch off AND the predicate threw nothing AND it returned true.
 * A throwing predicate (missing file, malformed verdict) returns false = do
 * not gate, which is the fail-open direction.
 *
 * @param {() => boolean} predicate
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {boolean}
 */
function coverageGateAllows(predicate, opts = {}) {
  const env = opts.env || process.env;
  if (coverageGateDisabled(env)) return false;
  try {
    return predicate() === true;
  } catch {
    return false; // fail open — never gate on a broken verdict read
  }
}

const DEFAULT_THRESHOLD_PCT = 5;
const DEFAULT_MIN_SAMPLE = 20;
// Absolute floor on `changed` before the percentage threshold may refuse a
// write. See the minChanged rationale in the header comment.
const DEFAULT_MIN_CHANGED = 5;

/**
 * Compare two {id -> state} snapshots and decide whether the new one is safe
 * to persist.
 *
 * @param {Object|Map} prevStates  id -> state from the last accepted run
 * @param {Object|Map} nextStates  id -> state this run wants to write
 * @param {Object} [opts]
 * @param {number} [opts.thresholdPct=5]  refuse above this % of compared ids changed
 * @param {number} [opts.minSample=20]    below this many compared ids, never refuse
 * @param {number} [opts.minChanged=5]    below this many CHANGED ids, never refuse
 * @param {string} [opts.label='coverage'] shown in the reason string
 * @param {(prevState: any, nextState: any) => boolean} [opts.isRiskyChange]
 *   Optional filter on which state transitions count toward `changed` at all.
 *   Defaults to "every transition counts" (the original, direction-blind
 *   behavior — unchanged for any caller that doesn't pass this). A caller
 *   whose state values aren't a flat interchangeable set — some transitions
 *   are the system doing its job, others are exactly the broken-input
 *   symptom this guard exists to catch — can narrow `changed` to only the
 *   risky direction. See the review-gap call site in
 *   audit-show-review-gap.js for the motivating case.
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{ok: boolean, compared: number, changed: number, changedPct: number,
 *            changedIds: string[], reason: string}}
 *   ok=true means "write it". Every uncertain path returns ok=true.
 */
function blastRadiusCheck(prevStates, nextStates, opts = {}) {
  const {
    thresholdPct = DEFAULT_THRESHOLD_PCT,
    minSample = DEFAULT_MIN_SAMPLE,
    minChanged = DEFAULT_MIN_CHANGED,
    label = 'coverage',
    isRiskyChange,
    env = process.env,
  } = opts;

  const toMap = (v) => {
    if (v instanceof Map) return v;
    if (v && typeof v === 'object') return new Map(Object.entries(v));
    return new Map();
  };

  let prev, next;
  try {
    prev = toMap(prevStates);
    next = toMap(nextStates);
  } catch {
    return { ok: true, compared: 0, changed: 0, changedPct: 0, changedIds: [], reason: 'unreadable snapshots — failing open' };
  }

  const changedIds = [];
  let compared = 0;
  for (const [id, nextState] of next) {
    if (!prev.has(id)) continue; // new show — not a state CHANGE
    compared++;
    const prevState = prev.get(id);
    if (prevState === nextState) continue;
    if (typeof isRiskyChange === 'function' && !isRiskyChange(prevState, nextState)) continue;
    changedIds.push(id);
  }
  const changed = changedIds.length;
  const changedPct = compared > 0 ? (changed / compared) * 100 : 0;

  if (coverageGateDisabled(env)) {
    return { ok: true, compared, changed, changedPct, changedIds, reason: 'COVERAGE_GATE_DISABLED — guard bypassed' };
  }
  if (envTrue(env.COVERAGE_BLAST_RADIUS_OVERRIDE)) {
    return { ok: true, compared, changed, changedPct, changedIds, reason: 'COVERAGE_BLAST_RADIUS_OVERRIDE — guard bypassed' };
  }
  if (compared < minSample) {
    return {
      ok: true, compared, changed, changedPct, changedIds,
      reason: `only ${compared} show(s) comparable (<${minSample}) — sample too small to judge, failing open`,
    };
  }
  if (changed < minChanged) {
    return {
      ok: true, compared, changed, changedPct, changedIds,
      reason: `only ${changed} show(s) changed state (<${minChanged}) — too few to be a broken input, failing open (${changedPct.toFixed(1)}% of ${compared} compared)`,
    };
  }
  if (changedPct > thresholdPct) {
    return {
      ok: false, compared, changed, changedPct, changedIds,
      reason: `${label} blast radius ${changedPct.toFixed(1)}% (${changed}/${compared} shows changed state) exceeds ${thresholdPct}% — refusing to write. Inspect the inputs (dead SERP provider / empty census / partial checkout all look like this). Force with COVERAGE_BLAST_RADIUS_OVERRIDE=1.`,
    };
  }
  return {
    ok: true, compared, changed, changedPct, changedIds,
    reason: `${changedPct.toFixed(1)}% of ${compared} compared show(s) changed state — within the ${thresholdPct}% threshold`,
  };
}

module.exports = {
  coverageGateDisabled,
  coverageGateAllows,
  blastRadiusCheck,
  DEFAULT_THRESHOLD_PCT,
  DEFAULT_MIN_SAMPLE,
  DEFAULT_MIN_CHANGED,
};
