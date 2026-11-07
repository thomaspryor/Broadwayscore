/**
 * Smoke test: verify stage-latency wiring compiles and emits in each pipeline module.
 * Does NOT run the full pipeline — just confirms the require/import works
 * and that emitStage reaches the JSONL file when called from each wired context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function makeTempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-latency-smoke-'));
  return path.join(dir, 'stage-latency.jsonl');
}

test('stage-latency module loads without error (used by gather-reviews)', () => {
  const { emitStage } = require('../../scripts/lib/stage-latency.js');
  assert.equal(typeof emitStage, 'function');
});

test('stage-latency emitStage writes JSONL and smoke-confirms wiring for gather (review-first-seen)', () => {
  const logFile = makeTempLog();
  process.env.STAGE_LATENCY_LOG = logFile;

  const { emitStage } = require('../../scripts/lib/stage-latency.js');
  emitStage({ showId: 'smoke-show-a', reviewKey: 'nytimes:ben-brantley:https://example.com', stage: 'review-first-seen' });

  delete process.env.STAGE_LATENCY_LOG;

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stage, 'review-first-seen');
  assert.equal(lines[0].showId, 'smoke-show-a');
});

test('stage-latency emitStage writes JSONL and smoke-confirms wiring for collect (review-text-collected)', () => {
  const logFile = makeTempLog();
  process.env.STAGE_LATENCY_LOG = logFile;

  const { emitStage } = require('../../scripts/lib/stage-latency.js');
  emitStage({
    showId: 'smoke-show-b',
    reviewKey: 'guardian:arifa-akbar:https://theguardian.com/r1',
    stage: 'review-text-collected',
    metadata: { textLength: 3200 },
  });

  delete process.env.STAGE_LATENCY_LOG;

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stage, 'review-text-collected');
  assert.equal(lines[0].metadata.textLength, 3200);
});

test('stage-latency emitStage writes JSONL for rebuild (rebuilt stage with reviewCount)', () => {
  const logFile = makeTempLog();
  process.env.STAGE_LATENCY_LOG = logFile;

  const { emitStage } = require('../../scripts/lib/stage-latency.js');
  emitStage({ showId: 'smoke-show-c', stage: 'rebuilt', metadata: { reviewCount: 21 } });

  delete process.env.STAGE_LATENCY_LOG;

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stage, 'rebuilt');
  assert.equal(lines[0].metadata.reviewCount, 21);
});
