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
 * Pass `model` to create_session and put `MODEL-REASON: <modelReason>` in the
 * prompt. Exit 1 when Linear can't be read or a card is missing.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/session-model.js BRO-N [BRO-M ...] | --no-card\nPrints the create_session model for a worker session on these cards (--no-card: work with no card), with the reason. Read-only.';

if (hasHelpFlag(process.argv)) {
  console.log(USAGE);
  process.exit(0);
}

require('./lib/load-env').loadEnv();

async function main() {
  const { modelPicker, sessionModelFor } = require('./lib/cloud-worker-pick.js');
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
  const modelOf = modelPicker(Date.now());
  const issues = await Promise.all(ids.map((id) => getIssue(id)));
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
  console.log(JSON.stringify({ model, modelReason, cards }, null, 2));
}

main().catch((err) => {
  console.error(`[session-model] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
