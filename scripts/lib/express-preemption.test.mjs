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
  assert.match(y, /^run-name: LLM Ensemble Score Reviews\$\{\{ inputs\.show_id && format\(' — \{0\}', inputs\.show_id\) \|\| '' \}\}$/m);
});
test('express passes its show id to both cancel calls', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/opening-night-express.yml', import.meta.url), 'utf8');
  assert.equal((y.match(/express-preemption\.js cancel "\$RUNNER_TEMP\/express-preempted\.json" --show="\$EXPRESS_SHOW_ID"/g) || []).length, 2);
});
