/**
 * Task #1625 / Notion 3bd637c5: scripts/audit-delete-without-breadcrumb.js is
 * the mechanical check for the bug class fixed by hand 3 times (#1618,
 * #1624 x2): a script does `delete data.X` on a field with no
 * scripts/lib/review-write-guard.js CLEAR_BREADCRUMBS entry, then calls
 * safeWriteReview(filePath, data) with default options — the merge-mode
 * restore pass silently reverts the delete on every subsequent run.
 *
 * Per CLAUDE.md §15 this require()s the real functions — it never
 * re-implements the AST walk or field-clear detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..');
const {
  analyzeSource,
  findUnprotectedDeletes,
  checkFile,
  auditRepo,
  main,
} = require(path.join(repoRoot, 'scripts/audit-delete-without-breadcrumb.js'));
const { CLEAR_BREADCRUMBS } = require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── Real bug shape: pre-fix flag-combined-reviews.js pattern (task #1624) ──
// Multiple fields deleted inside a for-loop (no separate function scope),
// then a single safeWriteReview(entry.filePath, data) call with no options —
// this is EXACTLY what silently reverted on the very next run.
const PRE_FIX_PATTERN = `
function main() {
  for (const entry of entries) {
    const data = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));
    if (data.wrongShow === true && data.rejectionReason === 'wrong_show') {
      data.rejectionReason = null;
      delete data.rejectedBy;
      delete data.rejectedAt;
      delete data.rejectionReasoning;
      delete data.rescoreCompletedAt;
      data.needsRescore = true;
    }
    safeWriteReview(entry.filePath, data);
  }
}
`;

test('checkFile: flags the pre-fix flag-combined-reviews.js pattern (delete + no force + no breadcrumb)', () => {
  const findings = checkFile(PRE_FIX_PATTERN, new Set(Object.keys(CLEAR_BREADCRUMBS)));
  const fields = findings.map((f) => f.field).sort();
  assert.deepEqual(fields, ['rejectedAt', 'rejectedBy', 'rejectionReasoning', 'rescoreCompletedAt']);
});

test('checkFile: does NOT flag when the safeWriteReview call passes force:true', () => {
  const src = PRE_FIX_PATTERN.replace('safeWriteReview(entry.filePath, data);', 'safeWriteReview(entry.filePath, data, { force: true });');
  const findings = checkFile(src, new Set(Object.keys(CLEAR_BREADCRUMBS)));
  assert.equal(findings.length, 0);
});

test('checkFile: does NOT flag when the deleted field has a registered CLEAR_BREADCRUMBS entry', () => {
  const src = `
function run(fp, data) {
  delete data.duplicateTextOf;
  safeWriteReview(fp, data);
}
`;
  const findings = checkFile(src, new Set(['duplicateTextOf']));
  assert.equal(findings.length, 0);
});

test('checkFile: flags a field with no breadcrumb entry even when it is not in PROTECTED_FIELDS at all (card requirement: ANY field, not just PROTECTED_FIELDS)', () => {
  const src = `
function run(fp, data) {
  delete data.someScratchFieldNeverProtected;
  safeWriteReview(fp, data);
}
`;
  const findings = checkFile(src, new Set(Object.keys(CLEAR_BREADCRUMBS)));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, 'someScratchFieldNeverProtected');
});

test('checkFile: a file with NO safeWriteReview call at all (raw fs.writeFileSync) is never flagged', () => {
  const src = `
function run(fp, data) {
  delete data.humanReviewScore;
  fs.writeFileSync(fp, JSON.stringify(data));
}
`;
  const findings = checkFile(src, new Set());
  assert.equal(findings.length, 0);
});

test('checkFile: fails open on unparseable source (never throws)', () => {
  const findings = checkFile('function broken( {{{ this is not js', new Set());
  assert.equal(findings.length, 0);
});

test('checkFile: respects the breadcrumb-delete-ok exemption annotation', () => {
  const src = `
// breadcrumb-delete-ok: reviewed false positive, tracked in card #999
function run(fp, data) {
  delete data.someUnbreadcrumbedField;
  safeWriteReview(fp, data);
}
`;
  const findings = checkFile(src, new Set());
  assert.equal(findings.length, 0);
});

// ── Per-function scoping (the "hard part" per the card): a delete in one
// function must NOT be attributed to an unrelated safeWriteReview() call in
// a DIFFERENT function, even when both use a generically-named variable
// (`data`) and the same field name. ──

test('analyzeSource + findUnprotectedDeletes: does not cross-attribute a delete in one function to a call in another', () => {
  const src = `
function first(fp, data) {
  delete data.humanReviewScore;
  // no safeWriteReview call here at all
}
function second(fp2, data) {
  safeWriteReview(fp2, data);
}
`;
  const { deletes, calls } = analyzeSource(src);
  const findings = findUnprotectedDeletes(deletes, calls, new Set());
  assert.equal(findings.length, 0, 'the delete in first() has no matching call in ITS scope, so it must not attribute to second()');
});

test('analyzeSource + findUnprotectedDeletes: correctly scopes a delete inside a nested arrow-function callback separately from its outer function', () => {
  const src = `
function main() {
  entries.forEach((entry) => {
    const data = loadEntry(entry);
    delete data.humanReviewScore;
    safeWriteReview(entry.filePath, data, { force: true });
  });
  // Outer-scope 'data' variable, unrelated to the inner one, with an
  // unprotected clear and a force-less call — must be flagged independently.
  const data = loadOuter();
  delete data.someOtherUnbreadcrumbedField;
  safeWriteReview(outerPath, data);
}
`;
  const { deletes, calls } = analyzeSource(src);
  const findings = findUnprotectedDeletes(deletes, calls, new Set());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, 'someOtherUnbreadcrumbedField');
});

test('findUnprotectedDeletes: nearest-call-wins when a scope has multiple safeWriteReview calls for the same var', () => {
  const src = `
function run(fp, data) {
  safeWriteReview(fp, data, { force: true });
  delete data.middleField;
  safeWriteReview(fp, data);
  delete data.laterField;
  safeWriteReview(fp, data, { force: true });
}
`;
  const { deletes, calls } = analyzeSource(src);
  const findings = findUnprotectedDeletes(deletes, calls, new Set());
  const fields = findings.map((f) => f.field).sort();
  // middleField's nearest call (by position) is the force-less middle call;
  // laterField's nearest call is the final force:true call.
  assert.deepEqual(fields, ['middleField']);
});

test('analyzeSource: ignores computed member deletes (delete obj[x]) — cannot resolve a static field name', () => {
  const src = `
function run(fp, data) {
  const key = 'dynamic';
  delete data[key];
  safeWriteReview(fp, data);
}
`;
  const { deletes } = analyzeSource(src);
  assert.equal(deletes.length, 0);
});

// ── auditRepo: file-scan wiring ──

test('auditRepo: scans a directory and flags the pre-fix pattern', () => {
  const scriptsDir = mkTmpDir('bcdel-scripts-');
  fs.writeFileSync(path.join(scriptsDir, 'fake-clear.js'), PRE_FIX_PATTERN);
  const { findings, scanned } = auditRepo({ scriptsDir, breadcrumbKeys: new Set(Object.keys(CLEAR_BREADCRUMBS)) });
  assert.equal(scanned.files, 1);
  assert.equal(scanned.filesWithSafeWrite, 1);
  assert.equal(findings.length, 4);
  assert.equal(findings[0].file, 'fake-clear.js');
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

test('auditRepo: a directory with no safeWriteReview-calling scripts reports zero scanned-with-safe-write', () => {
  const scriptsDir = mkTmpDir('bcdel-scripts-');
  fs.writeFileSync(path.join(scriptsDir, 'plain.js'), 'function run(fp, data) { fs.writeFileSync(fp, JSON.stringify(data)); }\n');
  const { findings, scanned } = auditRepo({ scriptsDir, breadcrumbKeys: new Set() });
  assert.equal(findings.length, 0);
  assert.equal(scanned.filesWithSafeWrite, 0);
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

// ── Real-repo acceptance check (Notion 3bd637c5 acceptance criteria) ──
// Running the audit against the REAL repo must currently report ZERO
// findings — task #1624's session confirmed the codebase is clean right now
// (all 8 files matching a delete-without-breadcrumb pattern write via raw
// fs.writeFileSync, not safeWriteReview). If this starts failing, either a
// real regression landed, or the heuristic itself regressed — both are worth
// investigating, not silencing.
test('auditRepo against the real repo: zero findings (corpus is confirmed clean as of task #1624)', () => {
  const { findings, scanned } = auditRepo({
    scriptsDir: path.join(repoRoot, 'scripts'),
    breadcrumbKeys: new Set(Object.keys(CLEAR_BREADCRUMBS)),
  });
  assert.equal(findings.length, 0, `expected no findings, got: ${JSON.stringify(findings)}`);
  assert.ok(scanned.filesWithSafeWrite > 0, 'expected at least one script in scripts/ to call safeWriteReview');
});

// ── main() never throws (mirrors audit-same-job-breadcrumb-coverage.js's own
// precedent) — a functional check that calls the REAL main(), not a
// source-text assertion about whether a try/catch exists. ──
test('main(): runs to completion without throwing against the real repo', () => {
  assert.doesNotThrow(() => main());
});
