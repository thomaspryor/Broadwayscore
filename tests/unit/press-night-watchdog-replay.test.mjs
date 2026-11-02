// BRO-6858: the watchdog replayed on two recorded press nights with their real GitHub runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replayNight, runsAt } = require('../../scripts/press-night-watchdog-replay.js');
const { normalizeOutlet } = require('../../scripts/lib/review-normalization');
const norm = (o) => (o ? normalizeOutlet(String(o)) || String(o).toLowerCase() : null);
const load = (p) => JSON.parse(fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const night = (id, n) => ({ record: load(`data/audit/press-night/${id}-${n}.json`), runs: load(`tests/fixtures/press-night-watchdog-replay/runs-${id}-${n}.json`) });

test('A Few Good Men 10-29 with its real runs: the poller was moving, so no page and one late score retry', () => {
  const { record, runs } = night('a-few-good-men-2026', '2026-10-29');
  const r = replayNight({ record, runs, normOutlet: norm });
  assert.equal(r.pages.length, 0);
  assert.deepEqual(r.dispatches.map((d) => `${d.atMin}:${d.type}:${d.stage || ''}`), ['90:dispatch:score']);
});

test('A Few Good Men 10-29 with no pipeline at all: orchestrator at the embargo, page 20 min later, resolved once live', () => {
  const { record } = night('a-few-good-men-2026', '2026-10-29');
  const r = replayNight({ record, runs: null, normOutlet: norm });
  assert.equal(r.dispatches[0].type, 'dispatch-orchestrator');
  assert.deepEqual(r.pages.map((p) => p.atMin), [20]);
  assert.ok(r.acted.some((t) => t.actions.some((a) => a.type === 'resolve')));
});

test('Imaginary Invalid 10-22 with its real runs: starts the orchestrator the cron started 19 min late; no page', () => {
  const { record, runs } = night('the-imaginary-invalid-2026', '2026-10-22');
  const r = replayNight({ record, runs, normOutlet: norm });
  assert.equal(r.pages.length, 0);
  assert.deepEqual(r.dispatches.map((d) => `${d.atMin}:${d.type}`), ['0:dispatch-orchestrator', '100:dispatch']);
});

test('runsAt: a run is active between its start and its last update, unseen before it starts', () => {
  const run = { workflow: 'opening-night-poller.yml', status: 'completed', conclusion: 'success', startedAt: '2026-10-30T02:00:00Z', updatedAt: '2026-10-30T03:00:00Z' };
  assert.equal(runsAt([run], Date.parse('2026-10-30T01:59:00Z')).length, 0);
  assert.equal(runsAt([run], Date.parse('2026-10-30T02:30:00Z'))[0].status, 'in_progress');
  assert.equal(runsAt([run], Date.parse('2026-10-30T03:01:00Z'))[0].conclusion, 'success');
});
