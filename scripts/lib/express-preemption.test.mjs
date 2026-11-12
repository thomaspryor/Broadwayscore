import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planRedispatch, ORCH, POLLER } = require('./express-preemption.js');

test('orchestrator title -> market', () => {
  assert.deepEqual(planRedispatch(ORCH, 'Opening Night Orchestrator (west-end)').fields, { market: 'west-end' });
  assert.deepEqual(planRedispatch(ORCH, 'Opening Night Orchestrator (auto)').fields, {});
});
test('poller title -> show_id', () => {
  assert.deepEqual(planRedispatch(POLLER, 'Opening Night Poller — whos-afraid-of-virginia-woolf-west-end-2026').fields, { show_id: 'whos-afraid-of-virginia-woolf-west-end-2026' });
  assert.deepEqual(planRedispatch(POLLER, 'Opening Night Poller — auto').fields, {});
});
test('unknown workflow -> null', () => assert.equal(planRedispatch('x.yml', 't'), null));
test('express workflow wires cancel + redispatch via the lib (no inline gh run cancel on orchestrator/poller)', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/opening-night-express.yml', import.meta.url), 'utf8');
  assert.match(y, /express-preemption\.js cancel/);
  assert.match(y, /express-preemption\.js redispatch/);
  assert.doesNotMatch(y, /for WORKFLOW in opening-night-orchestrator\.yml/);
});

// BRO-5890: Express for one show must not cancel runs scoped to other shows.
const { shouldCancel, SCORING } = require('./express-preemption.js');
test('shouldCancel: orchestrators and auto pollers are always cancelled', () => {
  assert.equal(shouldCancel(ORCH, 'Opening Night Orchestrator (broadway)', 'billy-crystal-860-2026'), true);
  assert.equal(shouldCancel(POLLER, 'Opening Night Poller — auto', 'billy-crystal-860-2026'), true);
});
test('shouldCancel (BRO-5851): a scoring run over a show list is cancelled only when it lists this show', () => {
  assert.equal(shouldCancel(SCORING, 'LLM Ensemble Score Reviews — a-2026,billy-crystal-860-2026,c-2026', 'billy-crystal-860-2026'), true);
  assert.equal(shouldCancel(SCORING, 'LLM Ensemble Score Reviews — a-2026,c-2026', 'billy-crystal-860-2026'), false);
});
test('shouldCancel: targeted poller for the same show is cancelled, another show is left alone', () => {
  assert.equal(shouldCancel(POLLER, 'Opening Night Poller — billy-crystal-860-2026', 'billy-crystal-860-2026'), true);
  assert.equal(shouldCancel(POLLER, 'Opening Night Poller — the-curious-case-of-benjamin-button-off-broadway-2026', 'billy-crystal-860-2026'), false);
});
test('shouldCancel: scoring scoped to another show is left alone; unscoped scoring is cancelled', () => {
  assert.equal(shouldCancel(SCORING, 'LLM Ensemble Score Reviews — the-curious-case-of-benjamin-button-off-broadway-2026', 'billy-crystal-860-2026'), false);
  assert.equal(shouldCancel(SCORING, 'LLM Ensemble Score Reviews — billy-crystal-860-2026', 'billy-crystal-860-2026'), true);
  assert.equal(shouldCancel(SCORING, 'LLM Ensemble Score Reviews', 'billy-crystal-860-2026'), true);
});
test('shouldCancel: with no Express show id, everything is cancelled (old behaviour)', () => {
  assert.equal(shouldCancel(POLLER, 'Opening Night Poller — some-show', ''), true);
});
test('a slug that is a prefix of another is not treated as the same show', () => {
  assert.equal(shouldCancel(POLLER, 'Opening Night Poller — the-bear-bites-back-2025', 'the-bear-2025'), false);
});
test('scoring workflow run-name carries the show id', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/llm-ensemble-score.yml', import.meta.url), 'utf8');
  assert.match(y, /^run-name: LLM Ensemble Score Reviews\$\{\{ inputs\.show_id && format\(' — \{0\}', inputs\.show_id\) \|\| '' \}\}/m);
});
test('express passes its show id to both cancel calls', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/opening-night-express.yml', import.meta.url), 'utf8');
  assert.equal((y.match(/express-preemption\.js cancel "\$RUNNER_TEMP\/express-preempted\.json" --show="\$EXPRESS_SHOW_ID"/g) || []).length, 2);
});

// BRO-7419: a cancelled needs_rescore chain batch must come back with its inputs.
const { RESCORE_CHAIN_RE } = require('./express-preemption.js');
test('rescore chain title -> needs_rescore chain redispatch with the same inputs', () => {
  assert.deepEqual(planRedispatch(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 8 left, limit 400, max-cost 15)').fields,
    { needs_rescore: 'true', chain: 'true', remaining_batches: '8', limit: '400', max_cost: '15', run_calibration: 'false', run_validation: 'false' });
  assert.deepEqual(planRedispatch(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 0 left, limit , max-cost )').fields,
    { needs_rescore: 'true', chain: 'true', remaining_batches: '0', run_calibration: 'false', run_validation: 'false' });
});
test('a typed non-numeric max_cost never comes back uncapped', () => {
  assert.equal(planRedispatch(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 8 left, limit 400, max-cost none)'), null);
});
test('a batch and the next batch it already dispatched restore as ONE chain (the unfinished batch)', () => {
  const { collapseRescoreChains } = require('./express-preemption.js');
  const t = n => ({ ...planRedispatch(SCORING, `LLM Ensemble Score Reviews (rescore chain, ${n} left, limit 400, max-cost 15)`), runId: n });
  const orch = { ...planRedispatch(ORCH, 'Opening Night Orchestrator (west-end)'), runId: 1 };
  const out = collapseRescoreChains([t(7), orch, t(8)]);
  assert.equal(out.length, 2);
  assert.equal(out.find(i => i.workflow === SCORING).fields.remaining_batches, '8');
  // A chain with a different budget cap is a different chain: both come back.
  const other = { ...planRedispatch(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 3 left, limit 400, max-cost 6)'), runId: 9 };
  assert.equal(collapseRescoreChains([t(7), t(8), other]).length, 2);
  // A chain started with no limit: its next batch carries the workflow default 400. One chain.
  const noLimit = { ...planRedispatch(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 7 left, limit , max-cost 15)'), runId: 7 };
  const out2 = collapseRescoreChains([noLimit, t(6)]);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].fields.remaining_batches, '7');
});
test('pending scoring runs are cancelled only when they can be restored', () => {
  const src = fs.readFileSync(new URL('./express-preemption.js', import.meta.url), 'utf8');
  assert.match(src, /const plan = planRedispatch\(workflow, run\.displayTitle\);\s*if \(status === 'pending' && !plan\)/);
  // e.g. a pending rescore_reason chain successor has no suffix -> not restorable -> left alone
  assert.equal(planRedispatch(SCORING, 'LLM Ensemble Score Reviews'), null);
});
test('plain or show-scoped scoring titles are not re-dispatched', () => {
  assert.equal(planRedispatch(SCORING, 'LLM Ensemble Score Reviews'), null);
  assert.equal(planRedispatch(SCORING, 'LLM Ensemble Score Reviews — billy-crystal-860-2026'), null);
});
test('a rescore chain run still counts as unscoped, so Express cancels it', () => {
  assert.equal(shouldCancel(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 8 left, limit 400, max-cost 15)', 'billy-crystal-860-2026'), true);
});
test('contract: llm-ensemble-score.yml run-name suffix renders a title the parser reads', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/llm-ensemble-score.yml', import.meta.url), 'utf8');
  const runName = y.split('\n').find(l => l.startsWith('run-name:'));
  const m = runName.match(/format\('( \(rescore chain, \{0\} left, limit \{1\}, max-cost \{2\}\))'/);
  assert.ok(m, 'run-name must carry the rescore chain suffix');
  const rendered = 'LLM Ensemble Score Reviews' + m[1].replace('{0}', '3').replace('{1}', '400').replace('{2}', '15');
  assert.match(rendered, RESCORE_CHAIN_RE);
  // Empty inputs render as empty strings and must still parse (no cap restored).
  assert.match('LLM Ensemble Score Reviews' + m[1].replace('{0}', '3').replace('{1}', '').replace('{2}', ''), RESCORE_CHAIN_RE);
  assert.ok(/inputs\.remaining_batches, inputs\.limit, inputs\.max_cost\)/.test(runName), 'limit/max_cost must render raw (no word sentinel)');
  // Only plain chains get the suffix: inputs the parser cannot restore must exclude it.
  for (const k of ['!inputs.rescore_reason', '!inputs.shard', "inputs.outdated != 'true'", "inputs.stale_scores != 'true'", "inputs.upgrade_ensemble != 'true'", "inputs.retry_emergency != 'true'", "inputs.dry_run != 'true'", "inputs.rescore != 'true'", '!inputs.show_id']) {
    assert.ok(runName.includes(k), `run-name suffix guard missing ${k}`);
  }
});
