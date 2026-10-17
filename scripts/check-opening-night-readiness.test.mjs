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
const { readinessFailureAlert, readinessRunAction, marketCoversShow, verifyLineFor, escapeAnnotation } = require('./route-readiness-failure.js');
const { readinessMarket, isWestEndReadinessMarket } = require('./lib/readiness-market.js');
const { verifyCommand } = require('./lib/linear-drain-parked.js');
const { decide } = require('./check-alert-condition-absent.js');
const { isPageWorthy } = require('./lib/page-worthy-alerts.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('auto-triggered failure files a High (P1) dispatch-now card', () => {
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
  // The market input is a choice (auto|broadway|west-end); passing a raw
  // category such as off-broadway is rejected at dispatch (BRO-5261).
  assert.match(line, /-f market=auto\b/);
});

test('readiness workflow keeps severity warning and routes unattended failures', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/check-opening-night-readiness.yml'), 'utf8');
  assert.match(yml, /triggered_by:/);
  assert.match(yml, /severity: 'warning'/);
  assert.match(yml, /node scripts\/route-readiness-failure\.js/);
  assert.match(yml, /--market="\$MARKET"/, 'the resolve path needs the run market (BRO-5261)');
});

test('a passing run resolves; an attended failure does nothing', () => {
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'success' }), 'resolve');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'success', triggeredBy: 'update-show-status' }), 'resolve');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'failure', triggeredBy: 'update-show-status' }), 'route');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'failure' }), 'none');
  assert.equal(readinessRunAction({ showId: 'x', outcome: 'cancelled', triggeredBy: 'update-show-status' }), 'none');
});

test('the card carries a VERIFY line the cloud worker accepts, scoped to its own show (BRO-5261)', () => {
  const a = readinessFailureAlert({ showId: 'x-2026', triggeredBy: 'update-show-status' });
  assert.equal(a.verify.line, verifyLineFor('x-2026'));
  const cmd = verifyCommand({ description: `body\n\n${a.verify.line}\n`, comments: { nodes: [] } });
  assert.match(cmd, /^node scripts\/check-alert-condition-absent\.js --key-b64 [A-Za-z0-9_-]+$/);
  const tok = cmd.split(' ').pop();
  assert.equal(Buffer.from(tok, 'base64url').toString('utf8'), 'opening-readiness:failed:x-2026');
});

test('VERIFY verdicts: own show only, a missing ledger entry is never a pass (BRO-5261)', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const fresh = '2026-10-13T10:00:00Z';
  const L = (conditions) => [{ path: 'fixture', conditions: { 'other:fresh': { status: 'open', lastSeen: fresh }, ...conditions } }];
  const key = 'opening-readiness:failed:x-2026';
  // Another show's open condition does not block this card.
  assert.equal(decide(L({ [key]: { status: 'resolved', lastSeen: '2026-10-13T08:00:00Z', resolvedAt: fresh }, 'opening-readiness:failed:y-2026': { status: 'open', lastSeen: fresh } }), key, now).code, 0);
  assert.equal(decide(L({ [key]: { status: 'open', lastSeen: fresh } }), key, now).code, 1);
  // The ledger commit failed: no entry at all is "cannot tell", not a pass.
  assert.equal(decide(L({}), key, now).code, 3);
});

test('a passing run resolves only when it covered the show\'s own market checks (BRO-5261)', () => {
  assert.equal(marketCoversShow({ market: 'auto', category: null }), true);
  assert.equal(marketCoversShow({ market: '', category: 'west-end' }), true);
  assert.equal(marketCoversShow({ market: 'broadway', category: 'off-broadway' }), true);
  assert.equal(marketCoversShow({ market: 'west-end', category: 'off-west-end' }), true);
  assert.equal(marketCoversShow({ market: 'broadway', category: 'west-end' }), false);
  assert.equal(marketCoversShow({ market: 'west-end', category: 'broadway' }), false);
  assert.equal(marketCoversShow({ market: 'broadway', category: null }), false, 'unknown show + override: do not resolve');
});

test('readiness market rule is shared by the check and the resolve path (BRO-5261)', () => {
  assert.equal(readinessMarket('', 'off-west-end'), 'off-west-end');
  assert.equal(readinessMarket('auto', undefined), 'broadway');
  assert.equal(readinessMarket('west-end', 'broadway'), 'west-end');
  assert.equal(isWestEndReadinessMarket('off-west-end'), true);
  assert.equal(isWestEndReadinessMarket('off-broadway'), false);
  const src = fs.readFileSync(path.join(root, 'scripts/check-opening-night-readiness.js'), 'utf8');
  assert.match(src, /readinessMarket\(MARKET, show\.category\)/);
  assert.match(src, /isWestEndReadinessMarket\(market\)/);
});

test('the filing-failure annotation escapes %, CR and LF (BRO-5261)', () => {
  assert.equal(escapeAnnotation('100% down\r\nnext'), '100%25 down%0D%0Anext');
});
