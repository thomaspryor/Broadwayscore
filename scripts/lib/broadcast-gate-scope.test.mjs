import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scopeBreaches, outputLines } = require('./broadcast-gate-scope.js');

test('2026-11-16: a breached refresh show does not block a ready new draft', () => {
  const s = scopeBreaches({ breached: 'cloud-9-west-end-2026', pending: 'downstate-2026', refresh: 'cloud-9-west-end-2026' });
  assert.equal(s.blocked, false);
  assert.equal(s.refreshBlocked, true);
  assert.deepEqual(outputLines(s), ['blocked=false', 'refresh_blocked=true']);
});

test('a breached new-draft show blocks new drafts but not refreshes', () => {
  const s = scopeBreaches({ breached: 'downstate-2026', pending: 'downstate-2026', refresh: 'cloud-9-west-end-2026' });
  assert.equal(s.blocked, true);
  assert.equal(s.refreshBlocked, false);
});

test('one breached pending show still holds the whole pending batch', () => {
  const s = scopeBreaches({ breached: 'a', pending: 'a,b', refresh: '' });
  assert.equal(s.blocked, true);
});

test('nothing breached blocks nothing', () => {
  assert.deepEqual(outputLines(scopeBreaches({ breached: '', pending: 'a', refresh: 'b' })), ['blocked=false', 'refresh_blocked=false']);
});

test('a show in both lists blocks both', () => {
  const s = scopeBreaches({ breached: 'a', pending: 'a', refresh: 'a' });
  assert.equal(s.blocked, true);
  assert.equal(s.refreshBlocked, true);
});

test('a breached id in neither list fails closed on both', () => {
  const s = scopeBreaches({ breached: 'ghost', pending: 'a', refresh: 'b' });
  assert.equal(s.blocked, true);
  assert.equal(s.refreshBlocked, true);
});
