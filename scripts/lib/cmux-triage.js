#!/usr/bin/env node
/**
 * cmux-triage — triage EVERY dead cmux workspace, including the ones every
 * existing sweep is forbidden to touch (BRO-2623).
 *
 * THE GAP THIS FILLS. Three modules already classify dead tabs, and all three
 * stop at the same boundary:
 *
 *   prune-closeable.js       isCloseable() returns false for any tab without
 *                            the 🤖 auto-dispatch marker, and false for any
 *                            crown (👑) tab whatever the other signals say.
 *   prune-dead-autodispatch  isReclaimable() — same two vetoes.
 *   zombie-tab-sweep.js      classifyZombieTabs() skips non-🤖 tabs outright
 *                            (`continue`), and reports crown tabs without a
 *                            verdict on the underlying work.
 *
 * Those vetoes are correct and stay (owner rule 2026-08-02: auto-close is
 * limited to tabs another session spun up, never one the owner opened; task
 * #1751 for the crown carve-out). But the consequence is that a dead
 * owner-opened or crown tab gets exactly one line of attention — bsc-prune's
 * "Dead but un-marked (... NOT closed, review yourself)" listing — with no
 * cross-reference to whether the work it was doing is finished. The owner is
 * left to open each husk and read it. That is how ~30 tabs accumulated after
 * the 2026-08-19 cmux crashes, and why the first dispatch at this (task #1184
 * S2) died without finishing: there was no tool, only manual inspection.
 *
 * So this module answers, for every dead tab regardless of provenance, the
 * question the existing sweeps deliberately decline to ask: IS THE WORK DONE?
 * It never closes anything itself — `autoActionAllowed` is computed by
 * delegating to isReclaimable(), so the ownership vetoes above still decide
 * what may be touched automatically. What is new here is the verdict.
 *
 * BUCKETS (the card's three, verbatim):
 *   safeToClose    the work is finished or is running somewhere else. Close
 *                  the husk; nothing is lost.
 *   needsResuming  the work is still open and its terminal died. Re-dispatch.
 *   needsOwnerCall not enough evidence, or a decision only the owner makes:
 *                  duplicate crown-loop instances, and any tab whose status
 *                  lookup FAILED (a Linear/GitHub API outage, the case the
 *                  card names). An outage must never read as "no open work".
 *
 * EVIDENCE PRECEDENCE (see triageDeadTabs for the ordered implementation):
 *   0. the fleet-watchdog dashboard (looks dead by design) → needsOwnerCall
 *   1. a LIVE tab is already doing this work        → safeToClose
 *   2. Linear says terminal, or the task store says completed → safeToClose
 *   3. duplicate crown-loop family                  → needsOwnerCall
 *   4. the status lookup errored                    → needsOwnerCall
 *   5. Linear/task store says still open            → needsResuming
 *   6. nothing maps this tab to any work            → needsOwnerCall
 *
 * (1) MUST precede (5): a dead tab for an issue that is legitimately still
 * "In Progress" *because a live tab is working it right now* would otherwise
 * be re-dispatched on top of the live session — the duplicate-dispatch bug
 * zombie-tab-sweep.js's header already documents having been caught once.
 *
 * Pure decision half + I/O half in ONE file, unlike this repo's usual
 * lib/script split, for a specific reason: `scripts/lib/**` is a test.yml push
 * path (test.yml:22), while a top-level `scripts/*.js` runner would need its
 * own hand-listed entry — and test.yml is `ci-gate` tier under CLAUDE.md rule
 * 18, so adding that entry means a blocking pre-implementation review for a
 * file that is otherwise only `shared-lib` (warn) tier. Keeping the CLI in
 * this file leaves the whole change inside the warn tier and inside CI's
 * existing trigger + `scripts/lib/*.test.mjs` glob. Everything above the
 * `── I/O half ──` divider is pure and is what the test exercises.
 *
 * STRICTLY REPORT-ONLY — it closes nothing, and an --apply flag was
 * deliberately removed before shipping after an adversarial review (Codex,
 * 2026-09-07) found two P0s in it that are not worth solving twice:
 *
 *   TOCTOU. `autoActionAllowed` is computed from one snapshot, and several
 *   Linear round trips happen before any close would fire. In that window a
 *   ref can become selected, restart, or be recycled onto unrelated work.
 *   bsc-prune closes safely only because it re-lists, re-verifies workspace
 *   identity (cmux-workspaces.js) and re-probes two-signal liveness
 *   IMMEDIATELY before each close.
 *
 *   No single-writer lock. bsc-prune's real sweeps take one (acquireRunLock)
 *   precisely so two concurrent read-decide-act passes cannot act on each
 *   other's stale snapshot. It runs on a 5-minute launchd tick AND on every
 *   session Stop hook, so a collision is routine, not theoretical.
 *
 * Reimplementing that machinery here would mean a SECOND destructive close
 * path over the same cmux socket and the same ledger — more surface, no more
 * capability. bsc-prune already closes every tab that may be closed
 * automatically; what was missing was the VERDICT, and a verdict is what this
 * produces. Owner-only tabs were never auto-closable anyway, which is the
 * whole reason this module exists.
 *
 * Usage:
 *   node scripts/lib/cmux-triage.js              report (touches nothing)
 *   node scripts/lib/cmux-triage.js --json       machine-readable report
 *   node scripts/lib/cmux-triage.js --no-linear  skip the Linear round trips
 */

'use strict';

// Canonical predicates, imported rather than restated (CLAUDE.md: a predicate
// that must agree with another module's is required from it, never copied).
const { isCrownTab, hasAutoDispatchMarker } = require('./prune-closeable.js');
const { isReclaimable } = require('./prune-dead-autodispatch-tabs.js');
const { normalizeTitle } = require('./zombie-tab-sweep.js');
const { titleFamilyKey } = require('./crown-duplicate-detector.js');
const { TERMINAL_STATE_TYPES, isTerminalStateType } = require('./linear-state-types.js');
// The team key is imported, never spelled here: three modules already hold a
// private copy of the literal 'BRO' and a fourth is how they drift apart.
const { TEAM_KEY } = require('./linear-client.js');
const { WATCHDOG_TAB_PREFIX, WATCHDOG_TAB_MARKER } = require('./dispatch-watchdog-core.js');

// Task-store statuses that mean the work is finished / still outstanding.
// `completed` mirrors zombie-tab-sweep.js's corpse test; the open set mirrors
// its revive + reconciler-territory split, collapsed here because this module
// reports rather than auto-redispatches (see the header: it never acts).
const OPEN_TASK_STATUSES = new Set(['pending', 'in_progress']);

// Linear issue identifiers as they appear in a dispatched tab title
// (bsc-next/linear-next buildAutoTitle stamps "Data·BRO-2623 <title>").
//
// Anchored to THIS team's key, not a generic /[A-Z]{2,5}-\d+/ shape. The
// generic form matches plenty of things that are not Linear issues and that
// really do appear in tab titles and dispatch subjects — "UTF-8", "CVE-2024",
// "GPT-5", a release tag — and every one of them would then be looked up,
// come back as no-such-issue or (worse) as a real issue on another team, and
// contribute a status verdict about work the tab has nothing to do with
// (Codex ship-check finding, 2026-09-07).
const LINEAR_KEY_RE = new RegExp(String.raw`\b(${TEAM_KEY}-\d+)\b`);

/**
 * Pull the Linear issue key out of a workspace title, if it carries one.
 * @param {string} title
 * @returns {string|null}
 */
function extractLinearKey(title) {
  const m = LINEAR_KEY_RE.exec(String(title || ''));
  return m ? m[1] : null;
}

/**
 * The issue key for a tab, looked for in the three places it actually turns
 * up. The title alone is NOT enough, and assuming it was would have made this
 * tool useless on the very tabs it was written for: on 2026-09-07 the two dead
 * tabs on this machine were titled "🧭 👑 OWNER — land card #1889 Express retry
 * merge" and "👑 OWNER watchdog — 5 in flight · …" — no key in either — while
 * the dispatch ledger held `taskId: "linear:BRO-2620"` and a subject beginning
 * "BRO-2620 P2: …" for the first. Owner-renamed and crown tabs are exactly the
 * class whose titles drift away from the work they are doing, and they are
 * this module's whole remit.
 * @param {string} title
 * @param {string|null} taskId ledger taskId, often "linear:BRO-N"
 * @param {string|null} subject ledger subject (the card title at dispatch)
 * @returns {string|null}
 */
function linearKeyFor(title, taskId, subject) {
  return ledgerLinearKey(taskId, subject) || extractLinearKey(title);
}

/**
 * The issue key with LEDGER provenance only — from the dispatch record, never
 * from the tab's free-form title. This is the only key allowed to prove two
 * tabs are doing the same work.
 *
 * A title is free text an owner may rename at will and may mention several
 * issues: "fix BRO-123 link in BRO-456 report" yields whichever appears first,
 * so two unrelated tabs can collide on a key neither of them is actually
 * working (Codex ship-check finding, 2026-09-07). zombie-tab-sweep.js:88
 * already sets this rule for its own duplicate test — the task id is the sole
 * authority whenever the ledger has one — after shipping the inverse bug: a
 * title-prefix match that closed a live sibling task as a false "duplicate".
 *
 * Title-derived keys stay perfectly good for the OTHER use, looking up a
 * status to report; being wrong there costs one misleading line in a report a
 * human reads, not a verdict about a second tab.
 * @param {string|null} taskId
 * @param {string|null} subject
 * @returns {string|null}
 */
function ledgerLinearKey(taskId, subject) {
  return extractLinearKey(taskId) || extractLinearKey(subject);
}

/**
 * The ONLY key allowed to prove two tabs are the same work: the one the
 * dispatcher itself wrote into the ledger's taskId ("linear:BRO-2623").
 *
 * ledgerLinearKey above also falls back to the ledger `subject`, and that is
 * one step too loose for this purpose: the subject is the CARD TITLE, free
 * text with exactly the multi-key hazard titles have. Two tabs on genuinely
 * different tasks with subjects "Follow-up to BRO-100: …" and "Revert BRO-100
 * and …" both yield BRO-100, and the dead one is then declared a duplicate of
 * live work it has nothing to do with (ship-check finding, 2026-09-07). The
 * taskId branch already covers every real duplicate, so the subject branch
 * added risk and no reach. Subject-derived keys keep feeding status lookup,
 * where the cost of being wrong is one misleading report line.
 * @param {string|null} taskId
 * @returns {string|null}
 */
function dispatchLinearKey(taskId) {
  return extractLinearKey(taskId);
}

/**
 * Is this the fleet-watchdog DASHBOARD tab?
 *
 * It is permanently indistinguishable from a corpse to every liveness check in
 * this codebase, BY DESIGN: dispatch-watchdog.js runs it as `--dashboard`, a
 * plain node process, so cmux's tag registry holds no claude_code row
 * (claudeAliveIn false) and the screen never draws Claude's "ctx NN%" status
 * bar (terminalSurfaceAliveIn false). A launchd job renames it from OUTSIDE
 * the tab, which is why its title carries a ticking "upd HH:MM" while nothing
 * is running inside it. Verified live 2026-09-07: bsc-prune has been listing
 * it under "Dead but un-marked" indefinitely, and this module would have
 * inherited the same false positive forever.
 *
 * It is also the one tab that must never be closed on this verdict:
 * dispatch-watchdog.js owns its lifecycle (it closes and recreates the tab
 * itself on a stale heartbeat), and the owner reads their whole fleet state
 * off its title.
 *
 * Exact-prefix, matching dispatch-watchdog.js's own isWatchdogTitle and built
 * from dispatch-watchdog-core's exported constants rather than copied string
 * literals. A substring test is a shipped-and-caught P0 there: "👑 OWNER —
 * repair dispatch-watchdog alerts" is a live owner SESSION, not the dashboard.
 * @param {string} title
 * @returns {boolean}
 */
function isWatchdogDashboardTitle(title) {
  return String(title || '')
    .replace(/^[^\p{L}\p{N}👑]*/u, '')
    .startsWith(`${WATCHDOG_TAB_PREFIX} ${WATCHDOG_TAB_MARKER}`);
}

// A `process` row parented to ANY agent tag, not just claude_code. The tag id
// carries the agent name and an optional session uuid:
//   workspace:<uuid>:tag:claude_code
//   workspace:<uuid>:tag:codex.01a055e0-8ac3-7c33-b4fa-6c12c2cf89ce
const AGENT_TAG_RE = /:tag:([A-Za-z][A-Za-z0-9_-]*)(?:\.[0-9a-fA-F-]+)?$/;

/**
 * Which agent CLI, if any, is ALIVE in this workspace — read from cmux's
 * process table (`cmux top --processes --format tsv`).
 *
 * WHY THIS EXISTS (verified live 2026-09-07, the sharpest finding of BRO-2623).
 * Every liveness check in this repo is hard-coded to Claude:
 *   cmux-workspaces.hasLiveClaude       matches only /:tag:claude_code$/
 *   cmux-workspaces.hasClaudeChrome     matches only Claude's "│ ctx NN%" bar
 * A live Codex session satisfies NEITHER, so checkLiveness reports it dead.
 * workspace:100 on this machine was a Codex session sitting idle at its prompt
 * with live `codex` (pid 87249) and `codex-code-mode` processes and an
 * `Idle`-status `:tag:codex` row — holding an UNMERGED commit (547cf4c1192,
 * branch fix-compareshow-tests) — and bsc-prune had been listing it under
 * "Dead but un-marked" indefinitely. It survived only because it is a 👑 tab
 * and crown tabs are exempt from auto-close: had it carried the 🤖 marker,
 * zombie-tab-sweep/isReclaimable would have closed a live session mid-turn.
 * A triage tool that inherited that blind spot would recommend exactly that.
 *
 * Matching on the tag NAME (any agent) rather than adding "codex" to a
 * hard-coded list deliberately: the next CLI cmux tags is unknown, and the
 * failure this guards is "we did not know about that one".
 *
 * Uses the same column layout as cmux-workspaces.hasLiveClaude — a process
 * row is col[3]==='process' with its parent tag in col[5] — and returns the
 * agent name so the report can say WHICH one is alive, not just that
 * something is. Sharing that layout with hasLiveClaude is deliberate: if cmux
 * changes its TSV schema, both break together and the existing sweep's tests
 * catch it, which is strictly better than this module quietly disagreeing
 * with the predicate it is extending.
 *
 * ACCEPTED LIMITATIONS, both erring toward "alive", which is the safe
 * direction for a tool whose output is a recommendation to a human:
 *   - a lingering child process under a matching tag reads as a live agent,
 *     so a genuine corpse can be withheld from triage. The cost is one tab
 *     the owner has to close by hand; the inverse — reporting a live session
 *     as safe to close — is what this whole module exists to prevent.
 *   - it requires a PROCESS row, not just a tag row, so a crashed agent that
 *     left a stale tag behind stays prunable (the same rule
 *     cmux-workspaces.hasLiveClaude states for itself).
 * @param {string} tsvText
 * @returns {string|null} agent tag name, or null when no agent process is live
 */
function liveAgentIn(tsvText) {
  for (const line of String(tsvText || '').split('\n')) {
    const c = line.split('\t');
    if (c[3] !== 'process') continue;
    const m = AGENT_TAG_RE.exec(c[5] || '');
    if (m) return m[1];
  }
  return null;
}

/**
 * Grouping key for "is another tab doing this same work". Crown tabs use the
 * version-stripping family key (Crown v20 and Crown v46 are the SAME loop —
 * crown-duplicate-detector.js's whole subject); everything else uses plain
 * normalized-title equality, which is the fallback bar zombie-tab-sweep.js
 * already sets for unmapped tabs. Deliberately NOT a prefix match: two
 * different tasks can share a title prefix, and closing a pending sibling as
 * a false "duplicate" is a bug this codebase has already shipped once
 * (zombie-tab-sweep.js header).
 * @param {string} title
 * @returns {string}
 */
/**
 * May this tab's TITLE alone be used to claim it duplicates another tab?
 *
 * Two fences, both from a ship-check finding (2026-09-07):
 *  - a non-empty title. cmux-workspaces.parseWorkspacesJson defaults `title`
 *    to '' when a workspace has neither a custom nor a derived title, so two
 *    untitled tabs matched each other and the dead one was declared safe to
 *    close.
 *  - the 🤖 auto-dispatch marker. zombie-tab-sweep.js uses full normalized
 *    title equality for its unmapped tabs and is safe doing so ONLY because
 *    it pre-filters to 🤖 tabs, whose titles buildAutoTitle generates from a
 *    unique card. This module deliberately dropped that pre-filter — that is
 *    its whole point — so it has to re-add the precondition here instead of
 *    inheriting the conclusion without it. Owner-renamed tabs routinely share
 *    a generic cwd-derived title ("Broadwayscore") that proves nothing.
 * A tab failing either fence just falls through to 'unmapped': "open it and
 * look", which is the honest answer when the only evidence is a shared name.
 * @param {{title?:string}} w
 * @returns {boolean}
 */
function titleDupEligible(w) {
  const title = String((w && w.title) || '');
  if (normalizeTitle(title).length === 0) return false;
  // Crown tabs qualify on a DIFFERENT basis than the 🤖 marker: workKeyForTitle
  // gives them the version-stripping family key (Crown v20 ≡ Crown v46), a
  // purpose-built succession key that crown-duplicate-detector.js already
  // treats as sufficient. Requiring 🤖 of them too would have silently dropped
  // the one duplicate class this module is most often asked about — caught by
  // the existing "dead crown whose loop has a LIVE successor" test.
  return hasAutoDispatchMarker(title) || isCrownTab(title);
}

function workKeyForTitle(title) {
  return isCrownTab(title) ? `crown:${titleFamilyKey(title)}` : `title:${normalizeTitle(title)}`;
}

/**
 * @param {object} args
 * @param {Array<{ref:string,title:string,selected?:boolean}>} args.deadTabs
 *        workspaces confirmed dead by BOTH liveness signals (cmux-workspaces
 *        checkLiveness). Provenance is NOT pre-filtered — that is the point.
 * @param {Array<{ref:string,title:string}>} args.liveWorkspaces every other
 *        currently-listed workspace, for the "already running elsewhere" test.
 * @param {(ref:string)=>({taskId?:string|number,subject?:string}|null)} args.launchByRef
 *        the latest UNRECONCILED dispatch-ledger launch for the ref — one with
 *        no terminal event (prune-closed / vanished / dead / remapped)
 *        recorded after it. It MUST NOT be a bare launchByRef: cmux recycles
 *        workspace refs, so the last launch row for a ref routinely belongs to
 *        a long-gone occupant. Caught live on 2026-09-07 before this shipped —
 *        workspace:140 was a fleet-watchdog dashboard created 01:59 that
 *        morning, and a bare lookup attributed it to task 989, whose tab had
 *        been prune-closed on 2026-08-04, whose status is "completed", which
 *        classified the owner's live dashboard as SAFE TO CLOSE. Same for
 *        workspace:100 and BRO-2620. dispatch-ledger.unreconciledLaunchForRef
 *        is the canonical primitive; the I/O half below passes it.
 * @param {(taskId:string)=>(string|null)} args.taskStatusById task-store status.
 * @param {(key:string)=>({type?:string,name?:string,error?:string}|null)} args.linearStateByKey
 *        resolved Linear state for an issue key: `{type,name}` on success,
 *        `{error}` when the lookup FAILED (never null — null means "no such
 *        issue", which is a different, non-blocking answer), null when the
 *        title carries no key or Linear was not consulted.
 * @returns {{safeToClose:Array,needsResuming:Array,needsOwnerCall:Array}}
 */
function triageDeadTabs({ deadTabs, liveWorkspaces, launchByRef, taskStatusById, linearStateByKey }) {
  const safeToClose = [];
  const needsResuming = [];
  const needsOwnerCall = [];

  const live = liveWorkspaces || [];
  // Only tabs eligible for the TITLE-fallback duplicate test (see the
  // `liveDup` computation) contribute keys to it.
  const liveWorkKeys = new Set(live.filter(titleDupEligible).map(w => workKeyForTitle(w.title)));
  const liveTaskIds = new Set();
  const liveLinearKeys = new Set();
  for (const w of live) {
    const launch = value(safeCall(() => launchByRef(w.ref)));
    const taskId = launch && launch.taskId != null ? String(launch.taskId) : null;
    if (taskId) liveTaskIds.add(taskId);
    // Dispatch provenance ONLY for duplicate matching — see dispatchLinearKey.
    const key = dispatchLinearKey(taskId);
    if (key) liveLinearKeys.add(key);
  }

  // Crown-loop families with more than one DEAD instance are the "duplicate
  // crown-loop instances" the card routes to the owner: re-dispatching any of
  // them re-crowns a loop, which is an owner decision (task #1751), and
  // closing them is likewise owner-only. Counted across dead tabs only —
  // a dead crown whose family has a LIVE member is already answered by the
  // stronger live-duplicate test below (the live one IS the successor).
  // Keyed by taskId when the ledger has one, title family otherwise — the
  // same two-tier rule crown-duplicate-detector.js:104 uses, so a renamed
  // succession sibling is still grouped with its family.
  const crownFamilyKey = (w) => {
    const launch = value(safeCall(() => launchByRef(w.ref)));
    const taskId = launch && launch.taskId != null ? String(launch.taskId) : null;
    return taskId ? `task:${taskId}` : workKeyForTitle(w.title);
  };
  const deadCrownFamilyCounts = new Map();
  const deadCrownKeys = new Map();
  for (const w of deadTabs || []) {
    if (!isCrownTab(w.title)) continue;
    const key = crownFamilyKey(w);
    deadCrownKeys.set(w.ref, key);
    deadCrownFamilyCounts.set(key, (deadCrownFamilyCounts.get(key) || 0) + 1);
  }

  for (const w of deadTabs || []) {
    const launchRaw = safeCall(() => launchByRef(w.ref));
    const launch = value(launchRaw);
    const taskId = launch && launch.taskId != null ? String(launch.taskId) : null;
    const taskStatusRaw = taskId ? safeCall(() => taskStatusById(taskId)) : null;
    const taskStatus = value(taskStatusRaw);
    const dupKey = dispatchLinearKey(taskId);
    const linearKey = ledgerLinearKey(taskId, launch && launch.subject) || extractLinearKey(w.title);
    const linearRaw = linearKey ? safeCall(() => linearStateByKey(linearKey)) : null;
    const linear = value(linearRaw);
    // Failure is tracked PER SOURCE, not as one flag. A collaborator that
    // THREW and one that answered `{error}` are the same fact — this source
    // could not be reached — but WHICH source failed changes the verdict, and
    // collapsing them let a P0 through (ship-check, 2026-09-07): see the
    // task-store branch below. A malformed Linear answer (a state with a name
    // but no type) counts as a failure too; it is not a usable verdict.
    const linearFailed = failed(linearRaw)
      || Boolean(linear && linear.error)
      || Boolean(linear && !linear.type);
    const ledgerFailed = failed(launchRaw);
    const taskFailed = failed(taskStatusRaw);
    const lookupFailure = linearFailed || ledgerFailed || taskFailed;
    const isAutoDispatched = hasAutoDispatchMarker(w.title);

    const entry = {
      ref: w.ref,
      title: w.title,
      selected: !!w.selected,
      taskId,
      subject: (launch && launch.subject) || null,
      taskStatus: taskStatus || null,
      linearKey,
      linearState: linear && linear.name ? linear.name : null,
      linearStateType: linear && linear.type ? linear.type : null,
      crown: isCrownTab(w.title),
      autoDispatched: isAutoDispatched,
      // Delegated, never re-derived: the ownership vetoes (owner-opened tab,
      // crown tab, the selected tab, a tab with a live claude) stay owned by
      // prune-dead-autodispatch-tabs.js. hasLiveClaude is false by
      // construction — every tab here is dead by both signals.
      autoActionAllowed: isReclaimable({
        title: w.title, selected: !!w.selected, hasLiveClaude: false, isAutoDispatched,
      }),
      reason: null,
    };

    // 0. The fleet-watchdog dashboard is not a corpse — it only looks like
    //    one. Checked before everything else: it has no task, so every later
    //    branch would fall through to 'unmapped' and tell the owner to go
    //    open and inspect the tab they read their fleet state off.
    if (isWatchdogDashboardTitle(w.title)) { push(needsOwnerCall, entry, 'watchdog-dashboard'); continue; }

    // 1. The work is already running in another tab. Highest precedence: this
    //    must beat "Linear says open", because Linear saying In Progress is
    //    exactly what a live sibling session looks like.
    // `ledgerKey`, not `linearKey`: only a key the DISPATCH RECORD vouches for
    // may prove two tabs share work (see ledgerLinearKey). A title-derived key
    // still feeds the status lookup above, it just never closes a tab here.
    // Title equality is the LAST resort and the weakest evidence, so it is
    // fenced twice: only for a tab the ledger cannot identify at all, and only
    // when both tabs are titleDupEligible (see that predicate for why an
    // untitled or owner-renamed tab must never match another on title alone).
    const liveDup = (taskId && liveTaskIds.has(taskId))
      || (dupKey && liveLinearKeys.has(dupKey))
      || (!taskId && !dupKey && titleDupEligible(w) && liveWorkKeys.has(workKeyForTitle(w.title)));
    if (liveDup) { push(safeToClose, entry, 'live-duplicate'); continue; }

    // 2. Confirmed finished. Linear is the board of record (CLAUDE.md §6), so
    //    it outranks the task-store mirror, which froze for Notion-sourced
    //    cards on 2026-08-20 and can report a stale status.
    if (linear && isTerminalStateType(linear.type)) { push(safeToClose, entry, `linear-${linear.type}`); continue; }
    // ...but ONLY when Linear actually answered. This module's own header
    // calls the task store a mirror that froze for Notion-sourced cards on
    // 2026-08-20 and says Linear outranks it — and then, before this guard, it
    // fell back to that stale mirror as SOLE evidence in precisely the moment
    // Linear was unreachable, which is when the mirror is least trustworthy
    // and the verdict is most destructive. A P0 found by ship-check on
    // 2026-09-07: Linear 503 + a month-old "completed" task row read as
    // "safe to close". `ledgerFailed` is in the guard for the same reason —
    // an unreadable ledger means this taskId may not even be this tab's.
    if (taskStatus === 'completed' && !linearFailed && !ledgerFailed) {
      push(safeToClose, entry, 'task-completed'); continue;
    }

    // 3. Duplicate crown loops — owner's call, both to close and to re-crown.
    if (entry.crown && (deadCrownFamilyCounts.get(deadCrownKeys.get(w.ref)) || 0) > 1) {
      push(needsOwnerCall, entry, 'duplicate-crown-loop'); continue;
    }

    // 4. The lookup FAILED. An outage is not evidence of anything — least of
    //    all that the work is done. Never falls through to "unmapped", which
    //    would understate it as merely unknown rather than unverified.
    if (lookupFailure) { push(needsOwnerCall, entry, 'unverifiable-lookup'); continue; }

    // 5. Still open, terminal died. This is the re-dispatch bucket.
    if (linear && linear.type && !isTerminalStateType(linear.type)) { push(needsResuming, entry, 'linear-open'); continue; }
    // A task-store `in_progress` row is the #883 reconciler's territory, and
    // zombie-tab-sweep.js:101 deliberately defers to it rather than racing it
    // with a re-dispatch. Same deference here — `pending` (the launch never
    // ran) is the only task-store status this module recommends resuming.
    if (taskStatus === 'in_progress') { push(needsOwnerCall, entry, 'reconciler-territory'); continue; }
    if (OPEN_TASK_STATUSES.has(taskStatus)) { push(needsResuming, entry, `task-${taskStatus}`); continue; }

    // 6. No ledger entry, no task file, no issue key: too little evidence to
    //    say anything. Reported, never acted on.
    push(needsOwnerCall, entry, 'unmapped');
  }

  return { safeToClose, needsResuming, needsOwnerCall };
}

function push(bucket, entry, reason) {
  bucket.push({ ...entry, reason });
}

// Sentinel distinguishing "the lookup threw" from "the lookup answered, and
// the answer was nothing". Collapsing the two was a shipped-and-caught bug
// (Codex ship-check, 2026-09-07): a ledger read or a Linear call that FAILED
// reported the tab as 'unmapped' — merely unknown — which reads as "no work is
// attached to this tab" and understates an outage as an absence. That is the
// same conflation this module's `unverifiable-lookup` bucket exists to stop,
// and it was leaking in through the back door of its own error handling.
const LOOKUP_FAILED = Symbol('lookup-failed');

// Every collaborator is injected and may be a live network/fs call; a thrown
// lookup must degrade that ONE fact, not abort the whole sweep.
function safeCall(fn) {
  try { return fn() || null; } catch { return LOOKUP_FAILED; }
}

function failed(v) { return v === LOOKUP_FAILED; }
function value(v) { return failed(v) ? null : v; }

/**
 * Render the report. Pure (returns lines) so the test can assert on it without
 * capturing stdout.
 * @param {{safeToClose:Array,needsResuming:Array,needsOwnerCall:Array}} buckets
 * @returns {string[]}
 */
function formatTriageReport({ safeToClose, needsResuming, needsOwnerCall }) {
  const lines = [];
  const total = safeToClose.length + needsResuming.length + needsOwnerCall.length;
  lines.push(`[cmux-triage] ${total} dead workspace(s): ${safeToClose.length} safe to close, ${needsResuming.length} need resuming, ${needsOwnerCall.length} need an owner call.`);

  section('SAFE TO CLOSE — work is finished or running elsewhere', safeToClose, e => {
    if (!e.autoActionAllowed) return 'OWNER-ONLY: not 🤖-dispatched or is a crown tab — close it by hand';
    // Not "bsc-prune will close this": classifyZombieTabs has no Linear-key
    // duplicate branch, so a live-duplicate whose task is still pending is
    // REVIVED there, not closed. Only claim what that sweep actually does.
    return e.reason === 'live-duplicate'
      ? 'bsc-prune may instead re-dispatch this (it has no Linear-key duplicate branch) — close it by hand'
      : 'bsc-prune will close this on its next sweep';
  });
  section('NEEDS RESUMING — work is still open, the terminal died', needsResuming, e =>
    e.linearKey ? `re-dispatch: node scripts/linear-next.js --id ${e.linearKey}` : 're-dispatch: no issue key in title, identify the work first');
  section('NEEDS AN OWNER CALL — not enough evidence, or your decision', needsOwnerCall, e => ({
    'duplicate-crown-loop': 'duplicate crown loop: pick which instance survives, close the rest',
    'unverifiable-lookup': 'status lookup FAILED (API outage) — re-run before deciding',
    'watchdog-dashboard': 'NOT a corpse: dispatch-watchdog.js runs this as a plain node dashboard and owns its lifecycle — leave it open',
    unmapped: 'no ledger entry, no task file, no issue key — open it and look',
    'reconciler-territory': 'task is in_progress — the #883 reconciler owns this; do not race it with a re-dispatch',
  }[e.reason] || 'review by hand'));

  function section(heading, entries, adviceFor) {
    if (!entries.length) return;
    lines.push('');
    lines.push(`${heading}:`);
    for (const e of entries) {
      const state = e.linearState ? `${e.linearKey} ${e.linearState}` : (e.taskStatus ? `task ${e.taskId} ${e.taskStatus}` : 'no status');
      lines.push(`  ${e.ref}  ${JSON.stringify(e.title)}`);
      lines.push(`      ${e.reason} · ${state} · ${adviceFor(e)}`);
    }
  }

  return lines;
}

// ── I/O half ────────────────────────────────────────────────────────────────
// Everything below touches cmux, the filesystem or the Linear API. Nothing
// above this line does; the test exercises only the pure half.

const TERMINAL_TYPES_FOR_HELP = TERMINAL_STATE_TYPES.join('/');

/**
 * Task-store status lookup: live dir first, archive fallback (completed tasks
 * get archived — without the fallback an archived-completed corpse reads as
 * "unmapped" forever). This is the same read bsc-prune.js:560 performs, and it
 * is deliberately re-implemented rather than imported: bsc-prune.js runs
 * `main()` at require time (`if (require.main === module) main()` guards only
 * DIRECT execution — but its module body also builds live cmux state), so
 * requiring it from here to reach its export would be a surprising side effect
 * in a reporting tool. Five lines of fs, not a duplicated predicate.
 */
function taskStatusById(taskId) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = path.join(os.homedir(), '.claude', 'tasks', process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore');
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${taskId}.json`), 'utf8')).status || null; }
  catch { /* fall through to archive */ }
  try {
    const { readArchivedTask } = require('./task-store-archive.js');
    const archived = readArchivedTask(dir, taskId);
    return (archived && archived.status) || null;
  } catch { return null; }
}

/**
 * Resolve Linear states for the issue keys found in the dead tabs' titles.
 * One getIssue() per DISTINCT key — a handful of calls, not a full board
 * fetch. A failed lookup resolves to `{ error }`, which routes the tab to
 * needsOwnerCall rather than silently reading as "no open work".
 */
async function resolveLinearStates(keys, client) {
  const out = new Map();
  if (!keys.length) return out;
  const lc = client || require('./linear-client.js');
  for (const key of keys) {
    try {
      const issue = await lc.getIssue(key);
      if (!issue) { out.set(key, null); continue; }
      out.set(key, { type: issue.state && issue.state.type, name: issue.state && issue.state.name });
    } catch (e) {
      out.set(key, { error: e.message || String(e) });
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const cmux = require('./cmux-workspaces.js');
  const dispatchLedger = require('./dispatch-ledger.js');

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'cmux-triage — triage every dead cmux workspace, including owner and crown tabs.',
      '',
      '  node scripts/lib/cmux-triage.js              report (this tool NEVER closes anything)',
      '  node scripts/lib/cmux-triage.js --json       machine-readable report',
      '  node scripts/lib/cmux-triage.js --no-linear  skip Linear lookups (task store only)',
      '',
      'To actually close the tabs it clears: run bsc-prune, which owns the only',
      'safe close path (single-writer lock + revalidation immediately before each',
      'close). Owner-opened and crown tabs are closed by hand, by you, on purpose.',
      '',
      `Linear states treated as finished: ${TERMINAL_TYPES_FOR_HELP}.`,
    ].join('\n'));
    return 0;
  }

  if (!cmux.cmuxAvailable()) {
    console.error('[cmux-triage] cmux CLI not found — is cmux.app installed?');
    return 1;
  }

  const asJson = argv.includes('--json');
  const useLinear = !argv.includes('--no-linear');

  const all = cmux.listWorkspacesWithCwd();
  const dead = [];
  const alive = [];
  const foreignAgentAlive = [];
  const livenessUnverifiable = [];
  for (const w of all) {
    // Same two-signal, fail-safe-to-alive test bsc-prune uses. Uncertainty
    // must never resolve to dead in a tool that can close tabs.
    const { dead: isDead } = cmux.checkLiveness(w.ref, cmux.claudeAliveIn, cmux.terminalSurfaceAliveIn);
    if (!isDead) { alive.push(w); continue; }
    // THIRD signal, and the one both of the above are blind to: a live agent
    // process of ANY kind. See liveAgentIn's header.
    let agent = null;
    let probeError = null;
    try { agent = liveAgentIn(cmux.run(['top', '--workspace', w.ref, '--processes', '--format', 'tsv'])); }
    catch (e) { probeError = e.message || String(e); }

    // A FAILED probe is not a dead tab. Swallowing the error to null resolved
    // a transient socket failure to "dead" — inverting the fail-safe-to-alive
    // rule claudeAliveIn/checkLiveness state for exactly this call
    // (cmux-workspaces.js:270), in the one place this module adds a signal
    // they do not have. Reported as unverifiable instead (ship-check, 2026-09-07).
    if (probeError) { livenessUnverifiable.push({ ...w, probeError }); alive.push(w); continue; }

    // NOT `agent !== 'claude_code'`. AGENT_TAG_RE tolerates a `.uuid` tag
    // suffix while hasLiveClaude anchors on /:tag:claude_code$/, so a suffixed
    // claude_code tag is a live Claude session this module can see and
    // hasLiveClaude cannot — and filtering it out here would have thrown away
    // that evidence for the very agent whose blind spot matters most. Any live
    // agent means not a corpse (ship-check, 2026-09-07).
    if (agent) { foreignAgentAlive.push({ ...w, agent }); alive.push(w); continue; }
    dead.push(w);
  }

  if (foreignAgentAlive.length) {
    console.log(`[cmux-triage] ${foreignAgentAlive.length} tab(s) look DEAD to bsc-prune but have a live agent process — NOT corpses:`);
    for (const w of foreignAgentAlive) console.log(`  ${w.ref}  ${JSON.stringify(w.title)}  — live ${w.agent} session`);
    console.log('');
  }
  if (livenessUnverifiable.length) {
    console.error(`[cmux-triage] WARN ${livenessUnverifiable.length} tab(s) could not be probed for a live agent — treated as ALIVE, not triaged:`);
    for (const w of livenessUnverifiable) console.error(`  ${w.ref}  ${JSON.stringify(w.title)}  — ${w.probeError}`);
    console.error('');
  }
  if (!useLinear) {
    console.error('[cmux-triage] WARN --no-linear: verdicts below rest on the dispatch ledger and the task-store mirror alone. That mirror froze for Notion-sourced cards on 2026-08-20, so a tab may read as unmapped or stale-completed when Linear knows better. Re-run without --no-linear before acting on anything here.');
    console.error('');
  }

  // A ledger read failure is NOT an empty ledger. Falling back to [] silently
  // makes every dead tab look like it was never dispatched — 'unmapped' —
  // which is the exact outage-as-absence conflation LOOKUP_FAILED exists to
  // stop, so it has to be loud here too. The throwing accessor below is what
  // routes affected tabs to 'unverifiable-lookup' rather than 'unmapped'.
  let ledgerError = null;
  let entries = [];
  try { entries = dispatchLedger.readEntries(); }
  catch (e) { ledgerError = e.message || String(e); }
  if (ledgerError) console.error(`[cmux-triage] WARN dispatch ledger unreadable (${ledgerError}) — tab provenance cannot be established; every tab will report as unverifiable.`);
  // unreconciledLaunchForRef, NOT launchByRef — see triageDeadTabs's
  // @param note for the live misclassification a bare lookup produced.
  const launchByRef = (ref) => {
    if (ledgerError) throw new Error(`dispatch ledger unreadable: ${ledgerError}`);
    return dispatchLedger.unreconciledLaunchForRef(ref, entries);
  };

  let linearStates = new Map();
  if (useLinear) {
    // Same three-source lookup the classifier uses — resolving keys from the
    // title alone here would fetch nothing for the owner/crown tabs whose
    // titles carry no key (see linearKeyFor's header) and hand the classifier
    // an empty map, silently degrading every one of them to 'unmapped'.
    const keys = [...new Set(dead.map(w => {
      const launch = (() => { try { return launchByRef(w.ref); } catch { return null; } })();
      return linearKeyFor(w.title, launch && launch.taskId, launch && launch.subject);
    }).filter(Boolean))];
    linearStates = await resolveLinearStates(keys);
  }

  const buckets = triageDeadTabs({
    deadTabs: dead,
    liveWorkspaces: alive,
    launchByRef,
    taskStatusById,
    linearStateByKey: (key) => (linearStates.has(key) ? linearStates.get(key) : null),
  });

  if (asJson) {
    console.log(JSON.stringify({ deadCount: dead.length, liveCount: alive.length, foreignAgentAlive, livenessUnverifiable, degraded: Boolean(ledgerError || livenessUnverifiable.length || !useLinear), ...buckets }, null, 2));
  } else {
    console.log(formatTriageReport(buckets).join('\n'));
  }

  // 0 clean / 2 could-not-fully-run, the exit contract this repo's other
  // audit CLIs use (audit-doubled-market-ids.js). A report produced with an
  // unreadable ledger, an unprobeable tab, or Linear deliberately skipped is
  // NOT a clean run, and returning 0 for it let a degraded report look
  // authoritative to any caller that checks only the status (ship-check).
  return (ledgerError || livenessUnverifiable.length || !useLinear) ? 2 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(e => {
    console.error(`[cmux-triage] ${e.stack || e.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  triageDeadTabs, formatTriageReport, extractLinearKey, linearKeyFor, workKeyForTitle,
  isWatchdogDashboardTitle, liveAgentIn,
  OPEN_TASK_STATUSES, taskStatusById, resolveLinearStates, main,
};
