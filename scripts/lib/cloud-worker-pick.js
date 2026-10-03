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
 * RESUME BEFORE PICK (BRO-4565): the state filter above also means a worker
 * that ended its turn before its Land run finished never comes back. When
 * Land refuses, the card stays In Progress with its land/ ref still on the
 * remote (Land deletes the ref only on success), and every later firing skips
 * it. Seen live on BRO-2311 (2026-10-03). findResumeCard hands such a card
 * back first: an open P0/P1 card in a started state, a land/ ref naming it
 * (bro-N anywhere in the ref), and that ref's latest Land run, for the ref's
 * current tip, refused between STRANDED_MS and RESUME_WINDOW_MS ago, with the
 * card itself quiet for IDLE_MS (the same idle rule as a new pick) and fit for
 * a headless worker (safe VERIFY, no headless blocker). The quiet period
 * leaves a live Mac or cloud session room to fix its own refusal; the window
 * keeps long-abandoned refs out. A card with any ref still landing (queued,
 * running, a tip pushed after its last run, or a ref with no run yet) is left
 * alone, and so is every card while a dispatched Land run is in flight
 * (dispatched runs report head_branch main, so they can't be tied to a ref).
 * A ref that has been through MAX_LAND_RUNS runs is not resumed again: the
 * same card would otherwise win every firing ahead of fresh work. A
 * `cancelled` run is an eviction from the shared landing slot (CLOUD.md
 * Landing), so its resume kind is 'evicted': re-run, nothing to fix.
 *
 * Pure functions only. The CLI is scripts/cloud-worker-pick.js.
 */

'use strict';

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 6 * HOUR_MS;
const PRIORITIES = new Set([1, 2]);
const STRANDED_MS = 90 * 60 * 1000;
const RESUME_WINDOW_MS = 7 * 24 * HOUR_MS;
const MAX_LAND_RUNS = 6;
const LAND_REF_CARD_RE = /(?:^|[^a-z0-9])bro-(\d+)(?![0-9])/i;

/** Why a headless worker can't finish this card (no safe VERIFY, or a headless blocker), or null. */
function headlessUnfitReason(issue, { allowParkedSentinel = false } = {}) {
  const hd = require('./headless-dispatchability.js');
  const drain = require('./linear-drain-parked.js');
  if (!drain.hasSafeVerifyCommand(issue)) return 'no-safe-verify';
  const { blockers } = hd.classifyHeadlessDispatchability({ subject: issue.title, notes: issue.description || '' });
  const blocking = blockers.filter((b) => !(allowParkedSentinel && b.code === hd.BLOCKERS.PARKED_SENTINEL));
  return blocking.length ? `blocker-${blocking[0].code}` : null;
}

function skipReason(issue, nowMs) {
  const drain = require('./linear-drain-parked.js');
  if (!issue || !issue.identifier) return 'malformed';
  if (!PRIORITIES.has(Number(issue.priority))) return 'not-p0-p1';
  const type = issue.state && issue.state.type;
  const parkedDrainable = drain.isSessionParkedDrainable(issue);
  if (type !== 'unstarted' && !parkedDrainable) return type === 'backlog' ? 'parked-or-backlog' : `state-${type}`;
  const unfit = headlessUnfitReason(issue, { allowParkedSentinel: parkedDrainable });
  if (unfit) return unfit;
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

/** Card number named by a land ref ('land/bro-2311-x' -> 2311), or null. */
function landRefCardNumber(ref) {
  const name = String(ref || '').replace(/^refs\/heads\//, '');
  if (!name.startsWith('land/')) return null;
  const m = name.slice('land/'.length).match(LAND_REF_CARD_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Open P0/P1 cards someone holds (started, not In Review): the only ones a land
 * ref can resume. In Review already has an owner, the stuck-card closer, which
 * runs the card's check and closes it or bounces it back to Todo.
 */
function resumableCardsByNumber(issues) {
  const { issueNumber } = require('./linear-drain-parked.js');
  const byNum = new Map();
  for (const iss of Array.isArray(issues) ? issues : []) {
    if (!iss || !iss.identifier || !PRIORITIES.has(Number(iss.priority))) continue;
    if (!iss.state || iss.state.type !== 'started' || /review/i.test(iss.state.name || '')) continue;
    const n = issueNumber(iss.identifier);
    if (Number.isFinite(n)) byNum.set(n, iss);
  }
  return byNum;
}

/**
 * @param {Array<object>} issues - open Linear issues
 * @param {Array<{ref:string, sha:string, lastRun:?{status:string, conclusion:?string, headSha:string, updatedAt:string, id:number, url?:string, attempts?:number}}>} landRefs
 *   remote land/ refs with the latest Land run on each (null when none ran);
 *   attempts is how many Land runs the ref has had
 * @param {{nowMs:number, landDispatchInFlight?:boolean}} opts
 * @returns {{ issue: object, ref: string, sha: string, lastRun: object, kind: 'refused'|'evicted' }|null}
 */
function findResumeCard(issues, landRefs, { nowMs, landDispatchInFlight = false }) {
  if (landDispatchInFlight) return null;
  const { priorityRank } = require('./linear-dispatch.js');
  const { issueNumber } = require('./linear-drain-parked.js');
  const cards = resumableCardsByNumber(issues);
  const refsByCard = new Map();
  for (const r of Array.isArray(landRefs) ? landRefs : []) {
    const n = landRefCardNumber(r && r.ref);
    if (n == null || !cards.has(n)) continue;
    if (!refsByCard.has(n)) refsByCard.set(n, []);
    refsByCard.get(n).push(r);
  }
  const candidates = [];
  for (const [n, refs] of refsByCard) {
    const iss = cards.get(n);
    const cardMs = Date.parse(iss.updatedAt);
    if (!Number.isFinite(cardMs) || nowMs - cardMs < IDLE_MS) continue;
    if (headlessUnfitReason(iss)) continue;
    // Still landing: no run yet, a run queued or in progress, or a tip pushed after the last run.
    if (refs.some((r) => !r.lastRun || r.lastRun.status !== 'completed' || r.lastRun.headSha !== r.sha)) continue;
    const refused = refs
      .filter((r) => r.lastRun.conclusion !== 'success' && !(Number(r.lastRun.attempts) >= MAX_LAND_RUNS))
      .map((r) => ({ r, ms: Date.parse(r.lastRun.updatedAt) }))
      .filter(({ ms }) => Number.isFinite(ms) && nowMs - ms >= STRANDED_MS && nowMs - ms <= RESUME_WINDOW_MS)
      .sort((a, b) => b.ms - a.ms);
    if (!refused.length) continue;
    const { r } = refused[0];
    const kind = r.lastRun.conclusion === 'cancelled' ? 'evicted' : 'refused';
    candidates.push({ issue: iss, ref: r.ref.replace(/^refs\/heads\//, ''), sha: r.sha, lastRun: r.lastRun, kind });
  }
  candidates.sort((a, b) => (priorityRank(a.issue) - priorityRank(b.issue))
    || (issueNumber(a.issue.identifier) - issueNumber(b.issue.identifier)));
  return candidates[0] || null;
}

module.exports = {
  IDLE_MS, STRANDED_MS, RESUME_WINDOW_MS, MAX_LAND_RUNS,
  skipReason, pickCloudCard, landRefCardNumber, resumableCardsByNumber, findResumeCard,
};
