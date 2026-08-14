/**
 * task-reclaim — pure decision logic for returning archive-trapped
 * `in_progress` tasks to the backlog (card #1402).
 *
 * THE TRAP. task-store-archive.js used to move an `in_progress` task into
 * archive/ after 7d untouched with its status untouched. Nothing flips such a
 * task back: sweepUntrackedInProgress (bsc-reconcile.js) reads the LIVE dir
 * only, by deliberate design (bsc-next.js:84-95). Measured 2026-08-12: 86 of
 * 942 archived tasks. The forward leak is already closed — archiveCopyFor()
 * now writes newly-archived in_progress tasks as status 'pending' — but that
 * fix cannot reach the ones already inside archive/.
 *
 * WHY RECLAIM IS A MOVE, NOT A RELABEL (plan-review v1, unanimous fail).
 * Rewriting the archive copy to `pending` in place looks like the minimal fix
 * and is the wrong one: TWO auto-dispatchers read archive/ and act on
 * `status === 'pending'`.
 *   - dispatch-watchdog.js:214 -> loadTasksUnioned() (audit-dispatch-outcomes.js:47)
 *     unions live AND archive/; planSweep's p01Queue (dispatch-watchdog-core.js:236)
 *     takes any pending P0/P1 from that map.
 *   - bsc-prune.js:393 taskStatusById() falls back to readArchivedTask(), and
 *     zombie-tab-sweep.js:82 revives a dead tab whose task reads `pending`.
 * So the reclaim writes the task back into the LIVE dir under the SAME id and
 * DELETES the archive copy. That leaves exactly one record per task, in the
 * directory every consumer already expects, with no archive-resident `pending`
 * for either dispatcher to act on unattended. Keeping the id is what preserves
 * blocks/blockedBy and the existing .notion-map mapping — a Notion round-trip
 * would re-mint a fresh id (notion-tasks-sync.js:462 -> doCreate) and orphan
 * the old record.
 *
 * WHY BREADCRUMBS ARE JSON FIELDS, NEVER PREPENDED TEXT (plan-review W1).
 * taskPriority() (dispatch-watchdog-core.js:71-77) anchors `^\[notion:` on
 * LINE 1 of the description. sweepUntrackedInProgress's flipFn prepends its
 * marker, which is safe there but would be fatal here: prepending a reclaim
 * note pushes `[notion:` off line 1 and makes every reclaimed task invisible to
 * p01Queue — a silent no-op that looks like success. reclaimedTaskShape()
 * therefore only ever touches JSON fields and the status segment WITHIN line 1.
 */

'use strict';

// Scans the WHOLE description, not line 1 (plan-review C2): a task already
// swept by sweepUntrackedInProgress carries a prepended `[zombie-sweep …]`
// note, so its `[notion:…]` is no longer first. A line-1-anchored match
// under-counted the live-twin population as 3 when it is really 14.
const NOTION_MARKER_RE = /\[notion:([0-9a-f-]{16,})\]/i;

// The morning digest's own auto-filed alert family. Both producers file these
// to Linear as of the BRO-286 migration, and the digest re-mints a fresh card
// daily regardless — so an archived one is superseded by construction, not
// work anybody is waiting on. Same title bet notion-tasks-sync.js:177
// (isMirrorableCard) and task-store-archive.js already make.
const BSC_DAILY_RE = /^(?:\[fix\]\s*)?BSC Daily:/;

// Notion statuses that mean "this card is finished" — reclaiming one would
// redispatch completed work (plan-review E-i; the #383 class that task #1272
// already had to fix once for the live sweep).
const TERMINAL_CARD_STATUSES = new Set(['Done', 'Archived', 'Cancelled']);

const DEFAULT_IDLE_MS = 48 * 60 * 60 * 1000; // same bar as sweepUntrackedInProgress

function notionMarkerOf(task) {
  // metadata.notionCard FIRST, matching notionIdOfTask (bsc-reconcile.js:472-477)
  // which checks it before the description. A task carrying only the metadata
  // form would otherwise read as marker-less and skip every Notion guard
  // (ship-check warning). No instances in the corpus today; latent otherwise.
  const meta = task && task.metadata && task.metadata.notionCard;
  if (typeof meta === 'string' && meta.trim()) return meta.trim().toLowerCase();
  const m = NOTION_MARKER_RE.exec(String((task && task.description) || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Loose title key for the marker-less population — punctuation/case insensitive. */
function normalizeSubject(subject) {
  return String(subject || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isBscDaily(task) {
  return BSC_DAILY_RE.test(String((task && task.subject) || ''));
}

/**
 * Does a git branch or worktree exist that looks like it belongs to this task?
 *
 * A trapped task WITH dispatch-ledger start events may have real commits on an
 * abandoned branch; re-running it could duplicate or conflict with work that
 * already exists. This predicate is deliberately LOOSE — a false positive only
 * parks a task for human review (cheap), while a false negative risks the
 * data-loss case the card explicitly forbids. Matched names are returned so the
 * report can show WHY something parked: low task ids like 5 or 7 will collide
 * with unrelated branch names and the operator needs to see that (plan-review E-iii).
 *
 * @param {string|number} taskId
 * @param {{branches?: string[], worktreePaths?: string[]}} sources
 */
function taskBranchEvidence(taskId, { branches = [], worktreePaths = [] } = {}) {
  const id = String(taskId);
  if (!/^\d+$/.test(id)) return { hasEvidence: false, matches: [] };
  // Task id as a whole hyphen/slash-delimited token: matches worktree-1416-x,
  // worktree-task-1075-x, task-752-clean, .claude/worktrees/1416-x. The
  // trailing (?:-|$) is what stops id 146 matching "worktree-1146-x".
  const re = new RegExp(`(?:^|[-/])(?:worktree-)?(?:task-)?${id}(?:-|$)`);
  const matches = [];
  for (const b of branches) {
    if (re.test(String(b).replace(/^remotes\/[^/]+\//, ''))) matches.push(String(b));
  }
  for (const p of worktreePaths) {
    const base = String(p).split('/').filter(Boolean).pop() || '';
    if (re.test(base)) matches.push(String(p));
  }
  return { hasEvidence: matches.length > 0, matches };
}

/**
 * Index the live task dir by both notion marker and normalized subject, so a
 * trapped task that already has a live twin can be recognised either way.
 * 14 of the 86 have one: 10 re-created by earlier repair passes or by
 * notion-tasks-sync re-minting a fresh id, 4 from the BSC-Daily family.
 * Reclaiming those produces two live tasks for one Notion card, and since
 * .notion-map points at the twin, only the reclaimed copy is dispatchable —
 * the duplicate silently becomes the dispatch target (plan-review C1).
 */
function indexLiveTasks(liveTasks) {
  const byMarker = new Map();
  const bySubject = new Map();
  for (const t of liveTasks || []) {
    if (!t) continue;
    const m = notionMarkerOf(t);
    if (m && !byMarker.has(m)) byMarker.set(m, String(t.id));
    const s = normalizeSubject(t.subject);
    if (s && !bySubject.has(s)) bySubject.set(s, String(t.id));
  }
  return { byMarker, bySubject };
}

/**
 * Decide what to do with each archive-trapped task.
 *
 * Guard order is safety-first and cheap-first: anything that proves the task is
 * live or already represented is settled before a Notion fetch is considered.
 * Every guard except `duplicate-live` and `superseded` is borrowed wholesale
 * from sweepUntrackedInProgress rather than reinvented — that function already
 * survived the review rounds that produced them.
 *
 * @param {Array<object>} trapped     archived tasks whose status is still in_progress
 * @param {object} ctx
 * @param {Array<object>} ctx.liveTasks
 * @param {Set<string>} ctx.startedIds        ids with a dispatch-ledger START_EVENT
 * @param {(id:string)=>{hasEvidence:boolean,matches:string[]}} [ctx.branchEvidenceOf]
 * @param {(id:string)=>boolean} [ctx.leaseAliveOf]
 * @param {(task:object)=>(string|null)} [ctx.liveTabOf]
 * @param {(markerId:string)=>(object|null)} [ctx.cardOf]  null = fetch failed
 * @param {number} ctx.now
 * @param {number} [ctx.idleMs]
 * @returns {Array<{id, subject, action, reason, detail}>}
 */
function classifyReclaimable(trapped, ctx = {}) {
  const {
    liveTasks = [],
    startedIds = new Set(),
    branchEvidenceOf = () => ({ hasEvidence: false, matches: [] }),
    leaseAliveOf = () => false,
    liveTabOf = () => null,
    cardOf = () => null,
    now = 0,
    idleMs = DEFAULT_IDLE_MS,
  } = ctx;

  const live = indexLiveTasks(liveTasks);
  const out = [];

  for (const task of trapped || []) {
    if (!task) continue;
    const id = String(task.id);
    // cardStatus rides along so the executor can gate its Notion write on what
    // the card ACTUALLY reads right now. Without it, parking a card that
    // already reads Done would downgrade it to Paused — inventing a decision
    // the owner never asked for. Same shape as sweepUntrackedInProgress's
    // `if (card.status === 'In progress')` guard on its own correction.
    let cardStatus = null;
    const push = (action, reason, detail = null) => out.push({ id, subject: task.subject || '', action, reason, detail, cardStatus });

    if (leaseAliveOf(id)) { push('skip-live', 'a live claude process still holds this task\'s lease'); continue; }
    const tab = liveTabOf(task);
    if (tab) { push('skip-live', `a live cmux tab (${tab}) is titled like this task`, tab); continue; }

    const marker = notionMarkerOf(task);
    const twin = (marker && live.byMarker.get(marker)) || live.bySubject.get(normalizeSubject(task.subject));

    // SELF-TWIN (ship-check B1). The reclaim writes the live copy, verifies it,
    // then unlinks the archive copy. That ordering deliberately tolerates a
    // crash in between — the task ends up in BOTH directories, which every
    // union loader already handles. But on the NEXT run the live copy looks
    // like a "twin" of the archive copy, and parking it would stamp
    // archive/<id>.json to `completed`. loadTasksUnioned
    // (audit-dispatch-outcomes.js:53) lets a `completed` ARCHIVE record win over
    // a live one, so the just-reclaimed pending task would read completed to
    // the watchdog, drop out of p01Queue forever, and never be flagged again —
    // it is no longer in_progress, so no audit sees it. That buries precisely
    // the task this whole module exists to rescue. A twin that IS this task is
    // not a duplicate; it is an interrupted reclaim, and the fix is to finish
    // it (drop the archive copy), never to park it.
    if (twin && String(twin) === id) { push('resume-interrupted-reclaim', 'a previous reclaim wrote the live copy but did not remove the archive copy — finishing it'); continue; }
    if (twin) { push('skip-duplicate-live', `live task #${twin} already represents this card`, twin); continue; }

    if (isBscDaily(task)) { push('close-superseded', 'BSC Daily alert card — the digest re-mints these daily and files to Linear, so this copy is superseded'); continue; }

    // STARTED WORK ALWAYS PARKS (ship-check B3). The original rule was "park
    // only if a branch survives", but branch detection is measurably
    // unreliable: 653 of this repo's worktree-prefixed branches carry no task
    // id at all (worktree-add-missing-fix-tests, worktree-agent-a239c96ad3...),
    // and the dispatch ledger records no branch/worktree field to fall back on
    // (checked: launch rows carry workspaceRef, never a ref name). So "no
    // branch found" means "this detector cannot answer", not "no work exists" —
    // the same distinction dispatchedTaskIds already makes about a missing
    // ledger in audit-archived-in-progress.js. Reclaiming on an unanswerable
    // check is the data-loss direction the card explicitly forbids, so a task
    // with ANY dispatch start event parks. Branch evidence now only enriches
    // the reason so a human can triage fastest-first.
    if (startedIds.has(id)) {
      const ev = branchEvidenceOf(id);
      push('park-started', ev.hasEvidence
        ? `dispatched before and a branch/worktree still exists — may hold real commits (${ev.matches.join(', ')})`
        : 'dispatched before; no branch matched, but branch detection cannot prove absence — needs a human look before any re-run',
      ev.matches);
      continue;
    }

    if (!marker) { push('reclaim', 'no Notion card to consult; local record is unambiguously stale'); continue; }

    const card = cardOf(marker);
    if (!card) { push('skip-card-unavailable', 'Notion card could not be fetched — refusing to act blind'); continue; }
    cardStatus = card.status || null;
    // A card with no usable lastEditedAt is unanswerable, so skip — matching
    // sweepUntrackedInProgress (bsc-reconcile.js:553), which treats a missing
    // timestamp as a skip rather than falling through to the flip. The earlier
    // shape only gated INSIDE the if, so a card lacking the field sailed past
    // the idle guard entirely (ship-check warning).
    const idle = card.lastEditedAt ? now - Date.parse(card.lastEditedAt) : NaN;
    if (!Number.isFinite(idle)) { push('skip-card-unavailable', 'card has no usable lastEditedAt — cannot tell whether anyone is on it'); continue; }
    if (idle < idleMs) { push('skip-fresh', `card was edited ${(idle / 3600e3).toFixed(1)}h ago — someone may be on it`); continue; }
    if (String(card.outcome || '').trim()) { push('park-outcome', 'card already records a completed Outcome — needs a human yes/no, not an automatic reopen'); continue; }
    if (TERMINAL_CARD_STATUSES.has(card.status)) { push('park-outcome', `card status is ${card.status} — finished work, never reclaim`); continue; }

    push('reclaim', 'no live session, no live tab, no duplicate, no branch, card idle and unfinished');
  }
  return out;
}

/**
 * The live-dir record to write when reclaiming.
 *
 * Never prepends to `description` — see this module's header. The only text
 * touched is the status segment INSIDE line 1 ("… P1 Next · In progress · X"),
 * which the health digest and card-drift readers parse and which would
 * otherwise keep claiming work is underway. The priority token that
 * taskPriority() reads is left exactly where it was.
 */
function reclaimedTaskShape(task, { now, reason = null } = {}) {
  const lines = String(task.description || '').split('\n');
  if (lines.length) {
    lines[0] = lines[0].replace(/(\]\s*P\d[^·]*·\s*)In progress(\s*·)/, '$1Not started$2');
  }
  return {
    ...task,
    status: 'pending',
    owner: null,
    description: lines.join('\n'),
    reclaimedFromArchiveAt: new Date(now).toISOString(),
    reclaimedFromArchiveReason: reason
      || 'archived while status still said in_progress, so no sweep could ever reach it (card #1402); returned to the live pool as pending',
  };
}

/**
 * The archive-copy record to write for a task that is NOT returning to the pool
 * but whose archived record is nonetheless lying.
 *
 * Measured on the real backlog: of 86 trapped tasks only 7 are genuinely
 * un-started. 52 have a Notion card that already records a completed Outcome
 * (or reads Done), and 14 are shadows of a task that is already live. Those 66
 * are not stranded work — they are FINISHED or SUPERSEDED work still wearing an
 * `in_progress` label, and archive/ is documented as the terminal record. So
 * the honest terminal status is 'completed', which has the useful property of
 * being invisible to every dispatcher (only `pending` reaches p01Queue /
 * zombie-tab-sweep's revive path).
 *
 * Deliberately NOT applied to the branch-evidence population: "a human must
 * look at this branch" is not a terminal state, and writing one would erase the
 * only signal that says so. Those stay in_progress and keep being counted.
 */
function parkedTaskShape(task, { now, reason } = {}) {
  return {
    ...task,
    status: 'completed',
    owner: null,
    reclaimParkedAt: new Date(now).toISOString(),
    reclaimParkedReason: reason,
  };
}

/** The archive-copy record to write when closing a superseded BSC-Daily card. */
function supersededTaskShape(task, { now } = {}) {
  return {
    ...task,
    status: 'completed',
    owner: null,
    reclaimClosedAt: new Date(now).toISOString(),
    reclaimClosedReason: 'BSC Daily alert card archived while still in_progress; the morning digest re-mints this family daily and now files to Linear, so this copy is superseded rather than outstanding (card #1402)',
  };
}

module.exports = {
  classifyReclaimable,
  reclaimedTaskShape,
  supersededTaskShape,
  parkedTaskShape,
  taskBranchEvidence,
  notionMarkerOf,
  normalizeSubject,
  indexLiveTasks,
  isBscDaily,
  NOTION_MARKER_RE,
  BSC_DAILY_RE,
  TERMINAL_CARD_STATUSES,
  DEFAULT_IDLE_MS,
};
