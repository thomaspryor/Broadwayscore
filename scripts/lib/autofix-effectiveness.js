/**
 * Is the digest auto-fix loop actually FIXING anything?
 *
 * THE CLASS THIS PREVENTS
 * On 2026-08-10 the owner reported receiving a near-identical morning digest for
 * the 13th day running. Root cause: the local `claude` CLI was logged out, so
 * every headless auto-fix job started, produced ZERO bytes of output, and was
 * killed by its own timeout. The cards stayed `in_progress` forever and the same
 * ~31 issues re-reported every morning.
 *
 * Nothing caught it, because the one check that looks like it should —
 * "Alert Router: dispatch deadman" — counts DISPATCH ATTEMPTS, not outcomes. A
 * logged-out CLI launches perfectly, so that row read `42/42 auto-dispatch
 * attempts succeeded` while the true fix rate was zero. Textbook vacuous gate:
 * green because it measures the wrong end of the pipe.
 *
 * data/audit/digest-autofix-ledger.jsonl already records the real outcomes as
 * `card-pass` / `card-fail` events. Nothing read them. This does.
 *
 * Deliberately outcome-based rather than probing `claude -p` for auth: the probe
 * only works on the machine that owns the CLI, while the ledger is committed and
 * readable from CI, and a dead fleet has many causes (revoked token, quota,
 * crashed launchd job) that all present identically here — as jobs that stop
 * passing.
 */

const DEFAULT_WINDOW_DAYS = 7;
// Below this many recorded outcomes we cannot distinguish "broken" from "quiet".
const MIN_OUTCOMES_TO_JUDGE = 3;
// Zero passes with enough attempts = the loop is dead, not merely struggling.
const WARN_BELOW_RATE = 0.5;

/**
 * @param {Array<object>} rows - parsed digest-autofix-ledger.jsonl records
 * @param {{now?: number, windowDays?: number, dispatchCount?: number}} [opts]
 *   dispatchCount: auto-dispatches recorded in the same window by the alert
 *   router (readDispatchAttempts). Used to tell "quiet because nothing was
 *   dispatched" apart from "dispatched plenty, but no outcome ever came back" —
 *   the latter is a dead loop and MUST NOT read as healthy. This matters because
 *   digest-autofix-ledger.jsonl is untracked (verified 2026-08-10: `git ls-files`
 *   does not know it), so in CI the ledger is simply absent and an
 *   outcomes-only check would go permanently, silently green.
 * @returns {{status:'pass'|'warn'|'error', attempts:number, passes:number,
 *            fails:number, rate:number|null, message:string}}
 */
function assessAutofixEffectiveness(rows, opts = {}) {
  const windowDays = opts.windowDays || DEFAULT_WINDOW_DAYS;
  const now = opts.now != null ? opts.now : Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  let passes = 0;
  let fails = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || (r.event !== 'card-pass' && r.event !== 'card-fail')) continue;
    const t = Date.parse(r.ts || '');
    // An unparseable timestamp is counted rather than dropped: silently ignoring
    // malformed rows is how a broken writer would make this check go quiet.
    if (Number.isFinite(t) && t < cutoff) continue;
    if (r.event === 'card-pass') passes++;
    else fails++;
  }

  const attempts = passes + fails;
  const dispatchCount = Number.isFinite(opts.dispatchCount) ? opts.dispatchCount : null;

  // Dispatched repeatedly but not one outcome came back. This is the shape a
  // dead fleet ACTUALLY presents in CI, where the outcome ledger is absent
  // entirely — and the shape the attempt-counting deadman scores as 100% green.
  if (attempts === 0 && dispatchCount != null && dispatchCount >= MIN_OUTCOMES_TO_JUDGE) {
    return {
      status: 'error',
      attempts: 0,
      passes: 0,
      fails: 0,
      rate: null,
      message: `${dispatchCount} auto-fix job(s) were dispatched in the last ${windowDays}d and NOT ONE reported an outcome. `
        + `Launching is not fixing — the loop is dead and the digest is claiming issues are "being fixed automatically". `
        + `First check: run \`claude -p "hi"\` — "Not logged in" means every job dies instantly on auth (2026-08-10 incident). `
        + `Note data/audit/digest-autofix-ledger.jsonl is untracked, so in CI its absence is itself the symptom.`,
    };
  }

  if (attempts < MIN_OUTCOMES_TO_JUDGE) {
    return {
      status: 'pass',
      attempts,
      passes,
      fails,
      rate: attempts ? passes / attempts : null,
      message: `Only ${attempts} auto-fix outcome(s) recorded in the last ${windowDays}d (need ${MIN_OUTCOMES_TO_JUDGE} to judge) — not enough to call it broken`,
    };
  }

  const rate = passes / attempts;
  if (passes === 0) {
    return {
      status: 'error',
      attempts,
      passes,
      fails,
      rate,
      message: `Auto-fix loop is DEAD: 0 of ${attempts} headless fix job(s) succeeded in the last ${windowDays}d. `
        + `The digest is telling you issues are "being fixed automatically" while nothing is. `
        + `First check: run \`claude -p "hi"\` — if it prints "Not logged in", every job dies instantly on auth (2026-08-10 incident). `
        + `Then check ~/Library/Logs/bsc-jobs/ for a job log that is empty apart from a TIMEOUT marker.`,
    };
  }
  if (rate < WARN_BELOW_RATE) {
    return {
      status: 'warn',
      attempts,
      passes,
      fails,
      rate,
      message: `Auto-fix loop is failing more than it fixes: ${passes}/${attempts} succeeded (${Math.round(rate * 100)}%) in the last ${windowDays}d — issues will re-report in tomorrow's digest`,
    };
  }
  return {
    status: 'pass',
    attempts,
    passes,
    fails,
    rate,
    message: `${passes}/${attempts} auto-fix job(s) succeeded (${Math.round(rate * 100)}%) in the last ${windowDays}d`,
  };
}

module.exports = {
  assessAutofixEffectiveness,
  MIN_OUTCOMES_TO_JUDGE,
  WARN_BELOW_RATE,
  DEFAULT_WINDOW_DAYS,
};
