import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { shouldSkipWatermarkDispatch } = require('./deploy-watermark-throttle.js');

const NOW = Date.parse('2026-09-08T00:00:00.000Z');

test('skips when watermark and global deploy telemetry are fresh', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-throttle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'stage.jsonl');
  fs.writeFileSync(logFile, JSON.stringify({ stage: 'deployed-live', at: '2026-09-07T23:50:00.000Z' }) + '\n');
  const r = shouldSkipWatermarkDispatch({
    updatedAtRaw: '2026-09-07T23:45:00.000Z', // 15min ago
    nowMs: NOW,
    intervalMinutes: 30,
    logFile,
  });
  assert.equal(r.skip, true);
});

test('ignores old, future, malformed and show-specific deployment events', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-throttle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'stage.jsonl');
  fs.writeFileSync(logFile, [
    '{"stage":"deployed-live",',
    JSON.stringify({ stage: 'deployed-live', at: '2026-09-07T23:29:00.000Z' }),
    JSON.stringify({ stage: 'deployed-live', at: '2026-09-08T00:01:00.000Z' }),
    JSON.stringify({ stage: 'deployed-live', at: '2026-09-07T23:59:00.000Z', showId: 'a' }),
  ].join('\n') + '\n');
  assert.equal(shouldSkipWatermarkDispatch({ updatedAtRaw: '2026-09-07T23:59:00.000Z', nowMs: NOW, intervalMinutes: 30, logFile }).skip, false);
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

test('a fresh rebuild watermark cannot suppress a deploy event when telemetry is missing', () => {
  const r = shouldSkipWatermarkDispatch({
    updatedAtRaw: '2026-09-07T23:45:00.000Z', nowMs: NOW, intervalMinutes: 30,
    logFile: '/nonexistent/bro-7661-stage-latency.jsonl',
  });
  assert.equal(r.skip, false);
});
