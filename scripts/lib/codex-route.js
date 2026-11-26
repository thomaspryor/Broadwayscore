'use strict';
/**
 * codex-route.js (BRO-7627): should a hand-started worker for these cards be a Codex run
 * (codex-runner.yml with ids=) instead of a Claude create_session? Advisory: session-model.js
 * prints the route and the dispatch command; nothing refuses a Claude session.
 *
 * A card goes to Codex only when the Codex runner would work it as it stands:
 *  - still Todo (state type unstarted): daily-runner.js workCard skips other states, so route
 *    before the runbook's step-1 claim and leave the card Todo;
 *  - not P0, no raw "Model: Opus" line (pickModel drops that to Sonnet once the daily Opus
 *    budget is spent, so the model alone would miss it), under 50 comments (getIssue reads 50:
 *    a bounce or pause past that would be missed);
 *  - no pause/stranded history the runner's picker skips (historySkipReason);
 *  - leaveToCodex: the Codex fit check (mac-only, protected path, ladder, bounce, START-NOW).
 *    A run started with ids= skips the picker's fit check, so this is the only fit gate.
 * And the GHA Codex lane must be healthy: no current gha breach (or a lost login) in
 * codex-lane-health.js. Unknown or unreadable health routes to Claude, with the reason.
 */

const MAX_COMMENTS = 50;

/** Why this card is not Codex's, or null when the Codex runner would work it. */
function cardRouteReason(issue, { nowMs = Date.now() } = {}) {
  if (!issue) return 'card not found';
  const P = require('./cloud-worker-pick.js');
  const { leaveToCodex, codexCardFit } = require('./codex-runner.js');
  const { MODEL_HINT_RE } = require('./bsc-next-model.js');
  const { verifyCommand } = require('./linear-drain-parked.js');
  const stateType = issue.state && issue.state.type;
  if (stateType !== 'unstarted') return `state ${(issue.state && issue.state.name) || 'unknown'}: the Codex runner only takes a Todo card`;
  if (Number(issue.priority) === 1) return 'P0: Claude (Opus) takes it';
  const hint = MODEL_HINT_RE.exec(String(issue.description || ''));
  if (hint && hint[1].toLowerCase() === 'opus') return 'the card asks for Opus (Model: Opus line)';
  const nodes = issue.comments && Array.isArray(issue.comments.nodes) ? issue.comments.nodes : null;
  if (!nodes) return 'comments not read';
  if (nodes.length >= MAX_COMMENTS) return `${MAX_COMMENTS}+ comments: its bounce and pause history may be incomplete`;
  const history = P.historySkipReason(issue, nodes, nowMs);
  if (history) return `the Codex runner skips it for its history (${history})`;
  const verify = verifyCommand(issue) || '';
  const startNow = P.isStartNow(issue, nowMs);
  if (!leaveToCodex(issue, { nowMs, verify, startNow })) {
    if (startNow) return 'START-NOW: a Claude worker takes it at once';
    const fit = codexCardFit({ title: issue.title, description: issue.description, verify, comments: nodes, nowMs, canDispatch: true, dataRouteLocked: false });
    return `not a Codex card (${fit.skip || 'bounced from Codex recently'})`;
  }
  return null;
}

/**
 * Lane health -> { ok, reason }. `health` is confirmedBreaches(...) output, or null when the run
 * list could not be read. The gha lane counts (the ids= dispatch runs there), plus a lost Codex
 * login, which stops every lane. A breach this hour counts before it is confirmed: routing to
 * Claude by mistake costs a Sonnet session, routing to a broken lane strands the card.
 */
function ghaLaneVerdict(health) {
  if (!health || !health.now) return { ok: false, reason: 'Codex lane health unknown (codex-runner.yml runs unreadable)' };
  if (!(health.now.facts && health.now.facts.ghaRuns > 0)) return { ok: false, reason: 'Codex lane health unknown (no codex-runner.yml run found)' };
  const bad = health.now.breaches.filter((b) => b.lane === 'gha' || b.cls === 'login-not-saved');
  if (bad.length) return { ok: false, reason: `Codex lane unhealthy: ${bad.map((b) => `${b.lane}:${b.cls} ${b.why}`).join('; ').slice(0, 300)}` };
  return { ok: true, reason: 'Codex GHA lane healthy' };
}

const dispatchCommand = (ids) => `node scripts/cloud-dispatch.js codex-runner.yml -f ids=${ids.join(',')} -f limit=${ids.length}`;
const DISPATCH_NOTE = 'Do not claim the card or start a Claude session: leave it Todo. First check for a live or queued codex-runner.yml run '
  + '(the concurrency group keeps one pending run, so the next cron firing can cancel a queued dispatch); then dispatch, '
  + 'and re-dispatch if a cron run dropped it. Watch the card: a Codex bounce returns it to Todo for a Claude worker.';

/**
 * -> { route: 'codex'|'claude', routeReason, cards: [{ identifier, routeReason|null }], dispatch?, dispatchNote? }
 * laneHealth: () => { ok, reason } (sync or async), called only when every card fits.
 */
async function decideRoute(issues, { nowMs = Date.now(), laneHealth } = {}) {
  const cards = (issues || []).map((issue) => ({ identifier: issue && issue.identifier, routeReason: cardRouteReason(issue, { nowMs }) }));
  if (!cards.length) return { route: 'claude', routeReason: 'no card', cards };
  const unfit = cards.filter((c) => c.routeReason);
  if (unfit.length) return { route: 'claude', routeReason: unfit.map((c) => `${c.identifier}: ${c.routeReason}`).join('; '), cards };
  let lane;
  try { lane = await laneHealth(); } catch (e) { lane = { ok: false, reason: `Codex lane health unknown (${(e && e.message) || e})` }; }
  if (!lane || !lane.ok) return { route: 'claude', routeReason: (lane && lane.reason) || 'Codex lane health unknown', cards };
  const ids = cards.map((c) => c.identifier);
  return { route: 'codex', routeReason: `every card fits Codex; ${lane.reason}`, cards, dispatch: dispatchCommand(ids), dispatchNote: DISPATCH_NOTE };
}

/** Reads the lane's outside signals (codex-lane-alarm.js readers) -> { ok, reason }. Never throws. */
async function readGhaLaneHealth({ nowMs = Date.now() } = {}) {
  try {
    const A = require('../codex-lane-alarm.js');
    const { confirmedBreaches } = require('./codex-lane-health.js');
    const runs = A.readRuns();
    if (runs === null) return ghaLaneVerdict(null);
    const [summaries, login] = await Promise.all([A.readSummaries(1), A.readLogin()]);
    return ghaLaneVerdict(confirmedBreaches({ nowMs, landed: null, summaries, ghRuns: A.toGhRuns(runs), lockAgeH: null, login }));
  } catch (e) {
    return { ok: false, reason: `Codex lane health unknown (${(e && e.message) || e})` };
  }
}

module.exports = { MAX_COMMENTS, cardRouteReason, ghaLaneVerdict, dispatchCommand, DISPATCH_NOTE, decideRoute, readGhaLaneHealth };
