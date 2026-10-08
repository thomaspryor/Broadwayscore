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
 *   - Machine-filed parked P0/P1 cards (digest-autofix, owner-alert-router)
 *     once quiet for AUTOMATION_PARK_STALE_MS. Their PARKED line is a filer's
 *     note ("runAutofix dispatches via linear-next separately"), not an owner
 *     hold, and only the Mac ever dispatched them. Measured 2026-10-04: 281
 *     such cards, idle 10 to 20+ days, because that same-pass dispatch never
 *     happened and nothing retried it. Three days leaves the Mac drain and the
 *     strict resolved-alert sweep their turn first.
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
 * A ref that has been through MAX_LAND_RUNS runs, or whose last run has been
 * re-run that many times, is not resumed again: the same card would otherwise
 * win every firing ahead of fresh work. A `cancelled` run is an eviction from
 * the shared landing slot (CLOUD.md Landing). land-retry-cancelled.yml re-runs
 * those once the landing slot is free (BRO-4653), so one still cancelled here is
 * waiting for the slot or was declined; its resume kind is 'evicted': nothing to
 * fix, the slot-aware retry decides (re-run now, wait, or re-push).
 *
 * PAUSE MEMORY (BRO-4574): the card text above can't tell whether a worker
 * already tried this card and stopped. Seen on the first two live firings
 * (2026-10-04): one took a card whose fix was already on main but whose VERIFY
 * (the whole unit suite) can't pass from the cloud, the next resumed a card
 * held for an owner decision; both paused, and both would have won again six
 * hours later. So the CLI reads each candidate's comments in pick order and
 * pausedHistorySkipReason skips a card whose latest session report is a pause
 * waiting on the owner (until someone comments after it, or for at most
 * AWAITING_OWNER_MAX_MS), or any pause less than RECENT_PAUSE_MS old. A VERIFY the cloud can't run is a card-text rule
 * (CLOUD_UNRUNNABLE_VERIFY_RE, in headlessUnfitReason).
 *
 * Pure functions only. The CLI is scripts/cloud-worker-pick.js.
 */

'use strict';

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 6 * HOUR_MS;
// A session that would have started a worker session files the card with a
// "START-NOW: <why>" line instead (create_session prompts the owner every time,
// BRO-4664). Such a Todo card is a handoff, so it skips the idle wait and goes
// to the front of the queue. Only for START_NOW_MAX_AGE_MS after filing, so a
// card bounced back to Todo later, or an over-eager filer, can't hold the front
// for good; and not in its first START_NOW_MIN_AGE_MS, so the filer can finish
// writing it.
const START_NOW_RE = /^\s*START-NOW\s*:/im;
const START_NOW_MIN_AGE_MS = 10 * 60 * 1000;
const START_NOW_MAX_AGE_MS = 48 * HOUR_MS;
function hasStartNowLine(issue) {
  return !!(issue && START_NOW_RE.test(issue.description || ''));
}
function isStartNow(issue, nowMs) {
  if (!hasStartNowLine(issue) || !issue.state || issue.state.type !== 'unstarted') return false;
  const age = nowMs - Date.parse(issue.createdAt);
  return Number.isFinite(age) && age >= START_NOW_MIN_AGE_MS && age < START_NOW_MAX_AGE_MS;
}
const PRIORITIES = new Set([1, 2]);
const STRANDED_MS = 90 * 60 * 1000;
const RESUME_WINDOW_MS = 7 * 24 * HOUR_MS;
const MAX_LAND_RUNS = 6;
const LAND_REF_CARD_RE = /(?:^|[^a-z0-9])bro-(\d+)(?![0-9])/i;
const RECENT_PAUSE_MS = 72 * HOUR_MS;
// The whole unit suite: 17 tests fail in a cloud container for reasons unrelated
// to any card, and the Done gate's 90s budget can't run it (BRO-4265, 2026-10-04).
const CLOUD_UNRUNNABLE_VERIFY_RE = /^node\s+scripts\/run-unit-tests\.js\s*$/;
// iOS app cards live in the BroadwayScorecard-app repo, which the cloud worker
// session does not check out (and add_repo prompts), so it would burn a firing.
// Also gates resume (findResumeCandidates), so a land ref for one isn't retried.
// "iOS Safari ..." is a web bug, not an app card.
const IOS_APP_CARD_RE = /^\W*iOS\b(?!\s+Safari)/i;
// A paused report that names the owner's call as the blocker.
// Comments automation posts on its own: dispatch receipts (linear-dispatch.js
// buildDispatchComment, with or without a correlation id), auto-corrections,
// tag markers like [auto-fix-attempted:fail] (auto-fix-friction-card.js) and
// acceptance re-arms (enrich-card-acceptance.js). One of these after a pause
// is not an answer to it.
const MACHINE_COMMENT_RE = /^(?:Dispatched (?:[0-9a-f]+ )?to |Auto-corrected |Auto-reset |\*\*Re-arm \(auto\b)/i;
// Machine tags are lowercase and hyphenated ([auto-fix-attempted:fail], [red-first follow-up]).
// Case-sensitive, and not a markdown link, so "[x] approved", "[Approved] go ahead"
// and "[the fix](url) looks right" still count as human answers.
const MACHINE_TAG_RE = /^\[[a-z][a-z0-9 ]*-[a-z0-9 -]*(?::[a-z0-9-]+)?\](?!\()/;
const AWAITING_OWNER_RE = /\bowner(?:'s)?\s+(?:decision|approval|sign[- ]?off|go[- ]ahead|judg(?:e)?ment|call)\b|\b(?:waiting|wait|held|hold|pending|blocked)\s+(?:on|for)\s+(?:the\s+|an?\s+)?(?:owner|thomas)\b(?!['\u2019]s)|\bpending\s+(?:the\s+)?owner\b(?!['\u2019]s)|\bneeds?\s+(?:an?\s+|the\s+)?owner\b(?!['\u2019]s)|\bDECISION NEEDED\b/gi;
// "not an owner decision", "no DECISION NEEDED", "owner decision not required".
const OWNER_NEGATED_BEFORE_RE = /\b(?:not|no|without)\s+(?:an?\s+|the\s+|any\s+)?$/i;
const OWNER_NEGATED_AFTER_RE = /^\s*(?:is\s+|was\s+)?(?:not|no\s+longer)\s+(?:required|needed)\b/i;
// An owner hold still gets one more worker after this long, so a card the
// owner never answers in Linear (or a misread report) can't wait forever.
const AWAITING_OWNER_MAX_MS = 14 * 24 * HOUR_MS;
const AUTOMATION_PARK_STALE_MS = 3 * 24 * HOUR_MS;
const MACHINE_PARK_LINE_RE = /Auto-filed by (?:digest-autofix|owner-alert-router)/;

/** A machine-filed parked P0/P1 card nobody has touched for AUTOMATION_PARK_STALE_MS. */
function isStaleAutomationParked(issue, nowMs) {
  const hd = require('./headless-dispatchability.js');
  const type = issue && issue.state && issue.state.type;
  if (type !== 'backlog' && type !== 'unstarted') return false;
  if (!PRIORITIES.has(Number(issue.priority))) return false;
  const notes = issue.description || '';
  if (!hd.isAutomationParked(notes)) return false;
  // isAutomationParked reads only the leading machine line; a hold a person
  // added on a later PARKED line still keeps the card parked.
  // Only the first PARKED line is the machine's; a later line that merely
  // quotes the marker is still a person's hold.
  const extraHold = [...notes.matchAll(/^\s*PARKED\s*:(.*)$/gim)]
    .some((m, i) => !(i === 0 && MACHINE_PARK_LINE_RE.test(m[1])) && hd.OWNER_HOLD_PARK_RE.test(m[1]));
  if (extraHold) return false;
  const updatedMs = Date.parse(issue.updatedAt);
  return Number.isFinite(updatedMs) && nowMs - updatedMs >= AUTOMATION_PARK_STALE_MS;
}

/** Why a headless worker can't finish this card (no safe VERIFY, or a headless blocker), or null. */
function headlessUnfitReason(issue, { allowParkedSentinel = false } = {}) {
  const hd = require('./headless-dispatchability.js');
  const drain = require('./linear-drain-parked.js');
  if (IOS_APP_CARD_RE.test(String(issue.title || ''))) return 'ios-app-repo';
  // BRO-2204: a card marked "NO-DISPATCH:" must not be launched by any
  // dispatcher; the cloud worker picked one that said it needs the owner's
  // answer before any code. Description only: comments quote the marker.
  if (require('./no-dispatch-marker.js').hasNoDispatchMarker(issue.description)) return 'no-dispatch-marker';
  const cmd = drain.verifyCommand(issue);
  if (!cmd) return 'no-safe-verify';
  if (CLOUD_UNRUNNABLE_VERIFY_RE.test(String(cmd).trim())) {
    return 'verify-not-cloud-runnable';
  }
  const { blockers } = hd.classifyHeadlessDispatchability({ subject: issue.title, notes: issue.description || '' }, { verifyCmd: cmd });
  const blocking = blockers.filter((b) => !(allowParkedSentinel && b.code === hd.BLOCKERS.PARKED_SENTINEL));
  return blocking.length ? `blocker-${blocking[0].code}` : null;
}

function skipReason(issue, nowMs) {
  const drain = require('./linear-drain-parked.js');
  if (!issue || !issue.identifier) return 'malformed';
  if (!PRIORITIES.has(Number(issue.priority))) return 'not-p0-p1';
  const type = issue.state && issue.state.type;
  const parkedDrainable = drain.isSessionParkedDrainable(issue) || isStaleAutomationParked(issue, nowMs);
  if (type !== 'unstarted' && !parkedDrainable) return type === 'backlog' ? 'parked-or-backlog' : `state-${type}`;
  const unfit = headlessUnfitReason(issue, { allowParkedSentinel: parkedDrainable });
  if (unfit) return unfit;
  const updatedMs = Date.parse(issue.updatedAt);
  if (!Number.isFinite(updatedMs)) return 'no-updatedAt';
  if (nowMs - updatedMs < IDLE_MS && !isStartNow(issue, nowMs)) return 'recent-activity';
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
  // START-NOW Todo cards that won't run (no safe VERIFY, a blocker, too new or
  // too old), by id: a filer told the owner they were queued, so say why not.
  const startNowSkipped = {};
  for (const iss of Array.isArray(issues) ? issues : []) {
    const reason = skipReason(iss, nowMs);
    if (reason) skipped[reason] = (skipped[reason] || 0) + 1;
    else eligible.push(iss);
    if (hasStartNowLine(iss) && iss.state && iss.state.type === 'unstarted' && (reason || !isStartNow(iss, nowMs))) {
      startNowSkipped[iss.identifier] = reason || 'start-now-outside-age-window';
    }
  }
  // Within a priority, the old machine-filed backlog goes after cards a person
  // filed or a session parked, so ~280 stale autofix cards can't starve them.
  const machineTier = (iss) => (iss.state && iss.state.type === 'unstarted') || !isStaleAutomationParked(iss, nowMs) ? 0 : 1;
  const startTier = (iss) => (isStartNow(iss, nowMs) ? 0 : 1);
  eligible.sort((a, b) => (startTier(a) - startTier(b)) || (priorityRank(a) - priorityRank(b)) || (machineTier(a) - machineTier(b))
    || (issueNumber(a.identifier) - issueNumber(b.identifier)));
  return { pick: eligible[0] || null, ordered: eligible, eligible: eligible.length, skipped, startNowSkipped };
}

/**
 * Why an earlier worker's pause should keep this card out of the pick, or null.
 * @param {Array<{body:string, createdAt:string}>} comments - the card's comments, any order
 * @param {number} nowMs
 * @returns {'awaiting-owner'|'recently-paused'|null}
 */
function pausedHistorySkipReason(comments, nowMs) {
  const { parseSessionReportStatus } = require('./linear-session-reporting.js');
  const sorted = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && Number.isFinite(Date.parse(c.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const idx = sorted.findIndex((c) => parseSessionReportStatus(c.body) != null);
  if (idx < 0) return null;
  const report = sorted[idx];
  if (parseSessionReportStatus(report.body) !== 'paused') return null;
  // A comment after the pause (the owner's answer, a human note) re-opens it to the idle rule.
  const answered = sorted.slice(0, idx).some((c) => !isMachineComment(c.body));
  const ageMs = nowMs - Date.parse(report.createdAt);
  if (!answered && ageMs < AWAITING_OWNER_MAX_MS && namesOwnerHold(report.body)) return 'awaiting-owner';
  return ageMs < RECENT_PAUSE_MS ? 'recently-paused' : null;
}

function isMachineComment(body) {
  const text = String(body || '').trim();
  return MACHINE_COMMENT_RE.test(text) || MACHINE_TAG_RE.test(text);
}

/** True when a paused report names the owner's call as its blocker (a negated mention doesn't count). */
function namesOwnerHold(text) {
  const body = String(text || '');
  for (const m of body.matchAll(AWAITING_OWNER_RE)) {
    const before = body.slice(Math.max(0, m.index - 30), m.index);
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (!OWNER_NEGATED_BEFORE_RE.test(before) && !OWNER_NEGATED_AFTER_RE.test(after)) return true;
  }
  return false;
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
 * @returns {Array<{ issue: object, ref: string, sha: string, lastRun: object, kind: 'refused'|'evicted' }>} best first
 */
function findResumeCandidates(issues, landRefs, { nowMs, landDispatchInFlight = false }) {
  if (landDispatchInFlight) return [];
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
      .filter((r) => r.lastRun.conclusion !== 'success'
        && !(Number(r.lastRun.attempts) >= MAX_LAND_RUNS) && !(Number(r.lastRun.runAttempt) >= MAX_LAND_RUNS))
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
  return candidates;
}

/** The first of findResumeCandidates, or null. */
function findResumeCard(issues, landRefs, opts) {
  return findResumeCandidates(issues, landRefs, opts)[0] || null;
}

module.exports = {
  IDLE_MS, STRANDED_MS, RESUME_WINDOW_MS, MAX_LAND_RUNS, RECENT_PAUSE_MS, AWAITING_OWNER_MAX_MS,
  AUTOMATION_PARK_STALE_MS, START_NOW_MIN_AGE_MS, START_NOW_MAX_AGE_MS, IOS_APP_CARD_RE, isStaleAutomationParked, isStartNow, hasStartNowLine, skipReason, pickCloudCard, pausedHistorySkipReason, landRefCardNumber, resumableCardsByNumber,
  findResumeCandidates, findResumeCard,
};
