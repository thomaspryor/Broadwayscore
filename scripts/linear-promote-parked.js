#!/usr/bin/env node
/**
 * linear-promote-parked.js — cloud-hosted unpark pass (BRO-5626).
 * Moves technically-parked Backlog cards with a safe VERIFY to Todo so the cloud
 * worker picker and Codex take them. Rules: scripts/lib/linear-promote-parked.js.
 *
 * Usage: node scripts/linear-promote-parked.js [--dry-run] [--max=N]
 * Kill switch: LINEAR_PROMOTE_PARKED_DISABLED=1.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const USAGE = 'usage: node scripts/linear-promote-parked.js [--dry-run] [--max=N]';
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
require('./lib/load-env').loadEnv();

const dry = process.argv.includes('--dry-run');
const maxArg = (process.argv.find((a) => a.startsWith('--max=')) || '').slice('--max='.length);
if (maxArg && !(Number.isInteger(Number(maxArg)) && Number(maxArg) > 0)) { console.error(USAGE); process.exit(2); }
const DEFAULT_MAX = 40; // per run: a worker pool drains a few cards an hour, so a flood adds nothing

async function main() {
  if (/^(1|true)$/i.test(process.env.LINEAR_PROMOTE_PARKED_DISABLED || '')) { console.log('LINEAR_PROMOTE_PARKED_DISABLED set: unpark pass disabled'); return; }
  if (!process.env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY not set');
  const linear = require('./lib/linear-client.js');
  const { skipReason } = require('./lib/cloud-worker-pick.js');
  const { planPromotion, promoteOne, unparkDescription } = require('./lib/linear-promote-parked.js');

  const issues = (await linear.listOpenIssuesWithDescriptions()).filter((i) => i.state && i.state.type === 'backlog');
  // A VERIFY may live in a comment (BRO-4642): read them for the parked cards only.
  const byId = await linear.listIssueComments(issues.map((i) => i.identifier));
  for (const i of issues) i.comments = { nodes: byId.get(i.identifier) || [] };

  const tierOf = (i) => ([1, 2].includes(Number(i.priority)) ? 'p0p1' : Number(i.priority) === 3 ? 'p2' : 'p3');
  const parkedSkips = (list) => list.filter((i) => skipReason(i, Date.now(), { tier: tierOf(i) }) === 'parked-or-backlog').length;
  const plan = planPromotion(issues, { limit: Number(maxArg) || DEFAULT_MAX });
  const moving = new Set(plan.promote.map((i) => i.identifier));
  const after = issues.map((i) => (moving.has(i.identifier) ? { ...i, state: { ...i.state, type: 'unstarted' }, description: unparkDescription(i.description) } : i));
  console.log(`${issues.length} Backlog cards; picker 'parked-or-backlog' skips ${parkedSkips(issues)} -> ${parkedSkips(after)} after; ${plan.eligible} promotable, moving ${plan.promote.length}`);
  console.log(`reasons: ${JSON.stringify(plan.tally)}`);
  if (dry) { for (const i of plan.promote) console.log(`dry-run: would move ${i.identifier} (P${i.priority}) to Todo: ${i.title.slice(0, 80)}`); return; }

  const todo = (await linear.getTeam()).states.nodes.find((s) => s.type === 'unstarted' && s.name === 'Todo') || (await linear.getTeam()).states.nodes.find((s) => s.type === 'unstarted');
  if (!todo) throw new Error('Linear team has no unstarted state');
  let moved = 0; let failed = 0;
  for (const i of plan.promote) {
    try {
      const r = await promoteOne({ linear, issue: i, todoStateId: todo.id });
      if (r === 'changed') { console.log(`${i.identifier}: changed since listing, skipped`); continue; }
      moved += 1;
      console.log(`${i.identifier}: moved to ${todo.name}: ${i.title.slice(0, 80)}`);
    } catch (err) {
      failed += 1;
      console.log(`::warning::${i.identifier}: could not move (${String(err.message).split('\n')[0]})`);
    }
  }
  console.log(`summary: moved ${moved}, failed ${failed}`);
  if (failed && !moved) process.exitCode = 1;
}

main().catch((err) => { console.error(`[linear-promote-parked] ${err && err.message ? err.message : err}`); process.exit(1); });
