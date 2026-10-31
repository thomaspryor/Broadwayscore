/**
 * BRO-3475: check-opening-night-drift.yml must route the alert BEFORE it commits
 * drift-state.json (the script stamps lastAlertTs at decide time), and the commit
 * step must run under always() so a routing failure still persists the ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yml = fs.readFileSync(new URL('../../.github/workflows/check-opening-night-drift.yml', import.meta.url), 'utf8');
const idx = (s) => yml.indexOf(`- name: ${s}`);

test('alert routing step precedes the drift-state commit step', () => {
  const route = idx('Route drift alerts per show');
  const commit = idx('Commit updated drift state');
  assert.ok(route > 0 && commit > 0, 'both steps exist');
  assert.ok(route < commit, 'route must come first');
});

test('commit step runs under always() and the router never rethrows', () => {
  const commit = yml.slice(idx('Commit updated drift state'));
  assert.match(commit.split('run:')[0], /if:\s*always\(\)/);
  assert.match(yml, /Never rethrow/);
});
