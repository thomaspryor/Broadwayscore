import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { emitStage, rotateIfNeeded } = require('../../scripts/lib/stage-latency.js');

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

test('rotateIfNeeded is a no-op below the size threshold', () => {
  const logFile = makeTempLog();
  fs.writeFileSync(logFile, '{"showId":"a","stage":"scored"}\n'.repeat(10));
  const before = fs.readFileSync(logFile, 'utf8');

  assert.equal(rotateIfNeeded(logFile, 1024 * 1024, 512 * 1024), false);
  assert.equal(fs.readFileSync(logFile, 'utf8'), before, 'file should be untouched');
});

test('rotateIfNeeded is a no-op when the file does not exist', () => {
  const logFile = makeTempLog();
  assert.equal(rotateIfNeeded(logFile, 100, 50), false);
});

test('rotateIfNeeded trims to newest lines, aligned to a line boundary', () => {
  const logFile = makeTempLog();
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    lines.push(JSON.stringify({ showId: `show-${i}`, stage: 'scored', seq: i }));
  }
  fs.writeFileSync(logFile, lines.join('\n') + '\n');
  const originalSize = fs.statSync(logFile).size;

  const rotated = rotateIfNeeded(logFile, 1024, 512);
  assert.equal(rotated, true);

  const size = fs.statSync(logFile).size;
  assert.ok(size <= 512, `rotated size ${size} should be <= retain bytes`);
  assert.ok(size < originalSize, 'file should have shrunk');

  const kept = readLines(logFile);
  assert.ok(kept.length > 0, 'should keep some lines');
  // Every kept line parses (checked by readLines) and they are the NEWEST ones
  assert.equal(kept[kept.length - 1].seq, 999, 'last line must be the newest entry');
  for (let i = 1; i < kept.length; i++) {
    assert.equal(kept[i].seq, kept[i - 1].seq + 1, 'kept lines must be contiguous');
  }
});

test('emitStage rotates an oversized log before appending', () => {
  const { MAX_LOG_BYTES, RETAIN_BYTES } = require('../../scripts/lib/stage-latency.js');
  const logFile = makeTempLog();
  const line = '{"showId":"old","stage":"scored"}\n';
  const repeats = Math.ceil((MAX_LOG_BYTES + 1024) / line.length);
  fs.writeFileSync(logFile, line.repeat(repeats));
  assert.ok(fs.statSync(logFile).size > MAX_LOG_BYTES, 'setup: file must exceed threshold');

  process.env.STAGE_LATENCY_LOG = logFile;
  emitStage({ showId: 'show-new', stage: 'rebuilt' });
  delete process.env.STAGE_LATENCY_LOG;

  const size = fs.statSync(logFile).size;
  assert.ok(size <= RETAIN_BYTES + 1024, `size ${size} should be near retain bytes after rotation`);

  const kept = readLines(logFile);
  assert.equal(kept[kept.length - 1].showId, 'show-new', 'append still lands after rotation');
});
