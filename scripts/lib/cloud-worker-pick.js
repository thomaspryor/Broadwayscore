/**
 * cloud-worker-pick — choose the one P0/P1 card a cloud worker session takes
 * on a firing (BRO-4535).
 *
 * WHY: every dispatcher that works the board (dispatch-watchdog.js,
 * linear-drain-parked.js, bsc-next.js) runs on the owner's Mac. When the Mac
 * is asleep or off, urgent cards wait. A scheduled cloud routine fires a fresh
 * session every few hours; this picks the card it works, using the same
 * card-text guards the Mac dispatchers use (priority, state, safe VERIFY,
 * headless blockers).
 *
 * NOT applied here: the Mac's dispatch-ledger guards (attempt memory, spend
 * breaker, per-card retry limits). The ledger lives on the Mac. What keeps a
 * cloud worker from looping on one card is the routine prompt: the worker
 * claims the card first (linear-session.js claim), which moves it to a started
 * state, so the next firing's state filter skips it. A card that fails ends
 * In Review or Blocked, never back in Todo, unless the stuck-card closer
 * bounces it (at most MAX_BOUNCES times).
 *
 * WHY THESE RULES:
 *   - P0/P1 only, highest first then oldest: the owner asked for urgent-card
 *     throughput, and one card per firing is the usage cap.
 *   - Todo (unstarted) only, plus parked P0/P1 session cards the Mac drain
 *     would also unpark (isSessionParkedDrainable). Every Mac dispatch moves
 *     its card to a started state (linear-next.js), so the state filter alone
 *     keeps the cloud off cards the Mac already holds.
 *   - Idle for IDLE_MS: a P0 filed minutes ago is usually being dispatched at
 *     creation by the session that filed it. Six hours gives that path, and
 *     the Mac watchdog, first claim.
 *   - A safe VERIFY command and no headless blocker other than the PARKED
 *     sentinel on a drainable card: a cloud worker has no owner to approve
 *     visual QA, wait out an async effect, or make a judgment call, and needs
 *     a machine-checkable definition of done.
 *
 * Pure functions only. The CLI is scripts/cloud-worker-pick.js.
 */

'use strict';

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 6 * HOUR_MS;
const PRIORITIES = new Set([1, 2]);

function skipReason(issue, nowMs) {
  const hd = require('./headless-dispatchability.js');
  const drain = require('./linear-drain-parked.js');
  if (!issue || !issue.identifier) return 'malformed';
  if (!PRIORITIES.has(Number(issue.priority))) return 'not-p0-p1';
  const type = issue.state && issue.state.type;
  const parkedDrainable = drain.isSessionParkedDrainable(issue);
  if (type !== 'unstarted' && !parkedDrainable) return type === 'backlog' ? 'parked-or-backlog' : `state-${type}`;
  if (!drain.hasSafeVerifyCommand(issue)) return 'no-safe-verify';
  const { blockers } = hd.classifyHeadlessDispatchability({ subject: issue.title, notes: issue.description || '' });
  const blocking = blockers.filter((b) => !(parkedDrainable && b.code === hd.BLOCKERS.PARKED_SENTINEL));
  if (blocking.length) return `blocker-${blocking[0].code}`;
  const updatedMs = Date.parse(issue.updatedAt);
  if (!Number.isFinite(updatedMs)) return 'no-updatedAt';
  if (nowMs - updatedMs < IDLE_MS) return 'recent-activity';
  return null;
}

/**
 * @param {Array<object>} issues - open Linear issues ({identifier, title, description, priority, state, updatedAt})
 * @param {{nowMs:number}} opts
 * @returns {{ pick: object|null, eligible: number, skipped: Record<string, number> }}
 */
function pickCloudCard(issues, { nowMs }) {
  const { priorityRank } = require('./linear-dispatch.js');
  const { issueNumber } = require('./linear-drain-parked.js');
  const skipped = {};
  const eligible = [];
  for (const iss of Array.isArray(issues) ? issues : []) {
    const reason = skipReason(iss, nowMs);
    if (reason) skipped[reason] = (skipped[reason] || 0) + 1;
    else eligible.push(iss);
  }
  eligible.sort((a, b) => (priorityRank(a) - priorityRank(b)) || (issueNumber(a.identifier) - issueNumber(b.identifier)));
  return { pick: eligible[0] || null, eligible: eligible.length, skipped };
}

module.exports = { IDLE_MS, skipReason, pickCloudCard };
