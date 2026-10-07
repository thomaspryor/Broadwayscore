// BRO-2431: acceptance guard against future sanitizeVenueForWrite() cousins.
// The detector (scripts/lib/venue-write-guard-detector.js) and the CI step
// (scripts/audit-venue-write-guard.js --strict) already exist; this test pins the
// repo-level guarantee: no NEW unguarded venue write exists beyond the frozen baseline.
// CLAUDE.md §15: require() the real functions, never copy their logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findUnguardedVenueWrites } = require('../../scripts/lib/venue-write-guard-detector.js');
const { scanRepo, loadBaseline, computeNewFindings } = require('../../scripts/audit-venue-write-guard.js');

test('live repo has no unguarded venue write outside the baseline', () => {
  const findings = scanRepo();
  const fresh = computeNewFindings(findings, loadBaseline());
  assert.deepEqual(
    fresh.map((f) => `${f.file}:${f.line} ${f.snippet}`),
    [],
    'new venue write skips sanitizeVenueForWrite(); route it through the guard',
  );
});

test('scan is non-vacuous (baseline still has frozen sites and the scan finds sites)', () => {
  assert.ok(Object.keys(loadBaseline().sites || {}).length > 0);
  assert.ok(scanRepo().length > 0);
});

test('a new raw venue write in a builder is flagged', () => {
  const src = `function buildShowEntry(c) {\n  return {\n    id: c.id,\n    venue: c.venue,\n  };\n}`;
  assert.equal(findUnguardedVenueWrites(src).length, 1);
});

test('a guarded write passes', () => {
  const src = `function buildShowEntry(c) {\n  return {\n    venue: sanitizeVenueForWrite(c.venue),\n  };\n}`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('a guard call defeated by an || fallback is flagged', () => {
  const src = `const e = {\n  venue: sanitizeVenueForWrite(c.venue) || c.venue,\n};`;
  assert.equal(findUnguardedVenueWrites(src).length, 1);
});
