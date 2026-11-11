'use strict';

/**
 * ack-landed-stranded-triage.js (BRO-4081): pure decisions for triaging cards
 * whose NEWEST dispatch-ledger row is job-stopped-short or job-stranded but
 * whose work may already be on origin/main.
 *
 * The card's evidence found 18 of 25 such cards with a commit naming them on
 * origin/main, and warned that several hits are only "Merge branch
 * job/linear-BRO-N-..." or "data: linear-gate-bypass ledger entry" commits,
 * which are not proof the work landed. This module is the one place that
 * judges that, so the CLI (scripts/ack-landed-stranded-triage.js) and its
 * test share the real logic. It never writes anything: the CLI hands each
 * 'ack' decision to scripts/ack-landed.js, which re-checks every
 * precondition itself (fresh fetch, sha window, verify command exits 0).
 */

const { messageNamesRef, isBookkeepingPath } = require('./ack-landed-core.js');

const COMMENT_MARKER = 'BRO-4081 stranded-job triage';
const STRANDED_EVENTS = new Set(['job-stopped-short', 'job-stranded']);

function refFromTaskId(taskId) {
  const m = /^(?:linear:)?(BRO-\d+)$/i.exec(String(taskId || '').trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Refs whose newest ledger row (file order: the ledger is append-only) is a
 * stranded/stopped-short row. A later landed-acked, job-done or relaunch row
 * means the card was already handled or is being worked again.
 * @returns {{ref:string, row:object}[]} in first-seen order
 */
function newestStrandedByRef(entries) {
  const newest = new Map();
  for (const e of entries || []) {
    const ref = refFromTaskId(e && e.taskId);
    if (ref) newest.set(ref, e);
  }
  const out = [];
  for (const [ref, row] of newest) {
    if (STRANDED_EVENTS.has(row.event)) out.push({ ref, row });
  }
  return out;
}

/**
 * Why a commit naming the card is NOT proof its work landed, or null when it
 * is real work. commit: { sha, subject, files: string[] }.
 */
function nonProofReason(commit, ref) {
  const subject = String((commit && commit.subject) || '');
  if (/^Merge\b/i.test(subject)) return 'merge commit';
  if (/linear-gate-bypass ledger entry/i.test(subject)) return 'gate-bypass ledger entry';
  const files = (commit && commit.files) || [];
  if (files.length === 0) return 'no files changed';
  if (files.every(isBookkeepingPath)) return 'bookkeeping paths only';
  if (ref && !messageNamesRef(subject, ref) && !messageNamesRef(commit.body, ref)) return 'does not name the card (substring match only)';
  return null;
}

/**
 * One card's triage decision.
 * input: { ref, row, commits: [{sha, subject, body, files}], verifyCmd }
 * verifyCmd is the card's safe-form VERIFY command, already gated by
 * isSafeCheckCommand (or null).
 * @returns {{ref, action:'ack'|'needs-verify'|'not-landed', detail:string,
 *   proofShas:string[], ackArgs?:string[], comment?:string}}
 */
function triageCard(input) {
  const { ref, row } = input;
  const commits = input.commits || [];
  const proof = [];
  const rejected = [];
  for (const c of commits) {
    const why = nonProofReason(c, ref);
    if (why) rejected.push(`${String(c.sha).slice(0, 11)} (${why})`);
    else proof.push(c.sha);
  }
  const base = { ref, proofShas: proof };

  if (proof.length === 0) {
    const detail = commits.length === 0
      ? 'no commit on origin/main names this card'
      : `only non-proof commits name it: ${rejected.join(', ')}`;
    return {
      ...base,
      action: 'not-landed',
      detail,
      comment: [
        `${COMMENT_MARKER}: not acked.`,
        ``,
        `The newest dispatch-ledger row for ${ref} is \`${row && row.event}\`${row && row.ts ? ` (${row.ts})` : ''}, and the work is not provably on origin/main: ${detail}.`,
        `The card stays open for its next worker; nothing on it was changed.`,
      ].join('\n'),
    };
  }

  if (!input.verifyCmd) {
    return {
      ...base,
      action: 'needs-verify',
      detail: `work commit(s) ${proof.map(s => String(s).slice(0, 11)).join(', ')} on origin/main, but the card has no safe-form VERIFY command for ack-landed`,
    };
  }

  const reason = `${COMMENT_MARKER}: newest ledger row was ${row && row.event}, and commit ${String(proof[0]).slice(0, 11)} naming ${ref} (not a merge or ledger-only commit) is on origin/main.`;
  return {
    ...base,
    action: 'ack',
    detail: `proof=${proof.map(s => String(s).slice(0, 11)).join(',')} verify="${input.verifyCmd}"`,
    // No --sha: ack-landed.js derives it from the card's own window (BRO-4078).
    ackArgs: ['--id', ref, '--verify', input.verifyCmd, '--reason', reason],
  };
}

/**
 * The card's current safe-form VERIFY command: the newest comment carrying one
 * wins over the description (BRO-4081 itself had its owner-judgment VERIFY
 * replaced by a comment). extract(text) -> {cmd} is extractVerifyCmd bound to
 * the isSafeCheckCommand gate, so a comment can never arm an unsafe command.
 */
function currentVerifyCmd(issue, extract) {
  if (!issue) return null;
  const comments = ((issue.comments && issue.comments.nodes) || []).slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const text of [...comments.map(c => c && c.body), issue.description]) {
    const ext = extract(String(text || ''));
    if (ext && ext.cmd) return ext.cmd;
  }
  return null;
}

// A re-run of --apply must not post the same explanation twice.
function hasTriageComment(issue) {
  return ((issue && issue.comments && issue.comments.nodes) || [])
    .some(c => String((c && c.body) || '').includes(COMMENT_MARKER));
}

module.exports = { COMMENT_MARKER, hasTriageComment, STRANDED_EVENTS, refFromTaskId, newestStrandedByRef, nonProofReason, triageCard, currentVerifyCmd };
