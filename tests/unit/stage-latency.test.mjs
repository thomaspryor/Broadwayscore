import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { emitStage } = require('../../scripts/lib/stage-latency.js');

function makeTempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-latency-'));
  return path.join(dir, 'stage-latency.jsonl');
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('emitStage appends three valid JSONL lines to the temp file', () => {
  const logFile = makeTempLog();
  process.env.STAGE_LATENCY_LOG = logFile;

  emitStage({ showId: 'show-a', reviewKey: 'bway-world:jane:https://example.com/r1', stage: 'review-first-seen' });
  emitStage({ showId: 'show-a', reviewKey: 'bway-world:jane:https://example.com/r1', stage: 'review-text-collected', metadata: { bytes: 4200 } });
  emitStage({ showId: 'show-a', stage: 'rebuilt', metadata: { reviewCount: 21 } });

  delete process.env.STAGE_LATENCY_LOG;

  const lines = readLines(logFile);
  assert.equal(lines.length, 3, 'should have 3 lines');

  assert.equal(lines[0].stage, 'review-first-seen');
  assert.equal(lines[0].showId, 'show-a');
  assert.equal(lines[0].reviewKey, 'bway-world:jane:https://example.com/r1');
  assert.ok(lines[0].at, 'should have at timestamp');

  assert.equal(lines[1].stage, 'review-text-collected');
  assert.deepEqual(lines[1].metadata, { bytes: 4200 });

  assert.equal(lines[2].stage, 'rebuilt');
  assert.equal(lines[2].reviewKey, null, 'missing reviewKey should be null');
  assert.deepEqual(lines[2].metadata, { reviewCount: 21 });
});

test('emitStage accepts an explicit at timestamp', () => {
  const logFile = makeTempLog();
  process.env.STAGE_LATENCY_LOG = logFile;

  const fixedAt = '2026-04-16T03:00:00.000Z';
  emitStage({ showId: 'show-b', stage: 'scored', at: fixedAt });

  delete process.env.STAGE_LATENCY_LOG;

  const lines = readLines(logFile);
  assert.equal(lines[0].at, fixedAt);
});

test('emitStage creates parent directory if it does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-latency-deep-'));
  const logFile = path.join(dir, 'nested', 'sub', 'stage-latency.jsonl');
  process.env.STAGE_LATENCY_LOG = logFile;

  emitStage({ showId: 'show-c', stage: 'deployed-live' });

  delete process.env.STAGE_LATENCY_LOG;

  assert.ok(fs.existsSync(logFile), 'log file should be created even in nested path');
  const lines = readLines(logFile);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stage, 'deployed-live');
});
