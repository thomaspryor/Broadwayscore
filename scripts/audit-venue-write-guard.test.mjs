// Regression tests for scripts/audit-venue-write-guard.js / scripts/lib/venue-write-guard-detector.js
// (card #1923 — CI guard against future sanitizeVenueForWrite() cousins).
// CLAUDE.md §15: require() the real exported detector, never copy its logic
// into the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanVenueWrites, findUnguardedVenueWrites, isHardcodedStringRhs, isGuardCallDefeatedByFallback, isNullLiteralRhs } = require('./lib/venue-write-guard-detector.js');
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

// --- quoted key / bracket-notation / compound-assignment shapes (adversarial-review findings) ---

test('a quoted object key ("venue": raw) is flagged just like the bare form', () => {
  const src = `const x = { "venue": raw.venue };`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
});

test('bracket-notation assignment (show["venue"] = raw) is flagged', () => {
  const src = `function go(show, raw) { show["venue"] = raw.venue; }`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'assignment');
});

test('a guarded bracket-notation assignment passes', () => {
  const src = `function go(show, x) { show["venue"] = sanitizeVenueForWrite(x.venue); }`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('compound assignment (show.venue ||= raw) is flagged — the bare "= " regex missed this entirely', () => {
  const src = `function go(show, raw) { show.venue ||= raw.venue; }`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
});

test('a string literal that reads exactly "venue" as an unrelated VALUE is not mistaken for a key/bracket write', () => {
  // field: 'venue' / checks.push('venue') style config — real patterns in
  // this codebase (scripts/validate-show-venue.js, scripts/update-show-status.js).
  const src = `function go(field) {
    if (field === "venue") return true;
    const schema = { field: "venue", label: "Venue" };
    checks.push("venue");
    return schema;
  }`;
  assert.deepEqual(scanVenueWrites(src), []);
});

// --- guard call defeated by a non-null fallback (adversarial-review finding) ---

test('sanitizeVenueForWrite(x) || x restores exactly what it just rejected — flagged, not guarded', () => {
  const src = `function go(c) { return { venue: sanitizeVenueForWrite(c.venue) || c.venue }; }`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
});

test('sanitizeVenueForWrite(x) || null is still guarded — null is a safe fallback', () => {
  const src = `function go(c) { return { venue: sanitizeVenueForWrite(c.venue) || null }; }`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('isGuardCallDefeatedByFallback: true for || <non-null>, false for bare call or || null', () => {
  assert.equal(isGuardCallDefeatedByFallback('sanitizeVenueForWrite(x) || x'), true);
  assert.equal(isGuardCallDefeatedByFallback('sanitizeVenueForWrite(x) || rawVenue'), true);
  assert.equal(isGuardCallDefeatedByFallback('sanitizeVenueForWrite(x) || null'), false);
  assert.equal(isGuardCallDefeatedByFallback('sanitizeVenueForWrite(x)'), false);
  assert.equal(isGuardCallDefeatedByFallback('candidate.venue'), false);
});

test('raw || sanitizeVenueForWrite(raw) is ALSO defeated — the guard call is the fallback, JS short-circuits around it', () => {
  // Reversed form of the same bug, found by a second adversarial-review
  // pass after the forward form (`guard(x) || x`) was already fixed: if
  // `raw` is truthy, `sanitizeVenueForWrite(raw)` never even runs, so the
  // unsanitized value is written directly.
  const src = `function go(raw) { return { venue: raw || sanitizeVenueForWrite(raw) }; }`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
  assert.equal(isGuardCallDefeatedByFallback('raw || sanitizeVenueForWrite(raw)'), true);
  assert.equal(isGuardCallDefeatedByFallback('a ?? sanitizeVenueForWrite(a)'), true);
});

test('a ternary with the guard call in one branch is NOT mistaken for the reversed-fallback shape', () => {
  // `cond ? sanitizeVenueForWrite(x) : null` has non-`||`/`??` text before
  // the call (`cond ? `) — must stay guarded.
  assert.equal(isGuardCallDefeatedByFallback('cond ? sanitizeVenueForWrite(x) : null'), false);
  const src = `const entry = { venue: category ? sanitizeVenueForWrite(candidate.venue) : null };`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('sanitizeVenueForWrite(a) || sanitizeVenueForWrite(b) is a legitimate chained guard, not a defeat', () => {
  // Real shape found live in production (card #1922's promote-ob-historical.js
  // fix, caught as a false positive against the ORIGINAL fallback-defeat
  // check): sanitizing each source separately before combining, specifically
  // because combining raw first and sanitizing once would let a placeholder
  // in the first source suppress a genuinely valid second source.
  assert.equal(isGuardCallDefeatedByFallback('sanitizeVenueForWrite(a) || sanitizeVenueForWrite(b)'), false);
  const src = `const entry = { venue: sanitizeVenueForWrite(r.parsed?.titleParse?.venue) || sanitizeVenueForWrite(r.venue) };`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

// --- a bare null/undefined RHS is never a placeholder value (adversarial-review finding) ---

test('venue: null is not flagged — it is the exact safe value sanitizeVenueForWrite() itself returns', () => {
  // Real shape found live: guarded builders early-return { venue: null,
  // reason: ... } before there is anything to sanitize yet.
  const src = `function go(raw) { if (!raw) return { venue: null, reason: null }; return { venue: sanitizeVenueForWrite(raw), reason: null }; }`;
  assert.deepEqual(findUnguardedVenueWrites(src), []);
});

test('isNullLiteralRhs: true for null/undefined, false for anything else', () => {
  assert.equal(isNullLiteralRhs('null'), true);
  assert.equal(isNullLiteralRhs(' undefined '), true);
  assert.equal(isNullLiteralRhs('candidate.venue'), false);
  assert.equal(isNullLiteralRhs('"null"'), false); // the STRING "null", not the literal
});

// --- hardcoded placeholder-marker strings are NOT treated as safe (adversarial-review finding) ---

test('a hardcoded "TBA" literal is flagged — it is exactly the placeholder value sanitizeVenueForWrite() rejects', () => {
  const src = `const entry = { venue: "TBA" };`;
  const findings = findUnguardedVenueWrites(src);
  assert.equal(findings.length, 1);
});

test('isHardcodedStringRhs rejects known placeholder markers but accepts a real venue name', () => {
  assert.equal(isHardcodedStringRhs('"TBA"'), false);
  assert.equal(isHardcodedStringRhs('"tbd"'), false);
  assert.equal(isHardcodedStringRhs('"N/A"'), false);
  assert.equal(isHardcodedStringRhs('"Studio 54"'), true);
});

// --- baseline diff logic (scripts/audit-venue-write-guard.js) ---
// Keyed on file+snippet (NOT file:line) — an unrelated edit shifting line
// numbers must not make a genuinely-unchanged baselined site look "new".

test('computeNewFindings drops a finding whose file+snippet already matches the baseline', () => {
  const findings = [{ file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: c.venue,' }];
  const baseline = { sites: { [siteKey(findings[0])]: { snippet: 'venue: c.venue,' } } };
  assert.deepEqual(computeNewFindings(findings, baseline), []);
});

test('computeNewFindings keeps a finding not present in the baseline', () => {
  const findings = [{ file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: c.venue,' }];
  const baseline = { sites: {} };
  assert.deepEqual(computeNewFindings(findings, baseline), findings);
});

test('computeNewFindings does NOT re-surface a baselined site whose LINE moved but snippet is unchanged', () => {
  // Regression guard for the file:line-keyed version (caught live by
  // adversarial review): an unrelated edit earlier in the file shifting
  // every subsequent line number by N must not force a spurious
  // --update-baseline for sites nothing actually changed about.
  const baselineFinding = { file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: c.venue,' };
  const baseline = { sites: { [siteKey(baselineFinding)]: { snippet: baselineFinding.snippet } } };
  const shifted = { file: 'scripts/foo.js', line: 15, kind: 'literal', snippet: 'venue: c.venue,' };
  assert.deepEqual(computeNewFindings([shifted], baseline), []);
});

test('computeNewFindings keeps a finding whose snippet differs even at the same line', () => {
  const findings = [{ file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: someOtherRawField,' }];
  const baseline = { sites: { [siteKey({ file: 'scripts/foo.js', line: 10, kind: 'literal', snippet: 'venue: c.venue,' })]: { snippet: 'venue: c.venue,' } } };
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
