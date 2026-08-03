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
 *     - shows absent from either side are ignored (added/pruned != changed)
 *     - COVERAGE_BLAST_RADIUS_OVERRIDE=1 forces the write through, for the
 *       real mass-change case (a big ingest run healing many shows at once)
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

/**
 * Compare two {id -> state} snapshots and decide whether the new one is safe
 * to persist.
 *
 * @param {Object|Map} prevStates  id -> state from the last accepted run
 * @param {Object|Map} nextStates  id -> state this run wants to write
 * @param {Object} [opts]
 * @param {number} [opts.thresholdPct=5]  refuse above this % of compared ids changed
 * @param {number} [opts.minSample=20]    below this many compared ids, never refuse
 * @param {string} [opts.label='coverage'] shown in the reason string
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{ok: boolean, compared: number, changed: number, changedPct: number,
 *            changedIds: string[], reason: string}}
 *   ok=true means "write it". Every uncertain path returns ok=true.
 */
function blastRadiusCheck(prevStates, nextStates, opts = {}) {
  const {
    thresholdPct = DEFAULT_THRESHOLD_PCT,
    minSample = DEFAULT_MIN_SAMPLE,
    label = 'coverage',
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
    if (prev.get(id) !== nextState) changedIds.push(id);
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
};
