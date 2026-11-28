#!/usr/bin/env node
/**
 * session-model.js — the model a cloud worker session started with
 * create_session should run on (BRO-5228). create_session defaults to the
 * calling session's model, so without an explicit `model` every child ran on
 * the parent's Opus. This applies the board worker's per-card policy
 * (scripts/lib/cloud-worker-pick.js modelPicker: Sonnet; Opus for P0, a
 * "Model: Opus" card line or a retry) and the batch rule (sessionModelFor:
 * Sonnet unless every card needs Opus; Opus cards go to an Opus subagent).
 *
 * Usage: node scripts/session-model.js BRO-N [BRO-M ...]   (or --no-card)
 * Prints JSON { model, modelReason, cards: [{identifier, model, modelReason}] }.
 * The card's own "Model: Opus" line spends the daily Opus budget (BRO-6684, scripts/opus-budget.js;
 * record the weekly limit with --record-usage first). The create_session hook re-runs this policy.
 * Pass `model` to create_session and put `MODEL-REASON: <modelReason>` in the
 * prompt, plus a `BUDGET: <hours>h` line (1-12) and a `REPORT-BACK:` line for a
 * Broadwayscore session (BRO-5673, BRO-5781). Exit 1 when Linear can't be read or a card is missing.
 * Exit 3 (JSON has `refused`, no `model`) when a card's description carries a NO-DISPATCH line (BRO-6502).
 * Codex route (BRO-7627, advisory): the JSON also has `route` ('codex'|'claude') and `routeReason`
 * (per card in `cards[].routeReason`). On 'codex' it carries `dispatch`, the exact
 * `node scripts/cloud-dispatch.js codex-runner.yml -f ids=BRO-A,BRO-B -f limit=N` to run instead of
 * create_session, and `dispatchNote` (leave the card Todo, check for a queued run first). Rules:
 * scripts/lib/codex-route.js. --no-card and exit 3 print no route.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/session-model.js BRO-N [BRO-M ...] | --no-card\nPrints the create_session model for a worker session on these cards (--no-card: work with no card), with the reason, and the route: codex (with the codex-runner.yml dispatch command to run instead) or claude. Read-only.';

if (hasHelpFlag(process.argv)) {
  console.log(USAGE);
  process.exit(0);
}

require('./lib/load-env').loadEnv();

async function main() {
  const { modelPicker, sessionModelFor, noDispatchHold } = require('./lib/cloud-worker-pick.js');
  if (process.argv.includes('--no-card')) {
    console.log(JSON.stringify({ model: sessionModelFor([]).model, modelReason: 'no card', cards: [] }, null, 2));
    return;
  }
  const ids = [...new Set(process.argv.slice(2).filter((a) => !a.startsWith('-')).map((a) => a.trim().toUpperCase()))];
  if (!ids.length || ids.some((id) => !/^BRO-\d+$/.test(id))) {
    console.error(USAGE);
    process.exit(2);
  }
  const { getIssue } = require('./lib/linear-client.js');
  const modelOf = modelPicker({ opusBudget: await require('./lib/opus-budget.js').loadOpusBudget() });
  const issues = await Promise.all(ids.map((id) => getIssue(id)));
  // BRO-6502: a card held with a NO-DISPATCH line gets no model at all, so a create_session
  // that follows this output has nothing to pass. Exit 3.
  const held = issues.filter((issue) => issue && noDispatchHold(issue)).map((issue) => issue.identifier);
  if (held.length) {
    console.log(JSON.stringify({ refused: held, refusedReason: `${held.join(', ')} carry a NO-DISPATCH line in the description: do not start a worker on them (remove the line to lift the hold)` }, null, 2));
    process.exit(3);
  }
  const cards = issues.map((issue, i) => {
    if (!issue) throw new Error(`${ids[i]} not found`);
    // getIssue reads 50 comments; past that a retry may be missed (as in cloud-worker-pick.js).
    if (issue.comments && issue.comments.nodes.length >= 50) console.error(`[session-model] ${issue.identifier}: 50+ comments, retry history may be incomplete`);
    const { model, reason } = modelOf(issue);
    return { identifier: issue.identifier, model, modelReason: reason };
  });
  const { model, opusCards } = sessionModelFor(cards);
  const opusIds = cards.filter((c) => c.model === 'opus').map((c) => c.identifier);
  let modelReason;
  if (cards.length === 1) modelReason = cards[0].modelReason;
  else if (!opusCards) modelReason = 'no card needs Opus';
  else if (opusCards === cards.length) modelReason = 'every card needs Opus';
  else modelReason = `batch on Sonnet; hand ${opusIds.join(', ')} to an Opus subagent (Agent tool, model "opus")`;
  // BRO-7627: advisory Codex route. Read through the module object so tests can stub the lane read
  // with a preload. A routing error never costs the model: it routes to Claude and says why.
  const codexRoute = require('./lib/codex-route.js');
  let route;
  try {
    route = await codexRoute.decideRoute(issues, { nowMs: Date.now(), laneHealth: () => codexRoute.readGhaLaneHealth() });
  } catch (err) {
    route = { route: 'claude', routeReason: `Codex route unreadable (${err && err.message ? err.message : err})`, cards: [] };
  }
  const reasonOf = new Map(route.cards.map((c) => [c.identifier, c.routeReason]));
  for (const c of cards) c.routeReason = reasonOf.has(c.identifier) ? reasonOf.get(c.identifier) : route.routeReason;
  const out = { model, modelReason, route: route.route, routeReason: route.routeReason };
  if (route.dispatch) Object.assign(out, { dispatch: route.dispatch, dispatchNote: route.dispatchNote });
  console.log(JSON.stringify({ ...out, cards }, null, 2));
}

main().catch((err) => {
  console.error(`[session-model] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
