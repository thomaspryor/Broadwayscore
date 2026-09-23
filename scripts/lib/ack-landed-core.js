/**
 * ack-landed-core.js — the pure decision behind scripts/ack-landed.js.
 *
 * Gate O v2 (~/.claude/hooks/exit-status-gate.sh) refuses a dispatching
 * session's CLOSE ME / IDLE until the dispatch ledger's newest row for each
 * DISPATCHED: ref is terminal-and-landed. bsc-runner classifies a headless
 * job whose final text lacked a `THIS SESSION:` line as job-stopped-short
 * even when its commits genuinely reached origin/main (linear:BRO-3535,
 * 2026-09-16), and nothing sanctioned could record "the owning session
 * verified this by hand". This module decides whether such an ack is
 * legitimate; the CLI gathers the facts (git, ledger, the verify run) and
 * writes the `landed-acked` row only when decideAck() says ok.
 *
 * Every refusal is a real precondition, not a formality (pre-implementation
 * review, 2026-09-16): a `--sha $(git rev-parse origin/main)` rubber stamp
 * is rejected because the sha must be tied to the job (committed after the
 * launch row and naming the ref, or descending from the sha a job-stranded
 * row recorded); the verify command must be safe-form AND exit 0 in a
 * checkout that already contains the sha with clean code paths; and a
 * newest row of job-done / landed-acked means there is nothing to ack.
 *
 * Pure: no fs, no git, no child processes. CLAUDE.md §15 — the test
 * require()s this file.
 */
'use strict';

const MIN_REASON_CHARS = 15;
// bsc-runner writes the terminal row moments after the job process exits; a
// commit stamped a little after it (clock skew, a push racing the exit) is
// still plausibly the job's. Same 5-minute skew convention as
// dispatch-ledger.js's FUTURE_TS_GRACE_MS.
const COMMIT_AFTER_TERMINAL_GRACE_MS = 5 * 60 * 1000;

// Terminal rows an ack may follow. job-done and landed-acked are terminal
// too, but there is nothing left to ack after them (Gate O already accepts
// job-done with a LANDED: line; a second ack would only be noise).
// watchdog-park (scripts/lib/dispatch-watchdog-core.js WATCHDOG_EVENTS.PARK)
// is terminal for the job too: the watchdog writes it only after its
// redispatch retries are exhausted (or a permanent guard refusal), with the
// job process already dead, and nothing but a NEW launch clears it — exactly
// the "owner lands the dead job's branch by hand" case this ack exists for
// (linear:BRO-3866, 2026-09-20). job-abandoned is deliberately NOT here: the
// ledger defines it as not dead-like (a lease-held abandon means a DIFFERENT
// job for the task is healthy), so there is no dead job to ack.
const ACKABLE_TERMINAL_EVENTS = new Set([
  'job-stopped-short', 'job-stranded', 'job-blocked', 'job-failed',
  'job-orphaned', 'prune-closed', 'dead', 'vanished', 'watchdog-park',
]);
const NOTHING_TO_ACK_EVENTS = new Set(['job-done', 'landed-acked']);
const LAUNCH_EVENTS = new Set(['launch', 'job-spawned']);

// Same taskId match Gate O v2 uses (`tid == i or tid.endswith(':' + i)`), in
// FILE ORDER — the ledger is append-only and the hook reads it the same way.
function rowsForRef(entries, ref) {
  const want = String(ref || '').toUpperCase();
  return (entries || []).filter((e) => {
    const tid = String((e && e.taskId) || '').toUpperCase();
    return tid === want || tid.endsWith(':' + want);
  });
}

function normalizeRef(raw) {
  const m = /^(?:linear:)?(BRO-\d+)$/i.exec(String(raw || '').trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Scope ref-rows (already filtered by rowsForRef) down to ONE dispatch
 * attempt by jobId — the fix for "ack-landed keys every precondition to the
 * LATEST dispatch" (BRO-4066). A card re-dispatched after its EARLIER
 * attempt had already landed leaves that earlier attempt's own launch/
 * terminal rows buried under the later attempt's — ledgerPrecondition()
 * always reads `rows[rows.length - 1]` as "newest", so it evaluates every
 * precondition (terminal-ness, the launch timestamp the sha is tied to)
 * against the WRONG attempt. Real case: linear:BRO-3924's first job landed
 * 8df620cc09d, then ended job-stopped-short only for a missing status line;
 * a --force re-dispatch verified the landing and moved the card Done, wrote
 * no commit of its own, and ALSO ended job-stopped-short — leaving no row
 * whose "newest" is the first job's own landed work.
 *
 * When jobId is omitted this is a no-op (identical to today's
 * latest-attempt behavior) — every existing caller that doesn't pass one
 * keeps working unchanged.
 * @param {object[]} rows  rows already scoped to the ref (rowsForRef output)
 * @param {string|null} jobId
 * @param {string} ref  for the refusal message only
 * @returns {{rows: object[], refusal: string|null}}
 */
function rowsForJobId(rows, jobId, ref) {
  if (!jobId) return { rows: rows || [], refusal: null };
  const scoped = (rows || []).filter((r) => r && r.jobId === jobId);
  if (!scoped.length) {
    return {
      rows: [],
      refusal: `--job-id ${jobId} has no ledger rows under ${ref} — it must be a jobId from this card's own dispatch history (see the launch/job-spawned rows)`,
    };
  }
  return { rows: scoped, refusal: null };
}

/**
 * Cheap ledger-only precondition, run BEFORE any git fetch or verify command
 * so a plainly un-ackable ref refuses in milliseconds.
 * @returns {{refusals: string[], newest: object|null, launch: object|null, stranded: object|null}}
 */
function ledgerPrecondition(rows) {
  const refusals = [];
  const list = rows || [];
  if (!list.length) {
    return { refusals: ['no dispatch-ledger row for this ref — nothing was dispatched under it'], newest: null, launch: null, stranded: null };
  }
  const newest = list[list.length - 1];
  const ev = String(newest.event || '');
  if (NOTHING_TO_ACK_EVENTS.has(ev)) {
    refusals.push(ev === 'job-done'
      ? 'newest ledger row is job-done — nothing to ack; Gate O already accepts it with a LANDED: line'
      : `newest ledger row is already landed-acked (${newest.ts || '?'}) — do not double-ack`);
  } else if (!ACKABLE_TERMINAL_EVENTS.has(ev)) {
    refusals.push(`newest ledger row is ${ev || '(no event)'} (${newest.ts || '?'}) — not a terminal event; the job is still open or a relaunch superseded the one you verified`);
  }
  let launch = null;
  let launchVerifyCmd = null; // only 'launch' rows carry verifyCmd; job-spawned does not
  let stranded = null;
  for (const r of list) {
    if (LAUNCH_EVENTS.has(String(r.event))) launch = r;
    if (String(r.event) === 'launch' && r.verifyCmd) launchVerifyCmd = String(r.verifyCmd);
    if (String(r.event) === 'job-stranded' && r.sha) stranded = r;
  }
  if (!launch) refusals.push('no launch/job-spawned row for this ref — cannot tie a sha to a dispatch that was never recorded');
  return { refusals, newest, launch, launchVerifyCmd, stranded };
}

// The EARLIEST launch/job-spawned row across ALL of a ref's ledger rows —
// deliberately NOT ledgerPrecondition's `launch` (that resolves to the MOST
// RECENT launch in scope, right for decideAck's "tie this sha to THIS
// attempt," wrong here: decideAlreadyLanded's claim is "before ANY dispatch
// on its ledger" (BRO-4069), i.e. before every attempt, not just the latest
// one. A sha that predates only the latest of several attempts could still
// be an EARLIER attempt's own legitimate work — decideAck --job-id is the
// correct tool for that shape, not this one (pre-implementation review,
// 2026-09-23: comparing against the latest launch would silently mislabel a
// real earlier landing as "no dispatch needed").
function earliestLaunch(rows) {
  let earliest = null;
  let earliestTs = Infinity;
  for (const r of rows || []) {
    if (!LAUNCH_EVENTS.has(String(r.event))) continue;
    const ts = Date.parse(r.ts || '');
    if (Number.isFinite(ts) && ts < earliestTs) { earliestTs = ts; earliest = r; }
  }
  return earliest;
}

// Shared mechanical checks between decideAck and decideAlreadyLanded — the
// checkout/verify/reason gates are identical in both; factored out so the
// two decision functions can't drift apart on these while their sha-timing
// and event-shape logic (the part that's actually different) stay separate,
// readable functions per BRO-4069's design ask for a DISTINCT verdict.
function checkoutRefusals(checkout) {
  const refusals = [];
  if (!checkout.containsSha) {
    refusals.push('the checkout the verify command would run in does not contain the sha yet — pull origin/main there first');
  }
  if (Array.isArray(checkout.dirtyCodePaths) && checkout.dirtyCodePaths.length) {
    refusals.push(`the checkout has uncommitted code changes (${checkout.dirtyCodePaths.slice(0, 5).join(', ')}${checkout.dirtyCodePaths.length > 5 ? ', …' : ''}) — a verify run there would not prove origin/main`);
  }
  return refusals;
}

function verifyRefusals(verify) {
  if (!verify.cmd) return ['--verify is required (a safe-form acceptance command)'];
  if (!verify.safe) return [`--verify is not a safe-form command: ${verify.unsafeReason || 'rejected by the allowlist'}`];
  if (verify.exitCode !== 0) return [`verify command exited ${verify.exitCode === null || verify.exitCode === undefined ? '(not run)' : verify.exitCode}, not 0: ${verify.cmd}`];
  return [];
}

function reasonRefusals(reason) {
  const reasonText = String(reason || '').trim();
  if (reasonText.length < MIN_REASON_CHARS) {
    return [`--reason must be at least ${MIN_REASON_CHARS} characters (got ${reasonText.length})`];
  }
  return [];
}

/**
 * @param {object} input
 * @param {string} input.ref            e.g. 'BRO-3535'
 * @param {object[]} input.rows         ledger rows for the ref, file order
 * @param {string} [input.jobId]        scope every precondition to THIS
 *   dispatch attempt (see rowsForJobId above) instead of the ref's latest.
 *   Omitted = today's latest-attempt behavior, unchanged.
 * @param {object} input.landing        {verdict:'LANDED'|'NOT_LANDED'|'UNKNOWN', sha, commitTs, authorTs, message, tiedToStranded}
 *   commitTs: committer date (%cI); authorTs: author date (%aI), optional —
 *   when present it is the timestamp the job window is checked against,
 *   because scripts/land.js REBASES before pushing, which re-stamps the
 *   committer date at landing time while the author date stays the job's.
 *   tiedToStranded: sha === the job-stranded row's sha, or sha is an ancestor of it
 * @param {object} input.checkout       {containsSha:boolean, dirtyCodePaths:string[]}
 * @param {object} input.verify         {cmd, safe:boolean, unsafeReason, exitCode:number|null}
 * @param {string} input.reason
 * @param {string} [input.ackedBy]
 */
function decideAck(input) {
  const { ref, rows, jobId, landing = {}, checkout = {}, verify = {}, reason, ackedBy } = input || {};
  const scoped = rowsForJobId(rows, jobId, ref);
  const refusals = scoped.refusal ? [scoped.refusal] : [];
  const pre = scoped.refusal
    ? { refusals: [], newest: null, launch: null, launchVerifyCmd: null, stranded: null }
    : ledgerPrecondition(scoped.rows);
  refusals.push(...pre.refusals);
  const { newest, launch, launchVerifyCmd, stranded } = pre;

  if (landing.verdict !== 'LANDED') {
    refusals.push(`${landing.sha || '<sha>'} is not an ancestor of origin/main after a fresh fetch (verdict ${landing.verdict || 'missing'}${landing.reason ? ', ' + landing.reason : ''})`);
  }
  // Tie the sha to THIS job, both ways (ship-check blocker 2026-09-16: with
  // only a lower bound, `git commit --allow-empty -m "BRO-N ack" && git push`
  // after the job died satisfied every check). The commit must be AUTHORED
  // after the launch AND before the terminal row (+skew) — the job had
  // already exited when that row was written, so anything authored later is
  // not its work. The author date is the one that survives scripts/land.js
  // (rebase → push re-stamps only the committer date), so a dead job's branch
  // landed by the owner an hour later still ties; an empty post-mortem
  // commit does not (authored now, after the terminal row). Fixtures/callers
  // without authorTs fall back to commitTs.
  // job-stranded is the one legitimate later-push case (the owner lands the
  // job's own stranded sha afterwards), so there the tie is the stranded sha
  // itself: --sha must BE it, or be a commit it descends from.
  const isStranded = Boolean(newest && String(newest.event) === 'job-stranded' && stranded);
  const workTsRaw = landing.authorTs || landing.commitTs || '';
  const workTs = Date.parse(workTsRaw);
  if (!Number.isFinite(workTs)) {
    refusals.push('could not read the commit timestamp for the sha');
  } else if (launch) {
    const launchTs = Date.parse(launch.ts || '');
    if (Number.isFinite(launchTs) && workTs <= launchTs) {
      refusals.push(`the sha was authored at ${workTsRaw}, BEFORE this dispatch launched (${launch.ts}) — it cannot be this job's work`);
    }
    const endTs = Date.parse((newest && newest.ts) || '');
    if (!isStranded && Number.isFinite(endTs) && workTs > endTs + COMMIT_AFTER_TERMINAL_GRACE_MS) {
      refusals.push(`the sha was authored at ${workTsRaw}, AFTER the job's terminal ${newest.event} row (${newest.ts}) — the job had already exited, so this is not its work (only job-stranded may be acked with a later landing, via the stranded sha)`);
    }
  }
  const refRe = new RegExp(`(?<![\\w-])${String(ref || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
  const namesRef = refRe.test(String(landing.message || ''));
  if (isStranded) {
    if (!landing.tiedToStranded) {
      refusals.push(`for a job-stranded row the sha must be the stranded sha ${stranded.sha} itself or an ancestor of it (the stranded job's own history) — got ${landing.sha || '<sha>'}`);
    }
  } else if (!namesRef) {
    refusals.push(`the sha's commit message does not name ${ref} — pass the job's own commit, not an unrelated one`);
  }

  refusals.push(...checkoutRefusals(checkout));
  refusals.push(...verifyRefusals(verify));
  refusals.push(...reasonRefusals(reason));

  const reasonText = String(reason || '').trim();
  const ok = refusals.length === 0;
  const row = ok ? {
    event: 'landed-acked',
    taskId: (newest && newest.taskId) || `linear:${ref}`,
    jobId: (newest && newest.jobId) || (launch && launch.jobId) || null,
    sha: landing.sha,
    strandedSha: isStranded ? stranded.sha : undefined,
    verifyCmd: verify.cmd,
    launchVerifyCmd: launchVerifyCmd || null,
    reason: reasonText,
    ackedBy: ackedBy || 'manual',
    priorEvent: newest ? newest.event : null,
  } : null;
  return { ok, refusals, row, newest, launch };
}

/**
 * BRO-4069 — the sibling case decideAck cannot express: the ref's real work
 * landed on origin/main BEFORE any dispatch attempt on its ledger even
 * launched (a stale/mistaken re-dispatch of an already-done card). decideAck
 * ties a sha to ONE attempt by requiring it be authored AFTER that attempt's
 * launch; when the sha genuinely predates every attempt, that tie can never
 * pass, and the card can never acquire a clean terminal ledger row (real
 * case: linear:BRO-3471, landed 2026-09-15T21:33-04:00, re-dispatched by
 * mistake on 2026-09-20 and 2026-09-21, both retracted no-ops).
 *
 * Asserts the OPPOSITE timing from decideAck: the sha must be authored
 * before the EARLIEST launch/job-spawned row across the ref's WHOLE ledger
 * (earliestLaunch, not ledgerPrecondition's scoped/latest `launch` — see
 * that function's header for why the latest launch would be the wrong
 * comparison here). No --job-id support: "before ANY dispatch" is a
 * ledger-wide claim, not an attempt-scoped one, so callers must not scope
 * `rows` before passing them in.
 *
 * Otherwise unchanged from decideAck: fresh-origin/main ancestry, the
 * commit message must still name the ref (the one guard against an
 * unrelated earlier commit being passed off as "the card's prior landing"),
 * checkout must contain the sha with clean code paths, --verify must be
 * safe-form and exit 0, --reason >= MIN_REASON_CHARS. Writes
 * 'landed-before-dispatch' (JOB_EVENTS.LANDED_BEFORE_DISPATCH in
 * dispatch-ledger.js), never 'landed-acked' — a distinct event so a no-op
 * re-dispatch is never misrecorded as this job's own productive work.
 *
 * @param {object} input
 * @param {string} input.ref     e.g. 'BRO-3471'
 * @param {object[]} input.rows  ALL ledger rows for the ref (rowsForRef output, unscoped)
 * @param {object} input.landing  same shape as decideAck's input.landing
 * @param {object} input.checkout {containsSha:boolean, dirtyCodePaths:string[]}
 * @param {object} input.verify   {cmd, safe:boolean, unsafeReason, exitCode:number|null}
 * @param {string} input.reason
 * @param {string} [input.ackedBy]
 */
function decideAlreadyLanded(input) {
  const { ref, rows, landing = {}, checkout = {}, verify = {}, reason, ackedBy } = input || {};
  const pre = ledgerPrecondition(rows);
  const refusals = [...pre.refusals];
  const { newest } = pre;
  const launch = earliestLaunch(rows);
  if (!launch) refusals.push('no launch/job-spawned row for this ref — cannot compare a sha against a dispatch that was never recorded');

  if (landing.verdict !== 'LANDED') {
    refusals.push(`${landing.sha || '<sha>'} is not an ancestor of origin/main after a fresh fetch (verdict ${landing.verdict || 'missing'}${landing.reason ? ', ' + landing.reason : ''})`);
  }

  const workTsRaw = landing.authorTs || landing.commitTs || '';
  const workTs = Date.parse(workTsRaw);
  if (!Number.isFinite(workTs)) {
    refusals.push('could not read the commit timestamp for the sha');
  } else if (launch) {
    const launchTs = Date.parse(launch.ts || '');
    if (Number.isFinite(launchTs) && workTs >= launchTs) {
      refusals.push(`the sha was authored at ${workTsRaw}, not before the ref's earliest dispatch launch (${launch.ts}) — --already-landed only covers work that predates every attempt on this ledger; if this sha is a LATER attempt's own work, use decideAck (optionally with --job-id) instead`);
    }
  }

  const refRe = new RegExp(`(?<![\\w-])${String(ref || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
  if (!refRe.test(String(landing.message || ''))) {
    refusals.push(`the sha's commit message does not name ${ref} — pass the card's own prior landing commit, not an unrelated one`);
  }

  refusals.push(...checkoutRefusals(checkout));
  refusals.push(...verifyRefusals(verify));
  refusals.push(...reasonRefusals(reason));

  const reasonText = String(reason || '').trim();
  const ok = refusals.length === 0;
  const row = ok ? {
    event: 'landed-before-dispatch',
    taskId: (newest && newest.taskId) || `linear:${ref}`,
    jobId: (newest && newest.jobId) || (launch && launch.jobId) || null,
    sha: landing.sha,
    verifyCmd: verify.cmd,
    reason: reasonText,
    ackedBy: ackedBy || 'manual',
    priorEvent: newest ? newest.event : null,
  } : null;
  return { ok, refusals, row, newest, launch };
}

function formatAckLine(ref, row) {
  return `ACKED: ${ref} — ${row.sha} on origin/main, ${row.verifyCmd} exit 0`;
}

module.exports = {
  MIN_REASON_CHARS, COMMIT_AFTER_TERMINAL_GRACE_MS, ACKABLE_TERMINAL_EVENTS, NOTHING_TO_ACK_EVENTS,
  rowsForRef, rowsForJobId, normalizeRef, ledgerPrecondition, earliestLaunch,
  decideAck, decideAlreadyLanded, formatAckLine,
};
