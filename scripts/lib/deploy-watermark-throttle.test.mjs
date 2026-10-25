import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldSkipWatermarkDispatch } = require('./deploy-watermark-throttle.js');

const NOW = Date.parse('2026-09-08T00:00:00.000Z');

test('skips when watermark is fresher than the interval floor', () => {
  const r = shouldSkipWatermarkDispatch({
    updatedAtRaw: '2026-09-07T23:45:00.000Z', // 15min ago
    nowMs: NOW,
    intervalMinutes: 30,
  });
  assert.equal(r.skip, true);
});

test('dispatches when watermark is at least as old as the interval floor', () => {
  const r = shouldSkipWatermarkDispatch({
    updatedAtRaw: '2026-09-07T23:29:00.000Z', // 31min ago
    nowMs: NOW,
    intervalMinutes: 30,
  });
  assert.equal(r.skip, false);
});

test('fails open (dispatches) with no prior timestamp', () => {
  assert.equal(shouldSkipWatermarkDispatch({ updatedAtRaw: '', nowMs: NOW, intervalMinutes: 30 }).skip, false);
  assert.equal(shouldSkipWatermarkDispatch({ updatedAtRaw: undefined, nowMs: NOW, intervalMinutes: 30 }).skip, false);
});

test('fails open (dispatches) on an unparseable timestamp — never silently suppress forever', () => {
  const r = shouldSkipWatermarkDispatch({ updatedAtRaw: 'not-a-date', nowMs: NOW, intervalMinutes: 30 });
  assert.equal(r.skip, false);
});

test('fails open on a future timestamp (clock skew), rather than skipping', () => {
  const r = shouldSkipWatermarkDispatch({
    updatedAtRaw: '2026-09-08T00:10:00.000Z', // 10min in the future
    nowMs: NOW,
    intervalMinutes: 30,
  });
  assert.equal(r.skip, false);
});

test('exactly at the floor dispatches (not-less-than, matches should-deploy-gate\'s >= convention)', () => {
  const r = shouldSkipWatermarkDispatch({
    updatedAtRaw: '2026-09-07T23:30:00.000Z', // exactly 30min ago
    nowMs: NOW,
    intervalMinutes: 30,
  });
  assert.equal(r.skip, false);
});
