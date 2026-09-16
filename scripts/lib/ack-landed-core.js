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

// Terminal rows an ack may follow. job-done and landed-acked are terminal
// too, but there is nothing left to ack after them (Gate O already accepts
// job-done with a LANDED: line; a second ack would only be noise).
const ACKABLE_TERMINAL_EVENTS = new Set([
  'job-stopped-short', 'job-stranded', 'job-blocked', 'job-failed',
  'job-orphaned', 'prune-closed', 'dead', 'vanished',
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
  let stranded = null;
  for (const r of list) {
    if (LAUNCH_EVENTS.has(String(r.event))) launch = r;
    if (String(r.event) === 'job-stranded' && r.sha) stranded = r;
  }
  if (!launch) refusals.push('no launch/job-spawned row for this ref — cannot tie a sha to a dispatch that was never recorded');
  return { refusals, newest, launch, stranded };
}

/**
 * @param {object} input
 * @param {string} input.ref            e.g. 'BRO-3535'
 * @param {object[]} input.rows         ledger rows for the ref, file order
 * @param {object} input.landing        {verdict:'LANDED'|'NOT_LANDED'|'UNKNOWN', sha, commitTs, message, descendsFromStranded}
 * @param {object} input.checkout       {containsSha:boolean, dirtyCodePaths:string[]}
 * @param {object} input.verify         {cmd, safe:boolean, unsafeReason, exitCode:number|null}
 * @param {string} input.reason
 * @param {string} [input.ackedBy]
 */
function decideAck(input) {
  const { ref, rows, landing = {}, checkout = {}, verify = {}, reason, ackedBy } = input || {};
  const pre = ledgerPrecondition(rows);
  const refusals = [...pre.refusals];
  const { newest, launch, stranded } = pre;

  if (landing.verdict !== 'LANDED') {
    refusals.push(`${landing.sha || '<sha>'} is not an ancestor of origin/main after a fresh fetch (verdict ${landing.verdict || 'missing'}${landing.reason ? ', ' + landing.reason : ''})`);
  }
  if (launch) {
    const launchTs = Date.parse(launch.ts || '');
    const commitTs = Date.parse(landing.commitTs || '');
    if (!Number.isFinite(commitTs)) {
      refusals.push('could not read the commit timestamp for the sha');
    } else if (Number.isFinite(launchTs) && commitTs <= launchTs) {
      refusals.push(`the sha was committed at ${landing.commitTs}, BEFORE this dispatch launched (${launch.ts}) — it cannot be this job's work`);
    }
  }
  const refRe = new RegExp(`(?<![\\w-])${String(ref || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
  const namesRef = refRe.test(String(landing.message || ''));
  const viaStranded = Boolean(stranded && landing.descendsFromStranded);
  if (!namesRef && !viaStranded) {
    refusals.push(stranded
      ? `the sha neither names ${ref} in its commit message nor descends from the job-stranded row's sha ${stranded.sha}`
      : `the sha's commit message does not name ${ref} — pass the job's own commit, not an unrelated one`);
  }

  if (!checkout.containsSha) {
    refusals.push('the checkout the verify command would run in does not contain the sha yet — pull origin/main there first');
  }
  if (Array.isArray(checkout.dirtyCodePaths) && checkout.dirtyCodePaths.length) {
    refusals.push(`the checkout has uncommitted code changes (${checkout.dirtyCodePaths.slice(0, 5).join(', ')}${checkout.dirtyCodePaths.length > 5 ? ', …' : ''}) — a verify run there would not prove origin/main`);
  }

  if (!verify.cmd) {
    refusals.push('--verify is required (a safe-form acceptance command)');
  } else if (!verify.safe) {
    refusals.push(`--verify is not a safe-form command: ${verify.unsafeReason || 'rejected by the allowlist'}`);
  } else if (verify.exitCode !== 0) {
    refusals.push(`verify command exited ${verify.exitCode === null || verify.exitCode === undefined ? '(not run)' : verify.exitCode}, not 0: ${verify.cmd}`);
  }

  const reasonText = String(reason || '').trim();
  if (reasonText.length < MIN_REASON_CHARS) {
    refusals.push(`--reason must be at least ${MIN_REASON_CHARS} characters (got ${reasonText.length})`);
  }

  const ok = refusals.length === 0;
  const row = ok ? {
    event: 'landed-acked',
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
  MIN_REASON_CHARS, ACKABLE_TERMINAL_EVENTS, NOTHING_TO_ACK_EVENTS,
  rowsForRef, normalizeRef, ledgerPrecondition, decideAck, formatAckLine,
};
