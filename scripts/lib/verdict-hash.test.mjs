#!/usr/bin/env node
// scripts/lib/verdict-hash.test.mjs — unit tests for content-equivalent hash.
//
// The contract these tests enforce:
//   1. Two verdict objects with identical stable inputs hash identically.
//   2. Mutating any stable input (paths, widths, refsDigest bytes, refRole,
//      element geometry, screenshot bytes, overflow signature, verdicts
//      verdict strings, overallPass, headSha) rotates the hash.
//   3. Metadata mutations (timestamp, runId, raw file paths, textPreview)
//      do NOT rotate the hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeContentHash,
  generateRunId,
  stableStringify,
  VERDICT_SCHEMA_VERSION,
} from './verdict-hash.mjs';

function baseVerdict() {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    branch: 'feat/foo',
    headSha: 'abc123',
    url: 'http://localhost:3000',
    paths: ['/'],
    widths: [360, 768, 1440],
    elements: ['.score-badge'],
    refsDigest: [{ bytesSha: 'ref-bytes-aaa', role: 'goal' }],
    screenshotsDigest: [{ path: '/', width: 360, bytesSha: 'ss-aaa' }],
    elementCropsDigest: [
      { path: '/', width: 360, selector: '.score-badge', geometry: { w: 80, h: 32, x: 10, y: 20 }, bytesSha: 'crop-aaa' },
    ],
    overflowReportForHash: [],
    verdicts: { openai: { verdict: 'PASS', issues: [] }, gemini: { verdict: 'PASS', issues: [] } },
    overallPass: true,
    // Metadata — must not affect hash:
    timestamp: '2026-05-25T03:00:00.000Z',
    runId: 'run-1',
    contentHash: null,
  };
}

test('identical stable inputs → identical contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  assert.equal(computeContentHash(a), computeContentHash(b));
});

test('different timestamp → SAME contentHash (timestamp is metadata)', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.timestamp = '2026-05-26T03:00:00.000Z';
  b.runId = 'run-99';
  assert.equal(computeContentHash(a), computeContentHash(b));
});

test('different branch → SAME contentHash (branch is metadata, /ship-check P0-1)', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.branch = 'feat/other-branch';
  assert.equal(computeContentHash(a), computeContentHash(b));
});

test('per-screenshot path metadata change → SAME contentHash (only bytesSha matters)', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.screenshotsDigest[0].path = '/different-route';
  b.screenshotsDigest[0].width = 9999;
  // bytesSha unchanged → still the same image content
  assert.equal(computeContentHash(a), computeContentHash(b));
});

test('per-crop selector change → DIFFERENT contentHash (selector is part of identity)', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.elementCropsDigest[0].selector = '.different-selector';
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('different element geometry → DIFFERENT contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.elementCropsDigest[0].geometry = { w: 40, h: 32, x: 10, y: 20 }; // collapsed width
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('different screenshot bytes → DIFFERENT contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.screenshotsDigest[0].bytesSha = 'ss-changed';
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('different ref bytes → DIFFERENT contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.refsDigest[0].bytesSha = 'ref-bytes-bbb';
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('different ref role (goal vs before) → DIFFERENT contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.refsDigest[0].role = 'before';
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('different headSha → DIFFERENT contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.headSha = 'def456';
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('LLM verdict flip → DIFFERENT contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.verdicts.openai.verdict = 'FAIL';
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('different overallPass → DIFFERENT contentHash', () => {
  const a = baseVerdict();
  const b = baseVerdict();
  b.overallPass = false;
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('throws on non-object input', () => {
  assert.throws(() => computeContentHash(null));
  assert.throws(() => computeContentHash('a string'));
});

test('generateRunId returns distinct values', () => {
  assert.notEqual(generateRunId(), generateRunId());
});

test('stableStringify sorts nested object keys', () => {
  const out = stableStringify({ b: 1, a: { d: 4, c: 3 } });
  assert.equal(out, '{"a":{"c":3,"d":4},"b":1}');
});

test('stableStringify preserves array order', () => {
  const out = stableStringify([3, 1, 2]);
  assert.equal(out, '[3,1,2]');
});
