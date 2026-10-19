import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadState, saveState, inErrorBackoff, orderTargets, recordAttempt, pruneState, ERROR_BACKOFF_DAYS } = require('./recollect-state');

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

test('pruneState drops only this outlet\'s keys that are no longer targets', () => {
  const state = { 'show-a/ew--x.json': {}, 'show-b/ew--y.json': {}, 'show-a/new-ew--x.json': {}, 'show-a/timeout--x.json': {} };
  pruneState(state, '/ew--', ['show-a/ew--x.json']);
  assert.deepEqual(Object.keys(state).sort(), ['show-a/ew--x.json', 'show-a/new-ew--x.json', 'show-a/timeout--x.json']);
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

test('every outlet in the weekly recollect list has a real score extractor', () => {
  // 'city-am' sat in the list for weeks with no extractor and exited "No extractor" (BRO-5675).
  const { OUTLET_EXTRACTORS } = require('./score-extractors');
  const wf = fs.readFileSync(new URL('../../.github/workflows/recollect-for-scores.yml', import.meta.url), 'utf8');
  const lists = [...wf.matchAll(/^\s*OUTLETS="([a-z0-9,-]+)"/gm)].map(m => m[1].split(','));
  assert.ok(lists.length > 0, 'no OUTLETS="..." list found in recollect-for-scores.yml');
  for (const outlet of lists.flat()) {
    const fn = OUTLET_EXTRACTORS[outlet];
    assert.ok(fn && fn.name !== 'noScoreExtractor', `recollect outlet "${outlet}" has no score extractor`);
  }
});
