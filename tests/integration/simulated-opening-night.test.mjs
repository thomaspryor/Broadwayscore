// BRO-7781: a whole simulated opening night through the real lane code (discovery, matcher, near-miss alarm, manual inbox,
// fetch, recorded scoring, persist/publish, real rebuild, score gate, alerts) on a fake clock against local synthetic outlets.
// Hermetic: any request off 127.0.0.1 fails the night. Mutation proof: node scripts/lib/game-day/mutants.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runSimulatedNight, formatReport } = require('../../scripts/lib/game-day/simulated-opening-night.js');

test('the simulated opening night publishes every expected review, alarms each deliberate miss once, and stays hermetic', { timeout: 10 * 60 * 1000 }, async () => {
  const report = await runSimulatedNight({ log: () => {} });
  const text = formatReport(report);
  console.log(text);
  const failed = report.checks.filter((c) => !c.ok);
  assert.equal(failed.length, 0, `failed checks:\n${failed.map((c) => `- ${c.name}: ${JSON.stringify(c.detail || '').slice(0, 400)}`).join('\n')}`);
  assert.ok(report.checks.length >= 20, `expected the full check set, got ${report.checks.length}`);
  assert.ok(Array.isArray(report.foundToLive) && report.foundToLive.length >= 13, 'found-to-live measured for every published review');
  assert.equal(report.pass, true);
});
