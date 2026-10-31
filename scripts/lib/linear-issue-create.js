/**
 * linear-issue-create.js — the single chokepoint for filing a NEW Linear
 * issue. Everything else that touches Linear issue creation should go
 * through this, the way scripts/lib/owner-alert-router.js's dispatchCard()
 * is the one chokepoint all 85 alert call sites route through.
 *
 * Why this exists: on 2026-08-12 a session filed 8 Linear issues
 * (BRO-274..282) with a throwaway hand-rolled `issueCreate` GraphQL call in a
 * scratch script, and zero were dispatched — nothing enforced a decision
 * because there was no shared entry point to enforce it AT. A helper nobody
 * is forced to use changes nothing, so scripts/audit-linear-issuecreate-
 * chokepoint.js CI-gates any `issueCreate`/api.linear.app call outside this
 * file (and scripts/lib/linear-client.js itself).
 *
 * Scoped narrowly to issue CREATION with the required dispatch/park
 * disposition (card #1310). BRO-375 (Phase 1) repointed routeAlert()'s
 * dispatchCard() at Linear via this file: dispatchCard() now calls
 * createLinearIssue() in-process instead of shelling out to the
 * linear-brain.js CLI, and the actual `issueCreate` mutation below runs
 * through `scripts/lib/linear.js`'s injectable LinearClient (BRO-374) rather
 * than linear-client.js's raw createIssue — that's the seam that lets
 * owner-alert-router.test.mjs assert a routed alert reaches Linear with a
 * stubbed client and zero network calls. The client is built with
 * linear-client.js's `graphql()` as its executor (NOT linear.js's own
 * createLinearClient(), which is a bare fetch with no retry) — this keeps
 * the 429-rate-limit backoff + mutation-vs-read retry policy
 * (linear-retry-policy.js) that every other Linear write in this repo gets,
 * while still building the mutation text through linear.js's LinearClient.
 * Team/state lookup (getTeam) also stays on linear-client.js, so both reads
 * and the create share one transport instead of two divergent ones.
 */

'use strict';

const linear = require('./linear-client');
const { LinearClient } = require('./linear');
const { resolveDisposition } = require('./card-disposition');
const { checkIntake, recordCreated, ENFORCE } = require('./intake-breaker');
const { TITLE_PRIORITY_TIER_RE } = require('./linear-watchdog-source');
const { stampModelHint } = require('./bsc-next-model');
const cardDedupe = require('./card-dedupe');

const USAGE_LIMIT_MESSAGE =
  'Linear issue creation refused: USAGE_LIMIT_EXCEEDED — the workspace is at (or near) the ' +
  'free-tier 250-issue cap. This is a hard failure, not a warning: archive/close stale issues ' +
  'before filing more (BRO-10 tracks the plan decision).';

function isUsageLimitExceeded(err) {
  if (Array.isArray(err && err.linearErrors)) {
    if (err.linearErrors.some((e) => e && e.extensions && e.extensions.code === 'USAGE_LIMIT_EXCEEDED')) {
      return true;
    }
  }
  return /USAGE_LIMIT_EXCEEDED|usage limit/i.test(String((err && err.message) || ''));
}

// Picks a team workflow state for the given disposition mode. `states` is
// Linear's own {id,name,type} list (type ∈ backlog/unstarted/started/
// completed/canceled) — we never invent our own status vocabulary here.
//   'park'     → a state that does NOT read as active work (backlog, or
//                unstarted as a fallback if the team has no backlog state).
//   'dispatch' → 'unstarted' (Todo), not 'started': nothing is actually
//                running yet at issue-creation time (bsc-next.js cannot
//                resolve a Linear issue id yet — task #1303, in flight
//                separately, is building that). Marking it 'started' here
//                would itself be a new silent-third-state wearing a
//                different label.
function pickStateForMode(states, mode) {
  // getTeam() returns the raw GraphQL connection shape ({ nodes: [...] }),
  // not a bare array — normalize both so this works with either. Shipped
  // broken (states.find is not a function) on every create until 2026-08-12.
  const list = Array.isArray(states) ? states : (states && states.nodes) || [];
  const byType = (type) => list.find((s) => s && s.type === type);
  if (mode === 'park') {
    // A team may carry several backlog-type states (Backlog plus a "Paused"
    // state, BRO-2857). New parked cards belong in plain Backlog, so match
    // that name first and only then fall back to any backlog-type state,
    // preferring one that is not Paused.
    const byName = (n) => list.find((s) => s && String(s.name).toLowerCase() === n);
    const state = byName('backlog')
      || list.find((s) => s && s.type === 'backlog' && String(s.name).toLowerCase() !== 'paused')
      || byType('backlog')
      || byType('unstarted');
    if (!state) {
      throw new Error(
        `linear-issue-create: no 'backlog' or 'unstarted' workflow state found on this team — cannot ` +
        `file a parked issue that doesn't read as in-progress. States seen: ${
          list.map((s) => `${s.name}(${s.type})`).join(', ') || '(none)'
        }`
      );
    }
    return state;
  }
  if (mode === 'self') {
    const started = list.find((s) => s && s.type === 'started' && String(s.name).toLowerCase() === 'in progress') || byType('started');
    if (!started) throw new Error(`linear-issue-create: no 'started' workflow state found on this team for --self. States seen: ${list.map((s) => `${s.name}(${s.type})`).join(', ') || '(none)'}`);
    return started;
  }
  const state = byType('unstarted');
  if (!state) {
    throw new Error(
      `linear-issue-create: no 'unstarted' workflow state found on this team for --dispatch. ` +
      `States seen: ${list.map((s) => `${s.name}(${s.type})`).join(', ') || '(none)'}`
    );
  }
  return state;
}

// BRO-4487: a PARKED issue is never filed as Urgent/High. CLAUDE.md's rule is
// "P0/P1 = dispatch at creation", and the dispatch-watchdog refuses anything
// carrying the PARKED: sentinel (headless-dispatchability.js), so a parked
// P0/P1 is a contradiction nothing will ever work. Measured 2026-10-01: of
// 907 open Urgent/High issues ~370 were machine-filed parked alerts
// (digest-autofix, owner-alert-router, date audits, UX walkthrough) plus
// session cards parked at P1, and the pile grew ~18/day. Clamped to Medium
// here, at the one creation chokepoint, so every filer present and future
// gets it. A "P0:"/"P1:" title prefix counts too: with the priority field
// unset, linear-watchdog-source.js's priorityOf() falls back to the title,
// so an unset field must be pinned to Medium or the prefix re-promotes it.
const PARKED_MAX_PRIORITY = 3;
// Stamped into a clamped issue's description. Consumers that select on the
// filer's ORIGINAL High intent (friction-fix-eligibility.js) read it back.
const PARKED_CLAMP_MARKER = 'Priority: filed at Medium because it is parked.';

// Every new card gets a priority field (2026-10-11): 341 of 993 open cards had
// none, and the cloud worker picker (cloud-worker-pick.js skipReason) reads
// only the field, so a dispatched "P1: ..." card with it unset was invisible
// to the workers. An unset priority takes the title's P0-P3 prefix, else Medium.
const DEFAULT_CREATE_PRIORITY = 3;
const TIER_TO_LINEAR_PRIORITY = Object.freeze({ 0: 1, 1: 2, 2: 3, 3: 4 });

/** PURE. Linear priority (1-4) from a "P0:".."P3:" title prefix, or null. */
function priorityFromTitle(title) {
  const m = TITLE_PRIORITY_TIER_RE.exec(String(title || ''));
  return m ? TIER_TO_LINEAR_PRIORITY[m[1]] : null;
}

/**
 * PURE. The priority a new issue is actually filed at.
 *   - An explicit caller priority (1-4) wins; parked issues are capped at
 *     Medium (BRO-4487).
 *   - Unset (undefined/null/''/0, Linear's "No priority", or non-numeric)
 *     takes the title's P0-P3 prefix, else Medium. A parked P0:/P1: title is
 *     still clamped to Medium.
 * @returns {{priority: number, clamped: boolean}}
 */
function effectiveCreatePriority({ priority, mode, title }) {
  const n = priority === undefined || priority === null || priority === '' ? NaN : Number(priority);
  const explicitlyRanked = Number.isFinite(n) && n > 0;
  if (explicitlyRanked) {
    const urgentOrHigh = n === 1 || n === 2;
    if (mode === 'park' && urgentOrHigh) return { priority: PARKED_MAX_PRIORITY, clamped: true };
    return { priority: n, clamped: false };
  }
  const fromTitle = priorityFromTitle(title);
  if (fromTitle === null) return { priority: DEFAULT_CREATE_PRIORITY, clamped: false };
  if (mode === 'park' && fromTitle < PARKED_MAX_PRIORITY) return { priority: PARKED_MAX_PRIORITY, clamped: true };
  return { priority: fromTitle, clamped: false };
}

/**
 * @param {object} p
 * @param {string} p.title
 * @param {string} p.description
 * @param {boolean} [p.dispatch]
 * @param {string} [p.park] reason, required with park, >= MIN_PARK_REASON_LENGTH chars
 * @param {number} [p.priority] Linear priority 0-4
 * @param {string} [p.projectId]
 * @param {'opus'|'sonnet'} [p.model] the filer's model pick; stamped as a
 *   "Model: Opus|Sonnet" line that linear-next.js reads (bsc-next-model.js
 *   pickLinearModel). Invalid or conflicting values throw before any API call.
 * @param {{createIssue: Function}} [p.client] injected Linear client for the
 *   create mutation (linear.js's LinearClient shape) — tests pass a stub;
 *   production defaults to a LinearClient wired to linear-client.js's
 *   retry-aware graphql() (BRO-374/BRO-375).
 * @param {string} [p.source] who is filing ('session', 'workflow:<name>', ...).
 *   Title/body rules win over it (card-dedupe.js inferCardSource); recorded as
 *   a "Filed by:" footer on the new card (BRO-5488).
 *   Defaults to workflow:$GITHUB_WORKFLOW when running in Actions.
 * Repeats and floods (BRO-5488), ON for every caller: a parked filing whose
 *   title repeats an open card is noted there instead (mode 'reused'), and a
 *   flood of same-kind parked filings from one workflow goes onto one rollup
 *   card (mode 'rolled-up'). Two ways to skip them:
 * @param {string} [p.dedupeOptOut] a caller that groups its own filings,
 *   named in card-dedupe.js DEDUPE_OPT_OUTS (anything else throws).
 * @param {string} [p.newAnyway] one filing a person says is new work despite
 *   the match; the reason is kept on the card.
 * @returns {Promise<{issue: object, mode: 'dispatch'|'self'|'park'|'reused'|'rolled-up', stateName: string}>}
 */
// BRO-5626 step 6: a session card with no safe acceptance command is the vague
// card nobody can verify or pick. Advisory first (CLAUDE.md 19): measured
// 2026-10-18, 12 of 75 session cards filed in 7 days had none (a floor: some
// were armed later). LINEAR_CREATE_VERIFY_ENFORCE=1 refuses instead of warning.
const VERIFY_GATE_ENFORCE = process.env.LINEAR_CREATE_VERIFY_ENFORCE === '1';
const MISSING_VERIFY_MESSAGE = 'add a VERIFY: <safe command> or mark it as an owner/access card';

/**
 * PURE. Why a new card fails the front-door VERIFY rule, or null. Only session
 * cards are checked: workflow filers (digest-autofix, the alert router, CI-red)
 * write their own VERIFY. A park whose reason is a real owner, key, Mac or date
 * block is exempt, and so is an owner-judgment marker (evaluateVerifiability
 * counts it as armed). noVerify is the caller's logged --no-verify reason.
 */
function missingVerifyReason({ source, mode, parkReason, body, noVerify }) {
  if (source !== 'session' || noVerify) return null;
  const hd = require('./headless-dispatchability');
  if (mode === 'park' && !hd.isWorkerTakeableParkReason(parkReason)) return null;
  const v = require('./verify-gate.js').evaluateVerifiability(body || '', []);
  if (v.armed) return null;
  return `${MISSING_VERIFY_MESSAGE} (${v.reason || 'no acceptance command found'})`;
}

async function createLinearIssue({ title, description, dispatch, park, self, priority, projectId, model, client, reuseTwin = false, source, dedupeOptOut, newAnyway, noVerify, macOnly, child }) {
  if (dedupeOptOut !== undefined && !Object.prototype.hasOwnProperty.call(cardDedupe.DEDUPE_OPT_OUTS, dedupeOptOut)) {
    throw new Error(`createLinearIssue: dedupeOptOut "${dedupeOptOut}" is not in card-dedupe.js DEDUPE_OPT_OUTS; add it there with its reason, or drop it`);
  }
  const dedupe = !dedupeOptOut && !newAnyway;
  const disposition = resolveDisposition({ dispatch, park, self, child });
  if (!disposition.ok) {
    const err = new Error(disposition.message);
    err.dispositionReason = disposition.reason;
    throw err;
  }
  // BRO-6130: 'self' is a dispatch the filing session already holds: every dispatch rule below
  // (near-duplicate refusal, mac-only, START-NOW, VERIFY) applies, but it never reuses someone
  // else's card as a twin and it is created already started (In Progress).
  const mode = disposition.mode === 'self' ? 'dispatch' : disposition.mode;
  const selfFiled = disposition.mode === 'self';
  let body = model == null ? (description || '') : stampModelHint(description, model);
  // BRO-6080: a card only the Mac can do. Todo only (the Mac drain takes Todo
  // cards); the MAC-ONLY line goes first so every check below, and the cloud
  // picker, sees it even if the label write fails.
  if (macOnly !== undefined) {
    if (typeof macOnly !== 'string' || macOnly.trim().length < 10) {
      throw new Error('macOnly needs a reason of at least 10 characters (what needs the Mac and why)');
    }
    if (mode !== 'dispatch') {
      throw new Error('--mac-only files a Todo card for the Mac drain; use it with --dispatch, not --park');
    }
    body = `MAC-ONLY: ${macOnly.trim()}\n\n${body}`.trim();
    // The Mac drain only takes a card with a safe VERIFY, and the cloud skips it,
    // so without one the card would sit in Todo forever.
    if (!require('./verify-gate.js').evaluateVerifiability(body, []).cmd) {
      throw new Error('--mac-only needs a safe "VERIFY: <cmd>" line on its own line in the notes (the Mac drain takes nothing else, and the cloud worker skips mac-only cards). Nothing was filed.');
    }
  }

  // A START-NOW card the cloud worker would skip sits in Todo forever (BRO-5017).
  // Sessions-only path (reuseTwin, i.e. linear-brain.js create): the alert router
  // drops an alert whose create throws, and its free-text notes could quote a
  // START-NOW line. Fails open: a throw inside the check never blocks a create.
  let unpickable = null;
  if (reuseTwin) {
    try {
      const filedPriority = effectiveCreatePriority({ priority, mode, title }).priority;
      unpickable = require('./cloud-worker-pick.js').startNowUnpickableReason({ title, description: body, priority: filedPriority, mode });
    } catch (e) {
      console.warn(`[linear-issue-create] START-NOW pickability check failed open: ${e.message}`);
    }
  }
  if (unpickable) {
    const err = new Error(`START-NOW card would never be picked by the cloud worker (${unpickable.reason}): ${unpickable.hint}. Nothing was filed.`);
    err.startNowUnpickable = unpickable.reason;
    throw err;
  }

  // Storm breaker (flow audit 2026-08-12: real intake 34.3/day vs burn-down
  // 5.7/day, and NOTHING bounded creation anywhere). Sized above a normal day,
  // so this is inert in ordinary use and only stops a runaway filer. Checked
  // here because this is the one chokepoint every scripted filer goes through;
  // issues the owner files in the Linear app never reach this code and are
  // deliberately unaffected.
  // OBSERVE-ONLY: warns, never throws. Codex review established that a refusal
  // here makes owner-alert-router LOSE the alert outright — it catches the
  // failure, returns {ok:false}, and neither queues a digest row nor sends a
  // fallback (owner-alert-router.js:284-305, :535-561). Silently eating alerts is
  // worse than an over-long list. ENFORCE flips to true only once that drop path
  // has a fallback; see intake-breaker.js's header.
  const breaker = checkIntake();
  if (!breaker.allow) {
    console.warn(`[intake-breaker] ${breaker.reason}`);
    if (ENFORCE) {
      const err = new Error(breaker.reason);
      err.intakeBreaker = breaker;
      throw err;
    }
  }

  // Same title already open: note it on that card instead of filing a copy
  // (BRO-4956, 2026-10-10: 52 groups of open cards shared an exact title, 58
  // extra cards). Opt-in (linear-brain.js create, i.e. sessions and routines):
  // the alert router and digest-autofix have their own condition-keyed dedupe
  // and act on the returned card (dispatch markers, linear-next), so they must
  // always get the card they asked for. Fail open on lookup errors.
  // BRO-6080: never for a mac-only filing. A twin gets the notes as a comment,
  // which no picker reads, so it would keep no MAC-ONLY line; the dispatch-mode
  // near-duplicate check below still refuses an open match instead.
  if (reuseTwin && macOnly === undefined && !selfFiled) {
    const reused = await reuseOpenTwin({ title, body, client, mode });
    if (reused) return reused;
  }

  // BRO-5488: the near-duplicate and flood rules, on by default. Skipped for a
  // named opt-out (DEDUPE_OPT_OUTS), --new-anyway, and, as a guard if an
  // opt-out is ever forgotten, any body or park reason carrying a filer's
  // per-card contract marker. Both fail open.
  const cardSource = cardDedupe.inferCardSource({
    title, description: body,
    // BRO-6081: a filer that names itself only via dedupeOptOut (owner-alert-router,
    // auto-fix-first) used to read "Filed by: unknown" off GitHub Actions.
    source: source || (process.env.GITHUB_WORKFLOW ? `workflow:${process.env.GITHUB_WORKFLOW}` : dedupeOptOut || undefined),
  });
  const kind = cardDedupe.titleKind(title);
  // The contract marker can sit in the park reason (digest-autofix passes it
  // as --park, not in the notes), so check both, plus the inferred filer.
  const contractText = `${disposition.reason || ''}\n${body || ''}`;
  const contract = cardDedupe.hasPerCardContract(contractText)
    || ['digest-autofix', 'alert-router', 'e2e-canary'].includes(cardSource);
  // A --dispatch filing (a session's own card) is never swapped for another
  // card, but a near-match of an open card is refused so the session works on
  // that card or says why it is different (--new-anyway). Fails open.
  if (dedupe && !contract && mode === 'dispatch') {
    const open = await findNearDuplicateOpen({ title, client });
    if (open) {
      const err = new Error(`already open: ${open.card.identifier} ${open.card.title} [${(open.card.state && open.card.state.name) || 'open'}] (title match ${open.score.toFixed(2)}). Work on that card (node scripts/linear-session.js claim --issue=${open.card.identifier}), or if this is different work re-run with --new-anyway "<why>".`);
      err.code = 'NEAR_DUPLICATE_OPEN';
      err.twin = open.card;
      throw err;
    }
  }
  if (dedupe && !contract && mode === 'park') {
    const reused = await reuseNearDuplicate({ title, body, client, mode });
    if (reused) return reused;
  }
  if (dedupe && mode === 'park' && !contract && cardDedupe.rollupEnforced({ source: cardSource, description: contractText })) {
    const rolled = await rollUpFlood({ title, body, client, source: cardSource, kind });
    if (rolled) return rolled;
  }

  // BRO-5371: a card that waits on the owner must say so in a DECISION NEEDED line, the one thing that emails them.
  // Kill switch: OWNER_JUDGMENT_LIMBO_REFUSE=0.
  if (process.env.OWNER_JUDGMENT_LIMBO_REFUSE !== '0') {
    const limbo = require('./owner-judgment-limbo-guard').createLimboReason({ body, parkReason: mode === 'park' ? disposition.reason : '' });
    if (limbo) {
      const err = new Error(`Card refused: ${limbo} Nothing was filed.`);
      err.code = 'OWNER_JUDGMENT_LIMBO';
      throw err;
    }
  }

  const team = await linear.getTeam();
  let missingVerify = null;
  try {
    missingVerify = missingVerifyReason({ source: cardSource, mode, parkReason: disposition.reason, body, noVerify });
  } catch (e) {
    console.warn(`[linear-issue-create] VERIFY check failed open: ${e.message}`);
  }
  if (missingVerify && VERIFY_GATE_ENFORCE) {
    const err = new Error(`Card refused: ${missingVerify}. Or pass --no-verify "<reason>". Nothing was filed.`);
    err.missingVerify = true;
    throw err;
  }
  if (missingVerify) console.warn(`[linear-issue-create] VERIFY-ADVISORY: ${missingVerify}. Or pass --no-verify "<reason>" (BRO-5626).`);

  let state = pickStateForMode(team.states, selfFiled ? 'self' : mode);

  const filed = effectiveCreatePriority({ priority, mode, title });
  // BRO-5626: a session discovery parked for a technical reason with a safe VERIFY is pickable work, not a
  // block. File it in Todo (no PARKED sentinel) so the workers take it; 183 such cards sat in Backlog
  // untouched once the Mac drain died. Sessions-only path (reuseTwin), fails open to the parked filing.
  let autoTodo = false;
  if (reuseTwin && mode === 'park' && !filed.clamped) {
    try {
      // Same rule the daily unpark drain applies (scripts/linear-unpark-drain.js), so a card it would move is filed in Todo.
      const parkedBody = `PARKED: ${disposition.reason}\n\n${body}`;
      const why = require('./linear-drain-parked.js').unparkSkipReason({ identifier: 'BRO-new', title, description: parkedBody, priority: filed.priority, state: { type: 'backlog' } });
      if (!why) {
        state = pickStateForMode(team.states, 'dispatch');
        autoTodo = true;
      }
    } catch (e) {
      console.warn(`[linear-issue-create] auto-Todo check failed open (filing parked): ${e.message}`);
    }
  }
  if (filed.clamped) {
    console.warn(`[linear-issue-create] parked issue filed at Medium, not P0/P1 (BRO-4487): "${title}"`);
  }
  if (mode === 'park') {
    let takeable = null;
    // BRO-5372, warn-only: an advisory must never fail the filing. Lazy require:
    // headless-dispatchability.js pulls in linear-drain-parked.js.
    try {
      const advisory = require('./headless-dispatchability').parkReasonAdvisory(disposition.reason);
      if (advisory) console.warn(`[linear-issue-create] ${advisory}`);
      // BRO-5626: sessions parked technical discoveries by default, and nothing picked them up.
      takeable = cardSource === 'session' && !autoTodo && require('./headless-dispatchability').takeableParkAdvisory(disposition.reason);
    } catch (e) {
      console.warn(`[linear-issue-create] park-reason advisory failed (filing continues): ${e.message}`);
    }
    // BRO-6130: the BRO-5626 advisory is now a refusal for session filers (a routine names itself
    // with --source routine:<name>). Owner/money/login/taste/irreversible/Mac/date reasons are not
    // "takeable", so those parks pass. Kill switch: LINEAR_TAKEABLE_PARK_REFUSE=0.
    if (takeable && process.env.LINEAR_TAKEABLE_PARK_REFUSE !== '0') {
      const err = new Error(`Card refused: ${takeable} If this session is doing the work now, file it with --self; if you are starting a child session on it, file it with --child "<session title>" (BRO-6359). Nothing was filed.`);
      err.code = 'TAKEABLE_PARK';
      throw err;
    }
    if (takeable) console.warn(`[linear-issue-create] ${takeable}`);
  }
  const clampNote = filed.clamped
    ? `\n\n${PARKED_CLAMP_MARKER} A P0/P1 must be dispatched at creation (BRO-4487); re-file with --dispatch if it needs urgent work.`
    : '';
  const footer = cardDedupe.sourceFooter(cardSource, kind);
  const finalDescription = `${
    autoTodo ? require('./linear-drain-parked.js').unparkDescription(`PARKED: ${disposition.reason}\n\n${body}`, `BRO-5626 filed in Todo ${new Date().toISOString().slice(0, 10)}`).trim()
      : mode === 'park' ? `PARKED: ${disposition.reason}${clampNote}\n\n${body}`.trim() : body
  }\n\n${footer}`.trim();

  // Built lazily (not at module load) so requiring this file never reads
  // LINEAR_API_KEY or touches the network — only a real create attempt does.
  // Injected executor is linear-client.js's graphql() (429 retry + backoff,
  // no retry-on-5xx-for-mutations since creation isn't idempotent — see
  // linear-retry-policy.js), NOT linear.js's own createLinearClient(), which
  // is a bare single-attempt fetch. This is the fix for a ship-check finding
  // (Codex, BRO-375): the naive transport silently dropped alerts on a
  // transient 429 instead of retrying.
  const issueClient = client || new LinearClient({ graphql: linear.graphql, teamKey: linear.TEAM_KEY });

  const labelIds = [];
  if (macOnly !== undefined) {
    const labelId = await macOnlyLabelId(client, team.id);
    if (labelId) labelIds.push(labelId);
  }

  let issue;
  try {
    issue = await issueClient.createIssue({
      teamId: team.id,
      title,
      description: finalDescription,
      priority: filed.priority,
      stateId: state.id,
      projectId,
      ...(labelIds.length ? { labelIds } : {}),
    });
  } catch (err) {
    if (isUsageLimitExceeded(err)) {
      const loud = new Error(USAGE_LIMIT_MESSAGE);
      loud.cause = err;
      throw loud;
    }
    throw err;
  }

  // Record AFTER the create succeeds, so a failed API call never consumes
  // breaker budget. recordCreated never throws — telemetry must not turn a
  // successful create into a reported failure.
  recordCreated({ identifier: issue?.identifier, title });

  return { issue, mode: selfFiled ? 'self' : mode, stateName: state.name, autoTodo };
}

// BRO-6080: the 'mac-only' label id, or null (fails open: the MAC-ONLY line
// already marks the card for every picker).
async function macOnlyLabelId(client, teamId) {
  const { MAC_ONLY_LABEL } = require('./linear-dispatch.js');
  try {
    const label = await (client && client.findOrCreateLabel ? client.findOrCreateLabel(teamId, MAC_ONLY_LABEL) : linear.findOrCreateLabel(teamId, MAC_ONLY_LABEL));
    return (label && label.id) || null;
  } catch (e) {
    console.warn(`[linear-issue-create] could not look up the '${MAC_ONLY_LABEL}' label (the MAC-ONLY line still marks the card): ${e.message}`);
    return null;
  }
}

const OPEN_TWIN_QUERY = `query($teamKey: String!, $title: String!) {
  issues(first: 5, filter: {
    team: { key: { eq: $teamKey } },
    title: { eqIgnoreCase: $title },
    state: { type: { nin: ["completed", "canceled", "duplicate"] } }
  }) { nodes { id identifier title url state { name type } } }
}`;

async function defaultFindOpenIssueByTitle(title) {
  const data = await linear.graphql(OPEN_TWIN_QUERY, { teamKey: linear.TEAM_KEY, title: String(title).trim() });
  const nodes = (data && data.issues && data.issues.nodes) || [];
  return nodes[0] || null;
}

// A twin is reused only when it is waiting in a state that serves the caller:
// never a started card (someone holds it), and a parked (backlog) twin only
// for a parked request, so a --dispatch is never swallowed by a parked card.
function twinServes(twin, mode) {
  const type = twin && twin.state && twin.state.type;
  if (type === 'unstarted') return true;
  if (type === 'backlog') return mode === 'park';
  return false;
}

async function noteOnCard(client, card, note) {
  try {
    if (client && client.addComment) await client.addComment(card.id, note);
    else await new LinearClient({ graphql: linear.graphql, teamKey: linear.TEAM_KEY }).addComment(card.id, note);
    return true;
  } catch (e) {
    console.warn(`[linear-issue-create] could not add a note to ${card.identifier}: ${e.message}`);
    return false;
  }
}

const OPEN_TITLES_QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 250, after: $after, filter: {
    team: { key: { eq: $teamKey } },
    state: { type: { nin: ["completed", "canceled", "duplicate"] } }
  }) { pageInfo { hasNextPage endCursor } nodes { id identifier title url state { name type } } }
}`;
const RECENT_QUERY = `query($teamKey: String!, $since: DateTimeOrDuration!, $after: String) {
  issues(first: 100, after: $after, includeArchived: true, filter: {
    team: { key: { eq: $teamKey } }, createdAt: { gte: $since }
  }) { pageInfo { hasNextPage endCursor } nodes { identifier title description createdAt } }
}`;
const MAX_PAGES = 10;

async function walkPages(query, vars) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await linear.graphql(query, { ...vars, after });
    const conn = (data && data.issues) || { nodes: [], pageInfo: {} };
    out.push(...(conn.nodes || []));
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// Titles only (~3 pages at ~750 open cards): one walk per CLI create.
async function defaultListOpenIssueTitles() {
  return walkPages(OPEN_TITLES_QUERY, { teamKey: linear.TEAM_KEY });
}

async function defaultListRecentIssues(sinceIso) {
  return walkPages(RECENT_QUERY, { teamKey: linear.TEAM_KEY, since: sinceIso });
}

async function findNearDuplicateOpen({ title, client }) {
  if (process.env.LINEAR_NEAR_DUP_DISABLED === '1') return null;
  const list = client ? (client.listOpenIssueTitles && client.listOpenIssueTitles.bind(client)) : defaultListOpenIssueTitles;
  if (!list) return null;
  try {
    return cardDedupe.findNearDuplicate(title, await list());
  } catch (e) {
    console.warn(`[linear-issue-create] near-duplicate lookup failed, filing anyway: ${e.message}`);
    return null;
  }
}

async function reuseNearDuplicate({ title, body, client, mode = 'park' }) {
  if (process.env.LINEAR_NEAR_DUP_DISABLED === '1') return null;
  const list = client ? (client.listOpenIssueTitles && client.listOpenIssueTitles.bind(client)) : defaultListOpenIssueTitles;
  if (!list) return null;
  let match = null;
  try {
    match = cardDedupe.findNearDuplicate(title, await list(), (card) => twinServes(card, mode));
  } catch (e) {
    console.warn(`[linear-issue-create] near-duplicate lookup failed, filing anyway: ${e.message}`);
    return null;
  }
  if (!match) return null;
  const twin = match.card;
  // Never park another filer's finding on a card whose lifecycle a filer owns
  // (router/autofix): resolved-alert-card-sweep ignores "Filed again on" notes
  // and would cancel the card, finding and all. Fail open = file normally.
  try {
    const desc = twin.description !== undefined ? twin.description
      : (client ? '' : ((await linear.getIssue(twin.identifier)) || {}).description);
    if (cardDedupe.hasPerCardContract(desc)) return null;
  } catch (e) {
    console.warn(`[linear-issue-create] could not read ${twin.identifier} before reusing it, filing anyway: ${e.message}`);
    return null;
  }
  const note = `Filed again on ${new Date().toISOString().slice(0, 16)}Z as "${title}" (near-duplicate of this card, score ${match.score.toFixed(2)}); added here instead of opening a new card. File a new card anyway with linear-brain.js create --new-anyway "<reason>".${body ? `\n\n${String(body).slice(0, 6000)}` : ''}`;
  // A finding that did not land on the twin must still be filed (audits treat
  // a returned card as proof the finding was saved).
  if (!(await noteOnCard(client, twin, note))) return null;
  console.warn(`[linear-issue-create] "${title}" repeats open ${twin.identifier} ("${twin.title}", score ${match.score.toFixed(2)}); noted there, no new card`);
  return { issue: twin, mode: 'reused', stateName: twin.state ? twin.state.name : '', reused: true, nearDuplicate: { score: match.score } };
}

// A flood (FLOOD_THRESHOLD same source+kind in 24h) goes onto one parked
// rollup card. Keyed on the rollup card existing, so once it is open every
// later filing of that kind lands there (no daily re-flood as the 24h count
// decays). The rollup card itself is filed with both rules off (no recursion).
async function rollUpFlood({ title, body, client, source, kind }) {
  if (process.env.LINEAR_ROLLUP_DISABLED === '1') return null;
  const rTitle = cardDedupe.rollupTitle(source, kind);
  const find = client ? (client.findOpenIssueByTitle && client.findOpenIssueByTitle.bind(client)) : defaultFindOpenIssueByTitle;
  const recentFn = client ? (client.listRecentIssues && client.listRecentIssues.bind(client)) : defaultListRecentIssues;
  if (!find || !recentFn) return null;
  try {
    let card = await find(rTitle);
    if (!card) {
      const recent = await recentFn(new Date(Date.now() - cardDedupe.FLOOD_WINDOW_MS).toISOString());
      const same = cardDedupe.sameKindCards({ source, kind, recent });
      if (same.length < cardDedupe.FLOOD_THRESHOLD) return null;
      const created = await createLinearIssue({
        title: rTitle,
        description: [
          `${same.length} cards of this kind were filed by ${source} in the last 24 hours (${same.map((c) => c.identifier).join(', ')}).`,
          'Further filings of this kind are added here as comments instead of new cards (BRO-5488). Work them from this card; close it when the list is clear.',
        ].join('\n\n'),
        park: `rollup of repeated ${source} filings; each comment is one finding`,
        source: 'rollup',
        dedupeOptOut: 'rollup',
        // Narrows (does not close) the window where two concurrent floods both open a rollup.
        reuseTwin: true,
        client,
      });
      card = created.issue;
    }
    if (!(await noteOnCard(client, card, `${title}${body ? `\n\n${String(body).slice(0, 6000)}` : ''}`))) return null;
    console.warn(`[linear-issue-create] "${title}" is part of a ${source} flood; added to rollup ${card.identifier}, no new card`);
    return { issue: card, mode: 'rolled-up', stateName: card.state ? card.state.name : '', reused: true };
  } catch (e) {
    console.warn(`[linear-issue-create] rollup check failed, filing anyway: ${e.message}`);
    return null;
  }
}

async function reuseOpenTwin({ title, body, client, mode = 'park' }) {
  if (process.env.LINEAR_TITLE_DEDUPE_DISABLED === '1') return null;
  const find = client ? (client.findOpenIssueByTitle && client.findOpenIssueByTitle.bind(client)) : defaultFindOpenIssueByTitle;
  if (!find) return null;
  let twin = null;
  try { twin = await find(title); } catch (e) {
    console.warn(`[linear-issue-create] open-twin lookup failed, filing anyway: ${e.message}`);
    return null;
  }
  // BRO-5488: the same row with only a count changed ("Star-band detector: 21
  // review(s)" -> "22 review(s)") is the same twin. Dates and BRO refs stay distinct.
  // Park mode only: a --dispatch filing is a session's own card, and handing it
  // a card whose title differs by a number would make it claim other work.
  if (!twin && mode === 'park') {
    const list = client ? (client.listOpenIssueTitles && client.listOpenIssueTitles.bind(client)) : defaultListOpenIssueTitles;
    try { twin = list ? cardDedupe.findCountOnlyTwin(title, await list(), (c) => twinServes(c, mode)) : null; } catch (e) {
      console.warn(`[linear-issue-create] count-only twin lookup failed, filing anyway: ${e.message}`);
      twin = null;
    }
  }
  if (!twin || !twin.identifier || !twinServes(twin, mode)) return null;
  const note = `Filed again on ${new Date().toISOString().slice(0, 16)}Z ${twin.title === title ? 'with the same title' : `as "${title}" (only a count changed)`}; added here instead of opening a duplicate card.${body ? `\n\n${String(body).slice(0, 6000)}` : ''}`;
  // A finding that did not land on the twin must still be filed (audits treat
  // a returned card as proof the finding was saved).
  if (!(await noteOnCard(client, twin, note))) return null;
  console.warn(`[linear-issue-create] "${title}" is already open as ${twin.identifier}; noted there, no new card`);
  return { issue: twin, mode: 'reused', stateName: twin.state ? twin.state.name : '', reused: true, countOnly: twin.title !== title };
}

module.exports = {
  createLinearIssue, reuseOpenTwin, reuseNearDuplicate, rollUpFlood, defaultFindOpenIssueByTitle, twinServes, pickStateForMode, isUsageLimitExceeded, USAGE_LIMIT_MESSAGE,
  effectiveCreatePriority, priorityFromTitle, missingVerifyReason, MISSING_VERIFY_MESSAGE, PARKED_MAX_PRIORITY, PARKED_CLAMP_MARKER, DEFAULT_CREATE_PRIORITY,
};
