#!/usr/bin/env node
/**
 * owner-hold-sweep.js — daily sweep of cards that say they need the owner but
 * carry no real question (BRO-6852; owner decision 2026-11-02, option A).
 *
 * Claude decides and releases worker-doable cards (OWNER-CLEARED comment,
 * PARKED -> UNPARKED, Backlog -> Todo). Cards only the owner can unblock get a
 * real DECISION NEEDED question, but only from text a person or session wrote
 * (--questions file); the rest are listed as needing one. All rules live in
 * scripts/lib/owner-hold-sweep.js.
 *
 *   node scripts/owner-hold-sweep.js                     dry run: list every held card and its proposed action
 *   node scripts/owner-hold-sweep.js --apply             write
 *   --release-cap N (25)   --question-cap N (5)   --questions FILE.json ({"BRO-1": "DECISION NEEDED: ..."})
 *   --only BRO-1,BRO-2     --json
 * Kill switch: OWNER_HOLD_SWEEP_DISABLED=1. Hosted daily by .github/workflows/linear-unpark-drain.yml.
 */
'use strict';

const fs = require('fs');
const { parseArgs } = require('./lib/cli-args.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'owner-hold-sweep.js — release or ask about owner-worded holds (BRO-6852).\n'
  + '  (no flags) dry run   --apply write   --release-cap N   --question-cap N   --questions FILE.json   --only BRO-1,BRO-2   --json\n'
  + '  Kill switch: OWNER_HOLD_SWEEP_DISABLED=1';

const intFlag = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== true && Number(v) >= 0 ? Number(v) : d);

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return null; }
  if (/^(1|true|yes|on)$/i.test(String(process.env.OWNER_HOLD_SWEEP_DISABLED || '').trim())) {
    console.log('owner-hold-sweep: OWNER_HOLD_SWEEP_DISABLED is set, nothing done.');
    return null;
  }
  const args = parseArgs(argv, { coerceBooleans: true, textFlags: ['release-cap', 'question-cap', 'questions', 'only'] });
  const apply = args.apply === true;
  require('./lib/load-env').loadEnv();
  const sweep = require('./lib/owner-hold-sweep.js');
  const bc = require('./lib/board-categories.js');
  const linear = deps.linear || require('./lib/linear-client.js');
  const now = deps.now || new Date();
  const secret = process.env.APPROVAL_HMAC_SECRET || null;

  let questions = {};
  if (args.questions) questions = JSON.parse(fs.readFileSync(String(args.questions), 'utf8'));
  const only = args.only ? new Set(String(args.only).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const releaseCap = intFlag(args['release-cap'], sweep.DEFAULT_RELEASE_CAP);
  const questionCap = intFlag(args['question-cap'], sweep.DEFAULT_QUESTION_CAP);

  const board = await bc.fetchOpenBoard({ graphql: deps.graphql || linear.graphql });
  const issues = only ? board.filter((i) => only.has(i.identifier)) : board;
  const byId = new Map(board.map((i) => [i.identifier, i]));
  const plan = sweep.planSweep(issues, { now, secret, releaseCap, questionCap, questions });

  const show = (tag, rows) => rows.forEach((r) => console.log(`${tag} ${r.identifier} P${r.priority} ${r.state} | ${String(r.title).slice(0, 60)} | ${r.why}`));
  show(apply ? 'release' : 'would release', plan.releases);
  show(apply ? 'ask' : 'would ask', plan.questions);
  show('needs a written question', plan.needsQuestion);
  show('leave', plan.leave);
  show('deferred', plan.deferred);

  const done = { released: [], asked: [], failed: [], changed: [] };
  if (apply && (plan.releases.length || plan.questions.length)) {
    const team = await linear.getTeam();
    const todo = team.states.nodes.find((s) => s.type === 'unstarted' && /^todo$/i.test(s.name)) || team.states.nodes.find((s) => s.type === 'unstarted');
    if (!todo) throw new Error('no unstarted (Todo) state on the team');
    for (const [kind, rows] of [['release', plan.releases], ['ask', plan.questions]]) {
      for (const row of rows) {
        try {
          // Re-read just before writing: a session may have claimed, edited or answered it since.
          const fresh = await linear.getIssue(row.identifier);
          const before = byId.get(row.identifier);
          if (!fresh || !before || fresh.description !== before.description || fresh.state.type !== before.state.type) {
            console.log(`changed since read, left alone: ${row.identifier}`);
            done.changed.push(row.identifier);
            continue;
          }
          if (kind === 'release') {
            // getIssue lacks board-only fields (updatedAt...): classify the fresh text on top of the board row.
            const cls = sweep.classifyHold({ ...before, ...fresh }, { now, secret });
            if (cls.action !== 'release') { done.changed.push(row.identifier); continue; }
            const input = { description: sweep.releasedView(fresh, now).description };
            if (['backlog'].includes(fresh.state.type) || fresh.state.name === 'Paused') input.stateId = todo.id;
            await linear.updateIssue(fresh.id, input);
            await linear.createComment(fresh.id, sweep.releaseComment(now));
            done.released.push(row.identifier);
          } else {
            const input = { description: sweep.withQuestion(fresh.description, row.question) };
            await linear.updateIssue(fresh.id, input);
            await linear.createComment(fresh.id, `Question written by the owner-hold sweep (${sweep.SWEEP_TAG}): this card needs a call only the owner can make, so it is now in "Waiting on you".`);
            done.asked.push(row.identifier);
          }
        } catch (e) {
          console.error(`failed: ${row.identifier}: ${e.message}`);
          done.failed.push(row.identifier);
        }
      }
    }
  }
  const summary = {
    mode: apply ? 'apply' : 'dry-run', held: plan.held,
    release: plan.releases.length, ask: plan.questions.length, needsQuestion: plan.needsQuestion.length,
    leave: plan.leave.length, deferred: plan.deferred.length, ...(apply ? { done } : {}),
  };
  console.log(args.json ? JSON.stringify(summary) : `owner-hold-sweep: ${JSON.stringify(summary)}`);
  if (done.failed.length) process.exitCode = 1;
  return { summary, plan };
}

if (require.main === module) {
  main().catch((e) => { console.error(`owner-hold-sweep: ${e.message}`); process.exit(1); });
}

module.exports = { main };
