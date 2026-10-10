/**
 * Is the digest auto-fix loop actually FIXING anything?
 *
 * THE CLASS THIS PREVENTS
 * On 2026-08-10 the owner reported a near-identical morning digest for the 13th
 * day running: headless auto-fix jobs were dying with empty logs (a single
 * `exit=null TIMEOUT` line), cards stayed `in_progress` forever, and the same
 * ~31 issues re-reported every morning under a banner promising they were being
 * handled.
 *
 * DO NOT diagnose that by running `claude -p` or `claude auth status`. Corrected
 * 2026-08-11: the fleet does NOT use the CLI's stored login — claude-cli.js
 * injects ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN from .env into every
 * spawned job (resolveAuthEnv + strippedEnv), because under launchd process.env
 * carries only the plist's block. A bare probe from an interactive shell reports
 * "Not logged in" while the fleet is demonstrably completing cards. That false
 * reading was escalated to the owner as a total outage twice in one session, and
 * cost him two unnecessary re-logins on earlier sessions' advice. The real
 * diagnostics are the job logs under ~/Library/Logs/bsc-jobs/ and the .env keys.
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

// Single source of truth for this check's name — health-check.js registers the
// row under it, and the digest renderer (autonomous-email-render.js) matches
// against it to decide whether "being fixed automatically" claims are honest
// (task #1220/BRO-230: those claims rendered unconditionally even when this
// check already knew the loop was dead).
const CHECK_NAME = 'Autofix: jobs actually succeeding';

// Read+parse the ledger straight off disk. Returns null (never []) when the
// file is absent — health-check.js's ENOENT handling and this one must agree
// on "absent" vs "present and empty" for the same reason both already treat
// zero-attempts specially (see assessAutofixEffectiveness's MIN_OUTCOMES_TO_JUDGE
// gate below). ship-check adversarial finding (task #1220/BRO-230): CI's
// health-check.js run can NEVER see this file (it's per-machine, absent in
// the GitHub Actions checkout), so a caller that only reads health.errors for
// this check's row will never observe status:'error' in practice — a caller
// on the SAME machine as the ledger (e.g. send-morning-digest.js, which runs
// via local launchd where the loop itself dispatches) must read it directly.
function readLedgerRows(filePath) {
  const fs = require('fs');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const rows = [];
  // Exact-line dedupe (BRO-3868, mirrors linear-drain-parked.js's
  // readLedger): digest-autofix-ledger.jsonl is tracked and merge=union, so
  // a sync's union recovery can leave the SAME row twice. This module's
  // dispatched/passed daily counts have no dedupe of their own and would
  // double-count a resurrected duplicate. A no-op for this function's other
  // (gitignored, never git-merged) callers.
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    try { rows.push(JSON.parse(t)); } catch { /* skip unparseable line */ }
  }
  return rows;
}

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

// BRO-3321. Outcome rows are aged by the dispatch they JUDGE, not by when the
// reconciler got around to writing them — see dispatch-reconcile.js's
// outcomeWindowTs header for the 2026-09-14 incident that forced this.
const { outcomeWindowTs, ORPHAN_TIMEOUT_H } = require('./dispatch-reconcile.js');

// A dispatch cannot have reported back before reconciliation has had a chance
// to look at it, and reconciliation declares nothing until ORPHAN_TIMEOUT_H has
// passed. So a dispatch younger than that is not evidence of silence — it is
// evidence of nothing yet, and counting it as silent is wrong by construction.
//
// This is the half of the 2026-09-14 false alarm that ageing alone does NOT
// fix: with the card-fails correctly aged out of the window the ledger reads
// dispatched=3, attempts=0, silent=3, which still satisfies the DEAD branch
// below. The digest dispatches and then immediately measures itself, so every
// run that dispatched its full cap would have declared the loop dead. Verified
// against the real ledger: without this grace the post-ageing verdict is still
// `error`, with it the verdict is `pass`.
const GRACE_MS = ORPHAN_TIMEOUT_H * 60 * 60 * 1000;

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
  // Dispatches too young to have been reconciled yet. Counted separately so
  // they never read as silence (see GRACE_MS above) but stay visible in the
  // message rather than vanishing — a run that dispatched its cap should say
  // so, not report an empty window.
  let tooYoung = 0;

  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const ev = r.event;
    if (ev !== 'card-pass' && ev !== 'card-fail' && ev !== 'auto-dispatch') continue;
    // An outcome ages by the dispatch it judges; a dispatch ages by itself,
    // because for a dispatch the write IS the event.
    const rowTs = ev === 'auto-dispatch' ? r.ts : outcomeWindowTs(r);
    if (ev === 'auto-dispatch') {
      const t = Date.parse(r.ts || '');
      if (Number.isFinite(t) && t > now - GRACE_MS) { tooYoung++; continue; }
    }
    const within = inWindow(rowTs, cutoff);
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
  // Terse for the same reason as youngNote below: both notes can render on the
  // SAME DEAD message, and digest-autofix.js:187 truncates at 400. With the
  // long form the silent-dispatch branch measured 392 — passing, but eight
  // characters from silently eating its own remediation clause.
  const undatedNote = undated ? ` (${undated} row(s) have unreadable timestamps — writer bug)` : '';
  // Terse on purpose. digest-autofix.js:187 truncates the card body at 400
  // chars, and this note plus undatedNote on a DEAD message measured 436 —
  // over the bound that a test exists specifically to guard (that test only
  // passed because none of its cases set tooYoung). The remediation clause is
  // the part that must survive truncation, so the diagnostics get shortened
  // rather than the instructions.
  const youngNote = tooYoung ? ` (+${tooYoung} launched <${ORPHAN_TIMEOUT_H}h ago, too recent to have reported back)` : '';
  const base = { attempts, passes, fails, dispatched, undated, tooYoung };

  // Launched jobs that never reported back. This is the dead-fleet shape, and it
  // stays detectable when a straggler or two DID report — which `attempts === 0`
  // alone would score as "not enough to judge".
  // Clamped at 0. A dispatch inside the grace is excluded from `dispatched`,
  // but if it has ALREADY been reconciled its outcome still counts in
  // `attempts` — so the subtraction can go negative (3 old dispatches + 3
  // fails + 1 young dispatch + its pass => dispatched 3, attempts 4). It
  // already failed safe, since a negative can never satisfy the `>=` guard
  // below, but "launched jobs that never reported back" has to actually BE a
  // count of those jobs for the guard to keep meaning what it says.
  const silent = Math.max(0, dispatched - attempts);
  if (dispatched >= MIN_OUTCOMES_TO_JUDGE
      && passes === 0
      && silent >= dispatched * SILENT_DISPATCH_RATIO) {
    return {
      ...base,
      rate: attempts ? 0 : null,
      status: 'error',
      message: `Auto-fix loop is DEAD: ${dispatched} job(s) launched in the last ${windowDays}d, ${attempts} reported back, 0 succeeded. `
        + `Check ~/Library/Logs/bsc-jobs/ for a job log that is empty apart from a TIMEOUT marker, then confirm .env still carries ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.${youngNote}${undatedNote}`,
    };
  }

  if (attempts < MIN_OUTCOMES_TO_JUDGE) {
    return {
      ...base,
      rate: attempts ? passes / attempts : null,
      status: 'pass',
      message: `Only ${attempts} auto-fix outcome(s) in the last ${windowDays}d from ${dispatched} launch(es) (need ${MIN_OUTCOMES_TO_JUDGE} to judge)${youngNote}${undatedNote}`,
    };
  }

  const rate = passes / attempts;
  if (passes === 0) {
    return {
      ...base,
      rate,
      status: 'error',
      message: `Auto-fix loop is DEAD: 0 of ${attempts} job(s) succeeded in the last ${windowDays}d. `
        + `Check ~/Library/Logs/bsc-jobs/ for a job log that is empty apart from a TIMEOUT marker, then confirm .env still carries ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.${youngNote}${undatedNote}`,
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
  readLedgerRows,
  CHECK_NAME,
  MIN_OUTCOMES_TO_JUDGE,
  WARN_BELOW_RATE,
  SILENT_DISPATCH_RATIO,
  DEFAULT_WINDOW_DAYS,
};
