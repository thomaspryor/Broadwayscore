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
 *   - the command must be a test run, `node --test` or `npx tsx --test` over
 *     one or more test files, that the shared safe-form gate
 *     (autonomous-triage-core.js isSafeCheckCommand) accepts, and no other
 *     audited card may use the identical command, so the test is this card's own;
 *   - the work demonstrably landed, by one of two routes:
 *       commit route: a commit on main naming the card in its subject (or a
 *       Refs/Fixes/Closes trailer) touched one of those test files after the
 *       card was created, and is not a revert;
 *       land route (BRO-4814): a Land run for a land/** ref naming the card
 *       succeeded after the card was created, every land/** ref naming the
 *       card is gone from origin (Land deletes the ref it lands) or sits at a
 *       tip Land already landed, some non-revert
 *       commit touched one of the test files after the card was created, no
 *       revert naming the card touched them, and no other audited card's
 *       command names any of the same files. This catches work landed with a
 *       commit subject that never named the card (27 of 44 In Review cards on
 *       2026-10-06 were done and sat up to 46 days for that reason);
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

const HOUR_MS = 60 * 60 * 1000;
const MAX_REPORT_AGE_MS = 6 * HOUR_MS;
const IDLE_MS_BY_STATE = { 'In Review': 24 * HOUR_MS, 'In Progress': 72 * HOUR_MS };
// Only a test run counts as the card's own check; the shapes (and every path
// check: traversal, allowed directories, mutating scripts) come from the one
// safe-form gate every VERIFY command already passes, never a local copy.
const TEST_RUNNER_RE = /^(?:node|npx tsx) --test(?: |$)/;
const NO_OWN_COMMIT = 'no-commit-naming-card-touched-test';
const RECHECK_AFTER_RE = /RECHECK-AFTER:\s*(\d{4}-\d{2}-\d{2})/g;
const CLOSER_MARKER = 'AUTO-CLOSED by stuck-card-closer';
// In Review cards whose own check FAILS on main go back to Todo for another
// worker (BRO-4535). Each bounce leaves this marker; after MAX_BOUNCES the
// card is reported instead, because a third failure means the check or the
// card needs a person, and another worker would just burn the same budget.
const BOUNCE_MARKER = 'BOUNCED by stuck-card-closer';
const MAX_BOUNCES = 2;
const MAX_BOUNCES_PER_RUN = 10;

/** The test files a `node --test`/`npx tsx --test` VERIFY runs, or null for any other or unsafe command. */
function cardTestPaths(cmd) {
  const s = String(cmd || '').trim();
  if (!TEST_RUNNER_RE.test(s)) return null;
  const { isSafeCheckCommand, extractCheckPaths } = require('./autonomous-triage-core.js');
  if (!isSafeCheckCommand(s)) return null;
  const paths = [...new Set(extractCheckPaths(s))];
  return paths.length && paths.every((p) => /\.test\.(?:m?js|ts)$/.test(p)) ? paths : null;
}

function cardTestPath(cmd) {
  const paths = cardTestPaths(cmd);
  return paths ? paths[0] : null;
}

function cardNumber(identifier) {
  const m = /^BRO-(\d+)$/.exec(String(identifier || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Land route evidence (BRO-4814). landing = {
 *   runs: [{ id, branch, headSha, createdAt }]  successful land.yml runs,
 *   refs: [{ branch, sha }]                     land/** refs still on origin,
 *   coveredSinceMs                              runs before this were not listed (optional),
 * } or null when it could not be read. Returns { landed: true, branch, runId }
 * or { landed: false, reason }; 'land-history-not-covered' means the card is
 * older than the listing, so the caller should list further back and ask again.
 */
function landedViaLandRef({ identifier, cardCreatedAt, landing }) {
  if (!landing || !Array.isArray(landing.runs) || !Array.isArray(landing.refs)) return { landed: false, reason: 'no-land-evidence' };
  const n = cardNumber(identifier);
  const createdMs = Date.parse(cardCreatedAt);
  if (n == null || !Number.isFinite(createdMs)) return { landed: false, reason: 'no-land-evidence' };
  const { landRefCardNumber } = require('./cloud-worker-pick.js');
  const mine = landing.runs.filter((r) => r && landRefCardNumber(r.branch) === n && !REVERT_BRANCH_RE.test(r.branch));
  // A ref still naming the card is unlanded work unless its tip is exactly a
  // tip Land already landed (cloud sessions cannot delete refs, so a landed
  // ref can linger). Anything else, including a ref with no known sha, waits.
  const landedTips = new Set(mine.map((r) => r.headSha).filter(Boolean));
  const open = landing.refs
    .map((r) => (typeof r === 'string' ? { branch: r, sha: null } : r || {}))
    .filter((r) => landRefCardNumber(r.branch) === n);
  if (open.some((r) => !r.sha || !landedTips.has(r.sha))) return { landed: false, reason: 'land-ref-still-open' };
  const run = mine
    .filter((r) => Date.parse(r.createdAt) >= createdMs)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!run) {
    if (Number.isFinite(landing.coveredSinceMs) && landing.coveredSinceMs > createdMs) return { landed: false, reason: 'land-history-not-covered' };
    return { landed: false, reason: NO_OWN_COMMIT };
  }
  return { landed: true, branch: run.branch, runId: run.id, createdAt: run.createdAt };
}

// A land branch that undoes work also names the card; it is not the card's landing.
const REVERT_BRANCH_RE = /(?:revert|undo|rollback)/i;

const isRevert = (c) => /^Revert\b/.test(String((c && c.message) || '').trim());

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
  const pathUsers = new Map();
  for (const r of results) {
    if (!r || !r.cmd) continue;
    cmdUse.set(r.cmd, (cmdUse.get(r.cmd) || 0) + 1);
    for (const p of cardTestPaths(r.cmd) || []) {
      if (!pathUsers.has(p)) pathUsers.set(p, new Set());
      pathUsers.get(p).add(r.id);
    }
  }
  const candidates = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const r of results) {
    if (!r || r.verdict !== 'STUCK') continue;
    if (!IDLE_MS_BY_STATE[r.state]) { skip(`state-${r.state}`); continue; }
    if (!Array.isArray(r.channels) || !r.channels.includes('verify-command')) { skip('no-verify-command'); continue; }
    const testPaths = cardTestPaths(r.cmd);
    if (!testPaths) { skip('command-not-a-test-run'); continue; }
    if (cmdUse.get(r.cmd) > 1) { skip('command-shared-with-another-card'); continue; }
    // Another card naming one of the files does not block the commit route
    // (a commit naming this card is its own proof) but does block the land
    // route, which has no such tie to the card.
    const sharesTestFile = testPaths.some((p) => [...pathUsers.get(p)].some((id) => id !== r.id));
    candidates.push({ id: r.id, state: r.state, cmd: r.cmd, testPath: testPaths[0], testPaths, sharesTestFile });
  }
  // The audit stamps openCheckFails only on In Review cards whose own VERIFY
  // command failed twice on main (done-evidence-audit.js classifyCard).
  const bounces = results
    .filter((r) => r && r.openCheckFails && r.state === 'In Review' && r.cmd)
    .map((r) => ({ id: r.id, state: r.state, cmd: r.cmd, failDetail: r.failDetail || null }));
  return { candidates, skipped, bounces };
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
 * Decide one candidate against the live issue and the commits that touched
 * its test files since the card was created.
 *   issue:   { state: { name, type }, createdAt, updatedAt, description, comments: [{ body, createdAt }] }
 *   commits: [{ sha, message }], newest first
 *   landing: land route evidence for landedViaLandRef, or null/undefined
 * Returns { close: true, route: 'commit', sha }, { close: true, route:
 * 'land-ref', sha, branch, runId } or { close: false, reason }.
 */
function decideClosure({ candidate, issue, commits, landing, nowMs }) {
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
  // A revert names the card too, but it undoes the fix rather than landing it.
  const all = commits || [];
  const own = all.find((c) => !isRevert(c) && commitIsForCard(c.message, candidate.id));
  if (own) return { close: true, route: 'commit', sha: own.sha };
  const land = landedViaLandRef({ identifier: candidate.id, cardCreatedAt: issue.createdAt, landing });
  if (!land.landed) return { close: false, reason: land.reason === 'no-land-evidence' ? NO_OWN_COMMIT : land.reason };
  if (candidate.sharesTestFile) return { close: false, reason: 'landed-but-test-shared-with-another-card' };
  if (all.some((c) => isRevert(c) && mentionsCard(c.message, candidate.id))) return { close: false, reason: 'landed-but-reverted' };
  // The touching commit must be dated inside the card's life and no later than
  // the landing run; an undated commit cannot prove that, so it does not count.
  const runMs = Date.parse(land.createdAt);
  const touched = all.find((c) => !isRevert(c) && Date.parse(c.date) >= Date.parse(issue.createdAt) && Date.parse(c.date) <= runMs);
  if (!touched) return { close: false, reason: 'landed-but-test-untouched-since-card' };
  return { close: true, route: 'land-ref', sha: touched.sha, branch: land.branch, runId: land.runId };
}

/**
 * Decide whether a failing In Review card goes back to a worker.
 * Returns { bounce: true, priorBounces } or { bounce: false, reason }.
 * 'bounce-exhausted' is reported, never acted on.
 */
function decideBounce({ candidate, issue, nowMs }) {
  if (!issue) return { bounce: false, reason: 'issue-not-found' };
  if ((issue.state && issue.state.name) !== 'In Review') return { bounce: false, reason: 'state-changed-since-audit' };
  // Only send back cards an automatic worker will pick up from Todo (the
  // watchdog and the cloud worker take P0/P1 with no headless blocker).
  // Anything else would sit in Todo looking unstarted; leave it In Review.
  if (![1, 2].includes(Number(issue.priority))) return { bounce: false, reason: 'no-auto-worker' };
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

// How many cards one run may close. The real limiter is time: every close
// re-runs the card's check through the Done gate on a fresh origin/main
// checkout, so quick checks close many cards per run and slow ones few. The
// count ceiling only bounds the damage if the closer itself has a bug.
// Raised from 50 (BRO-4814) with the land route and multi-file checks
// widening what qualifies; still a backstop, not the limiter.
const MAX_CLOSES_PER_RUN = 100;
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

function buildClosureComment({ candidate, sha, route = 'commit', branch, runId, auditGeneratedAt }) {
  const files = (candidate.testPaths || [candidate.testPath]).join(', ');
  const landed = route === 'land-ref'
    ? `Land run ${runId} landed ${branch} after the card was filed and no unlanded land ref for this card is left, and commit ${String(sha).slice(0, 12)} changed ${files} after the card was filed, so the work landed.`
    : `Commit ${String(sha).slice(0, 12)} names this card and changed ${files} after the card was filed, so the work landed.`;
  return [
    `${CLOSER_MARKER}.`,
    '',
    `This card's own check, \`${candidate.cmd}\`, passed on main in the done-evidence audit of ${auditGeneratedAt}.`,
    landed,
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
  NO_OWN_COMMIT,
  cardTestPath,
  cardTestPaths,
  landedViaLandRef,
  mentionsCard,
  commitIsForCard,
  planCandidates,
  futureRecheckAfter,
  decideClosure,
  buildClosureComment,
  decideBounce,
  buildBounceComment,
  closeRunStopReason,
};
