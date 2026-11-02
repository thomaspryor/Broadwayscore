// BRO-6858: 5-min orchestrator sleeps only in a Broadway show's first 2h after the embargo; input always wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pollIntervalMin } = require('../../scripts/lib/press-night-poll-plan.js');
const E = Date.parse('2026-11-09T03:00:00Z');
const M = 60000;
const bw = { id: 'wanted-2022', category: 'broadway', embargoMs: E };

test('fast only inside [embargo, +2h] for Broadway', () => {
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 30 * M }).intervalMin, 5);
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 121 * M }).intervalMin, 15);
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E - 10 * M }).intervalMin, 15);
  assert.equal(pollIntervalMin({ shows: [{ ...bw, category: 'off-broadway' }], nowMs: E + 30 * M }).intervalMin, 15);
  assert.equal(pollIntervalMin({ shows: [{ ...bw, embargoMs: NaN }], nowMs: E }).intervalMin, 15);
});

test('an explicit input wins; a default under 5 is never raised', () => {
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 30 * M, overrideMin: 20 }).intervalMin, 20);
  assert.equal(pollIntervalMin({ shows: [bw], nowMs: E + 30 * M, defaultMin: 3 }).intervalMin, 3);
});
