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
const { TITLE_PRIORITY_RE } = require('./linear-watchdog-source');
const { stampModelHint } = require('./bsc-next-model');

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
    const state = byType('backlog') || byType('unstarted');
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

/**
 * PURE. The priority a new issue is actually filed at. Dispatched issues keep
 * whatever the caller asked for; parked issues are capped at Medium.
 * @returns {{priority: (number|undefined), clamped: boolean}}
 */
function effectiveCreatePriority({ priority, mode, title }) {
  if (mode !== 'park') return { priority, clamped: false };
  const n = priority === undefined || priority === null || priority === '' ? NaN : Number(priority);
  const urgentOrHigh = n === 1 || n === 2;
  const explicitlyRanked = Number.isFinite(n) && n > 0;
  const titlePromotes = !explicitlyRanked && TITLE_PRIORITY_RE.test(String(title || ''));
  if (urgentOrHigh || titlePromotes) return { priority: PARKED_MAX_PRIORITY, clamped: true };
  return { priority, clamped: false };
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
 * @returns {Promise<{issue: object, mode: 'dispatch'|'park', stateName: string}>}
 */
async function createLinearIssue({ title, description, dispatch, park, priority, projectId, model, client, reuseTwin = false }) {
  const disposition = resolveDisposition({ dispatch, park });
  if (!disposition.ok) {
    const err = new Error(disposition.message);
    err.dispositionReason = disposition.reason;
    throw err;
  }
  const body = model == null ? (description || '') : stampModelHint(description, model);

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
  if (reuseTwin) {
    const reused = await reuseOpenTwin({ title, body, client, mode: disposition.mode });
    if (reused) return reused;
  }

  const team = await linear.getTeam();
  const state = pickStateForMode(team.states, disposition.mode);

  const filed = effectiveCreatePriority({ priority, mode: disposition.mode, title });
  if (filed.clamped) {
    console.warn(`[linear-issue-create] parked issue filed at Medium, not P0/P1 (BRO-4487): "${title}"`);
  }
  const clampNote = filed.clamped
    ? `\n\n${PARKED_CLAMP_MARKER} A P0/P1 must be dispatched at creation (BRO-4487); re-file with --dispatch if it needs urgent work.`
    : '';
  const finalDescription =
    disposition.mode === 'park' ? `PARKED: ${disposition.reason}${clampNote}\n\n${body}`.trim() : body;

  // Built lazily (not at module load) so requiring this file never reads
  // LINEAR_API_KEY or touches the network — only a real create attempt does.
  // Injected executor is linear-client.js's graphql() (429 retry + backoff,
  // no retry-on-5xx-for-mutations since creation isn't idempotent — see
  // linear-retry-policy.js), NOT linear.js's own createLinearClient(), which
  // is a bare single-attempt fetch. This is the fix for a ship-check finding
  // (Codex, BRO-375): the naive transport silently dropped alerts on a
  // transient 429 instead of retrying.
  const issueClient = client || new LinearClient({ graphql: linear.graphql, teamKey: linear.TEAM_KEY });

  let issue;
  try {
    issue = await issueClient.createIssue({
      teamId: team.id,
      title,
      description: finalDescription,
      priority: filed.priority,
      stateId: state.id,
      projectId,
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

  return { issue, mode: disposition.mode, stateName: state.name };
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

async function reuseOpenTwin({ title, body, client, mode = 'park' }) {
  if (process.env.LINEAR_TITLE_DEDUPE_DISABLED === '1') return null;
  const find = client ? (client.findOpenIssueByTitle && client.findOpenIssueByTitle.bind(client)) : defaultFindOpenIssueByTitle;
  if (!find) return null;
  let twin = null;
  try { twin = await find(title); } catch (e) {
    console.warn(`[linear-issue-create] open-twin lookup failed, filing anyway: ${e.message}`);
    return null;
  }
  if (!twin || !twin.identifier || !twinServes(twin, mode)) return null;
  const note = `Filed again on ${new Date().toISOString().slice(0, 16)}Z with the same title; added here instead of opening a duplicate card.${body ? `\n\n${String(body).slice(0, 6000)}` : ''}`;
  try {
    if (client && client.addComment) await client.addComment(twin.id, note);
    else await new LinearClient({ graphql: linear.graphql, teamKey: linear.TEAM_KEY }).addComment(twin.id, note);
  } catch (e) {
    console.warn(`[linear-issue-create] could not note the repeat on ${twin.identifier}: ${e.message}`);
  }
  console.warn(`[linear-issue-create] "${title}" is already open as ${twin.identifier}; noted there, no new card`);
  return { issue: twin, mode: 'reused', stateName: twin.state ? twin.state.name : '', reused: true };
}

module.exports = {
  createLinearIssue, reuseOpenTwin, defaultFindOpenIssueByTitle, twinServes, pickStateForMode, isUsageLimitExceeded, USAGE_LIMIT_MESSAGE,
  effectiveCreatePriority, PARKED_MAX_PRIORITY, PARKED_CLAMP_MARKER,
};
