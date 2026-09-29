/**
 * digest-autofix — the morning digest FIXES issues instead of asking the owner.
 *
 * Owner mandate 2026-08-02 (fifth escalation on this email, verbatim): "Why do
 * I need to hit 'Fix this'. I'm obvi going to hit it for everything here. So
 * why EVEN ASK ME? … Just have a Claude session fix them."
 *
 * The Fix-this button (card #634) was a human finger in front of an already
 * automated pipeline: the button's endpoint files a "BSC Daily: <name>" card
 * and the backlog drain / bsc-next --headless dispatches cards as fix
 * sessions. This module removes the finger: at digest-build time every named
 * health issue gets its card filed (deduped against the shared task list) and
 * the oldest few are dispatched through the EXACT same detached
 * `bsc-next.js --id N --headless` spawn the backlog drain uses
 * (scripts/backlog-drain.js) — one code path, same guards (duplicate lease,
 * dead-dispatch, verify gate), no new dispatch machinery.
 *
 * Safety rails:
 *  - DISPATCH_CAP per digest run (a 14-warning morning queues, never fans out
 *    14 sessions; the drain's own 3 ticks/day keep draining the rest).
 *  - Dedup: an open task whose subject contains "BSC Daily: <name>" (or the
 *    email-worker's "Fix: BSC Daily: <name>" variant) is NEVER re-filed —
 *    same conditionKey idea as api/autonomous-action handleDispatch.
 *  - bsc-next's own refusal guards still apply to every dispatch (this module
 *    deliberately spawns the CLI, never re-implements its checks — the same
 *    reasoning as backlog-drain.js's header comment).
 *  - Everything is fail-soft: a broken create/dispatch degrades that ONE row
 *    to 'card-failed'/'dispatch-attempted', never blocks the email.
 *
 * Digest v3.1 (task #843, owner escalation 2026-08-02, verbatim: "why do I
 * need to hit 'Fix this'... I'm obvi going to hit it for everything here"):
 * the "Needs your attention" bucket (owner-alert-router's disposition:'digest'
 * queue — scripts/lib/owner-alert-router.js's queueDigestLine) got ZERO
 * autofix coverage — every row rendered as a bare Dispatch-a-fix button,
 * forever, because planAutofix only ever read health.errors/warns/
 * extraIssues. planAutofix now also accepts `queued` (health.queued, same
 * {conditionKey,title,description,severity,url} shape) and folds each row
 * into the SAME plan/dispatch pipeline as a health row — UNLESS the caller
 * marked it `decision: true` (a genuine judgment call, e.g. "raise the
 * budget vs cut spend"), which renders a button and NEVER auto-dispatches.
 * Default (no `decision` flag) is auto-dispatch — matches the owner's own
 * read that both examples that prompted this card (scraping spend over
 * budget, main test.yml still red) are technical investigations, not
 * decisions.
 *
 * Attempt-memory (reusing #635's scripts/lib/attempt-memory.js, same
 * pattern as scripts/lib/backlog-drain.js's header comment: attempt-memory
 * was built for the paused nightly loop's own ledger, so THIS module feeds
 * it entries from its OWN ledger, data/audit/digest-autofix-ledger.jsonl,
 * shape-compatible: {cardId, contentHash, event: 'card-pass'|'card-fail'}).
 * A row that fails twice unchanged is 'parked', never redispatched blind.
 * A row's SECOND dispatch attempt (same content, first attempt failed)
 * escalates to --model opus — the loop's own "hard enough to escalate"
 * policy (scripts/lib/bsc-next-model.js), applied here explicitly since
 * these headless dispatches carry no triage-queue entry for bsc-next's own
 * model resolution to key off.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const dispatchLedger = require('./dispatch-ledger.js');
const dispatchReconcile = require('./dispatch-reconcile.js');
const { checkPark, computeContentHash } = require('./attempt-memory.js');
// BRO-3412: this path had neither of the two guards the sibling backlog
// drain has (spend circuit breaker, concurrency ceiling) — verified by grep,
// not assumed: this module's require list previously had no path to either
// primitive. Imported, not re-derived (CLAUDE.md rule 15) — same functions
// scripts/backlog-drain.js:468-471 calls, fed THIS module's own ledger
// (digest-autofix-ledger.jsonl) the same way backlog-drain.js feeds them its
// own (backlog-drain-ledger.jsonl). Each drain's ceiling stays independently
// scoped to the taskIds IT dispatched — the same pattern
// dispatch-watchdog-core.js's openHeadlessJobTasks already uses against the
// same shared dispatch-ledger.jsonl — so this does NOT introduce a shared
// cross-drain budget; that would be new infrastructure, out of scope here
// (plan review, BRO-3412). Spend threshold stays the shared default.
// BRO-3438 (owner-approved 2026-09-15) raised the DIGEST's concurrency ceiling
// from that shared default of 2 to 3 — at the CALLER, not here, so every other
// drain importing these same defaults is unaffected.
const {
  computeSpendCircuitBreaker, computeConcurrency,
  DEFAULT_CONCURRENCY_CAP, DEFAULT_SPEND_THRESHOLD_USD,
} = require('./backlog-drain.js');
// BRO-2499: the marker this module stamps onto every issue it files (via the
// --park reason, which linear-issue-create.js prepends to the description as
// `PARKED: <reason>`) and which linear-dispatch.js's autofixFiledIssueGuard
// recognises. Defined in the leaf so the writer and the recogniser cannot
// drift apart.
const { AUTOFIX_FILED_MARKER, BSC_DAILY_TITLE_PREFIX } = require('./autofix-filed-marker.js');
const { LINEAR_TASK_ID_RE, LINEAR_IDENTIFIER_RE } = require('./task-id-namespace.js');
// BRO-3923: never file/reattach a "BSC Daily: Watchdog parked #<bare
// numeric>" tracker for the frozen Notion mirror — see that module's header
// for the incident (31 hand-canceled trackers, 2026-09-21).
const { isWatchdogParkedMirrorTracker } = require('./digest-autofix-mirror-park-guard.js');

// Pulling a Linear identifier out of linear-issue-create.js's JSON output.
// Built from the shared identifier shape rather than a third hand-written
// `[A-Z]+-\d+` — ship-check (Codex) caught these two parsers still rejecting
// the digit-bearing team keys that LINEAR_TASK_ID_RE above now accepts, which
// would have left a card created-but-unparseable.
const LINEAR_IDENTIFIER_IN_JSON_RE = new RegExp(`"identifier":\\s*"(${LINEAR_IDENTIFIER_RE.source})"`);

const REPO = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(REPO, 'data', 'audit', 'digest-autofix-logs');
const DIGEST_LEDGER_PATH = path.join(REPO, 'data', 'audit', 'digest-autofix-ledger.jsonl');
const DISPATCH_CAP = 3;
// A dispatched row's bsc-runner job-spawned event never arrives (refused
// before it ever reached bsc-runner — same failure modes backlog-drain.js
// documents: runner disabled, live cmux duplicate, lease already held).
// Without a timeout the row would sit unresolved forever, permanently
// occupying attempt-memory's "in flight" slot.
// Single source of truth: scripts/lib/dispatch-reconcile.js, the module this
// value is handed straight back to as classifyDispatches' `orphanTimeoutH`.
// All three reconcilers used to declare their own `= 3` (BRO-3321).
const ORPHAN_TIMEOUT_H = dispatchReconcile.ORPHAN_TIMEOUT_H;
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);

// Canonical row-family key (BRO-232 S4): different checks sometimes name the
// SAME underlying condition two different ways — health-check.js's own
// last-run-failure scan emits "Cron failed: X" while its repeat-failure scan
// emits "Workflow repeat-failure: X" for the identical workflow. Without a
// shared key, card filing / matchOpenTask / ledger grouping treated them as
// two unrelated rows, splitting attempt-memory across two cards that could
// never individually resolve (fixing the workflow clears BOTH names at once).
const ROW_FAMILY_PREFIXES = [
  /^Cron failed:\s*/i,
  /^Workflow repeat-failure:\s*/i,
];

// Strips ONE matching family prefix, leaving the rest as the display form.
// Returns the name unchanged when no prefix matches — the common case, byte-
// identical to today's behavior for the vast majority of rows.
function familyDisplayName(name) {
  const s = String(name || '').trim();
  for (const re of ROW_FAMILY_PREFIXES) {
    const stripped = s.replace(re, '');
    if (stripped !== s) return stripped.trim();
  }
  return s;
}

// Match key: family display name, case/whitespace-normalized.
function rowFamilyKey(name) {
  return familyDisplayName(name).toLowerCase().replace(/\s+/g, ' ');
}

// BRO-3427: mirror-image of the prefix rule above — every one of this repo's
// per-show opening-night checks self-declares its remediation title as
// "<condition> on ${show.title || show.id}" (scripts/lib/opening-night-
// checks/*.check.js, grepped: stale-upcoming-tag, placeholder-synopsis,
// cv-wrongproduction-unhandled, publish-date-pre-opening, fulltext-mentions-
// show, etc. — all the SAME literal separator). Splitting on the FIRST
// " on " is correct even when a show title itself contains " on " (e.g.
// "Once on This Island"): the condition text is a fixed phrase that never
// contains " on ", so the first occurrence is always the condition/show
// boundary. Operates on the prefix-stripped name so a row carrying BOTH a
// known prefix and an "on show" suffix still resolves to the right
// condition. Rows with no " on " at all (most non-per-show conditions)
// return null and are never folded — see planAutofix's foldable check below.
const ON_SHOW_SUFFIX_RE = /^(.+?) on (.+)$/;

// KNOWN LANDMINE (ship-check finding — accepted, not fixed, see rationale):
// this applies to EVERY row this module sees, not just per-show opening-
// night-check remediations — anything whose raw name happens to contain
// literal " on " gets split the same way. Grepped repo-wide (2026-09-15):
// today's non-per-show producers each emit a FIXED, unique string containing
// " on " (health-check.js:3761 "...zero critic reviews on site",
// claude-auth-health.js's "...unusable on the Mac" /"...running on pay-per-
// token, not the subscription") — none collide with each other or with a
// real per-show condition, so folding just gives them a slightly blunter
// title, never a wrong merge. The unguarded risk is a FUTURE addition: two
// unrelated conditions that happen to share an identical prefix before
// " on " (e.g. "Failure on deploy" / "Failure on scoring") WOULD fold
// together incorrectly — there is no producer-identity signal (no
// isPerShow flag) for this function to check. Restricting folding to known
// per-show producers would need that signal threaded through
// normalizeQueuedRows/queueDigestLine — a real architecture change, left
// for if/when a real collision is observed rather than spent on a landmine
// that has never actually gone off.
function splitOnShowSuffix(name) {
  const m = ON_SHOW_SUFFIX_RE.exec(familyDisplayName(name));
  return m ? { condition: m[1].trim(), show: m[2].trim() } : null;
}

// "a condition matching 60 shows should not produce one card with 60 shows
// in it" (BRO-3427 suggested approach) — real-world max observed is 14
// (Stale 'upcoming' tag), so this comfortably covers today's data while
// still bounding a single card's blast radius. A condition exceeding the cap
// spills into additional cards ("BSC Daily: <condition> (batch 2)", etc.),
// each independently filed/dispatched/verified.
const MAX_FOLD_PER_CONDITION = 20;

const OPEN_TASK_SUBJECT_RE = /^(?:Fix: )?BSC Daily: (.+)$/;

// Which open task (pending/in_progress) already covers this health issue?
// Family-key compared (BRO-232 S4), not literal substring: a task filed
// under one prefix variant ("BSC Daily: Cron failed: X") now also covers a
// row that arrives under the sibling variant ("Workflow repeat-failure: X")
// once both compute the same canonical title (see planAutofix below) — this
// keeps matchOpenTask consistent with fileCard's own title collapse instead
// of a second row-family-blind copy of the same "already tracked?" check.
function matchOpenTask(tasks, name) {
  const wantFamily = rowFamilyKey(name);
  return (tasks || []).find(t => {
    if (!t || (t.status !== 'pending' && t.status !== 'in_progress')) return false;
    const m = OPEN_TASK_SUBJECT_RE.exec(String(t.subject || ''));
    if (!m) return false;
    return rowFamilyKey(m[1]) === wantFamily;
  }) || null;
}

// Some health rows self-document that they're already tracked, owner-accepted,
// and expected to clear on their own by a known date — the shared suffix shape
// emitted by scripts/lib/scrapingbee-ack.js / scrapingdog-ack.js:
// " — acknowledged: <reason> [expires YYYY-MM-DD]". Those rows stay 'warn'
// (by design — see task #367/#353) until the stamped date, so a P1 "fix this"
// card filed against them can never mechanically resolve before then; it's
// pure noise on top of the acknowledgment that already exists (task #804
// duplicated the already-closed #224 this exact way; #803 is the ScrapingDog
// cousin). Skip card-filing for these while the ack is still live.
const ACKNOWLEDGED_ROW_RE = /acknowledged:.*\[expires\s+(\d{4}-\d{2}-\d{2})\]/i;

function isRowAcknowledged(message, today) {
  const m = ACKNOWLEDGED_ROW_RE.exec(String(message || ''));
  if (!m) return false;
  const todayDate = today || new Date().toISOString().slice(0, 10);
  return m[1] > todayDate;
}

// Normalizes health.errors/warns/extraIssues rows and health.queued (digest-
// queue) rows into ONE shape planAutofix can iterate uniformly. Queued rows
// carry conditionKey/decision/decisionPrompt/model — health rows don't, so
// those come back null/false for them (harmless: nothing reads them there).
function normalizeQueuedRows(queued) {
  return (Array.isArray(queued) ? queued : []).filter(q => q && q.title).map(q => ({
    name: q.title,
    message: q.description || q.title,
    decision: !!q.decision,
    decisionPrompt: q.decisionPrompt || null,
    model: q.model && VALID_MODELS.has(q.model) ? q.model : null,
    conditionKey: q.conditionKey || null,
  }));
}

// Builds one plan row for a single raw health/queued row `r`. Extracted from
// planAutofix (BRO-3427) so the same row-shaping logic works for an unfolded
// row and for a folded group's ANCHOR row — `titleOverride` lets the caller
// substitute the condition-only title ("BSC Daily: <condition>") and key
// matchOpenTask off the condition text instead of the raw per-show name, so
// one open "BSC Daily: <condition>" task/issue is recognised as already
// covering EVERY show under that condition, the same way a prefix-family
// match already covers every prefix variant (matchOpenTask's own doc comment).
function buildPlanRow(r, { tasks, today, titleOverride = null } = {}) {
  const rawMessage = String(r.message || '');
  const message = rawMessage.slice(0, 400);
  // Family-collapsed (BRO-232 S4): two rows naming the SAME condition two
  // ways ("Cron failed: X" / "Workflow repeat-failure: X") now compute the
  // identical title, so fileCard's exact-title Linear dedup — and, for any
  // residual Notion-mirror task, matchOpenTask below — converge them onto
  // ONE card instead of filing/tracking a duplicate per name variant. The
  // raw r.name (never family-collapsed) still drives buildCardNotes' prose
  // and its check-health-row-absent.js verify command, which must keep
  // checking the SPECIFIC health-check row that was actually seen.
  // Built from the shared constant (code-review finding, BRO-2499) so this
  // producer and autofix-filed-marker.js's title matcher cannot drift.
  const title = titleOverride || `${BSC_DAILY_TITLE_PREFIX}${familyDisplayName(r.name)}`;
  const conditionKey = r.conditionKey || null;

  // Decision items (owner-alert-router callers that opted in via
  // `decision: true`) are a genuine judgment call, not a fix — they never
  // get a card filed or a session dispatched by this module. The digest
  // renders these with a button instead (send-morning-digest.js keeps
  // them in sections.health.queued by matching on conditionKey).
  if (r.decision) {
    return { name: r.name, message, title, state: 'decision', taskId: null, conditionKey, model: null, decisionPrompt: r.decisionPrompt || null };
  }

  const existing = matchOpenTask(tasks, titleOverride ? titleOverride.slice(BSC_DAILY_TITLE_PREFIX.length) : r.name);
  // Check the ack marker against the FULL text first — 400-char truncation
  // could otherwise sever a long reason's trailing "[expires ...]" token
  // and silently revert an acknowledged row to needs-card (ship-check P2).
  const acknowledged = !existing && isRowAcknowledged(rawMessage, today);
  if (acknowledged) {
    return { name: r.name, message, title, state: 'acknowledged', taskId: null, conditionKey, model: null, wasNew: false };
  }
  const state = existing ? (existing.status === 'in_progress' ? 'in-progress' : 'queued') : 'needs-card';
  return {
    name: r.name,
    message,
    title,
    state,
    taskId: existing ? existing.id : null,
    conditionKey,
    model: r.model || null,
    // Plan-time guess (BRO-232 S4 digest-subject split, send-morning-
    // digest.js's buildSubject): true only when NOTHING already tracked
    // this row's family. runAutofix overrides this for 'needs-card' rows
    // once it knows the REAL answer from fileCard's live Linear lookup —
    // matchOpenTask only sees the Notion-mirror task list, which
    // digest-autofix's own Linear-filed cards never populate post-BRO-286
    // (no mirror-sync path exists for them), so this default is a fallback
    // for dry-run/degraded runs where fileCard never executes, not the
    // final answer for a real send.
    wasNew: state === 'needs-card',
  };
}

/**
 * Pure planner (CLAUDE.md §15): health rows + extra issues + queued
 * "Needs your attention" rows + current tasks → per-issue action plan. No
 * I/O so the digest tests can exercise the real decision table.
 *
 * BRO-3427: every "<condition> on <show>" row folds onto ONE plan row per
 * condition (capped at MAX_FOLD_PER_CONDITION, overflow spills to "(batch
 * N)") instead of emitting one row per show — measured at 35 of 88 daily
 * health rows, 40% of the digest queue, each independently minting its own
 * card AND dispatch for a fix that one remediation run typically clears for
 * every affected show at once.
 *
 * UNCONDITIONAL, not "fold only when 2+ rows share a condition today" (the
 * first version of this fix, reverted in review): a condition's occurrence
 * count varies day to day as shows open/close/get fixed, so gating folding
 * on TODAY's count made the card TITLE itself flip between "BSC Daily:
 * <condition>" and "BSC Daily: <condition> on <show>" depending on how many
 * shows happened to have the issue that morning. matchOpenTask/fileCard's
 * dedup is an EXACT title match — a flipping title breaks it across the
 * exact day boundary that matters (a condition shrinking from 2 shows to 1,
 * or growing from 1 to 2), silently filing a genuine duplicate card instead
 * of reattaching to the one already open (ship-check finding, 2026-09-15).
 * Folding unconditionally — mirroring familyDisplayName's prefix rule above,
 * which ALWAYS strips a matching prefix regardless of whether a sibling
 * variant exists today — keeps the title, and therefore the card identity,
 * stable across every day regardless of how many shows currently share it.
 * A single-show occurrence still gets an `affected` array of length 1; that
 * degenerates to buildCardNotes' single-row rendering (row.affected.length
 * <= 1), so nothing downstream needs to special-case "was this ever folded".
 *
 * A row that never matches the "<condition> on <show>" shape is completely
 * unaffected — same title, same rendering as before this change. Every
 * folded row carries `affected`: the raw {name, message} of every show it
 * stands in for, so buildCardNotes can list (and emit a verify check for)
 * each one — see that function's own comment for why only folding, never
 * the verify semantics, can be solved generically here (SAFE_CHECK_FORMS'
 * check-health-row-absent.js form takes exactly one row).
 * @returns {Array<{name, message, title, state, taskId, conditionKey, model, affected}>}
 *   state: 'in-progress' | 'queued' | 'needs-card' | 'acknowledged' | 'decision' | 'parked'
 *   ('parked' is only ever set by runAutofix, never by planAutofix.)
 */
function planAutofix({ health, extraIssues = [], tasks = [], today, queued } = {}) {
  const rows = [
    ...(Array.isArray(health?.errors) ? health.errors : []),
    ...(Array.isArray(health?.warns) ? health.warns : []),
    ...extraIssues,
    ...normalizeQueuedRows(queued),
  ].filter(r => r && r.name && !isWatchdogParkedMirrorTracker(r.name, r.conditionKey));

  // Every "<condition> on <show>" row's ANCHOR is the plan row at the
  // position of its first occurrence in this batch — a later same-condition
  // row appends to the anchor's `affected` list instead of pushing a new
  // plan entry, which is the actual mechanism that turns 35 rows into 7
  // (runAutofix iterates `plan`, so fewer plan rows is fewer cards filed AND
  // fewer dispatches spent, with no changes needed there). Once an anchor's
  // `affected` hits MAX_FOLD_PER_CONDITION, the next row for that condition
  // starts a NEW anchor ("... (batch 2)") instead of growing the first past
  // the cap. Decision rows are never candidates — they're a judgment call,
  // not a fix — and never match the suffix pattern's fold path.
  const openAnchor = new Map(); // condition key -> {row, batch}
  const planRows = [];
  for (const r of rows) {
    const split = r.decision ? null : splitOnShowSuffix(r.name);
    if (!split) {
      planRows.push(buildPlanRow(r, { tasks, today }));
      continue;
    }
    const key = split.condition.toLowerCase();

    const open = openAnchor.get(key);
    if (open && open.row.affected.length < MAX_FOLD_PER_CONDITION) {
      open.row.affected.push({ name: r.name, message: String(r.message || '').slice(0, 400) });
      // BRO-3427 ship-check finding: isRowAcknowledged only ever runs on the
      // ANCHOR (inside buildPlanRow) — a later-joining member here never
      // goes through that check at all. If the anchor happened to be
      // acknowledged (its own message carried a live "acknowledged: ...
      // [expires ...]" marker) but THIS member is not, silently leaving the
      // group 'acknowledged' would suppress real, actionable work for this
      // show. Flip back to active whenever a non-acknowledged member joins
      // an acknowledged group — biased toward filing the card, the same
      // fail-safe direction isRowAcknowledged's own header comment argues
      // for (skip-filing is the exception, not the default). The reverse
      // (an acknowledged member joining an active group) needs no special
      // handling: the group is already active and correctly stays that way.
      if (open.row.state === 'acknowledged' && !isRowAcknowledged(String(r.message || ''), today)) {
        const existing = matchOpenTask(tasks, open.row.title.slice(BSC_DAILY_TITLE_PREFIX.length));
        open.row.state = existing ? (existing.status === 'in_progress' ? 'in-progress' : 'queued') : 'needs-card';
        open.row.taskId = existing ? existing.id : null;
        open.row.wasNew = open.row.state === 'needs-card';
        // Codex finding: buildPlanRow's 'acknowledged' branch always returns
        // model:null (acknowledged rows never dispatch, so there was never a
        // reason to carry one) — by the time we're here, open.row.model is
        // already that discarded null, not the anchor's real hint. Recover
        // it from openAnchor's own anchorModel (captured at anchor-creation
        // time below, before buildPlanRow could drop it), falling back to
        // this newly-active member's own hint.
        open.row.model = open.anchorModel || r.model || null;
      }
      continue;
    }
    const batch = open ? open.batch + 1 : 1;
    const titleOverride = `${BSC_DAILY_TITLE_PREFIX}${split.condition}${batch > 1 ? ` (batch ${batch})` : ''}`;
    const row = buildPlanRow(r, { tasks, today, titleOverride });
    row.affected = [{ name: r.name, message: String(r.message || '').slice(0, 400) }];
    // anchorModel: the anchor's raw model hint, captured HERE (not read back
    // off `row` later) because buildPlanRow's 'acknowledged' branch discards
    // it to null — see the reactivation branch above for why this matters.
    openAnchor.set(key, { row, batch, anchorModel: r.model || null });
    planRows.push(row);
  }
  return planRows;
}

// Row text comes from health-check output (semi-trusted: workflow names and
// scraped strings can leak in). extractVerifyCmd treats the FIRST
// "## Acceptance criteria" section / any "VERIFY:" line / backticked span in
// the notes as the card's executable proof, so hostile row text could inject
// its own safe-but-unrelated command (Codex finding, 2026-08-02). Neutralize
// the three carriers before interpolating.
// sanitizeRowText now lives in ./health-row-check-cmd.js — owner-alert-router.js
// needs the identical treatment for the identical reason (BRO-3881).

// Encodes one row's raw name into the check-health-row-absent.js safe-form
// token — shared by the single-row and folded-row buildCardNotes branches so
// they can never diverge on the encoding (round-tripped by the existing
// "acceptance command passes the REAL safe-form gate" test).
//
// BRO-3881 moved it to its own leaf so scripts/lib/owner-alert-router.js — the
// OTHER auto-filer, whose cards the digest also dispatches — can emit the same
// command instead of the prose that got every one of its cards refused at
// dispatch. See that module's header for the incident.
const { rowAbsentCheckCmd, sanitizeRowText } = require('./health-row-check-cmd.js');

// Card notes must pass notion-brain's card-quality gate for "Not started"
// cards: ## Problem + ## Suggested approach + ## Acceptance criteria sections
// and >=300 chars (the gate rejected the first live send's shorter format).
//
// BRO-3427: a FOLDED row (row.affected.length > 1, set by planAutofix) gets a
// different body — one Problem/Evidence/Acceptance entry per affected show
// instead of one row's worth. The raw per-show name/message for every folded
// show flows in via `row.affected`, unchanged from planAutofix, so nothing
// here re-derives or truncates the show list. Acceptance criteria lists a
// `check-health-row-absent.js --row-b64` line PER affected show — every line
// is a real backticked safe-form command, so ALL of them arm as candidates
// (autonomous-verify-cmd.js's candidatesFrom is a `matchAll` over every
// backticked span in the section), but extractVerifyCmd's rank-then-first
// selection only ever RUNS the first one automatically — SAFE_CHECK_FORMS'
// check-health-row-absent.js form takes exactly one row, and widening it to
// take N rows is a `scripts/lib/` review-gate change (CLAUDE.md §18), out of
// scope here. The prose says so explicitly, so a card is never read as
// "Done" once the first show clears while the rest are still flagged — the
// single-row branch below (row.affected absent/length<=1) is BYTE-IDENTICAL
// to before this change.
function buildCardNotes(row) {
  const affected = Array.isArray(row.affected) && row.affected.length > 1 ? row.affected : null;
  const name = sanitizeRowText(row.name);
  const message = sanitizeRowText(row.message);

  if (!affected) {
    return [
      '## Problem',
      `The daily health check (\`node scripts/health-check.js\`) reports an issue named "${name}": ${message || '(no detail message — reproduce locally for specifics)'}`,
      '',
      '## Evidence',
      `Auto-filed by the morning digest (Digest v3, owner mandate 2026-08-02: fix automatically, never ask). The row appeared in today's health-check errors/warnings; the message above is the check's own output.`,
      '',
      '## Suggested approach',
      `Run \`node scripts/health-check.js\` to reproduce, then grep scripts/health-check.js for the check that emits "${row.name}" to find the underlying data source or workflow. Fix the root cause (not the check), and include prevention per CLAUDE.md.`,
      '',
      '## Acceptance criteria',
      // The backticked command is the machine-checkable proof bsc-next's verify
      // gate arms and the nightly acceptance recheck re-runs. base64url keeps
      // the row name a single token (SAFE_CHECK_FORMS + quote-free argv split).
      // Encode the RAW name (the checker compares against raw snapshot names);
      // only prose gets sanitized. Slice matches the checker's own bound.
      `\`${rowAbsentCheckCmd(row.name)}\` passes — i.e. the daily health check no longer lists "${name}" among errors or warnings.`,
    ].join('\n');
  }

  const condition = sanitizeRowText(row.title.startsWith(BSC_DAILY_TITLE_PREFIX) ? row.title.slice(BSC_DAILY_TITLE_PREFIX.length) : row.title);
  return [
    '## Problem',
    `The daily health check (\`node scripts/health-check.js\`) reports "${condition}" on ${affected.length} shows:`,
    ...affected.map(a => `- ${sanitizeRowText(a.name)}: ${sanitizeRowText(a.message) || '(no detail message)'}`),
    '',
    '## Evidence',
    `Auto-filed by the morning digest (Digest v3, owner mandate 2026-08-02: fix automatically, never ask; BRO-3427 row-family fold). These ${affected.length} rows shared one condition and were folded onto this ONE card instead of ${affected.length} near-duplicate cards.`,
    '',
    '## Suggested approach',
    `Run \`node scripts/health-check.js\` to reproduce, then grep scripts/health-check.js (or scripts/lib/opening-night-checks/) for the check that emits "${condition}" to find the underlying data source or workflow. Several of these checks self-document a BULK remediation command (one run, no --show=, fixes every affected show) in their message above — prefer that over fixing one show at a time. Fix the root cause (not the check), and include prevention per CLAUDE.md.`,
    '',
    '## Acceptance criteria',
    `ALL of the following must pass — this card is NOT done while any show below is still flagged (only the first line is auto-verified by the dispatch gate; confirm the rest by hand or via --live before closing):`,
    ...affected.map(a => `\`${rowAbsentCheckCmd(a.name)}\` passes — i.e. the daily health check no longer lists "${sanitizeRowText(a.name)}" among errors or warnings.`),
  ].join('\n');
}

// File one Notion card. Extracted (task #1225) so the digest-autofix canary
// (scripts/lib/autofix-canary.js) reuses the EXACT same create call instead
// of a second copy that would drift the next time this one is fixed
// (CLAUDE.md §15). Callers that file several cards in one pass (runAutofix
// below) call this per-row, then ONE syncTasks() at the end — deliberately
// NOT folded into a single fileCardAndSync helper, since batching the sync
// after N creates (not N syncs) is the whole point of that shape.
//
// Phase 0 rail 2 (plan 2026-08-12, task #1341) deliberately does NOT wire the
// owner-alert-router.js Linear dedupe (findLinearDuplicate) in here. It would
// need to `await` before this call, and runAutofix()/fileCard() are
// synchronous top to bottom — 1 production call site (send-morning-digest.js)
// but 9 synchronous call sites in this file's own test suite
// (digest-autofix.test.mjs) would all need converting to async alongside it.
// That's a real refactor of a critical-tier dispatch file, not the "cheap to
// reach" case the rail's plan explicitly carved out — left for a follow-up
// rather than rushed in here. Health-check-sourced rows rarely share a
// conditionKey with a hand-filed Linear issue in practice (they're filed by
// name, not conditionKey, prior to this rail), so the exposure this leaves
// open is narrow.
// BRO-286 Phase 2 intake repoint (2026-08-12): files a LINEAR issue via the
// linear-brain.js CLI (single createLinearIssue() chokepoint underneath,
// CI-gated) instead of a Notion card. Returns { ok, identifier } — identifier
// is the human id ("BRO-287") the caller threads straight onto its row as
// `linear:BRO-287`, REPLACING the old file→syncTasks→matchOpenTask numeric-
// task resolution dance (there is no Notion mirror card to resolve anymore).
function fileCard(title, notes, { log = () => {}, refreshNotesOnReattach = false } = {}) {
  // Dedup BEFORE filing (BRO-286 merge-review P0): a persistent health row
  // hits this every morning, and the Notion-mirror dedup (matchOpenTask in
  // planAutofix) can't see Linear issues — without this check the same row
  // mints one duplicate issue per day, each fresh identifier resetting
  // attempt-memory (park/opus-escalation never trigger) and pressuring the
  // 250-issue cap. Matching the existing OPEN issue by exact title keeps the
  // row's taskId stable across days, so checkPark/priorAttempts keep
  // working. Fail-open: a find error just means we file (worst case one
  // duplicate, same as a transient Linear outage).
  try {
    const found = execFileSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'find', title, '--exact-title'],
      { cwd: REPO, encoding: 'utf8', timeout: 30000 });
    const fm = found.match(LINEAR_IDENTIFIER_IN_JSON_RE);
    if (fm) {
      log(`[digest-autofix] row already tracked as ${fm[1]} — reattaching instead of filing a duplicate`);
      // BRO-3427 ship-check finding: a folded row's affected-show SET can
      // change day to day (one show fixed, a new one joins) while the title
      // (and therefore this dedup match) stays the same — the issue's
      // DESCRIPTION is fixed at creation and never rewritten by a plain
      // reattach, so a stale card would keep listing yesterday's shows and
      // never mention today's. Posting the freshly-built notes as a COMMENT
      // fixes this without touching the description: verify-gate.js's
      // evaluateVerifiability already reads comments newest-first and lets
      // the latest one supersede the original acceptance criteria (built for
      // exactly this "correct a stale VERIFY command after dispatch"
      // problem, BRO-2796) — so the auto-armed check always tracks the
      // CURRENT membership, not day-1's. Only opted into by folded-row
      // callers (runAutofix below); a plain single-issue row's notes never
      // change day to day, so refreshing here would just be daily spam.
      if (refreshNotesOnReattach) {
        try {
          execFileSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'update', fm[1], '--comment', notes],
            { cwd: REPO, encoding: 'utf8', timeout: 30000 });
          log(`[digest-autofix] refreshed ${fm[1]}'s acceptance criteria via comment (fold membership may have changed)`);
        } catch (err) {
          log(`[digest-autofix] WARN could not refresh ${fm[1]}'s notes comment (fold membership may be stale): ${String(err.message).slice(0, 120)}`);
        }
      }
      return { ok: true, identifier: fm[1], existing: true };
    }
  } catch (err) {
    log(`[digest-autofix] WARN Linear dedup lookup failed (filing anyway): ${String(err.message).slice(0, 120)}`);
  }
  try {
    const out = execFileSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'create', title,
      // Linear priority 2 = High (scale: 1 Urgent / 2 High / 3 Medium / 4
      // Low) — same intent as the old 'P1' Notion priority: auto-fix rows
      // are dispatch-eligible immediately.
      '--priority', '2',
      '--notes', notes,
      // task #1310: filing and dispatching are deliberately separate steps
      // here (see header comment above) — this call only ever files; the
      // caller's own dispatchDetached() (below) is the real dispatch.
      '--park', `${AUTOFIX_FILED_MARKER}; runAutofix dispatches via linear-next separately in the same pass.`,
    ], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
    // linear-brain prints the issue JSON then a PARKED: line — the field is
    // `.identifier` (NOT `.id`, which is the opaque UUID).
    const m = out.match(LINEAR_IDENTIFIER_IN_JSON_RE);
    if (!m) {
      log(`[digest-autofix] WARN issue created but identifier not found in output for "${title}"`);
      return { ok: false, identifier: null };
    }
    log(`[digest-autofix] filed issue ${m[1]}: ${title}`);
    return { ok: true, identifier: m[1] };
  } catch (err) {
    log(`[digest-autofix] WARN issue create failed for "${title}": ${String(err.message).slice(0, 120)}`);
    return { ok: false, identifier: null };
  }
}

// Pull newly filed cards into the shared task list so they get task numbers.
function syncTasks({ log = () => {} } = {}) {
  try {
    execFileSync('node', [path.join(REPO, 'scripts', 'notion-tasks-sync.js'), 'pull'],
      { cwd: REPO, encoding: 'utf8', timeout: 120000 });
    return true;
  } catch (err) {
    log(`[digest-autofix] WARN tasks-sync pull failed (cards stay queued for the drain): ${String(err.message).slice(0, 120)}`);
    return false;
  }
}

// Detached headless dispatch — byte-for-byte the backlog drain's pattern
// (stdio to a log file so a refusal is debuggable, unref so the digest exits).
// `model`, when set, escalates the dispatch past bsc-next's own resolution
// (these headless dispatches carry no triage-queue entry to key off) — used
// for a row's 2nd+ attempt on unchanged content, or a caller-supplied hint
// (e.g. test.yml's streak escalation, which wants opus on its first try here
// since it's already the SECOND machine attempt at the underlying failure).
// `opts.allowAutofixFiled` (BRO-2499) appends --allow-autofix-filed on the
// linear-next path, waiving linear-dispatch.js's autofixFiledIssueGuard for
// THIS dispatch. Opt-in per call site, not defaulted on, so a future caller
// never inherits a bypass it never asked for (second-opinion review,
// BRO-2499). All three of today's callers legitimately own their population
// and pass it: runAutofix below, autofix-canary.js's two sites, and
// scripts/linear-drain-parked.js — that last one is NOT redundant, see its
// call site: health-check.js routes alert-router trackers under the same
// "BSC Daily:" title, so the guard refuses them too. Never appended on the
// bsc-next.js branch: that CLI has no such flag and no such guard.
function dispatchDetached(taskId, log, delaySec = 0, model = null, opts = {}) {
  // Validate BEFORE opening the log fd — throwing after openSync leaked a
  // file descriptor per rejected dispatch (Codex review, 2026-08-02).
  //
  // Two id shapes (BRO-286): 'linear:BRO-287' rows (the repointed fileCard
  // path) spawn linear-next.js with the bare Linear identifier; legacy
  // numeric ids keep the bsc-next.js path (rows resolved against the old
  // Notion mirror during the parallel run). Both regexes make the sh -c
  // interpolation injection-safe — anything else throws.
  // BRO-3423: was a private /^linear:([A-Z]+-\d+)$/ here, which rejected any
  // Linear team key containing a digit while linear-watchdog-source.js's copy
  // accepted it — two divergent answers to "is this a live-board id?", one of
  // them guarding this sh -c interpolation. Both now come from the shared
  // declaration. LINEAR_TASK_ID_RE is anchored and alphanumeric-plus-hyphen
  // only, so the injection-safety property this line depends on is preserved.
  const linearMatch = LINEAR_TASK_ID_RE.exec(String(taskId));
  const idNumEarly = Number(taskId);
  if (!linearMatch && (!Number.isSafeInteger(idNumEarly) || idNumEarly <= 0)) {
    throw new Error(`invalid taskId for dispatch: ${String(taskId).slice(0, 40)}`);
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${String(taskId).replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  // Staggered start: simultaneous detached spawns race on the main repo's
  // `git worktree add` lock and all but one die 'worktree-error' (live-run
  // finding 2026-08-02: 3 same-instant dispatches → 2 failed). Both id forms
  // are regex-validated above and delaySec is internal, so the sh -c line is
  // injection-safe. Codex hardening (2026-08-02): pass the script path as a
  // positional shell arg instead of interpolating it (JSON.stringify is NOT
  // shell quoting — $() would survive inside double quotes).
  const id = linearMatch ? linearMatch[1] : String(idNumEarly);
  const scriptPath = linearMatch
    ? path.join(REPO, 'scripts', 'linear-next.js')
    : path.join(REPO, 'scripts', 'bsc-next.js');
  const safeModel = model && VALID_MODELS.has(model) ? model : null;
  const modelArg = safeModel ? ` --model ${safeModel}` : '';
  const autofixArg = linearMatch && opts && opts.allowAutofixFiled ? ' --allow-autofix-filed' : '';
  // opts.allowAutomationParked (BRO-3060): every issue digest-autofix.js/
  // autofix-canary.js/linear-drain-parked.js dispatches through this
  // function was parked by THAT SAME pipeline (via fileCard's --park), so
  // it also carries the PARKED_SENTINEL headless-dispatchability.js refuses
  // by default — a second, independent guard from the autofixFiledIssueGuard
  // autofixArg above waives. Without this every one of those dispatches was
  // spawned only to be refused inside the detached child (see linear-next.js's
  // --allow-automation-parked doc comment for why --force/--allow-human-gated
  // are each too broad to use here instead).
  const parkedArg = linearMatch && opts && opts.allowAutomationParked ? ' --allow-automation-parked' : '';
  // --no-detach (BRO-3652, Codex review): this helper already detaches via
  // `sh -c … exec node` with stdio on the advertised log. linear-next.js now
  // detaches by DEFAULT, which would make that node re-exec a grandchild and
  // move the whole run's output (and its job-done/job-stranded verdict) into
  // a detached-linear-next-*.log the drain's troubleshooting notes never
  // point at (linear-drain-parked.js promises the outcome in THIS log). The
  // explicit flag keeps the contract exactly as it was. bsc-next.js does not
  // take the flag, so it is Linear-lane only.
  const detachArg = linearMatch ? ' --no-detach' : '';
  const cmd = `sleep ${Math.max(0, Math.floor(delaySec))} && exec node "$1" --id ${id} --headless${detachArg}${modelArg}${autofixArg}${parkedArg}`;
  const child = spawn('sh', ['-c', cmd, 'sh', scriptPath],
    { cwd: REPO, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  log(`[digest-autofix] dispatch attempted for ${linearMatch ? id : `#${id}`} (${linearMatch ? 'linear-next' : 'bsc-next'} headless, detached${safeModel ? `, model ${safeModel}` : ''}, +${delaySec}s stagger; log: ${logPath})`);
}

// ── attempt-memory plumbing (own ledger, shared dispatch-ledger for job outcomes) ──

// Exact-line dedupe (BRO-3868, same pattern as linear-drain-parked.js's
// readLedger — this file's own merge=union .gitattributes comment names it
// as a separate condition from ordering-safety): a union merge can leave the
// SAME row twice (sync-audit-checkout.sh's recovery re-appends locally-saved
// rows over origin's committed ones verbatim), and checkPark/priorAttempts
// below count every matching row with no dedupe of their own — one
// duplicated row would turn a single failure into a park, or a first
// dispatch into a false opus-escalating "second attempt". Safe against true
// collisions: appendJsonlLedger stamps every row with a fresh
// `new Date().toISOString()` at write time, so two genuinely distinct
// attempts never serialize identically.
function readJsonlLedger(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

// Strict variant (BRO-3412, Codex adversarial-review finding) — used ONLY by
// the spend/concurrency guard below. readJsonlLedger above (and
// dispatch-ledger.js's readEntries) swallow EVERY filesystem error into [],
// indistinguishable from "the ledger genuinely has nothing in it yet" — the
// common, healthy state on a fresh install. Reusing that fail-soft read for
// a money guard means the ONE failure mode most likely to happen (a
// corrupt/inaccessible ledger file, or — in tests — a throwing injected
// reader) silently computes "$0 spent, 0 alive" and lets dispatch through
// with ZERO protection: exactly backwards for a guard whose whole job is to
// fail closed. ENOENT is NOT a failure here — no ledger file yet is the
// normal first-run state and must not permanently halt dispatch — but any
// OTHER read error propagates, so the guard's own try/catch can act on it.
function readJsonlLedgerStrict(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }
  const out = [];
  const seen = new Set(); // dedupe rationale: see readJsonlLedger above
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line — matches readJsonlLedger */ }
  }
  return out;
}
// "Strict" above is deliberately scoped to FILE-level failure (unreadable,
// EACCES, a throwing injected test reader) — a single malformed LINE within
// an otherwise-healthy ledger is silently dropped, same as readJsonlLedger
// and dispatch-ledger.js's own readEntries. That's not an oversight (BRO-3412
// follow-up review, BRO-3453): a truncated line from a crash mid-append is a
// routine, expected event in an append-only JSONL log — every ledger reader
// in this codebase treats it that way. Escalating single-line corruption to
// "fail the whole guard closed" would be a NEW, stricter policy than the rest
// of the dispatch-ledger ecosystem uses, and its failure mode is worse: one
// bit-flipped historical row could permanently wedge all future dispatch
// until a human manually repairs the file, versus today's bounded, small
// undercount from one dropped row. See BRO-3453 for the fuller tradeoff.

// Same strict/ENOENT-tolerant contract as readJsonlLedgerStrict, for the
// SHARED dispatch-ledger.jsonl (dispatch-ledger.js's own readEntries also
// swallows every fs error into []). Reads dispatchLedger.LEDGER_PATH
// directly rather than calling readEntries() — the module boundary is worth
// keeping (this file doesn't own that ledger's format), but readEntries()
// itself offers no way to distinguish "empty" from "unreadable".
function readSharedDispatchLedgerStrict() {
  return readJsonlLedgerStrict(dispatchLedger.LEDGER_PATH);
}

function appendJsonlLedger(p, entry) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// Correlation logic shared with scripts/backlog-drain.js and
// scripts/linear-drain-parked.js since BRO-2542 — see
// dispatch-reconcile.findMyJob for why "latest ts for this taskId" is unsafe,
// and why job-retried chains are followed (task #1184 S1) so a live resume is
// never scored card-fail. Re-exported, not re-implemented: all three files
// previously carried a byte-for-byte copy.
const findMyJob = dispatchReconcile.findMyJob;

// A dispatch is resolved by an outcome recorded AT OR AFTER it, not by "this
// cardId+contentHash has an outcome somewhere in history" (BRO-2506, same bug
// class as BRO-2434's scripts/linear-drain-parked.js fix — see 1f0daa1100b,
// and BRO-2508's scripts/backlog-drain.js fix). The content-hash-keyed
// resolvedKeys Set this used to use collapses two dispatches of the SAME
// unchanged content onto one key — exactly the repeated-failure case
// attempt-memory's park mechanism exists to detect (the digest hashes a
// row's canonical family title alone, stable run over run for the same
// recurring condition — see runAutofix's own contentHash comment below) — so
// a card auto-dispatched, failed, and auto-dispatched again the next morning
// on unchanged content would never produce a SECOND card-fail at all, and
// checkPark could never see two failures to park on.
const RESOLVING_EVENTS = new Set(['card-pass', 'card-fail']);
// Arity-3 wrapper binding this module's own outcome vocabulary — the shared
// implementation takes the event set as a 4th argument, since
// scripts/backlog-drain.js resolves on a richer set (card-stranded,
// completion-unattributed) than this module's plain pass/fail.
function isDispatchResolved(digestLedgerEntries, cardId, dispatchTs) {
  return dispatchReconcile.isDispatchResolved(digestLedgerEntries, cardId, dispatchTs, RESOLVING_EVENTS);
}

// Resolves prior 'auto-dispatch' breadcrumbs (this module's own ledger) into
// card-pass/card-fail by cross-referencing the SHARED dispatch-ledger's job
// lifecycle. The correlation, resolution and same-pass jobId race guard are
// scripts/lib/dispatch-reconcile.js's since BRO-2542 — including the
// Number.isFinite(ts) filter and the "check only the IMMUTABLE pre-pass
// entries" rule, whose postmortems live in that file's header. Applied here to
// this module's own ledger file; what stays below is only this module's own
// per-tracker completion criterion and note text.
function reconcileDigestOutcomes(digestLedgerEntries, tasksById, dispatchLedgerEntries, now = new Date()) {
  const decisions = dispatchReconcile.classifyDispatches({
    ledgerEntries: digestLedgerEntries,
    dispatchLedgerEntries,
    isDispatchRow: e => e.event === 'auto-dispatch',
    resolvingEvents: RESOLVING_EVENTS,
    orphanTimeoutH: ORPHAN_TIMEOUT_H,
    cardIdOf: d => String(d.taskId),
    taskIdOf: d => String(d.taskId),
    now,
  });
  const newEntries = [];
  for (const { dispatch: d, cardId, job, kind } of decisions) {
    if (kind === dispatchReconcile.DECISION_KINDS.ORPHAN) {
      newEntries.push({
      // ts (BRO-3868 regression fix, 2026-09-20): stamp the outcome at the
      // moment it is DECIDED, not only when a copy of it is serialized to
      // disk. These rows are handed straight to attempt-memory's checkPark
      // in memory (ledgerEntries.concat(newOutcomes)), and BRO-3868's new
      // finite-ts guard drops any row it cannot place chronologically — so
      // an unstamped row silently vanished from the very fail-streak it was
      // created to record, and nothing ever parked. Verified: the park
      // end-to-end test went red on main the moment that guard landed.
      // appendLedger's own `{ ts: <now>, ...entry }` spread preserves this
      // value, so the persisted ts now equals the in-memory one.
      ts: now.toISOString(),
        // usd: 0 (BRO-3412) — no job ever spawned, so no cost was incurred.
        // Mirrors scripts/backlog-drain.js's reconcileOutcomes ORPHAN branch.
        event: 'card-fail', cardId, contentHash: d.contentHash, judgedDispatchTs: d.ts, usd: 0,
        // BRO-2518: fileCard()'s exact-title dedup can reattach a row to an
        // issue a PRIOR dispatch already moved to a started Linear state (In
        // Progress/In Review) — linear-next.js's startedStateGuard refuses
        // that cleanly (correctly: it's the guard closing exactly this class
        // of stray double-dispatch), so it belongs in this likely-cause list.
        note: `spawn never observed within ${ORPHAN_TIMEOUT_H}h of dispatch (likely refused: runner disabled, live cmux duplicate, already-started issue, or lease already held)`,
      });
      continue;
    }
    if (kind === dispatchReconcile.DECISION_KINDS.RETRY_TIMEOUT) {
      // The retry chain ended at 'job-retried' and no successor spawned inside
      // the orphan bound: the resume child died before spawning, so it fails.
      newEntries.push({
      // ts (BRO-3868 regression fix, 2026-09-20): stamp the outcome at the
      // moment it is DECIDED, not only when a copy of it is serialized to
      // disk. These rows are handed straight to attempt-memory's checkPark
      // in memory (ledgerEntries.concat(newOutcomes)), and BRO-3868's new
      // finite-ts guard drops any row it cannot place chronologically — so
      // an unstamped row silently vanished from the very fail-streak it was
      // created to record, and nothing ever parked. Verified: the park
      // end-to-end test went red on main the moment that guard landed.
      // appendLedger's own `{ ts: <now>, ...entry }` spread preserves this
      // value, so the persisted ts now equals the in-memory one.
      ts: now.toISOString(),
        // usd (BRO-3412): the timed-out attempt's own cost, same field
        // backlog-drain.js's RETRY_TIMEOUT branch records.
        event: 'card-fail', cardId, contentHash: d.contentHash, judgedDispatchTs: d.ts, usd: Number(job.costUSD) || 0,
        note: `resume recorded (job ${job.jobId}) but no successor session spawned within ${ORPHAN_TIMEOUT_H}h`,
      });
      continue;
    }
    // Explicit, not fall-through (ship-check finding) — see the same guard in
    // scripts/backlog-drain.js's reconcileOutcomes: a new `kind` from the
    // shared lib must stop the pass rather than be silently treated as
    // terminal and dereference a job that may be null.
    if (kind !== dispatchReconcile.DECISION_KINDS.TERMINAL) throw new Error(`reconcileDigestOutcomes: unhandled dispatch kind '${kind}'`);
    const sessionOk = job.event === dispatchLedger.JOB_EVENTS.DONE;
    const isLinear = /^linear:/.test(String(d.taskId));
    // Completion criterion differs by tracker (BRO-286): Notion-mirror rows
    // check the mirror task's status; Linear rows have no mirror — session
    // DONE is the pass signal here, and the board-level Done audit (Phase 3
    // teeth) is the independent check that the issue actually closed.
    const task = isLinear ? null : tasksById.get(cardId);
    const completed = isLinear ? sessionOk : !!(task && task.status === 'completed');
    const outcome = (sessionOk && completed) ? 'card-pass' : 'card-fail';
    // KNOWN LIMITATION surfaced by BRO-3412 (Codex adversarial review): for
    // Linear-tracked rows, `completed` above is just `sessionOk` — the
    // session exited cleanly, NOT that the issue actually closed (the board
    // Done-audit checks that separately, later, out-of-band). Before this
    // card, a false 'card-pass' here only under-parked a chronically-failing
    // row (attempt-memory noise). Now it ALSO counts as a `completions`
    // credit for computeSpendCircuitBreaker (autonomous-budget.js:294) — so a
    // session that exits cleanly without resolving anything can mask real
    // ongoing spend from OTHER dispatches and keep the breaker from
    // tripping. Tightening this (e.g. requiring the board Done-audit before
    // crediting a completion) is a real fix but a deeper, owner-scoped
    // change to shared completion semantics that attempt-memory/park also
    // depends on — out of scope for BRO-3412's "wiring, not new thresholds"
    // mandate. Tracked as a follow-up: BRO-3445.
    newEntries.push({
      // ts (BRO-3868 regression fix, 2026-09-20): stamp the outcome at the
      // moment it is DECIDED, not only when a copy of it is serialized to
      // disk. These rows are handed straight to attempt-memory's checkPark
      // in memory (ledgerEntries.concat(newOutcomes)), and BRO-3868's new
      // finite-ts guard drops any row it cannot place chronologically — so
      // an unstamped row silently vanished from the very fail-streak it was
      // created to record, and nothing ever parked. Verified: the park
      // end-to-end test went red on main the moment that guard landed.
      // appendLedger's own `{ ts: <now>, ...entry }` spread preserves this
      // value, so the persisted ts now equals the in-memory one.
      ts: now.toISOString(),
      event: outcome,
      cardId,
      // usd (BRO-3412): what this dispatch actually cost, so
      // computeSpendCircuitBreaker (called from runAutofix below) has
      // something to sum — this module's own ledger never recorded cost
      // before. Same field backlog-drain.js's TERMINAL branch records.
      contentHash: d.contentHash, judgedDispatchTs: d.ts, usd: Number(job.costUSD) || 0,
      note: outcome === 'card-pass'
        ? (isLinear ? 'session finished (Linear-tracked; board Done-audit verifies closure separately)' : 'session finished, task marked completed')
        : (sessionOk ? 'session finished but task still not completed' : `job ${job.event}${job.stage ? `: ${job.stage}` : ''}`),
    });
  }
  return newEntries;
}

/**
 * File missing cards, refresh the task list, dispatch up to `cap`.
 * Mutates each plan row's state to one of:
 *   'in-progress' | 'dispatched' | 'queued' | 'card-filed' | 'card-failed'
 *   | 'acknowledged' | 'decision' (left untouched — no card, no dispatch)
 *   | 'parked' (dispatch skipped — failed twice unchanged, see attempt-memory)
 * and returns the same array (annotated) for the email renderer.
 */
function runAutofix({
  plan, cap = DISPATCH_CAP, dryRun = false, log = () => {}, loadTasksFn = null,
  ledgerPath = DIGEST_LEDGER_PATH, dispatchLedgerEntriesFn = null, now = new Date(),
  dispatchFn = dispatchDetached,
  // BRO-3412: shared defaults imported from scripts/backlog-drain.js
  // (DEFAULT_CONCURRENCY_CAP=2, DEFAULT_SPEND_THRESHOLD_USD=12) rather than
  // re-declared here. BRO-3438: the DEFAULT stays 2 so backlog-drain.js's own
  // drain is untouched — the morning digest opts into a higher ceiling by
  // PASSING concurrencyCap (send-morning-digest.js's DIGEST_CONCURRENCY_CAP),
  // because per-dispatcher throughput policy belongs to the dispatcher, not to
  // this shared library (second-opinion design finding, 2026-09-20).
  concurrencyCap = DEFAULT_CONCURRENCY_CAP,
  spendThresholdUSD = DEFAULT_SPEND_THRESHOLD_USD,
} = {}) {
  if (!Array.isArray(plan) || !plan.length) return [];
  if (dryRun) {
    // Never file cards or spawn sessions on --dry-run — but show what WOULD
    // happen so the preview is honest about the new behavior. Does NOT model
    // the spend/concurrency guards below (BRO-3412): dry-run was already an
    // approximation (no real fileCard/dispatch calls either), so it can show
    // up to this ceiling simulated dispatches even where a live run would cap
    // lower (jobs already alive) or halt entirely on a tripped breaker.
    //
    // BRO-3438: the ceiling is min(cap, concurrencyCap), not `cap`. A live run
    // can never exceed concurrency headroom, so a dry-run that ignores the
    // concurrency cap entirely overstates the preview by exactly the gap
    // between the two numbers — harmless while they were 3 and 2, misleading
    // the moment a caller raises one without the other.
    for (const row of plan) if (row.state === 'needs-card') row.state = 'card-filed';
    let budget = Math.max(0, Math.min(cap, concurrencyCap));
    for (const row of plan) if (row.state === 'queued' && budget > 0) { row.state = 'dispatched'; budget--; }
    return plan;
  }

  // 1. File missing trackers (dedup already done in planAutofix). BRO-286:
  //    fileCard files a LINEAR issue and returns its identifier, which is
  //    threaded straight onto the row as `linear:BRO-N` — no task-mirror
  //    sync/resolution step exists for these rows (the old notion-brain →
  //    syncTasks → matchOpenTask dance applied only to Notion cards). The
  //    "## Acceptance criteria" backticked command in buildCardNotes keeps
  //    the issue dispatchable through linear-next's verify gate, same
  //    contract the Notion verify gate had (#480).
  for (const row of plan) {
    if (row.state !== 'needs-card') continue;
    // BRO-3427: a folded row's affected-show list can change day to day
    // while the (now-unconditional) condition-only title stays the same —
    // refresh the reattached card's acceptance criteria via comment so a
    // membership change is never silently invisible. See fileCard's own
    // comment for why this is scoped to folded rows only.
    const filed = fileCard(row.title, buildCardNotes(row), { log, refreshNotesOnReattach: Array.isArray(row.affected) });
    if (filed.ok) {
      row.state = 'card-filed';
      row.taskId = `linear:${filed.identifier}`;
      row.linearIdentifier = filed.identifier;
      // Overrides planAutofix's plan-time guess with the REAL answer (BRO-232
      // S4): fileCard's live exact-title Linear lookup is the only place that
      // actually knows whether this row's family was already tracked —
      // including a sibling-prefix row from THIS SAME run that filed a fresh
      // issue a moment earlier (e.g. "Cron failed: X" then "Workflow
      // repeat-failure: X" both reattaching to one issue). `existing` is only
      // set true on a dedup hit, so a brand-new issue correctly stays "new".
      row.wasNew = !filed.existing;
    } else {
      row.state = 'card-failed';
      row.wasNew = true;
    }
  }

  // 3. Re-resolve task ids. Rows whose card just got filed pick up their
  //    fresh task id here.
  let tasks = [];
  try {
    if (loadTasksFn) tasks = loadTasksFn();
    else {
      // loadTasks REQUIRES the shared task directory — calling it bare returns
      // [] silently (readdirSync(undefined) is swallowed), which killed both
      // dedup and dispatch on the first live run (Codex finding, 2026-08-02).
      const bn = require('../bsc-next.js');
      tasks = bn.loadTasks(bn.TASKS_DIR);
    }
  } catch { /* dispatch skipped below */ }
  const tasksById = new Map(tasks.map(t => [String(t.id), t]));

  // 4. Attempt-memory: reconcile prior dispatches from THIS module's own
  //    ledger, then compute a park check per row before spending dispatch
  //    budget on it. Fail-soft throughout — a broken ledger degrades to "no
  //    park state known", never blocks the digest.
  let digestLedgerEntries = [];
  try {
    digestLedgerEntries = readJsonlLedger(ledgerPath);
    const dispatchEntries = dispatchLedgerEntriesFn ? dispatchLedgerEntriesFn() : dispatchLedger.readEntries();
    const newOutcomes = reconcileDigestOutcomes(digestLedgerEntries, tasksById, dispatchEntries, now);
    for (const o of newOutcomes) {
      appendJsonlLedger(ledgerPath, o);
      log(`[digest-autofix] attempt-memory: #${o.cardId} ${o.event} (${o.note})`);
    }
    if (newOutcomes.length) digestLedgerEntries = digestLedgerEntries.concat(newOutcomes);
  } catch (err) {
    log(`[digest-autofix] WARN attempt-memory reconcile failed (park checks skipped this run): ${String(err.message).slice(0, 120)}`);
  }

  // 4.5. Spend circuit breaker + concurrency ceiling (BRO-3412) — same
  // primitives and the same evaluate-before-spend-budget order as
  // scripts/backlog-drain.js:468-471. Deliberately fails CLOSED (zero
  // budget) if this computation itself throws, unlike the attempt-memory
  // reconcile above (which fails open/soft): a broken park check only risks
  // one redundant dispatch, but a broken spend/concurrency guard failing
  // OPEN would silently remove the money/fleet-storm protection this card
  // exists to add (same "a spend breaker that under-counts fails OPEN, the
  // one direction a money guard must never fail" doctrine as
  // scripts/lib/backlog-drain.js's own computeSpendCircuitBreaker header).
  // Scoped to taskIds THIS module dispatched (digestDispatchedTaskIds), same
  // as backlog-drain.js scopes to its own drainDispatchedTaskIds and
  // dispatch-watchdog-core.js scopes to its own claimed taskIds — each
  // engine's ceiling is independent, not a shared cross-drain budget (that
  // would be new infrastructure, out of scope for this wiring-only card).
  //
  // KNOWN LIMITATIONS (BRO-3412 post-ship review, tracked as BRO-3453, owner
  // triage): this is a SNAPSHOT read, not a reservation — two overlapping
  // runAutofix invocations could both see the same headroom. Rows are also
  // only excluded by plan state ('in-progress'), not by concurrency.
  // aliveTaskIds the way scripts/backlog-drain.js:497-500 excludes its own
  // live candidates — a stale pending task could re-dispatch while its own
  // prior job is still alive (downstream dispatch-time guards likely refuse
  // the duplicate, but this budget slot still gets consumed reporting
  // "dispatched"). Neither is new: both are properties of this module's
  // existing fire-and-forget dispatch architecture, now inherited by a
  // stricter consumer than attempt-memory ever needed.
  //
  // Deliberately does its OWN independent reads (readJsonlLedgerStrict /
  // readSharedDispatchLedgerStrict, or the injected dispatchLedgerEntriesFn
  // called fresh) rather than reusing step 4's `digestLedgerEntries` /
  // `dispatchEntries` — two Codex adversarial-review findings, both fixed by
  // this:
  //   1. reconcileDigestOutcomes' newOutcomes carry no `ts` of their own
  //      (appendJsonlLedger stamps it only in the copy serialized to disk),
  //      and computeSpendCircuitBreaker's 24h window drops any entry with no
  //      `ts` — so reusing step 4's in-memory `digestLedgerEntries.concat(
  //      newOutcomes)` would make dollars just reconciled THIS run invisible
  //      to the breaker for the rest of THIS run. Re-reading from disk after
  //      the writes picks up the real `ts`. Same read-after-write shape
  //      scripts/backlog-drain.js:463 already uses for the identical reason.
  //   2. step 4's reads are fail-soft by design (readJsonlLedger/
  //      dispatchLedger.readEntries swallow every fs error into [], and step
  //      4's own try/catch swallows a throwing injected reader too) — reusing
  //      their result here would mean the guard's fail-closed catch below
  //      never actually fires on the failure mode most likely to happen (a
  //      corrupt/inaccessible ledger). The strict readers throw on anything
  //      but ENOENT, so a genuine read failure reaches THIS try/catch.
  let concurrency = { atCap: true, alive: null, cap: concurrencyCap, aliveTaskIds: [] };
  let breaker = { halt: true, reason: 'guard computation failed — failing closed, no dispatch this run', spentUSD: null, completions: null, thresholdUSD: spendThresholdUSD };
  try {
    const freshDigestLedgerEntries = readJsonlLedgerStrict(ledgerPath);
    const freshDispatchLedgerEntries = dispatchLedgerEntriesFn ? dispatchLedgerEntriesFn() : readSharedDispatchLedgerStrict();
    // Freshen the outer digestLedgerEntries too (only on success) so the
    // dispatch loop's checkPark/priorAttempts below also see this run's own
    // just-reconciled rows, not the stale pre-reconcile snapshot.
    digestLedgerEntries = freshDigestLedgerEntries;
    const digestDispatchedTaskIds = new Set(
      digestLedgerEntries.filter(e => e && e.event === 'auto-dispatch').map(e => String(e.taskId)));
    concurrency = computeConcurrency(digestDispatchedTaskIds, freshDispatchLedgerEntries, concurrencyCap);
    breaker = computeSpendCircuitBreaker(digestLedgerEntries, { thresholdUSD: spendThresholdUSD });
  } catch (err) {
    log(`[digest-autofix] WARN spend/concurrency guard computation failed (failing CLOSED — no dispatch this run): ${String(err.message).slice(0, 120)}`);
  }
  if (concurrency.atCap) {
    log(`[digest-autofix] concurrency cap reached (${concurrency.alive}/${concurrencyCap} digest jobs alive: ${(concurrency.aliveTaskIds || []).join(', ')}) — dispatch budget reduced this run`);
  }
  if (breaker.halt) {
    log(`[digest-autofix] ${breaker.reason}`);
  }

  // 5. Dispatch the first `cap` queued rows, bounded by remaining
  //    concurrency headroom and halted entirely by the spend breaker.
  //    BRO-3438: the caller now picks concurrencyCap (send-morning-digest.js
  //    passes DIGEST_CONCURRENCY_CAP=3, raised from the shared default of 2 on
  //    owner approval 2026-09-15). DISPATCH_CAP (3) and that cap are equal on
  //    purpose — an idle morning dispatches 3, and neither number is a dead
  //    constant that silently caps the other. Raising throughput further is a
  //    machine-pressure decision (swap, not disk — see the card), not a digit.
  //
  //    concurrency.alive is null on the guard-computation-failure path above.
  //    `concurrencyCap - null` evaluates to concurrencyCap (a FULL budget), so
  //    the only thing standing between a failed guard and an unbounded run is
  //    breaker.halt happening to be true in the same catch. Fail closed here
  //    explicitly instead of relying on that coincidence (second-opinion
  //    blocker, 2026-09-20): a non-finite alive count means "assume no
  //    headroom", which floors the budget at 0.
  const aliveForBudget = Number.isFinite(concurrency.alive) ? concurrency.alive : concurrencyCap;
  let budget = breaker.halt ? 0 : Math.min(cap, Math.max(0, concurrencyCap - aliveForBudget));
  // The stagger below is "how many have I dispatched so far", which is
  // (starting budget - remaining budget). It used to read (cap - budget), which
  // is only the same thing while budget STARTS at cap — i.e. only while
  // concurrencyCap >= cap. The moment concurrency headroom binds (2 alive jobs,
  // say), every dispatch in the run inherits a phantom offset: at cap=3 with
  // budget starting at 1, the first dispatch would sleep 90s instead of 45s.
  const startBudget = budget;
  for (const row of plan) {
    if (row.state === 'in-progress' || row.state === 'card-failed' || row.state === 'acknowledged' || row.state === 'decision') continue;
    if (!row.taskId) {
      const t = matchOpenTask(tasks, row.name);
      if (t) row.taskId = t.id;
    }
    if (!row.taskId) continue; // sync lag — the drain picks it up on its next tick

    // Hash the canonical family title ALONE (BRO-232 S4) — row.message stays
    // per-variant raw text (different prefixes describing the same condition
    // carry different detail text), so folding it in here would defeat the
    // whole point of collapsing family variants onto one taskId: two
    // variants would still diverge in contentHash and reset each other's
    // attempt-memory/park state. title is already family-collapsed (see
    // planAutofix) and stable run over run for the same condition — the same
    // stability assumption fileCard's own exact-title dedup already relies on.
    // BRO-3427: this ALSO means a folded row's contentHash never reflects
    // WHICH shows are in row.affected — two consecutive failures on
    // completely disjoint show sets (day 1: A/B/C fail; day 3, A/B/C fixed
    // elsewhere, D/E/F newly broken) still park as "the same content",
    // blocking D/E/F from a fresh attempt. That's the same title-only-hash
    // policy this module already shipped for prefix-collapsed conditions
    // (BRO-232 S4, comment above) — accepted here rather than widened,
    // deliberately: hashing in the affected-show set would make ANY
    // day-to-day membership drift reset the failure streak, which defeats
    // park's actual purpose (catching a remediation that is structurally
    // broken, not show-specific). A condition that's genuinely parked this
    // way is visible in the digest email ("kept failing the same way —
    // parked, needs a manual look") — a human looking at the card's comment
    // history (see fileCard's refreshNotesOnReattach) sees which shows are
    // CURRENTLY affected and can unpark by hand if the new shows warrant it.
    const contentHash = computeContentHash({ name: row.title });
    const park = checkPark(digestLedgerEntries, String(row.taskId), contentHash);
    if (park.parked) {
      row.state = 'parked';
      row.parkReason = park.reason;
      continue;
    }

    if (budget <= 0) { row.state = 'queued'; continue; }
    // Attempt N = how many times this exact content has already been
    // dispatched by this module (regardless of outcome) + this attempt.
    const priorAttempts = digestLedgerEntries.filter(e =>
      e.event === 'auto-dispatch' && String(e.taskId) === String(row.taskId) && e.contentHash === contentHash).length;
    const attempt = priorAttempts + 1;
    const model = row.model || (attempt >= 2 ? 'opus' : null);
    try {
      // allowAutofixFiled (BRO-2499): every row dispatched here is an issue
      // THIS module filed moments ago (fileCard, above), so it is exactly the
      // population autofixFiledIssueGuard refuses — waived at the one call
      // site that legitimately owns it.
      // allowAutomationParked (BRO-3060): fileCard's --park also means every
      // one of these rows carries PARKED_SENTINEL — a second, independent
      // guard from autofixFiledIssueGuard. Without this every dispatch here
      // was spawned only to be refused inside the detached child.
      dispatchFn(row.taskId, log, (startBudget - budget) * 45, model, { allowAutofixFiled: true, allowAutomationParked: true });
      row.state = 'dispatched';
      row.attempt = attempt;
      if (model) row.model = model;
      budget--;
      try {
        appendJsonlLedger(ledgerPath, { event: 'auto-dispatch', taskId: String(row.taskId), contentHash });
      } catch (err) {
        log(`[digest-autofix] WARN attempt-memory ledger write failed for #${row.taskId} (park tracking degraded): ${String(err.message).slice(0, 120)}`);
      }
    } catch (err) {
      row.state = 'queued';
      log(`[digest-autofix] WARN dispatch spawn failed for #${row.taskId}: ${String(err.message).slice(0, 120)}`);
    }
  }
  return plan;
}

module.exports = {
  planAutofix, runAutofix, matchOpenTask, buildCardNotes, isRowAcknowledged, DISPATCH_CAP,
  DIGEST_LEDGER_PATH, reconcileDigestOutcomes, isDispatchResolved, findMyJob, readJsonlLedger, appendJsonlLedger,
  fileCard, syncTasks, dispatchDetached, familyDisplayName, rowFamilyKey,
  splitOnShowSuffix, MAX_FOLD_PER_CONDITION,
};
