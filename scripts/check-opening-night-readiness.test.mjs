// BRO-3038: an opening-night readiness failure from an UNATTENDED run
// (update-show-status.yml, the morning before opening) files a dispatch-now
// card; a hand-dispatched run files nothing. require()s the real decision
// (CLAUDE.md §15) and pins the two workflow files that carry the signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readinessFailureAlert, readinessRunAction, VERIFY_LINE } = require('./route-readiness-failure.js');
const { verifyCommand } = require('./lib/linear-drain-parked.js');
const { isPageWorthy } = require('./lib/page-worthy-alerts.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('auto-triggered failure files a P1 dispatch-now card', () => {
  const a = readinessFailureAlert({ showId: 'x-2026', triggeredBy: 'update-show-status', runId: 42, runUrl: 'https://run/42' });
  assert.equal(a.disposition, 'auto');
  assert.equal(a.severity, 'error'); // High: the router derives priority from severity
  assert.equal(a.conditionKey, 'opening-readiness:failed:x-2026');
  assert.deepEqual(a.dispatchAtFiling, { runId: '42', runUrl: 'https://run/42' });
});

test('hand-dispatched run (no triggered_by) files nothing', () => {
  assert.equal(readinessFailureAlert({ showId: 'x-2026', triggeredBy: '' }), null);
  assert.equal(readinessFailureAlert({ showId: 'x-2026' }), null);
  assert.equal(readinessFailureAlert({ showId: 'x-2026', triggeredBy: 'someone-else' }), null);
});

test('the card never emails the owner (BRO-4603: worker-fixable, not page-worthy)', () => {
  const a = readinessFailureAlert({ showId: 'x-2026', triggeredBy: 'update-show-status' });
  assert.equal(isPageWorthy(a.conditionKey), false);
});

test('update-show-status.yml marks its dispatch as unattended', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/update-show-status.yml'), 'utf8');
  const line = yml.split('\n').find((l) => l.includes('gh workflow run check-opening-night-readiness.yml'));
  assert.ok(line, 'dispatch line not found');
  assert.match(line, /-f triggered_by=update-show-status/);
});

test('readiness workflow keeps severity warning and routes unattended failures', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/check-opening-night-readiness.yml'), 'utf8');
  assert.match(yml, /triggered_by:/);
  assert.match(yml, /severity: 'warning'/);
  assert.match(yml, /node scripts\/route-readiness-failure\.js/);
});

test('a passing run resolves; an attended failure does nothing', () => {
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'success' }), 'resolve');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'success', triggeredBy: 'update-show-status' }), 'resolve');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'failure', triggeredBy: 'update-show-status' }), 'route');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'failure' }), 'none');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'cancelled', triggeredBy: 'update-show-status' }), 'none');
});

test('the card carries a VERIFY line the cloud worker accepts (no-safe-verify cards are never picked)', () => {
  const a = readinessFailureAlert({ showId: 'x-2026', triggeredBy: 'update-show-status' });
  assert.equal(a.verify.line, VERIFY_LINE);
  assert.equal(verifyCommand({ description: `body\n\n${a.verify.line}\n`, comments: { nodes: [] } }), 'node --test tests/live/opening-readiness-clear.test.mjs');
});
