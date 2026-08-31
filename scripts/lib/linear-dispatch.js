/**
 * linear-dispatch.js — pure decision logic + GraphQL query/mutation TEXT for
 * scripts/linear-next.js (task #1303, BRO-266 Linear transition). This is the
 * Linear-issue counterpart of bsc-next.js's inline buildSeed()/priorityRank()/
 * routing logic, kept in its own scripts/lib/ file (not copied into
 * linear-next.js or linear-client.js) so both the CLI and its tests
 * require() the exact same code (CLAUDE.md rule 15).
 *
 * No I/O, no fetch — scripts/lib/linear-client.js is the only place that
 * actually talks to Linear's GraphQL endpoint (CI-gated by
 * scripts/audit-linear-issuecreate-chokepoint.js); this file only builds the
 * query/mutation TEXT that client sends and the pure decisions linear-next.js
 * makes around it (priority sort, mac-only routing override, the seed
 * prompt).
 */

'use strict';

const crypto = require('crypto');
const { buildAutoTitle } = require('./workspace-naming');
// Idempotency helpers (hasLiveLedgerEntry below) reuse dispatch-ledger.js's
// own pure predicates (latestAttemptForTask/isLatestDispatchDead/JOB_EVENTS)
// rather than re-deriving "is the most recent attempt for this task still
// live" a second way — entries/taskId are passed in by the caller
// (linear-next.js does the actual readEntries() I/O), so this file performs
// no ledger I/O itself.
const dispatchLedger = require('./dispatch-ledger.js');
const { TERMINAL_STATE_TYPES, isTerminalStateType } = require('./linear-state-types.js');
// BRO-2499: autofixFiledIssueGuard below recognises issues the digest-autofix
// / canary pipeline filed and dispatches itself. Leaf module, no I/O — see
// its header for why the signal lives there and not in this file.
const { isAutofixFiledIssue, hasAutofixFiledMarker } = require('./autofix-filed-marker.js');
// BRO-2543 - reportedOutcomeGuard's two "already reported back" signals plus
// the acceptance-command parse it quotes. All three are leaf modules
// (linear-session-reporting.js has zero require()s of its own), so requiring
// them here introduces no cycle.
const { parseSessionReportStatus } = require('./linear-session-reporting.js');
const { extractPrRef } = require('./linear-pr-evidence.js');
const { evaluateVerifiability } = require('./verify-gate.js');

// v1 machine-bound routing (see decideRouting below): an issue carrying this
// label always forces a local cmux tab, whatever --headless/--tab flag was
// passed. No Cyrus/queue routing yet — deliberately out of scope for #1303.
const MAC_ONLY_LABEL = 'mac-only';

// ── GraphQL query/mutation TEXT (pure — returns a string, no network) ──────

// Fetches everything linear-next.js needs to seed a dispatch: title,
// description (the card body), state (to know what "In Progress"/"In
// Review" resolve to isn't needed here — linear-client.js's listOpenIssues
// return the team's state list separately via getTeam()), priority, labels
// (for the mac-only routing check), url (quoted in the seed), comments
// (not currently rendered into the seed, but fetched so a future version can
// show prior context without a second round trip), and project (BRO-2488 —
// marketingProjectGuard below needs issue.project.name to refuse a
// Marketing/distribution-project issue; nothing fetched it before). Only
// `name`, not `id`: this codebase's other project-identity checks
// (ARCHIVE_PROJECT in linear-import.js, TEAM_KEY in linear-client.js) are
// already plain name/key string literals resolved at call time, not cached
// ids — matching that convention here means a project rename is fixed by
// updating one string in one place (marketingProjectGuard's
// MARKETING_PROJECT_NAMES) rather than also re-deriving a UUID.
function buildIssueQuery() {
  return `query($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      priority
      url
      state { id name type }
      project { name }
      labels(first: 20) { nodes { id name } }
      comments(first: 50, orderBy: createdAt) { nodes { id body createdAt user { name } } }
    }
  }`;
}

// Open (non-completed, non-canceled) issues for one team, newest-updated
// first — priority ORDER is a caller-side pure sort (sortIssuesByPriority
// below), not baked into the query, so the same fetch can serve both
// --list's priority view and any future recency view without refetching.
//
// linear-next.js's --list is a deliberate v1 choice: a LIVE fetch every
// invocation, not a notion-tasks-sync-style local mirror (~/.claude/tasks/)
// that bsc-next.js's --list reads from. At the current backlog size (~100
// open BRO issues, first:100 above covers it in one request with no
// pagination) a live round trip costs nothing meaningful and is trivially
// correct — no mirror to go stale, no sync cron to keep alive, no drift
// between "what --list shows" and "what's actually on the board". Paginated
// ($after cursor + pageInfo, consumed by linear-client.js's cursor loop) so
// crossing 100 open issues degrades to extra round trips, never silent
// truncation. Revisit the live-fetch choice itself only if a caller needs
// --list fast enough to run in a tight loop (a live GraphQL round trip every
// call does not scale to that).
// labels(first: 20): matches buildIssueQuery's cap above — an issue with
// more labels than that silently drops the extras from mac-only routing and
// (BRO-282) the awaiting-owner digest check. Realistic label counts on this
// board are 1-3; this is a cheap ceiling raise, not a guarantee for
// pathological cases (ship-check finding, BRO-282).
function buildOpenIssuesQuery() {
  return `query($teamKey: String!, $after: String) {
    issues(
      first: 100
      after: $after
      filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } } }
      orderBy: updatedAt
    ) {
      nodes {
        identifier
        title
        priority
        url
        updatedAt
        state { name type }
        labels(first: 20) { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

// "Dispatched to <ref> at <ts>" comment (see buildDispatchComment) posted
// through this mutation — the one write linear-next.js performs besides the
// state transition (which reuses linear-client.js's existing generic
// updateIssue(), no new mutation text needed).
function buildCommentMutation() {
  return `mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
    }
  }`;
}

// ── priority ────────────────────────────────────────────────────────────
// Linear's raw priority ints: 0 = No priority, 1 = Urgent, 2 = High,
// 3 = Medium, 4 = Low. A bare ascending sort on the raw int would put every
// untriaged ("No priority") issue AHEAD of every Urgent one — priorityRank
// remaps 0/missing to rank 5 (last) so "top of --list" means "most urgent",
// matching Linear's own UI priority sort.
function priorityRank(issue) {
  const p = Number(issue && issue.priority);
  if (!Number.isFinite(p) || p <= 0) return 5;
  return p;
}

const PRIORITY_LABELS = { 0: 'None', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
function priorityLabel(issue) {
  const p = Number(issue && issue.priority);
  return PRIORITY_LABELS[p] || 'None';
}

// Stable sort (Array.prototype.sort is stable per spec since Node 11) so
// same-priority issues keep the server's orderBy (updatedAt) as the tiebreak.
function sortIssuesByPriority(issues) {
  return [...(issues || [])].sort((a, b) => priorityRank(a) - priorityRank(b));
}

// ── labels / machine-bound routing (v1) ────────────────────────────────────

function issueLabelNames(issue) {
  return ((issue && issue.labels && issue.labels.nodes) || [])
    .map((l) => String((l && l.name) || '').toLowerCase())
    .filter(Boolean);
}

function hasMacOnlyLabel(issue) {
  return issueLabelNames(issue).includes(MAC_ONLY_LABEL);
}

/**
 * v1 machine-bound routing hook. A single hard override, not a policy
 * engine: an issue labeled 'mac-only' (GUI-dependent scraper, keychain,
 * physical-device work — anything that genuinely needs the operator's own
 * Mac) always routes to a local cmux tab, regardless of what --headless/--tab
 * flag the caller passed. Everything else defers entirely to the caller's
 * flag. No Cyrus/queue routing — that's explicitly out of scope for #1303.
 *
 * @param {object} issue - the fetched Linear issue (needs .labels.nodes)
 * @param {object} opts
 * @param {boolean} [opts.headless] - true when --headless was passed (and
 *   not overridden by --tab — the caller resolves that precedence before
 *   calling this)
 * @returns {{mode: 'tab'|'headless', reason: string}}
 */
function decideRouting(issue, { headless = false } = {}) {
  if (hasMacOnlyLabel(issue)) {
    return { mode: 'tab', reason: `label '${MAC_ONLY_LABEL}' forces a local cmux tab` };
  }
  return headless
    ? { mode: 'headless', reason: '--headless flag' }
    : { mode: 'tab', reason: 'default (no --headless)' };
}

// ── seed prompt ─────────────────────────────────────────────────────────

/**
 * The context a dispatched worker gets — the Linear counterpart of
 * bsc-next.js's buildSeed(). Deliberately tells the session to report back
 * ON THE ISSUE ITSELF (comment + state transition), not just to the ledger —
 * that's what makes progress visible on the Linear board to anyone who isn't
 * grepping the local dispatch ledger.
 */
function buildLinearSeed({ identifier, title, description, url, model, project, mode }) {
  return [
    `[${identifier}] ${title} —`,
    ``,
    `Work on this Linear issue as this session's focus. Implement it per CLAUDE.md rules — worktree before any code edit, /ship-check before you claim it's done.`,
    ``,
    `ISSUE: ${identifier} — ${title}`,
    url ? `Linear: ${url}` : null,
    mode ? `Dispatch mode: ${mode}` : null,
    ``,
    description || '(no description)',
    ``,
    project
      ? `This workspace is named "${buildAutoTitle({ subject: `${identifier} ${title}`, project, model })}" — the 🤖 marks it as auto-dispatched, "${project}" is its project bucket.`
      : null,
    ``,
    `When you are done (or blocked), report the outcome by running: node scripts/linear-session.js report --issue=${identifier} --status=<done|in-review|paused|blocked> --summary="..." [--key-files="a,b"] [--verification="..."]. That posts the comment AND moves the issue's state in one step, in the one format the dispatcher can recognise later — reportedOutcomeGuard reads it to stop a second worker being dispatched onto work you already finished (BRO-2543), so a hand-rolled commentCreate is not equivalent. Do not leave it silently sitting in "In Progress" with no comment — that is how work goes untracked. If you cannot finish, report --status=blocked with what is blocking it; that deliberately leaves the state as-is rather than guessing at "In Review", and keeps the issue re-dispatchable.`,
    ``,
    `Start by confirming your understanding and a short plan, then proceed.`,
  ].filter((v) => v !== null).join('\n');
}

// "Dispatched <correlationId> to <ref> at <ts> (<mode>)" — posted on the
// issue itself (via linear-client.js's createComment) at dispatch time so
// double-dispatch is visible on the Linear board, not just in the local
// dispatch ledger. correlationId ties this comment back to the exact ledger
// entry the same dispatch wrote (see hasLiveLedgerEntry/
// findUnresolvedDispatchComment below — the two independent idempotency
// signals a retry cross-checks against). Optional so existing callers that
// pass none still get a readable comment.
function buildDispatchComment({ ref, ts, mode, correlationId }) {
  const corr = correlationId ? ` ${correlationId}` : '';
  return `Dispatched${corr} to ${ref} at ${ts}${mode ? ` (${mode})` : ''}`;
}

// Short opaque id embedded in both the ledger 'launch' entry and the Linear
// comment for one dispatch attempt, so a human (or a future audit script)
// can find "the ledger row this exact comment came from" without fuzzy-
// matching on timestamps. Not a security token — collision cost is a
// slightly confusing cross-reference, not a guessable secret, so 4 bytes is
// plenty.
function generateCorrelationId() {
  return crypto.randomBytes(4).toString('hex');
}

// ── idempotency (task #1303 plan review item 4) ────────────────────────────
//
// Two INDEPENDENT signals that "this issue already looks dispatched",
// checked before every launch attempt so a retry (this host, a different
// host, or a different invocation after the local ledger was lost/rotated)
// reconciles instead of double-launching:
//   1. findUnresolvedDispatchComment — reads the issue's OWN comment thread
//      (fetched alongside the issue, no extra round trip). Cross-machine by
//      construction: the comment lives on Linear's server, not this host.
//   2. hasLiveLedgerEntry — reads the LOCAL dispatch-ledger.jsonl. Cheap and
//      fast, but host-local (a different machine's ledger won't see it) —
//      exactly why (1) exists as a second, independent check.

// The newest "Dispatched ..." comment on a thread, by createdAt — ignoring
// workflow state entirely (findUnresolvedDispatchComment below layers the
// state precondition on top; reportedOutcomeGuard wants the raw "when was
// this issue last sent to a worker" fact regardless).
//
// BRO-2543: this used to be inlined in findUnresolvedDispatchComment as
// `dispatched[dispatched.length - 1]` with the comment "most-recent comment
// wins (last-in-array), matching this codebase's lastByRef/foldJobs 'last
// record wins' convention". That reasoning does not transfer: lastByRef folds
// an APPEND-ONLY ledger this repo writes itself, where array order IS time
// order. These comments come off Linear's API, whose `comments` connection
// has no orderBy here and so returns its default — updatedAt DESCENDING.
// Verified live against BRO-2506's own thread while closing this issue: the
// nodes came back 03:18, 02:18, 02:15, 01:31, 00:43, i.e. last-in-array was
// the OLDEST dispatch comment, the exact opposite of what the comment
// claimed. Harmless where it stood (the caller only prints the body), but
// reportedOutcomeGuard compares timestamps against it, so it is fixed here
// rather than worked around with a second, differently-wrong ordering rule
// next to it.
//
// `>=` (not `>`) so that when timestamps are absent or tied the LAST array
// entry still wins, preserving the old behaviour exactly for fixtures and
// legacy payloads that carry no createdAt.
function newestDispatchComment(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let best = null;
  for (const c of list) {
    if (!c || !/^Dispatched\b/.test(String(c.body || '').trim())) continue;
    if (!best || String(c.createdAt || '') >= String(best.createdAt || '')) best = c;
  }
  return best;
}

// An issue already moved to a terminal workflow-state type (completed/
// canceled) has resolved whatever a prior "Dispatched ..." comment was
// about, one way or another — a stale comment on a now-closed issue is not
// evidence of a LIVE dispatch.
function findUnresolvedDispatchComment(issue) {
  const stateType = issue && issue.state && issue.state.type;
  if (isTerminalStateType(stateType)) return null;
  const comments = (issue && issue.comments && issue.comments.nodes) || [];
  return newestDispatchComment(comments);
}

// The most recent dispatch-ledger attempt for this task exists and is
// neither dead/unverified (dispatch-ledger's own isLatestDispatchDead) nor a
// TERMINAL success (a finished headless job, JOB_EVENTS.DONE — done means
// resolved, not "still live"). Anything else (a verified cmux 'launch', an
// in-flight 'job-spawned') counts as live.
function hasLiveLedgerEntry(taskId, entries) {
  const list = entries || [];
  const latest = dispatchLedger.latestAttemptForTask(taskId, list);
  if (!latest) return false;
  if (dispatchLedger.isLatestDispatchDead(taskId, list)) return false;
  if (latest.event === dispatchLedger.JOB_EVENTS.DONE) return false;
  return true;
}

// Terminal-state guard (task #1517, BRO-247 incident root cause): a
// re-dispatch of an issue Linear itself already considers resolved
// (completed/canceled) is never correct — the incident this closes was
// exactly that (a Done, archived issue got re-dispatched and only failed at
// the createComment/updateIssue step with a cryptic "Entity not found"
// error, task #1510's unarchive-and-retry symptom fix). buildIssueQuery
// already fetches `state { id name type }` on every getIssue() call; this is
// the first caller that reads it. Returns a refusal string (caller decides
// how to report it) or null when dispatch may proceed — same "pure
// predicate, caller does I/O/exit" shape as the other guards in this file.
function checkTerminalStateGuard(issue) {
  const stateType = issue && issue.state && issue.state.type;
  if (!isTerminalStateType(stateType)) return null;
  const stateName = (issue.state && issue.state.name) || stateType;
  return `${issue.identifier} is already in a terminal state ("${stateName}") — refusing to re-dispatch. Re-run with --force if this is a deliberate re-open.`;
}

// Marketing-project guard (BRO-2488): the dispatch funnel has always been
// DOCUMENTED as "Backlog/Todo, not `· Marketing`, not BSC Daily/CANARY"
// (crown-loop handoff notes, ~/Documents/claude-outputs/p1-dispatcher-
// handoff-*.md) but was never enforced in code — it relied on a human/LLM
// eyeballing each issue's description every cycle. That failed live: BRO-128
// (Linear project "Marketing/distribution" — a Reddit post, external-facing
// copy) dispatched cleanly through `linear-next.js --id BRO-128 --headless`
// with zero refusal, and was only caught after the fact by a BRO-343
// crown-loop session manually un-dispatching it (see BRO-128's own comment
// thread: "Un-dispatched by the BRO-343 crown loop. This is a Marketing /
// owner-judgment card... and was sent to an autonomous coding worker by
// mistake").
//
// Root cause: no query this dispatcher used ever fetched the issue's
// `project` relation (buildIssueQuery above omitted it) — so `issue.project`
// was always undefined, and no predicate keyed on it could ever refuse
// anything. Fixed by fetching `project { name }` there and gating on it here.
//
// Lives here, next to checkTerminalStateGuard, NOT in dispatch-guards.js's
// GUARD_NAMES family (second-opinion review, BRO-2488): every guard in that
// array is simulated across the whole Notion-mirror + Linear backlog by
// predispatch-queue-audit.js's runGuard() dispatch, which only ever builds a
// task-shaped `{id, subject, description}` object — a Notion-mirror task has
// no `.project`, so a project-relation guard added there would report 100%
// "error" forever (dispatch-guard-queue-audit.js's own header explains why
// dispatchClaimGuard is deliberately excluded from GUARD_NAMES for the same
// reason: not every guard here is safe to blind-simulate). checkTerminalStateGuard
// is the existing precedent for an issue-shaped, Linear-only guard living in
// this file instead — this one follows it.
//
// Keyed on the Linear project RELATION (issue.project.name), not the
// `· Marketing` text that happens to survive in an imported issue's
// description (linear-import.js carries the Notion mirror's trailing
// category segment over verbatim, same convention autonomous-eligibility.js
// parses on the Notion side) — the project relation is set on every issue in
// this workstream regardless of whether it went through the Notion import
// path, so it's the more durable, structural signal. "Marketing/distribution"
// is the literal project name linear-import.js's ensureProjects() creates
// from linear-import-rules.js's PROJECT_RULES (name: 'Marketing/distribution'
// — that file is the source of truth for the literal string); bare
// "marketing" is matched too in case a project is ever renamed or created by
// hand.
//
// No `--id` bypass (divergence from autonomous-eligibility.js's Notion-side
// isCardEligible, which explicitly lets `--id`/`--pick` through human-
// territory categories): linear-next.js has no separate auto-pick layer the
// way bsc-next.js does — every dispatch, automated or not, goes through
// `--id` — so gating on `--id` alone would gate nothing. `--force` is the
// only override, matching checkTerminalStateGuard's own bypass just above.
const MARKETING_PROJECT_NAMES = new Set(['marketing/distribution', 'marketing']);

function marketingProjectGuard(issue, opts) {
  const o = opts || {};
  if (o.force || o['dry-run'] || o['print-prompt']) return null;
  const name = issue && issue.project && issue.project.name;
  if (!name || !MARKETING_PROJECT_NAMES.has(String(name).trim().toLowerCase())) return null;
  return `${(issue && issue.identifier) || '(unknown)'} is in Linear project "${name}" — refusing to dispatch. ` +
    `Marketing/distribution is owner-judgment territory (external-facing copy: Reddit posts, journalist pitches, ` +
    `donor/broadcast email), not safe for unattended dispatch. Re-run with --force if the owner has reviewed and ` +
    `approved this specific card.`;
}

// Auto-filed-pipeline guard (BRO-2499): the OTHER half of the same
// documented funnel line marketingProjectGuard above closes — "Backlog/Todo,
// not `· Marketing`, not BSC Daily/CANARY". Found by the /what-else pass on
// BRO-2488: nothing in this dispatcher's chain ever looked at either signal.
//
// This one is NOT a blanket refusal, and that distinction is load-bearing.
// scripts/lib/digest-autofix.js files "BSC Daily: <row>" issues and
// scripts/lib/autofix-canary.js files the "CANARY: touch <marker>" card, and
// BOTH then dispatch their own issue through this exact CLI
// (digest-autofix.js's dispatchDetached → `linear-next.js --id BRO-N
// --headless`, no --force). Refusing on the title alone would have disabled
// the daily autofix drain and the daily end-to-end canary — the only live
// proof the dispatch pipeline still works. What the documented line actually
// excludes is CANDIDATE SELECTION: a crown-loop or human sweeping the
// backlog must not pick one of these up, because the pipeline that filed it
// already owns it and is mid-flight on it.
//
// So: refuse by default; each owning pipeline passes `--allow-autofix-filed`
// explicitly at its own call site (NOT blanket-applied inside
// dispatchDetached — second-opinion review, BRO-2499: that would hand every
// present and future caller of that helper a silent bypass it never asked
// for). Three call sites own a slice of this population today:
// digest-autofix.js's runAutofix, autofix-canary.js, and
// scripts/linear-drain-parked.js — that third one was missed on the first
// pass and caught by the BRO-2499 ship-check: health-check.js:3951 routes
// actionable rows through owner-alert-router under the SAME "BSC Daily:"
// title, so this guard refuses that drain's candidates too, and it records
// "attempted" whether or not the detached child was refused.
// `--force`/`--dry-run`/`--print-prompt` bypass too, matching
// marketingProjectGuard's own exemptions directly above.
//
// Lives here next to marketingProjectGuard for the same reason that one
// does: it is issue-shaped and Linear-only. It is deliberately NOT added to
// dispatch-guards.js's GUARD_NAMES — those are blind-simulated across the
// Notion-mirror backlog by predispatch-queue-audit.js, and a Notion-mirror
// task never carries the `PARKED: ...` description prefix
// linear-issue-create.js:141 writes, so half this guard's signal is
// structurally absent there and the simulated refusal rate would be
// meaningless.
function autofixFiledIssueGuard(issue, opts) {
  const o = opts || {};
  if (o.force || o['dry-run'] || o['print-prompt'] || o['allow-autofix-filed']) return null;
  if (!isAutofixFiledIssue(issue)) return null;
  // Name the RIGHT owner (code-review finding): two different pipelines file
  // into this population, and telling an operator to check the wrong one
  // sends them to the wrong log. digest-autofix's own trackers carry its
  // PARKED marker; an alert-router tracker (health-check.js:3951, same
  // "BSC Daily:" title, different marker) is owned by linear-drain-parked.js.
  const owner = hasAutofixFiledMarker(issue && issue.description)
    ? { pipeline: 'the digest-autofix / canary pipeline', dispatcher: "scripts/lib/digest-autofix.js's runAutofix", check: 'no autofix dispatch is in flight for it' }
    : { pipeline: 'an automated filer (owner-alert-router, via health-check)', dispatcher: 'scripts/linear-drain-parked.js', check: 'that drain is not about to pick it up' };
  return `${(issue && issue.identifier) || '(unknown)'} was auto-filed by ${owner.pipeline} ` +
    `("${(issue && issue.title) || ''}") — refusing to dispatch. ${owner.dispatcher} dispatches this issue ` +
    `itself, so a backlog sweep picking it up either duplicates a live dispatch or burns a session "fixing" a ` +
    `rolling health snapshot. Re-run with --force if you have checked that ${owner.check}.`;
}

// Started-state guard (BRO-2518): the THIRD clause of the same documented
// funnel line marketingProjectGuard/autofixFiledIssueGuard above close —
// "Backlog/Todo, not `· Marketing`, not BSC Daily/CANARY". "Backlog/Todo"
// was never enforced either: checkTerminalStateGuard only refuses TERMINAL
// state types (completed/canceled/duplicate); nothing refused an issue
// already in a STARTED type (In Progress / In Review). Found by the
// /what-else pass on BRO-2499, same way BRO-2499 itself was found closing
// BRO-2488. Against the live snapshot at filing time: 238 of 807 open
// issues were started-type and freely dispatchable.
//
// The existing idempotency guards (findUnresolvedDispatchComment,
// hasLiveLedgerEntry, checked later in linear-next.js) do NOT cover the
// gap: both need a positive signal (a "Dispatched ..." comment, or a local
// ledger row) that a dispatch actually recorded. An issue moved to In
// Progress by a human, by another machine, or by a session whose
// reportDispatchOnIssue() comment-post step failed (best-effort,
// logs-and-continues — see linear-next.js's reportDispatchOnIssue) carries
// NEITHER signal, especially cross-machine (the ledger is host-local) — so
// it dispatches cleanly on top of live work today.
//
// Deliberately a blanket "started ⇒ refuse unless --force" rather than
// "started AND no live signal ⇒ refuse": the population this guard needs to
// stop is exactly issues a human/other-machine already has hands on, and a
// same-pipeline retry (state started WITH a live signal) is already refused
// by the idempotency checks below regardless — this guard firing first for
// that overlapping case changes only which message prints, not the outcome.
// --force is the deliberate escape hatch for the legitimate "this stalled,
// re-dispatch it" operation (dispatch-ledger data at filing time: ~14% of
// tracked tasks carry more than one 'launch' entry, i.e. genuine re-dispatch
// is a normal, not rare, event) — matching checkTerminalStateGuard's own
// --force-only exemption, not autofixFiledIssueGuard's per-caller opt-in
// flag: no machine caller here legitimately WANTS to re-dispatch an
// already-started issue without a human deciding to force it — but one CAN
// still hit this refusal in normal operation (ship-check finding, BRO-2518):
// digest-autofix.js's fileCard() dedups by exact-title match against LIVE
// Linear state (not the local task mirror) — a reattach hit can land on an
// issue a PRIOR dispatch already moved to a started state (cross-host, or a
// stalled prior attempt), and runAutofix's dispatch-loop skip-list
// ('in-progress'/'card-failed'/'acknowledged'/'decision') does not include
// the 'card-filed' state a reattached row carries, so it reaches dispatchFn
// same as a freshly-filed row would. That is this guard doing its job, not a
// bug: refusing IS the correct outcome (prevents a stray double-dispatch
// onto still-active work), and digest-autofix's own attempt-memory
// (reconcileDigestOutcomes' orphan-timeout branch, digest-autofix.js) scores
// the un-spawned attempt 'card-fail' and eventually parks a row that keeps
// hitting this — no bypass flag needed, unlike autofixFiledIssueGuard, whose
// refused population (its OWN freshly-filed tracker) has no other path to
// resolution. autofix-canary.js's "existingTask" sync-lag branch is a
// separate, narrower check (matches the legacy Notion-mirror task list,
// which has no sync path for Linear-filed issues, so it never even reaches a
// live started Linear issue this way) — unaffected. linear-drain-parked.js
// (selectDrainCandidates filters to PARKED_STATE_TYPES = backlog/unstarted
// only) never selects a started issue in the first place.
function startedStateGuard(issue, opts) {
  const o = opts || {};
  if (o.force || o['dry-run'] || o['print-prompt']) return null;
  const stateType = issue && issue.state && issue.state.type;
  if (stateType !== 'started') return null;
  const stateName = (issue.state && issue.state.name) || stateType;
  return `${(issue && issue.identifier) || '(unknown)'} is already in a started state ("${stateName}") — refusing to ` +
    `dispatch. It may have been picked up by a human, another machine, or a session whose dispatch comment failed to ` +
    `post — check it (comment thread, cmux/workspace list) before re-dispatching. Re-run with --force if you know this ` +
    `is a stalled issue that needs re-dispatch.`;
}

// -- reportedOutcomeGuard (BRO-2543) ----------------------------------------
//
// The incident: BRO-2506's worker committed its fix to origin/main at
// 00:53Z, posted a `**Session report (in-review)**` comment at 01:31Z, and
// the issue sat in In Review. At 02:15Z a crown-loop dead-session recovery
// ran `linear-next.js --id BRO-2506 --model opus --force` and a SECOND
// worker opened on it, re-did the discovery, found the fix already merged
// and closed with "duplicate dispatch - no new code needed". A whole
// dispatch, wasted.
//
// startedStateGuard above ALREADY refuses this issue - verified live against
// the real BRO-2506: `startedStateGuard(issue, {})` returns its refusal
// string. The bypass was `--force`, whose very first line clears it. And the
// crown loop was not being reckless: the local ledger carried a `dead` row
// for that worker's workspace:138, so "the session died, re-dispatch it" was
// the correct read of everything it could see. (That `dead` row was itself
// wrong - written at 00:55:32Z, 36 minutes BEFORE the same worker posted its
// session report at 01:31Z. Tracked separately; this guard is the
// defense-in-depth that holds even when the liveness signal lies, which is
// exactly why it must not key on the ledger.)
//
// So the defect is not that --force exists. --force is the right and
// necessary escape hatch for a genuinely stalled issue, and re-dispatch is a
// normal operation (~14% of tracked tasks carry more than one launch). The
// defect is that ONE boolean clears every started-state signal at once,
// including the one signal that does not mean "a human has hands on this"
// but "the work is already done" - and no amount of care at the call site
// recovers a signal the flag has already erased. Hence a separate predicate
// with its own narrow bypass, rather than a fourth clause inside
// startedStateGuard. That follows closedCardGuard's precedent in
// dispatch-guards.js (see its header): a guard whose refused population has
// a legitimate escape gets its own flag, not a share of --force.
//
// Two independent "this dispatch already reported back" signals, either
// sufficient, both already present on the payload buildIssueQuery fetches
// (zero extra round trips, zero I/O - this stays a pure predicate):
//
//   1. A session report of status `done` or `in-review`, parsed via
//      linear-session-reporting.js's own parseSessionReportStatus (rule 15:
//      the writer's format is required, never re-derived here).
//      DELIBERATELY NOT `paused`/`blocked`: planCompletion() leaves a blocked
//      issue's state untouched, so a blocked worker's report sits on an issue
//      still in a started type - and re-dispatching THAT is precisely the
//      crown loop's job. Refusing on any-report-at-all would have broken the
//      case this escape hatch exists for.
//   2. A `PR-EVIDENCE:` marker (linear-pr-evidence.js), which CLAUDE.md section 6
//      already requires to close an issue. This covers the worker that
//      commits and dies before it can report - and, more importantly, the
//      worker that reports in its own words: buildLinearSeed instructs
//      workers to comment via raw `commentCreate`, so the canonical
//      `**Session report` prefix is produced only when the machine-local
//      `linear-issue-required-stop.sh` Stop hook forces linear-session.js.
//      That hook does not exist on cloud sessions and never fires for a
//      worker killed at its runner timeout. The seed has been pointed at
//      `linear-session.js report` as part of this fix so signal 1 becomes
//      structural rather than hook-dependent, but signal 2 covers the
//      workers already in flight under the old seed.
//
// "Reported AFTER the outstanding dispatch, not merely somewhere in the
// thread's history" is the load-bearing part, and it is this repo's own
// hard-won rule: dispatch-reconcile.js's header states it outright - "a
// dispatch is resolved by an outcome recorded AT OR AFTER it, never by 'this
// identifier has an outcome somewhere in history'" - and
// dispatch-dead-launch-guard.js reaches the same conclusion independently.
// Without it, an issue re-dispatched after a REAL death would stay refused
// forever on the strength of its previous run's report.
//
// Lives here next to startedStateGuard, NOT in dispatch-guards.js's
// GUARD_NAMES family, for the reason that file's header already documents
// for checkTerminalStateGuard and marketingProjectGuard:
// predispatch-queue-audit.js blind-simulates every GUARD_NAMES guard against
// Notion-shaped `{id, subject, description}` tasks, which have no
// `.comments` - a comment-relation guard added there would report 100%
// "error" forever.
const RESOLVED_REPORT_STATUSES = new Set(['done', 'in-review']);

// The bypass takes a REASON, not a bare boolean - linear-session.js's own
// done-gate established that shape for waiving a "did the work actually
// happen" check, and it is the right one here: the population this refuses is
// an operator (increasingly an LLM operator) who just reached for --force and
// is about to reach for whatever flag the refusal names. Making them type a
// reason turns a reflex into a claim, and the reason is journaled onto the
// ledger launch row so a dispatch that only happened because the guard was
// waived stays auditable after the fact.
const REPORTED_WORK_BYPASS_FLAG = 'allow-reported-work';
const REPORTED_WORK_BYPASS_MIN_REASON = 10;

// Is `flagValue` a usable bypass reason? A bare `--allow-reported-work` (which
// parseArgs yields as boolean true) is NOT - that is the reflex this guard
// exists to interrupt.
function isValidBypassReason(flagValue) {
  return typeof flagValue === 'string' && flagValue.trim().length >= REPORTED_WORK_BYPASS_MIN_REASON;
}

// buildDispatchComment ends its body with " (<mode>)" — 'cmux' or 'headless'.
function dispatchCommentMode(comment) {
  const m = String((comment && comment.body) || '').trim().match(/\(([a-z-]+)\)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// The timestamp a resolved-outcome comment must beat to count as answering
// `dispatch`.
//
// For a cmux dispatch this is simply the dispatch comment's own createdAt:
// linear-next.js posts it immediately after launchCmux() returns, before the
// worker has done anything, so the comment really does mark the start of that
// dispatch.
//
// The headless path does NOT work that way, and reading it as if it did was a
// live bug in the first cut of this guard (caught by the pre-ship adversarial
// review). There, `await runJob(...)` runs the ENTIRE worker to completion and
// reportDispatchOnIssue() only runs afterwards, past an `if (!res.ok) return`
// — so a headless "Dispatched ..." comment is written at the END of a job that
// SUCCEEDED, and the worker's own session report is necessarily OLDER than it.
// Using its createdAt as the floor would discard exactly the report the guard
// exists to notice, silently, on every headless dispatch.
//
// So for headless, the window that dispatch actually occupied began no later
// than the PREVIOUS dispatch comment; use that instead. With no previous one,
// there is no lower bound to apply and any resolved report on the thread
// counts — which is right: a headless dispatch comment is itself proof that
// that job ran to completion, so it is not an outstanding dispatch awaiting an
// answer.
function dispatchFloor(dispatch, comments) {
  if (dispatchCommentMode(dispatch) !== 'headless') return dispatch.createdAt;
  const ts = String(dispatch.createdAt || '');
  let prev = null;
  for (const c of (Array.isArray(comments) ? comments : [])) {
    if (!c || c === dispatch) continue;
    if (!/^Dispatched\b/.test(String(c.body || '').trim())) continue;
    const cts = String(c.createdAt || '');
    if (!(cts < ts)) continue;
    if (!prev || cts >= String(prev.createdAt || '')) prev = c;
  }
  return prev ? prev.createdAt : '';
}

// The newest comment strictly after `sinceTs` that carries a resolved-outcome
// signal, or null. `sinceTs` of '' means "anything counts" (no dispatch
// comment on the thread at all).
//
// A comment with no createdAt can never clear `> sinceTs` and so never
// refuses: absent ordering information, this fails OPEN, matching every other
// guard in this file rather than blocking a dispatch on a payload it cannot
// actually order.
function findResolvedOutcomeComment(comments, sinceTs) {
  const list = Array.isArray(comments) ? comments : [];
  const since = String(sinceTs || '');
  let best = null;
  for (const c of list) {
    if (!c) continue;
    const ts = String(c.createdAt || '');
    if (!(ts > since)) continue;
    const body = String(c.body || '');
    const status = parseSessionReportStatus(body);
    const signal = RESOLVED_REPORT_STATUSES.has(status)
      ? `session report (${status})`
      : (extractPrRef(body) ? 'PR-EVIDENCE marker' : null);
    if (!signal) continue;
    if (!best || ts >= String(best.comment.createdAt || '')) best = { comment: c, signal };
  }
  return best;
}

function reportedOutcomeGuard(issue, opts) {
  const o = opts || {};
  // Rollback story (adversarial review): every other way out of this guard is
  // per-dispatch, so without this a guard that started refusing wrongly at 2am
  // could only be escaped by pasting the bypass onto every single dispatch, or
  // by reverting and redeploying. LINEAR_NEXT_DISABLED is not the answer -- it
  // is checked AFTER this guard and disables the whole dispatcher rather than
  // one predicate. An env var (not a flag) deliberately: it is set once by a
  // human fixing an incident, not reached for mid-prompt by an operator who
  // just read a refusal.
  if (process.env.REPORTED_OUTCOME_GUARD_DISABLED === '1') return null;
  // --dry-run/--print-prompt launch nothing, so there is nothing to refuse.
  // NOTE the absence of `o.force` here - that omission IS this guard.
  if (o['dry-run'] || o['print-prompt']) return null;
  if (isValidBypassReason(o[REPORTED_WORK_BYPASS_FLAG])) return null;

  const stateType = issue && issue.state && issue.state.type;
  if (stateType !== 'started') return null;

  const comments = (issue && issue.comments && issue.comments.nodes) || [];
  const dispatch = newestDispatchComment(comments);
  // No dispatch comment at all means there is no identified outstanding
  // dispatch for a report to be answering, and nothing to order against.
  // Fail OPEN rather than treating every historical outcome on the thread as
  // grounds to refuse — on a long thread the relevant dispatch comment can
  // also simply have fallen outside the fetched window, and a confident
  // refusal built on a truncated view is worse than no refusal at all.
  if (!dispatch) return null;
  const found = findResolvedOutcomeComment(comments, dispatchFloor(dispatch, comments));
  if (!found) return null;

  const identifier = (issue && issue.identifier) || '(unknown)';
  const stateName = (issue.state && issue.state.name) || stateType;
  const bareFlag = o[REPORTED_WORK_BYPASS_FLAG] !== undefined && !isValidBypassReason(o[REPORTED_WORK_BYPASS_FLAG])
    ? ` (--${REPORTED_WORK_BYPASS_FLAG} was passed without a reason of at least ${REPORTED_WORK_BYPASS_MIN_REASON} characters, so it did not apply)`
    : '';

  // Name the issue's own acceptance command in the refusal. "Read the report
  // before re-dispatching" is advice an operator skips; a pasteable command
  // is one it runs, and running it is the cheapest possible answer to "did
  // this actually land". evaluateVerifiability is the same parse
  // linear-next.js already applies to this description further down, so the
  // command quoted here is exactly the one the dispatch would have armed.
  let verifyLine = '';
  try {
    const gate = evaluateVerifiability((issue && issue.description) || '');
    if (gate && gate.cmd) verifyLine = `\n  Check whether it landed first:  ${gate.cmd}`;
  } catch { /* a description this can't parse must never break dispatch */ }

  return `${identifier} is in a started state ("${stateName}") and its most recent dispatch has ALREADY reported back - `
    + `${found.signal} at ${found.comment.createdAt}, after the dispatch comment at ${dispatch ? dispatch.createdAt : '(none)'}. `
    + `Refusing to re-dispatch${bareFlag}: a dead/stalled WORKSPACE is not the same as work that did not land, and this is `
    + `what a wasted duplicate dispatch looks like before it happens (BRO-2506).`
    + verifyLine
    // Name the WHOLE recovery command, not just this guard's own flag.
    // startedStateGuard still refuses a started-type issue and still wants
    // --force, so an operator given only half the invocation bounces off a
    // second refusal and learns the wrong lesson ("these guards are noise").
    + `\n  If it genuinely did not land, re-run with:  --force --${REPORTED_WORK_BYPASS_FLAG} "<reason, at least ${REPORTED_WORK_BYPASS_MIN_REASON} chars>"`
    + `\n  --force alone does NOT bypass this one, deliberately: it is what turned BRO-2506 into a wasted dispatch.`;
}

// Rail 2 (Phase 0 parallel-run safety, plan 2026-08-12, task #1341): the
// alert router's cross-system dedupe needs `description` on top of what
// buildOpenIssuesQuery() above fetches — kept as its own query (not an added
// field on the shared one) so a --list regression can never be caused by a
// change that only rail 2 needed, and vice versa. Paginated ($after +
// pageInfo) like buildOpenIssuesQuery: the workspace already holds 200+
// issues, so a single first:100 page would silently miss dedupe matches —
// exactly the double-file this query exists to prevent.
//
// Deliberately NOT given `project` (BRO-2488, ship-check adversarial review):
// this query also backs owner-alert-router.js's cross-system dedupe
// (searchIssues) — an unused field here is pure blast radius on a second
// consumer for no benefit, since nothing reads `.project` off this candidate
// list today. The actual enforcement point is buildIssueQuery() above, which
// marketingProjectGuard reads at real dispatch time; if a future funnel needs
// to pre-filter Marketing issues out of this candidate list before ever
// calling `--id`, add the field there when that caller exists, not before.
function buildOpenIssuesWithDescriptionsQuery() {
  return `query($teamKey: String!, $after: String) {
    issues(
      first: 100
      after: $after
      filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } } }
    ) {
      nodes {
        identifier
        title
        description
        url
        state { name type }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

// Pure match for linear-client.js's searchIssues(): does any OPEN issue's
// title or description already contain this literal term (the alert's
// conditionKey)? owner-alert-router.js's dispatchCard() embeds the raw
// conditionKey in every card/issue it files — in the "## Acceptance
// criteria" line (`Condition "<key>" no longer fires...`) that has always
// been there, and now also in a dedicated `[conditionKey:<key>]` marker (see
// buildCardNotes) — so a plain substring check catches both the historical
// and the new form without needing to special-case either. First match wins,
// same "first match is enough" contract as findUnresolvedDispatchComment
// above. Client-side (not a Linear-side `contains` filter) so this never
// depends on the exact shape of Linear's filter DSL doing the right thing
// for a body-text search.
function findOpenIssueForTerm(issues, term) {
  if (!term || !Array.isArray(issues)) return null;
  for (const issue of issues) {
    if (!issue) continue;
    if (issue.title && issue.title.includes(term)) return issue;
    if (issue.description && issue.description.includes(term)) return issue;
  }
  return null;
}

module.exports = {
  MAC_ONLY_LABEL,
  buildIssueQuery,
  buildOpenIssuesQuery,
  buildOpenIssuesWithDescriptionsQuery,
  findOpenIssueForTerm,
  buildCommentMutation,
  priorityRank,
  priorityLabel,
  sortIssuesByPriority,
  issueLabelNames,
  hasMacOnlyLabel,
  decideRouting,
  checkTerminalStateGuard,
  marketingProjectGuard,
  autofixFiledIssueGuard,
  startedStateGuard,
  reportedOutcomeGuard,
  newestDispatchComment,
  dispatchCommentMode,
  dispatchFloor,
  findResolvedOutcomeComment,
  RESOLVED_REPORT_STATUSES,
  REPORTED_WORK_BYPASS_FLAG,
  REPORTED_WORK_BYPASS_MIN_REASON,
  MARKETING_PROJECT_NAMES,
  buildLinearSeed,
  buildDispatchComment,
  generateCorrelationId,
  findUnresolvedDispatchComment,
  hasLiveLedgerEntry,
};
