/**
 * stuck-card-closer — decide which open cards can be closed because their
 * own check already passes on main (BRO-4523).
 *
 * WHY: the daily done-evidence audit (scripts/audit-done-evidence.js) labels
 * open P0/P1 cards STUCK when the card's own VERIFY command passes on main.
 * 53 cards carried that label on 2026-10-02, 22 of them In Review for up to
 * five weeks. Nothing acted on the label: workers report "in-review" and
 * stop, and the only other closer (the started-zombie sweep, BRO-4510) runs
 * on the Mac and only looks at cards whose dispatch job ended without a
 * report. A card that reported back, or was started from an interactive
 * session, was never revisited.
 *
 * WHY THESE RULES (a passing test alone is not proof the card's work landed;
 * a test that existed before the card was filed passes vacuously):
 *   - a `node --test <one test file>` command: a commit on main naming the
 *     card in its subject (or a Refs/Fixes/Closes trailer) must have touched
 *     that test file after the card was created, and must not be a revert.
 *     That ties the test to this card, so another card sharing the same
 *     command does not matter (BRO-4814: three shared-test cards sat STUCK);
 *   - any other safe-form command (`node scripts/check-x.js --arg ...`): no
 *     other audited card may share it (a generic audit passes for everyone),
 *     and a data/audit/landings.jsonl row whose land/ branch names the card
 *     must postdate the card. land.yml writes that row only after the push
 *     to main succeeded, so the card's work demonstrably landed (BRO-4814:
 *     seven such cards were skipped as "not a single test file");
 *   - the card must be idle (24h In Review, 72h In Progress) so a live
 *     worker is never pre-empted;
 *   - a RECHECK-AFTER date still in the future means the author asked for
 *     the effect to be observed later, so the card is left alone.
 * The close itself goes through linear-brain.js's Done gate, which re-runs
 * the command on a fresh origin/main checkout: two independent verifications.
 *
 * Pure functions only. The CLI is scripts/close-stuck-verified-cards.js.
 */

'use strict';

const { isRealInReview, hasOwnerMarker } = require('./in-review-backlog.js');
const { extractPrRef } = require('./linear-pr-evidence.js');

const HOUR_MS = 60 * 60 * 1000;
const MAX_REPORT_AGE_MS = 6 * HOUR_MS;
const IDLE_MS_BY_STATE = { 'In Review': 24 * HOUR_MS, 'In Progress': 72 * HOUR_MS };
const CARD_TEST_RE = /^node --test (\S+\.test\.(?:mjs|cjs|js))$/;
const RECHECK_AFTER_RE = /RECHECK-AFTER:\s*(\d{4}-\d{2}-\d{2})/g;
const CLOSER_MARKER = 'AUTO-CLOSED by stuck-card-closer';
// In Review cards whose own check FAILS on main go back to Todo for another
// worker (BRO-4535). Each bounce leaves this marker; after MAX_BOUNCES the
// card is reported instead, because a third failure means the check or the
// card needs a person, and another worker would just burn the same budget.
const BOUNCE_MARKER = 'BOUNCED by stuck-card-closer';
const MAX_BOUNCES = 2;
const MAX_BOUNCES_PER_RUN = 10;

function cardTestPath(cmd) {
  const m = CARD_TEST_RE.exec(String(cmd || '').trim());
  return m ? m[1] : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "BRO-71" must not match "BRO-710" or "XBRO-71".
function mentionsCard(message, identifier) {
  if (!message || !identifier) return false;
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRe(identifier)}(?![0-9])`).test(message);
}

// The commit is FOR this card only when the card is in its subject line
// (164 of 166 card-naming commits on main, 2026-10-02) or in a Refs/Fixes/
// Closes trailer. A body that merely cites another card ("the BRO-1397 sweep
// flagged ...") is context, not the landing.
const CARD_TRAILER_RE = /^(?:Refs|Fixes|Closes|Linear)\s*:/i;
function commitIsForCard(message, identifier) {
  const lines = String(message || '').trim().split('\n');
  if (mentionsCard(lines[0], identifier)) return true;
  return lines.slice(1).some((l) => CARD_TRAILER_RE.test(l.trim()) && mentionsCard(l, identifier));
}

/**
 * Pick candidates from a done-evidence audit report.
 * Returns { error } when the report is too old to trust, else
 * { candidates: [{ id, state, cmd, testPath }], skipped: { reason: count } }.
 */
function planCandidates(report, nowMs) {
  const generatedMs = Date.parse(report && report.generatedAt);
  if (!Number.isFinite(generatedMs)) return { error: 'audit report has no generatedAt' };
  if (nowMs - generatedMs > MAX_REPORT_AGE_MS) {
    return { error: `audit report is ${Math.round((nowMs - generatedMs) / HOUR_MS)}h old (max ${MAX_REPORT_AGE_MS / HOUR_MS}h)` };
  }
  const results = Array.isArray(report.results) ? report.results : [];
  const cmdUse = new Map();
  for (const r of results) {
    if (r && r.cmd) cmdUse.set(r.cmd, (cmdUse.get(r.cmd) || 0) + 1);
  }
  const candidates = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const r of results) {
    if (!r || r.verdict !== 'STUCK') continue;
    if (!IDLE_MS_BY_STATE[r.state]) { skip(`state-${r.state}`); continue; }
    if (!Array.isArray(r.channels) || !r.channels.includes('verify-command')) { skip('no-verify-command'); continue; }
    const testPath = cardTestPath(r.cmd);
    if (!testPath && /^node --test\b/.test(String(r.cmd || '').trim())) { skip('command-multi-file-test'); continue; }
    if (!testPath && cmdUse.get(r.cmd) > 1) { skip('command-shared-with-another-card'); continue; }
    candidates.push({ id: r.id, state: r.state, cmd: r.cmd, testPath });
  }
  // The audit stamps openCheckFails only on In Review cards whose own VERIFY
  // command failed twice on main (done-evidence-audit.js classifyCard).
  const bounces = results
    .filter((r) => r && r.openCheckFails && r.state === 'In Review' && r.cmd)
    .map((r) => ({ id: r.id, state: r.state, cmd: r.cmd, failDetail: r.failDetail || null }));
  return { candidates, skipped, bounces };
}

// A land/ branch is for the card when it names it: land/bro-4171-x,
// land/job/linear-BRO-4171-mv3x, land/codex-bro-4408. Case-insensitive
// because branch names are usually lowercased; BRO-71 must not match bro-710.
function branchIsForCard(branch, identifier) {
  if (!branch || !identifier) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(identifier)}(?![0-9])`, 'i').test(branch);
}

/** Parse landings.jsonl text into [{ ts, branch, sha }], skipping bad lines. */
function parseLandingRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.branch && r.sha && r.ts) rows.push({ ts: r.ts, branch: r.branch, sha: r.sha });
    } catch { /* a torn line is not evidence */ }
  }
  return rows;
}

/**
 * BRO-3034 #1a: the newest land/ branch row naming this card, or null.
 * Used for OPEN Backlog/Todo cards (the closer above only sees started ones):
 * a landing that names the card plus its own check passing on main means the
 * work shipped and only the board is stale. A revert branch names the card
 * too but undoes it, so it never counts; a landing later reverted under
 * another name still does, as in decideClosure.
 * @param {string} identifier e.g. "BRO-2942"
 * @param {Array<{ts:string,branch:string,sha:string}>} landings parseLandingRows() output
 * @returns {{ts:string,branch:string,sha:string}|null}
 */
function findCardLanding(identifier, landings) {
  const own = (landings || []).filter((l) => l && !/revert/i.test(l.branch) && branchIsForCard(l.branch, identifier));
  return own.length ? own[own.length - 1] : null;
}

function futureRecheckAfter(texts, nowMs) {
  for (const t of texts) {
    for (const m of String(t || '').matchAll(RECHECK_AFTER_RE)) {
      // The date is checkable from the start of that UTC day.
      if (Date.parse(`${m[1]}T00:00:00Z`) > nowMs) return m[1];
    }
  }
  return null;
}

/**
 * Decide one candidate against the live issue and its landing evidence.
 *   issue:    { state: { name, type }, createdAt, updatedAt, description, comments: [{ body, createdAt }] }
 *   commits:  [{ sha, message }] that touched candidate.testPath since the card was created
 *   landings: [{ ts, branch, sha }] rows of data/audit/landings.jsonl (non-test commands)
 * Returns { close: true, sha, evidence } or { close: false, reason }.
 */
function decideClosure({ candidate, issue, commits, landings, nowMs }) {
  if (!issue) return { close: false, reason: 'issue-not-found' };
  const stateName = issue.state && issue.state.name;
  if (stateName !== candidate.state) return { close: false, reason: 'state-changed-since-audit' };
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  if (comments.some((c) => String(c.body || '').includes(CLOSER_MARKER))) {
    return { close: false, reason: 'closer-already-tried' };
  }
  const lastActivity = Math.max(
    Date.parse(issue.updatedAt) || 0,
    ...comments.map((c) => Date.parse(c.createdAt) || 0),
  );
  if (nowMs - lastActivity < IDLE_MS_BY_STATE[candidate.state]) return { close: false, reason: 'recent-activity' };
  if (futureRecheckAfter([issue.description, ...comments.map((c) => c.body)], nowMs)) {
    return { close: false, reason: 'recheck-after-pending' };
  }
  if (!candidate.testPath) {
    // A generic checker command proves nothing card-specific, so a landing only
    // counts once the worker itself moved the card to In Review (its own claim
    // that the work is finished), and only after the card existed.
    if (candidate.state !== 'In Review') return { close: false, reason: 'landing-evidence-needs-in-review' };
    const createdMs = Date.parse(issue.createdAt);
    if (!Number.isFinite(createdMs)) return { close: false, reason: 'issue-created-unparseable' };
    const landed = (landings || []).filter((l) => !/revert/i.test(l.branch)
      && branchIsForCard(l.branch, candidate.id) && Date.parse(l.ts) > createdMs);
    if (!landed.length) return { close: false, reason: 'no-landing-naming-card' };
    const last = landed[landed.length - 1];
    return { close: true, sha: last.sha, evidence: `land branch ${last.branch}` };
  }
  // A revert names the card too, but it undoes the fix rather than landing it.
  const own = (commits || []).find((c) => !/^Revert\b/.test(String(c.message || '').trim()) && commitIsForCard(c.message, candidate.id));
  if (!own) return { close: false, reason: 'no-commit-naming-card-touched-test' };
  return { close: true, sha: own.sha, evidence: `touched ${candidate.testPath}` };
}

/**
 * Decide whether a failing In Review card goes back to a worker.
 * Returns { bounce: true, priorBounces } or { bounce: false, reason }.
 * 'bounce-exhausted' is reported, never acted on.
 */
function decideBounce({ candidate, issue, nowMs, priorities = [1, 2] }) {
  if (!issue) return { bounce: false, reason: 'issue-not-found' };
  if ((issue.state && issue.state.name) !== 'In Review') return { bounce: false, reason: 'state-changed-since-audit' };
  // Only send back cards an automatic worker will pick up from Todo (the
  // watchdog and the cloud worker take P0/P1 with no headless blocker; the
  // cloud worker's P2/P3 fallback tiers take priorities 3 and 4, so the
  // In Review sweep below passes [1, 2, 3, 4]). Anything else would sit in
  // Todo looking unstarted; leave it In Review.
  if (!priorities.includes(Number(issue.priority))) return { bounce: false, reason: 'no-auto-worker' };
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  const lastActivity = Math.max(
    Date.parse(issue.updatedAt) || 0,
    ...comments.map((c) => Date.parse(c.createdAt) || 0),
  );
  if (nowMs - lastActivity < IDLE_MS_BY_STATE['In Review']) return { bounce: false, reason: 'recent-activity' };
  if (futureRecheckAfter([issue.description, ...comments.map((c) => c.body)], nowMs)) {
    return { bounce: false, reason: 'recheck-after-pending' };
  }
  const { classifyHeadlessDispatchability } = require('./headless-dispatchability.js');
  if (classifyHeadlessDispatchability({ subject: issue.title || '', notes: issue.description || '' }).blockers.length) {
    return { bounce: false, reason: 'no-auto-worker' };
  }
  const priorBounces = comments.filter((c) => String(c.body || '').includes(BOUNCE_MARKER)).length;
  if (priorBounces >= MAX_BOUNCES) return { bounce: false, reason: 'bounce-exhausted' };
  return { bounce: true, priorBounces };
}

function buildBounceComment({ candidate, priorBounces, auditGeneratedAt }) {
  return [
    `${BOUNCE_MARKER} (${priorBounces + 1} of ${MAX_BOUNCES}).`,
    '',
    `This card is In Review, but its own check, \`${candidate.cmd}\`, failed twice on main in the done-evidence audit of ${auditGeneratedAt}.`,
    candidate.failDetail ? `What failed: ${String(candidate.failDetail).slice(0, 500)}` : null,
    'Moved back to Todo so a worker picks it up again. Done means the fix is on main and this check passes there.',
    `After ${MAX_BOUNCES} bounces the closer stops moving this card and reports it instead.`,
  ].filter((l) => l !== null).join('\n');
}

// ── In Review sweep (BRO-5433) ──────────────────────────────────────────
// The audit-driven paths above only see cards the done-evidence audit labels
// STUCK or check-failed. Technical cards a worker parked In Review with a PR
// reference, or with no check at all, matched neither, so nothing ever moved
// them and the morning digest counted them as owner decisions (BRO-3376's
// pile). This class covers the rest: every real In Review card idle 3+ days
// with no owner marker, that no audit path already handles.
const SWEEP_IDLE_MS = 3 * 24 * HOUR_MS;
const MAX_SWEEP_PER_RUN = 25;
// The cloud worker's tiers take Linear priorities 1-4 (P0/P1, then the P2 and
// P3 fallbacks); priority 0 ("none") is never picked, so it is never bounced.
const SWEEP_BOUNCE_PRIORITIES = [1, 2, 3, 4];
const SWEEP_CLOSER_NOTE = 'In Review sweep';
const REFUSED_MARKER = 'closer-sweep-refused';
const REFUSED_COOLDOWN_MS = 7 * 24 * HOUR_MS;

/**
 * Cards for the In Review sweep, oldest-idle first.
 *   issues:     linear.listOpenIssues() rows
 *   handledIds: Set of ids the audit-driven candidates/bounces already cover
 */
function planInReviewSweep(issues, nowMs, handledIds = new Set()) {
  return (issues || [])
    .filter((i) => isRealInReview(i) && !hasOwnerMarker(i) && !handledIds.has(i.identifier))
    .map((i) => ({ id: i.identifier, idle: nowMs - (Date.parse(i.updatedAt) || nowMs) }))
    .filter((c) => c.idle >= SWEEP_IDLE_MS)
    .sort((a, b) => b.idle - a.idle)
    .map((c) => c.id);
}

/**
 * Does the full card carry something the Done gate can verify? (A PR-EVIDENCE
 * line or a safe-form VERIFY command.) Cheap pre-screen only: the gate
 * itself still decides, and re-runs the command on a fresh origin/main.
 */
function hasGateEvidence(issue) {
  const { evaluateVerifiability } = require('./verify-gate.js');
  const comments = (Array.isArray(issue && issue.comments) ? issue.comments : []).map((c) => c && c.body).filter(Boolean);
  if (extractPrRef([issue && issue.description, ...comments].join('\n'))) return true;
  const v = evaluateVerifiability(issue && issue.description, comments);
  return !!(v.armed && v.cmd);
}

/**
 * Decide one sweep card against the full issue.
 * Returns { action: 'try-close' } | { action: 'bounce', priorBounces } | { action: 'leave', reason }.
 * `gateRefused` is true on the second pass, after the Done gate refused the close.
 */
function decideSweep({ issue, nowMs, gateRefused = false }) {
  if (!issue) return { action: 'leave', reason: 'issue-not-found' };
  if ((issue.state && issue.state.name) !== 'In Review') return { action: 'leave', reason: 'state-changed' };
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  // Re-check on the full card, body AND comments: the list query has neither,
  // and a worker's In Review report (where an ask to the owner lives) is a comment.
  const commentText = comments.map((c) => c && c.body).filter(Boolean).join('\n');
  if (hasOwnerMarker({ ...issue, commentText })) return { action: 'leave', reason: 'owner-marker' };
  if (comments.some((c) => String(c.body || '').includes(CLOSER_MARKER))) return { action: 'leave', reason: 'closer-already-tried' };
  // A refusal leaves no marker from linear-brain (it exits before commenting),
  // so the closer posts one itself; without a cooldown the same refused cards
  // would re-run their check every day and starve newer cards.
  const lastRefusal = Math.max(0, ...comments.filter((c) => String(c.body || '').includes(REFUSED_MARKER)).map((c) => Date.parse(c.createdAt) || 0));
  if (lastRefusal && nowMs - lastRefusal < REFUSED_COOLDOWN_MS) return { action: 'leave', reason: 'refused-recently' };
  const lastActivity = Math.max(Date.parse(issue.updatedAt) || 0, ...comments.map((c) => Date.parse(c.createdAt) || 0));
  if (nowMs - lastActivity < SWEEP_IDLE_MS) return { action: 'leave', reason: 'recent-activity' };
  // A fix only observable later is never closed early.
  if (futureRecheckAfter([issue.description, ...comments.map((c) => c.body)], nowMs)) return { action: 'leave', reason: 'recheck-after-pending' };
  if (!gateRefused && hasGateEvidence(issue)) return { action: 'try-close' };
  // No evidence the gate can verify: Todo only helps when a worker can pick the
  // card up. decideBounce refuses cards with no runnable check (the cloud worker
  // skips them too), so those stay In Review and the digest counts them under
  // Technical details. A landing that merely names the card is NOT evidence:
  // it can be a partial or follow-up landing, and the gate would approve a
  // commit that is on main by definition.
  if (!gateRefused) return { action: 'leave', reason: 'no-evidence' };
  const b = decideBounce({ candidate: {}, issue, nowMs, priorities: SWEEP_BOUNCE_PRIORITIES });
  if (!b.bounce) return { action: 'leave', reason: b.reason };
  return { action: 'bounce', priorBounces: b.priorBounces };
}

function buildSweepBounceComment({ priorBounces }) {
  return [
    `${BOUNCE_MARKER} (${priorBounces + 1} of ${MAX_BOUNCES}), ${SWEEP_CLOSER_NOTE}.`,
    '',
    'This card sat In Review 3+ days and the Done gate refused to close it: its recorded evidence did not hold on main.',
    'Moved back to Todo so a worker finishes it. Before moving it to In Review again, add a line starting PR-EVIDENCE with the landed commit URL, or an acceptance command.',
    `After ${MAX_BOUNCES} bounces the closer stops moving this card.`,
  ].join('\n');
}

function buildSweepRefusedComment() {
  return [
    `${REFUSED_MARKER} (${SWEEP_CLOSER_NOTE}).`,
    '',
    'The Done gate refused to close this card and no worker can pick it up automatically, so it stays In Review. The closer will not retry for 7 days.',
  ].join('\n');
}

function buildSweepClosureComment() {
  return [
    `${CLOSER_MARKER} (${SWEEP_CLOSER_NOTE}).`,
    '',
    'This card sat In Review 3+ days with no owner marker. The Done gate accepted its recorded evidence against a fresh copy of main, so the board is closed out here.',
    'If the problem is still happening, reopen the card and say what you saw.',
  ].join('\n');
}

// How many cards one run may close. The real limiter is time: every close
// re-runs the card's check through the Done gate on a fresh origin/main
// checkout, so quick checks close many cards per run and slow ones few. The
// count ceiling only bounds the damage if the closer itself has a bug.
const MAX_CLOSES_PER_RUN = 50;
// The closer and the Done gate read the same check. When the gate keeps
// refusing what the closer picked, they disagree, and closing more on that
// run would be guessing. Stop and let the report show it.
const MAX_REFUSALS_PER_RUN = 3;

/**
 * Why the apply loop must stop before the next close, or null to go on.
 * @param {{closed:number, refused:number, remainingMs:number, closeTimeoutMs:number}} s
 */
function closeRunStopReason({ closed, refused, remainingMs, closeTimeoutMs }) {
  if (refused >= MAX_REFUSALS_PER_RUN) return 'refusal-breaker';
  if (closed >= MAX_CLOSES_PER_RUN) return 'over-run-cap';
  if (remainingMs < closeTimeoutMs) return 'over-time-budget';
  return null;
}

function buildClosureComment({ candidate, sha, auditGeneratedAt }) {
  return [
    `${CLOSER_MARKER}.`,
    '',
    `This card's own check, \`${candidate.cmd}\`, passed on main in the done-evidence audit of ${auditGeneratedAt}.`,
    candidate.testPath
      ? `Commit ${String(sha).slice(0, 12)} names this card and changed ${candidate.testPath} after the card was filed, so the work landed.`
      : `Commit ${String(sha).slice(0, 12)} reached main through a land/ branch naming this card after the card was filed, so the work landed.`,
    'The close went through the Done gate, which runs the check again on a fresh copy of main.',
    'If the problem is still happening, reopen the card and say what you saw.',
  ].join('\n');
}

module.exports = {
  MAX_REPORT_AGE_MS,
  IDLE_MS_BY_STATE,
  MAX_CLOSES_PER_RUN,
  MAX_REFUSALS_PER_RUN,
  CLOSER_MARKER,
  BOUNCE_MARKER,
  MAX_BOUNCES,
  MAX_BOUNCES_PER_RUN,
  cardTestPath,
  mentionsCard,
  branchIsForCard,
  parseLandingRows,
  findCardLanding,
  commitIsForCard,
  planCandidates,
  futureRecheckAfter,
  decideClosure,
  buildClosureComment,
  decideBounce,
  buildBounceComment,
  closeRunStopReason,
  SWEEP_IDLE_MS,
  MAX_SWEEP_PER_RUN,
  SWEEP_BOUNCE_PRIORITIES,
  planInReviewSweep,
  hasGateEvidence,
  decideSweep,
  buildSweepBounceComment,
  buildSweepClosureComment,
  buildSweepRefusedComment,
  REFUSED_MARKER,
};
