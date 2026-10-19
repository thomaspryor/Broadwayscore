import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadState, saveState, inErrorBackoff, orderTargets, recordAttempt, ERROR_BACKOFF_DAYS } = require('./recollect-state');

const now = Date.parse('2026-10-19T00:00:00Z');
const daysAgo = d => new Date(now - d * 86_400_000).toISOString();

test('never-attempted first, then oldest attempt first, ties keep input order', () => {
  const state = { a: { lastAttemptAt: daysAgo(1) }, b: { lastAttemptAt: daysAgo(10) } };
  const keys = orderTargets([{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }], state, now).map(t => t.key);
  assert.deepEqual(keys, ['c', 'd', 'b', 'a']);
});

test('an errored target backs off, then comes back after the window', () => {
  const recent = { b: { lastAttemptAt: daysAgo(7), lastError: 'All scraping methods failed' } };
  assert.deepEqual(orderTargets([{ key: 'a' }, { key: 'b' }], recent, now).map(t => t.key), ['a']);
  const old = { b: { lastAttemptAt: daysAgo(ERROR_BACKOFF_DAYS + 1), lastError: 'x' } };
  assert.deepEqual(orderTargets([{ key: 'a' }, { key: 'b' }], old, now).map(t => t.key), ['a', 'b']);
  assert.equal(inErrorBackoff({ lastAttemptAt: daysAgo(1) }, now), false); // success never backs off
  assert.equal(inErrorBackoff({ lastAttemptAt: 'garbage', lastError: 'x' }, now), false);
});

test('recordAttempt clears an old error on success; state round-trips; bad file reads empty', () => {
  const state = {};
  recordAttempt(state, 'k', 'boom', now);
  assert.equal(state.k.lastError, 'boom');
  recordAttempt(state, 'k', null, now);
  assert.deepEqual(state.k, { lastAttemptAt: new Date(now).toISOString() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recollect-state-'));
  const file = path.join(dir, 's.json');
  saveState(file, state);
  assert.deepEqual(loadState(file), state);
  fs.writeFileSync(file, '[1,2]');
  assert.deepEqual(loadState(file), {});
  assert.deepEqual(loadState(path.join(dir, 'missing.json')), {});
});
