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
