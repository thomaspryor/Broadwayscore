/**
 * cloud-worker-pick — choose the one P0/P1 card (or, when none is eligible, a
 * P2 card, then a P3 card) a cloud worker session takes on a firing (BRO-4535).
 *
 * WHY: every dispatcher that works the board (dispatch-watchdog.js,
 * linear-drain-parked.js, bsc-next.js) runs on the owner's Mac. When the Mac
 * is asleep or off, urgent cards wait. A scheduled cloud routine fires a fresh
 * session every few hours; this picks the card it works, using the same
 * card-text guards the Mac dispatchers use (priority, state, safe VERIFY,
 * headless blockers).
 *
 * NOT applied here: the Mac's dispatch-ledger guards (attempt memory, spend
 * breaker, per-card retry limits). The ledger lives on the Mac. The cloud's own
 * spend breaker (daily and per-card claim caps read from Linear, BRO-6229) is
 * scripts/lib/cloud-worker-breaker.js, applied by the CLI. What keeps a
 * cloud worker from looping on one card is the routine prompt: the worker
 * claims the card first (linear-session.js claim), which moves it to a started
 * state, so the next firing's state filter skips it. A card that fails ends
 * In Review or Blocked, never back in Todo, unless the stuck-card closer
 * bounces it (at most MAX_BOUNCES times).
 *
 * WHY THESE RULES:
 *   - P0/P1 first, highest first then oldest: the owner asked for urgent-card
 *     throughput, and one card per firing is the usage cap.
 *   - P2 FALLBACK: P2 (Linear priority 3) Todo cards, under every other rule
 *     here, but only after every P0/P1 card (pickCloudCard returns them in
 *     orderedP2; the CLI queues them after the P0/P1 queue, so one is reached
 *     only when no P0/P1 card survives the history and Codex-bounce skips
 *     too). Measured 2026-10-11: 76 eligible P0/P1 cards, about 3-4 days of
 *     work, and 17 P2 Todo cards nothing could ever reach, so the workers
 *     would sit idle once P0/P1 drained. Todo, plus paused Backlog cards,
 *     stale machine-filed parks and technical session parks (BRO-5369); an
 *     owner hold on a PARKED line keeps a P2 card parked.
 *     START-NOW does not apply to P2 (linear-issue-create refuses to file a
 *     START-NOW P2 card), so a P2 card always waits out IDLE_MS. A refused
 *     P2 landing is resumed too (findResumeCandidates includeP2), after every
 *     P0/P1 entry.
 *   - P3 FALLBACK: Low (Linear priority 4) Todo cards, one tier further down,
 *     under the same rules as P2 (IDLE_MS, START-NOW ignored,
 *     every guard), reached only after every P0/P1 and P2 entry (orderedP3;
 *     the CLI queues P3 resumes and P3 cards last). The owner wants every card
 *     handled, not only urgent ones (2026-10-11). The Codex runner (--list=N)
 *     reads the same queue, so it takes Low cards too, last. No-priority
 *     (Linear 0) cards are never picked: nobody has triaged them.
 *   - Todo (unstarted) only, plus technically parked session cards at any
 *     tier (isSessionParkedDrainable; P2/P3 since BRO-5369, the Mac drain
 *     that used to be the only path being dead). Every Mac dispatch moves
 *     its card to a started state (linear-next.js), so the state filter alone
 *     keeps the cloud off cards the Mac already holds.
 *   - PAUSED BACKLOG (BRO-5360): a worker's pause report moves its card to
 *     Paused, or Backlog when the team has no such state
 *     (linear-session-reporting.js STATUS_TO_STATE_NAME), and only the
 *     Mac drain ever moved such cards back. That drain stopped on 2026-09-19:
 *     on 2026-10-14, 38 of 47 Backlog P0/P1 cards had got there from In
 *     Progress (a pause) and nothing reached them again, so the workers fell
 *     through to P3 while 46 P0/P1 cards sat. A Backlog card with no PARKED
 *     line was paused, not parked (--park writes the line at filing), so it
 *     rejoins its tier; pausedHistorySkipReason still holds it for the pause
 *     cooldown, an owner hold, or after MAX_PAUSES pauses.
 *   - Machine-filed parked cards (digest-autofix, owner-alert-router), P0 to
 *     P3, once quiet for AUTOMATION_PARK_STALE_MS, after a tier's other cards
 *     (P2/P3 since BRO-5360: the Mac drain that ran them is gone). Their PARKED line is a filer's
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
 * win every firing ahead of fresh work. A `cancelled` run was cancelled before
 * it did any work (an eviction under the pre-BRO-5112 shared landing group).
 * land-retry-cancelled.yml re-runs those in order (BRO-6015), so one still cancelled
 * here is waiting for the sweep or was declined; its resume kind is 'evicted':
 * nothing to fix, the retry decides (re-run now or re-push).
 *
 * PAUSE MEMORY (BRO-4574): the card text above can't tell whether a worker
 * already tried this card and stopped. Seen on the first two live firings
 * (2026-10-04): one took a card whose fix was already on main but whose VERIFY
 * (the whole unit suite) can't pass from the cloud, the next resumed a card
 * held for an owner decision; both paused, and both would have won again six
 * hours later. So the CLI reads each candidate's comments in pick order and
 * pausedHistorySkipReason skips a card whose latest session report is a pause
 * waiting on the owner (until someone comments after it, or for at most
 * AWAITING_OWNER_MAX_MS), or any pause less than RECENT_PAUSE_MS old
 * (RECENT_PAUSE_URGENT_MS for P0/P1, which the owner wants worked fast). A VERIFY the cloud can't run is a card-text rule
 * (CLOUD_UNRUNNABLE_VERIFY_RE, in headlessUnfitReason).
 *
 * Pure functions only. The CLI is scripts/cloud-worker-pick.js.
 */

'use strict';

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 6 * HOUR_MS;
// A session with no human in it (routine, worker) that would have started a
// worker session files the card with a "START-NOW: <why>" line instead
// (create_session prompts the owner; sessions the owner is in start their own,
// BRO-5040). Such a Todo card is a handoff, so it skips the idle wait and goes
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
// BRO-6654: the owner tapped Done on a Mac-only task emailed from this card
// (src/lib/owner-decision-link.js buildAnswerComment, TASK_CHOICES). The work
// was only waiting on that, so the card skips the idle wait and the pause
// cooldown and goes to the front, like START-NOW, while the tap is the newest
// human comment and under 48 h old. The comment's createdAt is set by Linear,
// so editing the card cannot reopen the window; the comment must also carry
// the answer ref recordAnswer writes. Bodies are unescaped first, as every
// other marker test does (Linear escapes markdown in stored bodies).
const OWNER_TASK_DONE_RE = /^\*\*Owner decision\*\* \(answered by the owner\b[^\n]*\n\s*\nChose: Done, I did it\s*(?:\n|$)/;
const OWNER_TASK_RESUME_MS = 48 * HOUR_MS;
function isOwnerTaskResume(issue, nowMs) {
  const nodes = (issue && issue.comments && Array.isArray(issue.comments.nodes)) ? issue.comments.nodes : [];
  const newest = nodes.filter((c) => c && Number.isFinite(Date.parse(c.createdAt)) && !isMachineComment(c.body))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const { unescapeMarkdown, ANSWER_REF_RE } = require('../../src/lib/owner-decision-link.js');
  const body = newest ? unescapeMarkdown(String(newest.body || '')) : '';
  if (!OWNER_TASK_DONE_RE.test(body) || !ANSWER_REF_RE.test(body)) return false;
  const age = nowMs - Date.parse(newest.createdAt);
  return age >= 0 && age < OWNER_TASK_RESUME_MS;
}
const PRIORITIES = new Set([1, 2]);
// Linear priority 3 = Medium = P2: the fallback tier (see WHY THESE RULES).
const P2_PRIORITY = 3;
const TIER_P0P1 = 'p0p1';
const TIER_P2 = 'p2-fallback';
// Linear priority 4 = Low = P3: the last fallback tier, after P2.
const P3_PRIORITY = 4;
const TIER_P3 = 'p3-fallback';
// The fallback tiers skipReason accepts as `{ tier }`: Linear priority by tier.
const FALLBACK_TIER_PRIORITY = { p2: P2_PRIORITY, p3: P3_PRIORITY };
const STRANDED_MS = 90 * 60 * 1000;
const RESUME_WINDOW_MS = 7 * 24 * HOUR_MS;
const MAX_LAND_RUNS = 6;
const LAND_REF_CARD_RE = /(?:^|[^a-z0-9])bro-(\d+)(?![0-9])/i;
const RECENT_PAUSE_MS = 72 * HOUR_MS;
const RECENT_PAUSE_URGENT_MS = 24 * HOUR_MS;
// Paused this many times with no person commenting since: retrying again is
// churn, the card needs a person (or a re-scope), so it stays out.
const MAX_PAUSES = 3;
// Any PARKED line in the description: written by --park at filing or by a person.
const PARKED_LINE_RE = /^\s*PARKED\s*:/im;
// The Codex runner's own comments (scripts/codex/daily-runner.js moveCard): it works Backlog cards too.
const CODEX_RUNNER_NOTE_RE = /^\s*(?:<!--[^>]*-->\s*)?## Codex runner\b/;

// P2/P3 cards collect "do it later" parks that TECHNICAL_PARK_RE also matches
// ("low impact, small follow-up for next session", "risky ... irreversible").
// At the fallback tiers any PARKED line with these words keeps the card parked.
const FALLBACK_PARK_DENY_RE = /\bnext (?:working )?(?:session|pass)\b|low.?impact|follow.?up|irreversib|risky/i;
const FALLBACK_TIER_PRIORITIES = { [P2_PRIORITY]: new Set([P2_PRIORITY]), [P3_PRIORITY]: new Set([P3_PRIORITY]) };

/** A P2/P3 card parked only for a technical reason, with no "later" wording (BRO-5369). */
function isFallbackTechnicalPark(issue) {
  const drain = require('./linear-drain-parked.js');
  const priorities = FALLBACK_TIER_PRIORITIES[Number(issue && issue.priority)];
  if (!priorities || !drain.isSessionParkedDrainable(issue, { priorities })) return false;
  return ![...String(issue.description || '').matchAll(/^\s*PARKED\s*:(.*)$/gim)].some((m) => FALLBACK_PARK_DENY_RE.test(m[1]));
}

/** A Backlog card a worker paused (no PARKED line), not one parked at filing or by a person. */
function isPausedBacklog(issue) {
  return !!(issue && issue.state && issue.state.type === 'backlog' && !PARKED_LINE_RE.test(issue.description || ''));
}
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
// Also the reclaim sweep's note (linear-reclaim-abandoned.js RECLAIM_MARKER) and
// the Codex runner's hand-backs (scripts/codex/daily-runner.js), BRO-5360, and the
// claim trace linear-session.js claim posts (buildClaimComment), BRO-6092.
const { isFilerRefreshComment } = require('./filer-refresh-marker.js');
const MACHINE_COMMENT_RE = /^(?:Dispatched (?:[0-9a-f]+ )?to |Claimed by |Auto-corrected |Auto-reset |\*\*Re-arm \(auto\b|RECLAIMED-ABANDONED:|Headless worker ended without its own session report|<!-- codex-runner|## Codex runner\b)/i;
// The reclaim sweep's note when it sends a card to Backlog, not Todo, after
// MAX_RECLAIMS: "Someone should read the history before it is retried."
const RECLAIM_TO_BACKLOG_RE = /^RECLAIMED-ABANDONED:[\s\S]*goes to Backlog instead of Todo/;
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
// BRO-6262: a worker that paused a card because this lane cannot do the work (no
// attached review-texts repo, "not workable from the cloud lane") says so in its
// report. Re-picking it only burns another session to learn the same thing
// (BRO-5489, BRO-5401), so it stays out of the cloud pick until a person comments or
// LANE_UNWORKABLE_MAX_MS passes (the lane may have been fixed meanwhile).
// Deliberately narrow phrases: a report that merely mentions "review-texts" while
// finishing other work must not match.
const LANE_UNWORKABLE_RE = /not workable from the cloud lane|data\/review-texts is not attached|review-texts private repo not attached/i;
const LANE_UNWORKABLE_MAX_MS = 14 * 24 * HOUR_MS;
/** True when a paused session report says the cloud lane cannot do this card's work. */
function laneUnworkableReason(reportBody) {
  return LANE_UNWORKABLE_RE.test(String(reportBody || ''));
}
const AUTOMATION_PARK_STALE_MS = 3 * 24 * HOUR_MS;
const MACHINE_PARK_LINE_RE = /Auto-filed by (?:digest-autofix|owner-alert-router)/;

/**
 * True when a PARKED line names an owner hold. Only the first PARKED line can be
 * a filer's machine line (MACHINE_PARK_LINE_RE), which is not a hold; a later
 * line that merely quotes the marker is still a person's hold.
 */
function hasPersonParkHold(notes) {
  const hd = require('./headless-dispatchability.js');
  return [...String(notes || '').matchAll(/^\s*PARKED\s*:(.*)$/gim)]
    .some((m, i) => !(i === 0 && MACHINE_PARK_LINE_RE.test(m[1])) && hd.OWNER_HOLD_PARK_RE.test(m[1]));
}

const FILER_RECOMMENT_SLACK_MS = 5000;
// The comment a filer posts to refresh a card's notes starts with its own marker
// ("Auto-filed by the morning digest ..." from digest-autofix's notes builder, or
// the park-line forms). Anchored: a person quoting the phrase mid-comment is not the filer.
const FILER_RECOMMENT_RE = /^\s*Auto-filed by (?:the morning digest|digest-autofix|owner-alert-router)\b/;

/**
 * BRO-6234: when the issue was last touched by a person or a real event. A
 * filer's daily re-comment (digest-autofix refreshing its notes) bumps
 * updatedAt and reset the 3-day quiet timer, so 31 machine-filed cards never
 * aged out. Only trailing filer re-comments whose time matches updatedAt are
 * skipped (a description edit or state move after them keeps updatedAt); dispatch
 * and claim receipts still count as activity. Without comments: updatedAt.
 */
function effectiveTouchMs(issue) {
  const updatedMs = Date.parse(issue && issue.updatedAt);
  const nodes = (issue && issue.comments && Array.isArray(issue.comments.nodes)) ? issue.comments.nodes : [];
  if (!Number.isFinite(updatedMs) || !nodes.length) return updatedMs;
  const dated = nodes.filter((c) => c && Number.isFinite(Date.parse(c.createdAt)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let end = dated.length;
  while (end > 0 && (FILER_RECOMMENT_RE.test(String(dated[end - 1].body || '')) || isFilerRefreshComment(dated[end - 1].body))) end--;
  if (end === dated.length) return updatedMs;
  const lastFilerMs = Date.parse(dated[dated.length - 1].createdAt);
  if (Math.abs(updatedMs - lastFilerMs) > FILER_RECOMMENT_SLACK_MS) return updatedMs;
  const before = end > 0 ? Date.parse(dated[end - 1].createdAt) : Date.parse(issue.createdAt);
  return Number.isFinite(before) ? Math.min(before, updatedMs) : updatedMs;
}

/** A machine-filed parked card (any triaged priority) nobody has touched for AUTOMATION_PARK_STALE_MS. */
function isStaleAutomationParked(issue, nowMs) {
  const hd = require('./headless-dispatchability.js');
  const type = issue && issue.state && issue.state.type;
  if (type !== 'backlog' && type !== 'unstarted') return false;
  const priority = Number(issue.priority);
  if (!PRIORITIES.has(priority) && priority !== P2_PRIORITY && priority !== P3_PRIORITY) return false;
  const notes = issue.description || '';
  if (!hd.isAutomationParked(notes)) return false;
  // isAutomationParked reads only the leading machine line; a hold a person
  // added on a later PARKED line still keeps the card parked.
  if (hasPersonParkHold(notes)) return false;
  const touchMs = effectiveTouchMs(issue);
  return Number.isFinite(touchMs) && nowMs - touchMs >= AUTOMATION_PARK_STALE_MS;
}

/** True when the description or a comment carries the VERIFY: owner-judgment marker. */
function ownerJudgmentMarked(issue) {
  const { evaluateVerifiability } = require('./verify-gate.js');
  const { sortedCommentBodies } = require('./linear-dispatch.js');
  return !!evaluateVerifiability(issue.description || '', sortedCommentBodies(issue)).ownerJudgment;
}

/** Why a headless worker can't finish this card (no safe VERIFY, or a headless blocker), or null. */
function headlessUnfitReason(issue, { allowParkedSentinel = false } = {}) {
  const hd = require('./headless-dispatchability.js');
  const drain = require('./linear-drain-parked.js');
  // BRO-6080: filed for the Mac ('mac-only' label or a MAC-ONLY: line). The Mac's
  // parked drain takes it; every cloud lane (pick, resume, Codex, unpark) leaves it.
  if (require('./mac-only-marker.js').isMacOnlyCard(issue)) return 'mac-only';
  if (IOS_APP_CARD_RE.test(String(issue.title || ''))) return 'ios-app-repo';
  // BRO-2204: a card marked "NO-DISPATCH:" must not be launched by any
  // dispatcher; the cloud worker picked one that said it needs the owner's
  // answer before any code. Description only: comments quote the marker.
  if (require('./no-dispatch-marker.js').hasNoDispatchMarker(issue.description)) return 'no-dispatch-marker';
  const cmd = drain.verifyCommand(issue);
  // BRO-5370: a "VERIFY: owner-judgment" card is armed for a person, not a
  // worker. Counting it as no-safe-verify hid the 35 cards the arming pass
  // can still fix behind 76 that only a person can close.
  if (!cmd) return ownerJudgmentMarked(issue) ? 'owner-judgment' : 'no-safe-verify';
  if (CLOUD_UNRUNNABLE_VERIFY_RE.test(String(cmd).trim())) {
    return 'verify-not-cloud-runnable';
  }
  const { sortedCommentBodies } = require('./linear-dispatch.js');
  const { blockers } = hd.classifyHeadlessDispatchability({ subject: issue.title, notes: issue.description || '', comments: sortedCommentBodies(issue) }, { verifyCmd: cmd });
  const blocking = blockers.filter((b) => !(allowParkedSentinel && b.code === hd.BLOCKERS.PARKED_SENTINEL));
  return blocking.length ? `blocker-${blocking[0].code}` : null;
}

// What the filer should change for each reason a START-NOW card can't be picked.
const START_NOW_FIX_HINTS = {
  'parked-or-backlog': 'file it with --dispatch, not --park',
  'not-p0-p1': 'file it with --priority 1 or 2',
  'no-safe-verify': 'add a safe-form "VERIFY: <cmd>" line (node --test <path>.test.mjs, npx tsc --noEmit, npm run lint, test -f <path>)',
  'owner-judgment': 'the card says a person must judge it (VERIFY: owner-judgment); drop START-NOW or replace the marker with a safe-form VERIFY',
  'verify-not-cloud-runnable': 'use a narrower VERIFY than the whole unit suite',
  'no-dispatch-marker': 'drop NO-DISPATCH or drop START-NOW',
  'ios-app-repo': 'the cloud worker cannot check out the app repo; drop START-NOW',
  'mac-only': 'the Mac drain takes mac-only cards, not the cloud worker; drop START-NOW',
};

/**
 * PURE. Why a card filed now with a START-NOW line would never be picked by the
 * cloud worker, or null (BRO-5017: filed with prose acceptance criteria, it sat
 * in Todo under startNowSkipped, which nobody reads). Same checks skipReason
 * applies to a fresh unstarted card, on the description as it will be stored.
 * @param {{title: string, description: string, priority: (number|undefined), mode: string}} card
 * @returns {{reason: string, hint: string}|null}
 */
function startNowUnpickableReason({ title, description, priority, mode }) {
  const issue = { title, description };
  if (!hasStartNowLine(issue)) return null;
  let reason = null;
  if (mode !== 'dispatch') reason = 'parked-or-backlog';
  else if (!PRIORITIES.has(Number(priority))) reason = 'not-p0-p1';
  else reason = headlessUnfitReason(issue);
  if (!reason) return null;
  return { reason, hint: START_NOW_FIX_HINTS[reason] || 'remove what the reason names from the notes, or drop START-NOW' };
}

/**
 * Why this card can't be picked in a tier, or null. The default tier is
 * P0/P1 ('not-p0-p1' for anything else). `{ tier: 'p2' }` checks the P2
 * fallback: priority 3 only ('not-p2' otherwise), every other rule the same
 * (technical session parks, stale machine-filed parks and paused Backlog
 * cards included). `{ tier: 'p3' }` is the same for priority 4
 * ('not-p3').
 */
function skipReason(issue, nowMs, { tier = 'p0p1', codex = false } = {}) {
  const drain = require('./linear-drain-parked.js');
  if (!issue || !issue.identifier) return 'malformed';
  const fallbackPriority = FALLBACK_TIER_PRIORITY[tier];
  const fallback = fallbackPriority != null;
  if (fallback ? Number(issue.priority) !== fallbackPriority : !PRIORITIES.has(Number(issue.priority))) return fallback ? `not-${tier}` : 'not-p0-p1';
  const type = issue.state && issue.state.type;
  // Technical session parks (needs a review, a worktree, a monitor window) at every tier (BRO-5369);
  // the fallback tiers use the stricter isFallbackTechnicalPark.
  const parkedDrainable = (fallback ? isFallbackTechnicalPark(issue) : drain.isSessionParkedDrainable(issue))
    || isStaleAutomationParked(issue, nowMs);
  if (type !== 'unstarted' && !parkedDrainable && !isPausedBacklog(issue)) return type === 'backlog' ? 'parked-or-backlog' : `state-${type}`;
  const unfit = headlessUnfitReason(issue, { allowParkedSentinel: parkedDrainable });
  if (unfit) return unfit;
  const updatedMs = effectiveTouchMs(issue);
  if (!Number.isFinite(updatedMs)) return 'no-updatedAt';
  // For the Codex runner only (codex: true): a fix round it carried to its next run (BRO-5384) is
  // its own hand-back note, not someone working the card. The Claude lane keeps the 6 h wait, so
  // it does not take the card first and redo it without Codex's carried change.
  const CR = codex && require('./codex-runner.js');
  // A carried fix round or a retry note (BRO-6260) is the newest comment, which makes the card look recently touched.
  const carry = codex && (CR.parseSwfCarry(issue.comments && issue.comments.nodes, nowMs) || CR.parseCodexRetry(issue.comments && issue.comments.nodes));
  if (nowMs - updatedMs < IDLE_MS && (fallback || !(isStartNow(issue, nowMs) || isOwnerTaskResume(issue, nowMs))) && !carry) return 'recent-activity';
  return null;
}

/**
 * The pause-history verdict both lanes apply before taking a card (firstUnpaused, the Codex
 * runner's claim-time re-check, leaveCodexCards): one call so the rule can't drift between them
 * (BRO-5407). `nodes` are the card's comments. -> reason string or null
 */
function historySkipReason(issue, nodes, nowMs, { cloudLane = false } = {}) {
  return pausedHistorySkipReason(nodes || [], nowMs, { priority: issue && issue.priority, pausedBacklog: isPausedBacklog(issue), cloudLane });
}

/**
 * Codex first (BRO-5384): the Claude worker's queue while a Codex runner is live. The cards Codex
 * would take (codex-runner.js leaveToCodex) are left to it, but only as many as one Codex firing
 * works (`cap`, board-workers --limit), in Codex's own order (tier, then fit score; START-NOW cards are never left), so a
 * backlog past Codex's capacity, or a runner that died holding its lock, never parks the rest.
 * Resume entries always stay, and so do cards Codex would skip for their pause history
 * (historySkipReason) or whose comments were not read: leaving those spent the cap on cards
 * neither lane takes and kept Codex's real picks in the Claude queue (BRO-5407).
 * -> { queue, left: [identifier] }
 */
function leaveCodexCards(queue, { nowMs, verifyOf = () => '', cap = 9 } = {}) {
  const { leaveToCodex, codexCardFit, codexLadderAccess } = require('./codex-runner.js');
  const ladder = codexLadderAccess(); // once per pick (BRO-6303)
  const tierRank = new Map();
  for (const q of queue) if (!tierRank.has(q.tier)) tierRank.set(q.tier, tierRank.size);
  const fit = queue.filter((q) => !q.resume
    && q.issue.comments && Array.isArray(q.issue.comments.nodes)
    && !historySkipReason(q.issue, q.issue.comments.nodes, nowMs)
    && leaveToCodex(q.issue, { nowMs, verify: verifyOf(q.issue), startNow: isStartNow(q.issue, nowMs), ladder }))
    .map((q) => ({ q, score: codexCardFit({ title: q.issue.title, description: q.issue.description, verify: verifyOf(q.issue), comments: q.issue.comments.nodes, nowMs, ladder, dataRouteLocked: false }).score }))
    .sort((a, b) => tierRank.get(a.q.tier) - tierRank.get(b.q.tier) || b.score - a.score);
  const leave = new Set(fit.slice(0, Math.max(0, cap)).map((x) => x.q));
  return { queue: queue.filter((q) => !leave.has(q)), left: [...leave].map((q) => q.issue.identifier) };
}

/** True for a P2 card that is a fallback candidate at all (Todo). */
function isP2FallbackCandidate(issue, nowMs) {
  const r = skipReason(issue, nowMs, { tier: 'p2' });
  return !/^(malformed|not-p2|parked-or-backlog|state-.*)$/.test(r || '');
}

/** True for a P3 (Low) card that is a fallback candidate at all (Todo). */
function isP3FallbackCandidate(issue, nowMs) {
  const r = skipReason(issue, nowMs, { tier: 'p3' });
  return !/^(malformed|not-p3|parked-or-backlog|state-.*)$/.test(r || '');
}

/**
 * Cards the CLI must read comments for before picking: every P0/P1 card the
 * state rules don't rule out (parked and started/resume ones included), every
 * P2 and P3 Todo card, and every P2/P3 card a land ref could resume. Comments carry a
 * VERIFY that arms or corrects the card (BRO-4642), pause history, the Codex
 * bounce marker and the retry signal pickModel reads.
 */
function needsComments(issue, nowMs) {
  if (!/^(malformed|not-p0-p1)$/.test(skipReason(issue, nowMs) || '')) return true;
  if (isP2FallbackCandidate(issue, nowMs) || isP3FallbackCandidate(issue, nowMs)) return true;
  const { issueNumber } = require('./linear-drain-parked.js');
  return !!(issue && issue.identifier)
    && resumableCardsByNumber([issue], { includeP2: true, includeP3: true }).has(issueNumber(issue.identifier));
}

/**
 * @param {Array<object>} issues - open Linear issues ({identifier, title, description, priority, state, updatedAt})
 * @param {{nowMs:number}} opts
 * @returns {{ pick: object|null, pickTier: ('p0p1'|'p2-fallback'|'p3-fallback'|null), ordered: object[], eligible: number,
 *   skipped: Record<string, number>, orderedP2: object[], eligibleP2: number, skippedP2: Record<string, number>,
 *   orderedP3: object[], eligibleP3: number, skippedP3: Record<string, number>,
 *   startNowSkipped: Record<string, string> }}
 *   `ordered`/`eligible`/`skipped` are the P0/P1 tier, as before (a P2 or P3 card still counts as
 *   'not-p0-p1' there); `orderedP2`/`eligibleP2`/`skippedP2` are the P2 fallback tier and
 *   `orderedP3`/`eligibleP3`/`skippedP3` the P3 (Low) fallback tier.
 */
function pickCloudCard(issues, { nowMs, codex = false }) {
  const { priorityRank } = require('./linear-dispatch.js');
  const { issueNumber } = require('./linear-drain-parked.js');
  const skipped = {};
  const eligible = [];
  const skippedP2 = {};
  const eligibleP2 = [];
  const skippedP3 = {};
  const eligibleP3 = [];
  // START-NOW Todo cards that won't run (no safe VERIFY, a blocker, too new or
  // too old), by id: a filer told the owner they were queued, so say why not.
  const startNowSkipped = {};
  for (const iss of Array.isArray(issues) ? issues : []) {
    const reason = skipReason(iss, nowMs, { codex });
    if (reason) skipped[reason] = (skipped[reason] || 0) + 1;
    else eligible.push(iss);
    let fallbackEligible = false;
    if (reason === 'not-p0-p1' && Number(iss.priority) === P2_PRIORITY) {
      const r2 = skipReason(iss, nowMs, { tier: 'p2', codex });
      if (r2) skippedP2[r2] = (skippedP2[r2] || 0) + 1;
      else { eligibleP2.push(iss); fallbackEligible = true; }
    } else if (reason === 'not-p0-p1' && Number(iss.priority) === P3_PRIORITY) {
      const r3 = skipReason(iss, nowMs, { tier: 'p3', codex });
      if (r3) skippedP3[r3] = (skippedP3[r3] || 0) + 1;
      else { eligibleP3.push(iss); fallbackEligible = true; }
    }
    // A P2/P3 card the fallback can pick is not "skipped", though its START-NOW line is ignored.
    if (hasStartNowLine(iss) && iss.state && iss.state.type === 'unstarted' && !fallbackEligible && (reason || !isStartNow(iss, nowMs))) {
      startNowSkipped[iss.identifier] = reason || 'start-now-outside-age-window';
    }
  }
  // Within a priority, the old machine-filed backlog goes after cards a person
  // filed or a session parked, so ~280 stale autofix cards can't starve them.
  const machineTier = (iss) => (iss.state && iss.state.type === 'unstarted') || !isStaleAutomationParked(iss, nowMs) ? 0 : 1;
  const startTier = (iss) => (isStartNow(iss, nowMs) || isOwnerTaskResume(iss, nowMs) ? 0 : 1);
  eligible.sort((a, b) => (startTier(a) - startTier(b)) || (priorityRank(a) - priorityRank(b)) || (machineTier(a) - machineTier(b))
    || (issueNumber(a.identifier) - issueNumber(b.identifier)));
  // START-NOW doesn't apply to P2 and P3: Todo and paused cards oldest first, then
  // technical parks, then stale machine-filed parks (BRO-5369).
  const fallbackTier = (iss) => (isStaleAutomationParked(iss, nowMs) && !(iss.state && iss.state.type === 'unstarted') ? 2 : (isFallbackTechnicalPark(iss) ? 1 : 0));
  eligibleP2.sort((a, b) => (fallbackTier(a) - fallbackTier(b)) || (issueNumber(a.identifier) - issueNumber(b.identifier)));
  eligibleP3.sort((a, b) => (fallbackTier(a) - fallbackTier(b)) || (issueNumber(a.identifier) - issueNumber(b.identifier)));
  const pick = eligible[0] || eligibleP2[0] || eligibleP3[0] || null;
  const pickTier = eligible.length ? TIER_P0P1 : (eligibleP2.length ? TIER_P2 : (eligibleP3.length ? TIER_P3 : null));
  return {
    pick, pickTier, ordered: eligible, eligible: eligible.length, skipped, startNowSkipped,
    orderedP2: eligibleP2, eligibleP2: eligibleP2.length, skippedP2,
    orderedP3: eligibleP3, eligibleP3: eligibleP3.length, skippedP3,
  };
}

/**
 * PURE. The CLI's pick queue, in the order it is worked: P0/P1 resumes, P0/P1
 * cards, P2 resumes, P2 cards, P3 resumes, P3 cards, each entry tagged with its
 * tier. Resumes are split by their own priority, so a P2/P3 landing never rides
 * in the P0/P1 block (where mayTakeUnchecked would skip its history check); a
 * resume of any other priority is dropped.
 * @param {Array<{issue: object}>} resumes - findResumeCandidates output
 * @param {{ordered: object[], orderedP2: object[], orderedP3: object[]}} tiers - pickCloudCard output
 * @returns {Array<{issue: object, resume: object|null, tier: string}>}
 */
function buildPickQueue(resumes, { ordered = [], orderedP2 = [], orderedP3 = [] } = {}) {
  const rs = Array.isArray(resumes) ? resumes : [];
  const resumesAt = (match, tier) => rs.filter((r) => r && r.issue && match(Number(r.issue.priority)))
    .map((r) => ({ issue: r.issue, resume: r, tier }));
  const fresh = (list, tier) => list.map((iss) => ({ issue: iss, resume: null, tier }));
  return [
    ...resumesAt((p) => PRIORITIES.has(p), TIER_P0P1),
    ...fresh(ordered, TIER_P0P1),
    ...resumesAt((p) => p === P2_PRIORITY, TIER_P2),
    ...fresh(orderedP2, TIER_P2),
    ...resumesAt((p) => p === P3_PRIORITY, TIER_P3),
    ...fresh(orderedP3, TIER_P3),
  ];
}

/**
 * PURE. Earlier worker runs on this card that left no "Dispatched ..." comment
 * and no Mac ledger row: a cloud worker's session report that did not close it
 * (paused, blocked, in-review), and a Codex runner bounce. Mac dispatches are
 * already counted by pickLinearModel (comments and ledger).
 */
function cloudPriorAttempts(issue) {
  const { parseSessionReportStatus } = require('./linear-session-reporting.js');
  const { isCodexBounce } = require('./codex-runner.js');
  const nodes = (issue && issue.comments && issue.comments.nodes) || [];
  return nodes.filter((c) => {
    const body = String((c && c.body) || '');
    const status = parseSessionReportStatus(body);
    return (status && status !== 'done') || isCodexBounce(body);
  }).length;
}

/**
 * The model a cloud worker should run this card on, by the same policy as a
 * Mac dispatch (linear-next.js -> bsc-next-model.js pickLinearModel): a retry
 * escalates, a filer's "Model:" line is honored on the first attempt, a P0
 * gets Opus, and a card's own Opus line spends the daily Opus budget (BRO-6684,
 * opus-budget.js; pass it as opts.opusBudget). Cloud retries (cloudPriorAttempts) count as prior launches; they
 * are added as ledger rows with no model.
 * @param {object} issue - Linear issue, with prefetched comments
 * @param {{readEntries?:Function}} [opts] - readEntries defaults to the dispatch ledger
 * @returns {{ model: string, reason: string }}
 */
function pickModel(issue, { readEntries, opusBudget = null } = {}) {
  const { pickLinearModel } = require('./bsc-next-model.js');
  const baseRead = readEntries || require('./dispatch-ledger.js').readEntries;
  const taskId = `linear:${issue && issue.identifier}`;
  const prior = cloudPriorAttempts(issue);
  const read = () => [...baseRead(), ...Array.from({ length: prior }, () => ({ event: 'launch', taskId, model: null }))];
  return pickLinearModel({ explicitFlag: null, issue, taskId, readEntries: read, opusBudget });
}

/**
 * Ledger-shaped launch rows for the cloud's own Opus work (BRO-5730): one per claim comment whose
 * "Worker model:" line says opus. The cloud has no dispatch ledger, so without these the board's
 * 24h Opus usage count never saw a cloud launch. comments: [{ body, createdAt, issue: { identifier } }].
 */
function opusClaimEntries(comments) {
  const { parseWorkerModel } = require('./linear-session-reporting.js');
  return (Array.isArray(comments) ? comments : [])
    .filter((c) => c && c.issue && parseWorkerModel(c.body) === 'opus')
    // One row per card (BRO-6684): a parent's claim and its child's re-claim are one launch.
    .filter((c, i, all) => all.findIndex((d) => d.issue.identifier === c.issue.identifier) === i)
    .map((c) => ({ event: 'launch', source: 'cloud-claim', taskId: `linear:${c.issue.identifier}`, model: 'opus', ts: c.createdAt }));
}

/**
 * Ledger entries plus cloud Opus claim rows, leaving out a claim within an hour of any real ledger
 * launch of the same card (a Mac-dispatched worker that also posted a claim). Claim rows carry
 * source 'cloud-claim': they count toward the 24h Opus usage count only, not as prior launches of a card.
 */
function withCloudOpusClaims(entries, claims) {
  const { isRealLaunch } = require('./bsc-next-model.js');
  const base = Array.isArray(entries) ? entries : [];
  const launches = new Map();
  for (const e of base) {
    const ts = isRealLaunch(e) ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(ts)) launches.set(e.taskId, [...(launches.get(e.taskId) || []), ts]);
  }
  const extra = (claims || []).filter((c) => !(launches.get(c.taskId) || []).some((t) => Math.abs(Date.parse(c.ts) - t) < 60 * 60_000));
  return [...base, ...extra];
}

/** -> the last 24h of "Worker model: opus" claim comments as launch rows (opusClaimEntries). */
async function fetchOpusClaimEntries(nowMs = Date.now(), client = require('./linear-client.js')) {
  const { LINEAR_OPUS_WINDOW_MS } = require('./bsc-next-model.js');
  const comments = await client.listRecentCommentsContaining({ sinceIso: new Date(nowMs - LINEAR_OPUS_WINDOW_MS).toISOString(), text: 'Worker model: opus' });
  return opusClaimEntries(comments);
}

/**
 * pickModel with the dispatch ledger read once per run. The ledger is the Mac's
 * (gitignored); in a cloud container it is absent and reads as [], so Mac
 * retries are invisible there (the card's "Dispatched" comments still count).
 * Shared by scripts/cloud-worker-pick.js and scripts/session-model.js.
 */
function modelPicker({ opusBudget = null } = {}) {
  const ledger = require('./dispatch-ledger.js');
  const ledgerMissing = !require('fs').existsSync(ledger.LEDGER_PATH);
  let entries;
  const readEntries = () => {
    if (entries === undefined) entries = ledger.readEntries();
    return entries;
  };
  return (issue) => {
    const m = pickModel(issue, { readEntries, opusBudget });
    return ledgerMissing && m.model === 'sonnet' ? { ...m, reason: `${m.reason} (no dispatch ledger here: Mac launches of this card are not counted as retries)` } : m;
  };
}

/**
 * Why no worker may be started on this card (BRO-6502): its description carries a
 * "NO-DISPATCH:" line (BRO-2204). Description only, as headlessUnfitReason: comments quote the
 * marker, and deleting the line from the description is how a hold is lifted.
 * Used by session-model.js, which exits 3 without a model; this is advisory for a hand-started
 * create_session (the hook only checks the model id, and --no-card skips the check).
 * @returns {'no-dispatch-marker'|null}
 */
function noDispatchHold(issue) {
  return require('./no-dispatch-marker.js').hasNoDispatchMarker(issue && issue.description) ? 'no-dispatch-marker' : null;
}

/**
 * The create_session `model` for a worker session given its cards' picks
 * (BRO-5228). Sonnet unless EVERY card needs Opus: a mixed batch runs on Sonnet
 * and hands each Opus card to an Opus subagent, as the board worker does
 * (docs/cloud-routines/board-workers.md step 4), so one retry card does not
 * put the whole batch on Opus. No cards (owner-asked work with no card): Sonnet.
 * @param {Array<{model: string}>} picks - modelPicker results, short aliases
 * @returns {{ model: string, opusCards: number }} model is the full id create_session takes
 */
function sessionModelFor(picks) {
  const { DISPATCH_SONNET, DISPATCH_OPUS } = require('./models.js');
  const list = Array.isArray(picks) ? picks : [];
  const opusCards = list.filter((p) => p && p.model === 'opus').length;
  const allOpus = list.length > 0 && opusCards === list.length;
  return { model: allOpus ? DISPATCH_OPUS : DISPATCH_SONNET, opusCards };
}

/**
 * Past the history-check budget, only a P0/P1 Todo entry may be taken unchecked;
 * P2/P3 entries and paused Backlog cards (a pause is why they are there) are always checked.
 */
function mayTakeUnchecked(entry) {
  return !!entry && entry.tier === TIER_P0P1 && !isPausedBacklog(entry.issue);
}

/**
 * Why an earlier worker's pause should keep this card out of the pick, or null.
 * @param {Array<{body:string, createdAt:string}>} comments - the card's comments, any order
 * @param {number} nowMs
 * @param {{priority?: number, pausedBacklog?: boolean}} [opts] - priority: the card's Linear priority, P0/P1
 *   wait out RECENT_PAUSE_URGENT_MS instead. pausedBacklog: the card is a paused Backlog card
 *   (isPausedBacklog), which is only taken when a worker's session report or a Codex runner
 *   note shows a worker put it there; one moved to Backlog by hand is 'backlog-unexplained'.
 * @returns {'awaiting-owner'|'lane-unworkable'|'backlog-unexplained'|'reclaimed-to-backlog'|'recheck-pending'|'paused-repeatedly'|'recently-paused'|null}
 */
function pausedHistorySkipReason(comments, nowMs, { priority, pausedBacklog = false, cloudLane = false } = {}) {
  const { parseSessionReportStatus } = require('./linear-session-reporting.js');
  const { BOUNCED_MARKER } = require('./codex-runner.js');
  const { parseRecheckAfter } = require('./recheck-stamp.js');
  const sorted = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && Number.isFinite(Date.parse(c.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const idx = sorted.findIndex((c) => parseSessionReportStatus(c.body) != null);
  if (pausedBacklog && idx < 0 && !sorted.some((c) => CODEX_RUNNER_NOTE_RE.test(String(c.body || '')) || String(c.body || '').startsWith(BOUNCED_MARKER))) {
    return 'backlog-unexplained';
  }
  // Sent to Backlog by the reclaim sweep after repeated dead sessions: out until a person comments after it.
  const reclaimIdx = sorted.findIndex((c) => RECLAIM_TO_BACKLOG_RE.test(String(c.body || '').trim()));
  if (pausedBacklog && reclaimIdx >= 0 && (idx < 0 || reclaimIdx < idx)
    && !sorted.slice(0, reclaimIdx).some((c) => !isMachineComment(c.body) && parseSessionReportStatus(c.body) == null)) {
    return 'reclaimed-to-backlog';
  }
  // The newest RECHECK-AFTER stamp is still ahead: the fix waits on time (a day of cron runs,
  // an opening night), and the nightly acceptance recheck owns the card until then. Working it
  // early only re-runs a check that cannot pass yet (BRO-5384: 4 of 32 Codex bounces). A later
  // human comment re-opens it.
  const stampIdx = sorted.findIndex((c) => parseRecheckAfter(c.body) != null);
  if (stampIdx >= 0 && parseRecheckAfter(sorted[stampIdx].body) > nowMs
    && !sorted.slice(0, stampIdx).some((c) => !isMachineComment(c.body))) return 'recheck-pending';
  if (idx < 0) return null;
  const report = sorted[idx];
  if (parseSessionReportStatus(report.body) !== 'paused') return null;
  // A comment after the pause (the owner's answer, a human note) re-opens it to the idle rule.
  const answered = sorted.slice(0, idx).some((c) => !isMachineComment(c.body));
  const ageMs = nowMs - Date.parse(report.createdAt);
  if (!answered && ageMs < AWAITING_OWNER_MAX_MS && namesOwnerHold(report.body)) return 'awaiting-owner';
  if (cloudLane && !answered && ageMs < LANE_UNWORKABLE_MAX_MS && laneUnworkableReason(report.body)) return 'lane-unworkable';
  const pauses = sorted.filter((c) => parseSessionReportStatus(c.body) === 'paused').length;
  if (!answered && pauses >= MAX_PAUSES) return 'paused-repeatedly';
  // The owner did the Mac task the pause was waiting on (BRO-6654): no cooldown.
  if (answered && isOwnerTaskResume({ comments: { nodes: sorted } }, nowMs)) return null;
  const cooldownMs = PRIORITIES.has(Number(priority)) ? RECENT_PAUSE_URGENT_MS : RECENT_PAUSE_MS;
  return ageMs < cooldownMs ? 'recently-paused' : null;
}

function isMachineComment(body) {
  const text = String(body || '').trim();
  return MACHINE_COMMENT_RE.test(text) || MACHINE_TAG_RE.test(text) || isFilerRefreshComment(text);
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
 * Open P0/P1 cards (and P2 with includeP2, P3 with includeP3: the fallback
 * tiers' landings, which the Codex runner leaves In Progress for this resume) someone holds (started,
 * not In Review): the only ones a land ref can resume. In Review already has an owner, the stuck-card closer, which
 * runs the card's check and closes it or bounces it back to Todo.
 */
function resumableCardsByNumber(issues, { includeP2 = false, includeP3 = false } = {}) {
  const { issueNumber } = require('./linear-drain-parked.js');
  const byNum = new Map();
  for (const iss of Array.isArray(issues) ? issues : []) {
    const p = Number(iss && iss.priority);
    if (!iss || !iss.identifier || !(PRIORITIES.has(p) || (includeP2 && p === P2_PRIORITY) || (includeP3 && p === P3_PRIORITY))) continue;
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
 * @param {{nowMs:number, landDispatchInFlight?:boolean, includeP2?:boolean, includeP3?:boolean}} opts
 * @returns {Array<{ issue: object, ref: string, sha: string, lastRun: object, kind: 'refused'|'evicted' }>} best first
 */
function findResumeCandidates(issues, landRefs, { nowMs, landDispatchInFlight = false, includeP2 = false, includeP3 = false }) {
  if (landDispatchInFlight) return [];
  const { priorityRank } = require('./linear-dispatch.js');
  const { issueNumber } = require('./linear-drain-parked.js');
  const cards = resumableCardsByNumber(issues, { includeP2, includeP3 });
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
  leaveCodexCards,
  isMachineComment, laneUnworkableReason, LANE_UNWORKABLE_MAX_MS,
  IDLE_MS, STRANDED_MS, RESUME_WINDOW_MS, MAX_LAND_RUNS, RECENT_PAUSE_MS, RECENT_PAUSE_URGENT_MS, MAX_PAUSES, AWAITING_OWNER_MAX_MS, isPausedBacklog,
  AUTOMATION_PARK_STALE_MS, effectiveTouchMs, hasPersonParkHold, isFallbackTechnicalPark, START_NOW_MIN_AGE_MS, START_NOW_MAX_AGE_MS, IOS_APP_CARD_RE, isStaleAutomationParked, isStartNow, hasStartNowLine, isOwnerTaskResume, startNowUnpickableReason, skipReason, pickCloudCard, pausedHistorySkipReason, historySkipReason, landRefCardNumber, resumableCardsByNumber,
  P2_PRIORITY, TIER_P0P1, TIER_P2, isP2FallbackCandidate, P3_PRIORITY, TIER_P3, isP3FallbackCandidate, buildPickQueue, needsComments, pickModel, modelPicker, noDispatchHold, opusClaimEntries, fetchOpusClaimEntries, withCloudOpusClaims, sessionModelFor, cloudPriorAttempts, mayTakeUnchecked,
  findResumeCandidates, findResumeCard, headlessUnfitReason, AWAITING_OWNER_RE, namesOwnerHold, FALLBACK_PARK_DENY_RE,
};
