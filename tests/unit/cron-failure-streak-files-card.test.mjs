// BRO-8269: the "failing every scheduled run" row must be actionable (files a card).
// With urgency 'low' it never was: weekly sweeps stayed red for weeks with no card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const h = require('../../scripts/health-check.js');

test('failing-every-scheduled-run warn row is actionable and has a card action', () => {
  const row = { name: 'Cron: failing every scheduled run', status: 'warn', message: 'x' };
  assert.equal(h.isActionableResult(row), true);
  const entry = h.getPlaybookEntry(row.name);
  assert.ok(entry.humanAction, 'needs humanAction so routeAlert files the card');
  assert.notEqual(entry.urgency, 'low');
});
