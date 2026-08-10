/**
 * Is the digest auto-fix loop actually FIXING anything?
 *
 * THE CLASS THIS PREVENTS
 * On 2026-08-10 the owner reported a near-identical morning digest for the 13th
 * day running. Root cause: the local `claude` CLI was logged out, so every
 * headless auto-fix job started, produced ZERO bytes, and was killed by its own
 * timeout. Cards stayed `in_progress` forever and the same ~31 issues re-reported
 * every morning under a banner promising they were being handled.
 *
 * Nothing caught it, because the one check that looks like it should —
 * "Alert Router: dispatch deadman" — counts DISPATCH ATTEMPTS, not outcomes. A
 * logged-out CLI launches perfectly, so that row read `42/42 auto-dispatch
 * attempts succeeded` while the true fix rate was zero.
 *
 * BOTH SIGNALS COME FROM THE SAME LEDGER, ON PURPOSE
 * data/audit/digest-autofix-ledger.jsonl records `event:'auto-dispatch'` when a
 * headless job is launched and `event:'card-pass'|'card-fail'` when one reports
 * back. Comparing those two within one file is what makes "launched N, heard back
 * from none" detectable.
 *
 * Do NOT reach for readDispatchAttempts()/alert-router-attempts.jsonl here. Code
 * review of d8d11372ffc (2026-08-10) caught two fatal problems with that:
 *   1. It logs Notion ALERT-CARD creations (its live entries are `e2e-canary:*`),
 *      not headless fix jobs — a completely unrelated population.
 *   2. It is git-TRACKED and re-committed by data-health-check.yml every run,
 *      while this ledger is UNTRACKED. In CI that pairing is permanently
 *      "ledger absent + ~100 attempts" → a hard ERROR every single day forever,
 *      even at 100% health, burning a daily auto-dispatch slot on an unfixable
 *      card. That is the same vacuous gate with the sign flipped, and it would
 *      have recreated the very "same error every morning" experience this row was
 *      written to end.
 */

const DEFAULT_WINDOW_DAYS = 7;
// Below this many recorded outcomes we cannot distinguish "broken" from "quiet".
const MIN_OUTCOMES_TO_JUDGE = 3;
// Zero passes with enough attempts = the loop is dead, not merely struggling.
const WARN_BELOW_RATE = 0.5;
// If this share of launched jobs never reported back, the loop is dead even when
// a couple of stragglers did report — the near-dead case a strict `attempts === 0`
// test walks straight past.
const SILENT_DISPATCH_RATIO = 0.5;

function inWindow(ts, cutoff) {
  const t = Date.parse(ts || '');
  if (!Number.isFinite(t)) return null; // unparseable — caller decides
  return t >= cutoff;
}

/**
 * @param {Array<object>} rows - parsed digest-autofix-ledger.jsonl records
 * @param {{now?: number, windowDays?: number}} [opts]
 * @returns {{status:'pass'|'warn'|'error', attempts:number, passes:number,
 *            fails:number, dispatched:number, undated:number,
 *            rate:number|null, message:string}}
 */
function assessAutofixEffectiveness(rows, opts = {}) {
  const windowDays = opts.windowDays || DEFAULT_WINDOW_DAYS;
  const now = opts.now != null ? opts.now : Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  let passes = 0;
  let fails = 0;
  let dispatched = 0;
  let undated = 0;

  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const ev = r.event;
    if (ev !== 'card-pass' && ev !== 'card-fail' && ev !== 'auto-dispatch') continue;
    const within = inWindow(r.ts, cutoff);
    if (within === false) continue;
    if (within === null) {
      // Counted, never silently dropped — a broken writer must not be able to
      // quiet this check. Tracked separately so a handful of malformed rows can
      // surface in the message without permanently condemning a healthy loop
      // (the ledger is append-only with no retention pass, so anything counted
      // as a normal outcome here would never age out).
      undated++;
      continue;
    }
    if (ev === 'card-pass') passes++;
    else if (ev === 'card-fail') fails++;
    else dispatched++;
  }

  const attempts = passes + fails;
  const undatedNote = undated ? ` (${undated} ledger row(s) had unreadable timestamps — writer bug, investigate separately)` : '';
  const base = { attempts, passes, fails, dispatched, undated };

  // Launched jobs that never reported back. This is the dead-fleet shape, and it
  // stays detectable when a straggler or two DID report — which `attempts === 0`
  // alone would score as "not enough to judge".
  const silent = dispatched - attempts;
  if (dispatched >= MIN_OUTCOMES_TO_JUDGE
      && passes === 0
      && silent >= dispatched * SILENT_DISPATCH_RATIO) {
    return {
      ...base,
      rate: attempts ? 0 : null,
      status: 'error',
      message: `Auto-fix loop is DEAD: ${dispatched} job(s) launched in the last ${windowDays}d, ${attempts} reported back, 0 succeeded. `
        + `Run \`claude -p "hi"\` on the dispatch host — "Not logged in" means every job dies instantly on auth (2026-08-10 incident).${undatedNote}`,
    };
  }

  if (attempts < MIN_OUTCOMES_TO_JUDGE) {
    return {
      ...base,
      rate: attempts ? passes / attempts : null,
      status: 'pass',
      message: `Only ${attempts} auto-fix outcome(s) in the last ${windowDays}d from ${dispatched} launch(es) (need ${MIN_OUTCOMES_TO_JUDGE} to judge)${undatedNote}`,
    };
  }

  const rate = passes / attempts;
  if (passes === 0) {
    return {
      ...base,
      rate,
      status: 'error',
      message: `Auto-fix loop is DEAD: 0 of ${attempts} job(s) succeeded in the last ${windowDays}d. `
        + `Run \`claude -p "hi"\` on the dispatch host — "Not logged in" means every job dies on auth (2026-08-10 incident).${undatedNote}`,
    };
  }
  if (rate < WARN_BELOW_RATE) {
    return {
      ...base,
      rate,
      status: 'warn',
      message: `Auto-fix loop fails more than it fixes: ${passes}/${attempts} succeeded (${Math.round(rate * 100)}%) in the last ${windowDays}d — issues will re-report tomorrow${undatedNote}`,
    };
  }
  return {
    ...base,
    rate,
    status: 'pass',
    message: `${passes}/${attempts} auto-fix job(s) succeeded (${Math.round(rate * 100)}%) in the last ${windowDays}d${undatedNote}`,
  };
}

module.exports = {
  assessAutofixEffectiveness,
  MIN_OUTCOMES_TO_JUDGE,
  WARN_BELOW_RATE,
  SILENT_DISPATCH_RATIO,
  DEFAULT_WINDOW_DAYS,
};
