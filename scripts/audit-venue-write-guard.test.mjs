// Regression tests for scripts/audit-venue-write-guard.js / scripts/lib/venue-write-guard-detector.js
// (card #1923 — CI guard against future sanitizeVenueForWrite() cousins).
// CLAUDE.md §15: require() the real exported detector, never copy its logic
// into the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanVenueWrites, findUnguardedVenueWrites, isHardcodedStringRhs } = require('./lib/venue-write-guard-detector.js');
const { computeNewFindings, siteKey } = require('./audit-venue-write-guard.js');

// --- acceptance criteria: guarded passes, unguarded fails ---

test('a guarded venue: sanitizeVenueForWrite(x) write passes (no unguarded findings)', () => {
  const src = `function buildEntry(candidate) {\n  return {\n    id: candidate.id,\n    venue: sanitizeVenueForWrite(candidate.venue),\n  };\n}`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('an unguarded venue: candidate.venue write is flagged', () => {
  const src = `function buildEntry(candidate) {\n  return {\n    id: candidate.id,\n    venue: candidate.venue,\n  };\n}`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
  assert.equal(findings[0].kind, 'literal');
});

// --- ternary-of-sanitized-value pattern (card #1921's buildRegionalShowEntry fix) ---

test('venue: cond ? sanitizeVenueForWrite(x) : null passes — ternary RHS is captured whole', () => {
  const src = `const entry = {\n  venue: category ? sanitizeVenueForWrite(candidate.venue) : null,\n  category,\n};`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('venue: cond ? candidate.venue : null (no guard call anywhere) is still flagged', () => {
  const src = `const entry = {\n  venue: category ? candidate.venue : null,\n  category,\n};`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
});

// --- .venue = assignment form ---

test('an unguarded show.venue = raw assignment is flagged', () => {
  const src = `function enrich(show, tt) {\n  if (tt.venue) show.venue = tt.venue.trim();\n}`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'assignment');
});

test('a guarded show.venue = sanitizeVenueForWrite(x) assignment passes', () => {
  const src = `function enrich(show, tt) {\n  show.venue = sanitizeVenueForWrite(tt.venue);\n}`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

// --- object key must be exactly `venue`, not a similarly-named key ---

test('a differently-named key (venueName, primaryVenue) is not matched', () => {
  const src = `const x = { venueName: raw.venueName, primaryVenue: raw.primaryVenue };`;
  assert.deepEqual(scanVenueWrites(src), []);
});

// --- comparisons must not be mistaken for assignment ---

test('a .venue === comparison is not mistaken for an assignment', () => {
  const src = `function go(show, other) {\n  if (show.venue === other.venue) return true;\n}`;
  assert.deepEqual(scanVenueWrites(src), []);
});

// --- comment / string false positives ---

test('the literal text "venue:" inside a // comment is not a call site', () => {
  const src = `function go() {\n  // venue: candidate.venue -- historical note, not real code\n  return 1;\n}`;
  assert.deepEqual(scanVenueWrites(src), []);
});

// --- hardcoded string literal RHS is treated as safe (never carries scraped/junk data) ---

test('a hardcoded string literal venue is not flagged', () => {
  const src = `const entry = {\n  venue: "Studio 54",\n  title: "Cabaret",\n};`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('a template literal WITH interpolation is still flagged (can embed unsanitized data)', () => {
  const src = `const entry = {\n  venue: \`\${prefix} Theatre\`,\n};`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
});

test('isHardcodedStringRhs rejects an interpolated template but accepts a plain one', () => {
  assert.equal(isHardcodedStringRhs('"Studio 54"'), true);
  assert.equal(isHardcodedStringRhs('`Studio 54`'), true);
  assert.equal(isHardcodedStringRhs('`${x} Theatre`'), false);
  assert.equal(isHardcodedStringRhs('candidate.venue'), false);
});

// --- whole-file exemption comment ---

test('// venue-write-guard-ok: <reason> suppresses the whole file', () => {
  const src = `// venue-write-guard-ok: read-only report tool, venue already sanitized upstream\nfunction go(c) {\n  return { venue: c.venue };\n}`;
  assert.deepEqual(scanVenueWrites(src), []);
});

// --- multiple sites in one function: only the unguarded one is flagged ---

test('two venue writes, one guarded one not — only the unguarded one is flagged', () => {
  const src = `function go(a, b) {\n  const x = { venue: sanitizeVenueForWrite(a.venue) };\n  const y = { venue: b.venue };\n  return [x, y];\n}`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
});

// --- baseline diff logic (scripts/audit-venue-write-guard.js) ---

test('computeNewFindings drops a finding whose file:line:snippet already matches the baseline', () => {
  const findings = [{ file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: c.venue,' }];
  const baseline = { sites: { [siteKey(findings[0])]: { snippet: 'venue: c.venue,' } } };
  assert.deepEqual(computeNewFindings(findings, baseline), []);
});

test('computeNewFindings keeps a finding not present in the baseline', () => {
  const findings = [{ file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: c.venue,' }];
  const baseline = { sites: {} };
  assert.deepEqual(computeNewFindings(findings, baseline), findings);
});

test('computeNewFindings re-surfaces a site whose snippet changed even if the file:line key matches', () => {
  // An unrelated edit landing on the same line number as a baselined site
  // must be checked fresh, not silently inherit the old site's pass.
  const findings = [{ file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: someOtherRawField,' }];
  const baseline = { sites: { [siteKey(findings[0])]: { snippet: 'venue: c.venue,' } } };
  assert.deepEqual(computeNewFindings(findings, baseline), findings);
});

// --- full-repo regression: the current baseline covers everything scanRepo() finds ---

test('the checked-in baseline has zero new findings against the current repo (scripts/audit-venue-write-guard.js --strict passes)', () => {
  const { scanRepo, loadBaseline } = require('./audit-venue-write-guard.js');
  const findings = scanRepo();
  const baseline = loadBaseline();
  const newFindings = computeNewFindings(findings, baseline);
  assert.deepEqual(newFindings, [], `expected zero new (non-baselined) unguarded sites, got: ${JSON.stringify(newFindings, null, 2)}`);
});
