import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isUrlProvenanceWrongProduction,
  scanFileForViolations,
  findWrongProductionAssignments,
  hasNearbyProvenanceSignal,
  isValidProvenance,
} = require('./wrongproduction-provenance.js');

// ── isUrlProvenanceWrongProduction — ported from tests/unit/review-normalization.test.js
// so the exact 2026-08-06 main-red regression cases keep passing after the move.

test('isUrlProvenanceWrongProduction requires positive evidence, never bare absence', () => {
  assert.strictEqual(isUrlProvenanceWrongProduction({}), false, 'no evidence at all');
  assert.strictEqual(
    isUrlProvenanceWrongProduction({ wrongProductionReason: 'anticipatory_pre_opening_post' }),
    false, 'date-based reason with no note is NOT url-based'
  );
  assert.strictEqual(
    isUrlProvenanceWrongProduction({ wrongProductionNote: 'Same URL exists in x-2020' }),
    true, 'Same URL note'
  );
  assert.strictEqual(
    isUrlProvenanceWrongProduction({ _wrongProductionDetectedBy: 'cleanup-dedup-comprehensive' }),
    true, 'explicit URL-collision provenance'
  );
  assert.strictEqual(
    isUrlProvenanceWrongProduction({
      wrongProductionNote: 'Pre-opening guard: dated 2016-07-30',
      _wrongProductionDetectedBy: 'cleanup-dedup-comprehensive',
    }),
    false, 'an explicit date-based note wins over the legacy provenance stamp'
  );
});

test('isUrlProvenanceWrongProduction trusts the explicit wrongProductionProvenance field directly', () => {
  assert.strictEqual(
    isUrlProvenanceWrongProduction({ wrongProductionProvenance: 'url' }),
    true, 'explicit url provenance, no note needed'
  );
  assert.strictEqual(
    isUrlProvenanceWrongProduction({ wrongProductionProvenance: 'date' }),
    false, 'explicit non-url provenance'
  );
  assert.strictEqual(
    isUrlProvenanceWrongProduction({
      wrongProductionProvenance: 'url',
      wrongProductionNote: 'Pre-opening guard: dated 2016-07-30',
    }),
    true, 'the canonical field is authoritative even over a conflicting legacy note — that is the entire point of adding it'
  );
});

test('isValidProvenance accepts only the four declared values', () => {
  assert.strictEqual(isValidProvenance('url'), true);
  assert.strictEqual(isValidProvenance('manual'), true);
  assert.strictEqual(isValidProvenance('venue-transfer'), false);
  assert.strictEqual(isValidProvenance(undefined), false);
});

// ── static-scan primitives (the lint's engine) ──────────────────────────────

test('findWrongProductionAssignments finds member-assignment and object-literal writes', () => {
  const src = [
    "data.wrongProduction = true;",
    "const x = { wrongProduction: true, wrongProductionReason: 'x' };",
  ].join('\n');
  const hits = findWrongProductionAssignments(src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].line, 1);
  assert.equal(hits[1].line, 2);
});

test('findWrongProductionAssignments ignores comparisons, comments, and string-literal mentions', () => {
  const src = [
    "if (data.wrongProduction === true) return;",
    "// data.wrongProduction = true — old approach, removed",
    "console.log('Reviews now have wrongProduction: true');",
    "const description = 'contentVerification.wrongProduction=true without a clear flag';",
    "warn(`set wrongProduction:true, or declare a priorRun`);",
  ].join('\n');
  assert.deepEqual(findWrongProductionAssignments(src), []);
});

test('hasNearbyProvenanceSignal finds canonical and legacy field names within the window', () => {
  const withCanonical = "data.wrongProduction = true;\ndata.wrongProductionProvenance = 'manual';";
  assert.equal(hasNearbyProvenanceSignal(withCanonical, 1), true);

  const withLegacyNote = "data.wrongProduction = true;\ndata.wrongProductionNote = 'Same URL';";
  assert.equal(hasNearbyProvenanceSignal(withLegacyNote, 1), true);

  const withLegacyUnderscore = "data.wrongProduction = true;\ndata._wrongProductionReason = 'x';";
  assert.equal(hasNearbyProvenanceSignal(withLegacyUnderscore, 1), true);

  const bare = "data.wrongProduction = true;\ndata.otherField = 1;";
  assert.equal(hasNearbyProvenanceSignal(bare, 1), false);
});

test('hasNearbyProvenanceSignal ignores a provenance field mentioned only in a comment', () => {
  const src = "data.wrongProduction = true;\n// wrongProductionReason should be set by callers\n".repeat(1);
  assert.equal(hasNearbyProvenanceSignal(src, 1), false);
});

test('scanFileForViolations: the exact "deliberately-unprovenanced writer" shape the lint exists to catch', () => {
  const violation = "function flag(data) {\n  data.wrongProduction = true;\n  save(data);\n}\n";
  const violations = scanFileForViolations(violation, 'scripts/some-new-writer.js');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'scripts/some-new-writer.js');
  assert.equal(violations[0].line, 2);
});

test('scanFileForViolations: a real multi-writer fixture with provenance throughout is clean', () => {
  const clean = [
    "function flagUrl(data) {",
    "  data.wrongProduction = true;",
    "  data.wrongProductionProvenance = 'url';",
    "}",
    "function flagManual(data, reason) {",
    "  data.wrongProduction = true;",
    "  data.wrongProductionReason = reason;",
    "}",
    "function legacyDetector(data) {",
    "  data.wrongProduction = true;",
    "  data._wrongProductionDetectedBy = 'cleanup-dedup-comprehensive';",
    "  data._wrongProductionReason = 'URL matches (year-based)';",
    "}",
  ].join('\n');
  assert.deepEqual(scanFileForViolations(clean, 'scripts/clean-writer.js'), []);
});
