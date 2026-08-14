/**
 * BRO-250 / Notion 3b9637c5: scripts/audit-same-job-breadcrumb-coverage.js is
 * the mechanical check for the bug class fixed reactively 3 times
 * (task #97 staleScoredBeforeOpening, task #1237 fullTextWrongAuthor,
 * task #1259 stuckRescoreCleared) — a script that force:true-clears a
 * PROTECTED_FIELDS field in a CI job that later restores from committed HEAD
 * via push-review-texts, with no CLEAR_BREADCRUMBS entry registered for the
 * field it just cleared.
 *
 * Per CLAUDE.md §15 this require()s the real functions — it never
 * re-implements the YAML parsing or field-clear detection.
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
  getJobBlocks,
  findForceTrueClearSites,
  auditRepo,
} = require(path.join(repoRoot, 'scripts/audit-same-job-breadcrumb-coverage.js'));
const { PROTECTED_FIELDS, CLEAR_BREADCRUMBS } =
  require(path.join(repoRoot, 'scripts/lib/review-write-guard.js'));

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('getJobBlocks: finds a job with a push-review-texts step and its step order', () => {
  const yaml = [
    'jobs:',
    '  rebuild:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v5',
    '      - name: Apply audit flags',
    '        run: node scripts/apply-audit-flags.js',
    '      - name: Push review-texts',
    '        uses: ./.github/actions/push-review-texts',
    '      - name: Commit',
    '        run: git commit -m done',
    '',
  ].join('\n');
  const jobs = getJobBlocks(yaml);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'rebuild');
  assert.equal(jobs[0].steps.length, 4);
  const pushIdx = jobs[0].steps.findIndex((s) => /push-review-texts/.test(s.bodyText));
  assert.equal(pushIdx, 2);
});

test('findForceTrueClearSites: detects delete-style clears preceding a force:true call', () => {
  const src = `
function apply(fp, data) {
  data.fullTextWrongAuthor = true;
  data.fullTextWrongAuthorAt = new Date().toISOString();
  delete data.fullText;
  delete data.assignedScore;
  delete data.ensembleData;
  safeWriteReview(fp, data, { force: true });
}
`;
  const sites = findForceTrueClearSites(src, new Set(['fullText', 'assignedScore', 'ensembleData']));
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].fields.sort(), ['assignedScore', 'ensembleData', 'fullText']);
});

test('findForceTrueClearSites: detects null-assignment clears (strip-stale-single-model-scores.js shape)', () => {
  const src = `
function strip(fp, data) {
  data.ensembleData = null;
  data.assignedScore = null;
  data.llmScore = null;
  data.staleScoredBeforeOpening = true;
  data.staleScoredBeforeOpeningAt = new Date().toISOString();
  const r = safeWriteReview(fp, data, { force: true });
}
`;
  const sites = findForceTrueClearSites(src, new Set(['ensembleData', 'assignedScore', 'llmScore']));
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].fields.sort(), ['assignedScore', 'ensembleData', 'llmScore']);
});

test('findForceTrueClearSites: ignores non-protected field clears and force-less calls', () => {
  const src = `
function noop(fp, data) {
  delete data.someScratchField;
  safeWriteReview(fp, data);
}
`;
  const sites = findForceTrueClearSites(src, new Set(['assignedScore']));
  assert.equal(sites.length, 0);
});

test('findForceTrueClearSites: does not cross-attribute clears between two unrelated force:true call sites', () => {
  const src = `
function first(fp, data) {
  delete data.assignedScore;
  safeWriteReview(fp, data, { force: true });
}

function second(fp2, data2) {
  // No clears here at all — must NOT inherit assignedScore from first().
  safeWriteReview(fp2, data2, { force: true });
}
`;
  const sites = findForceTrueClearSites(src, new Set(['assignedScore']));
  assert.equal(sites.length, 1, 'only the first call site should report a cleared field');
});

test('auditRepo: flags a same-job force:true clear with no CLEAR_BREADCRUMBS entry (synthetic new bug)', () => {
  const workflowDir = mkTmpDir('bc-wf-');
  const scriptsDir = mkTmpDir('bc-scripts-');
  fs.writeFileSync(path.join(workflowDir, 'fake.yml'), [
    'jobs:',
    '  drain:',
    '    steps:',
    '      - name: Clear stuck flag',
    '        run: node scripts/fake-clear.js --fix',
    '      - name: Push review-texts',
    '        uses: ./.github/actions/push-review-texts',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(scriptsDir, 'fake-clear.js'), `
function run(fp, data) {
  data.someNewFlag = true;
  data.someNewFlagAt = new Date().toISOString();
  delete data.humanReviewScore;
  safeWriteReview(fp, data, { force: true });
}
`);
  const { gaps } = auditRepo({
    workflowDir,
    scriptsDir,
    protectedFields: ['humanReviewScore'],
    breadcrumbKeys: new Set(), // nothing registered — must flag
  });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].field, 'humanReviewScore');
  assert.equal(gaps[0].script, 'fake-clear.js');
  assert.equal(gaps[0].job, 'drain');
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

test('auditRepo: does NOT flag when a CLEAR_BREADCRUMBS entry is registered for the cleared field', () => {
  const workflowDir = mkTmpDir('bc-wf-');
  const scriptsDir = mkTmpDir('bc-scripts-');
  fs.writeFileSync(path.join(workflowDir, 'fake.yml'), [
    'jobs:',
    '  drain:',
    '    steps:',
    '      - name: Clear stuck flag',
    '        run: node scripts/fake-clear.js --fix',
    '      - name: Push review-texts',
    '        uses: ./.github/actions/push-review-texts',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(scriptsDir, 'fake-clear.js'), `
function run(fp, data) {
  delete data.humanReviewScore;
  safeWriteReview(fp, data, { force: true });
}
`);
  const { gaps } = auditRepo({
    workflowDir,
    scriptsDir,
    protectedFields: ['humanReviewScore'],
    breadcrumbKeys: new Set(['humanReviewScore']), // registered — must NOT flag
  });
  assert.equal(gaps.length, 0);
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

test('auditRepo: ignores force:true clears in jobs with no push-review-texts step', () => {
  const workflowDir = mkTmpDir('bc-wf-');
  const scriptsDir = mkTmpDir('bc-scripts-');
  fs.writeFileSync(path.join(workflowDir, 'fake.yml'), [
    'jobs:',
    '  standalone:',
    '    steps:',
    '      - name: Clear flag, never restored in this job',
    '        run: node scripts/fake-clear.js',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(scriptsDir, 'fake-clear.js'), `
function run(fp, data) {
  delete data.humanReviewScore;
  safeWriteReview(fp, data, { force: true });
}
`);
  const { gaps, scanned } = auditRepo({
    workflowDir,
    scriptsDir,
    protectedFields: ['humanReviewScore'],
    breadcrumbKeys: new Set(),
  });
  assert.equal(gaps.length, 0);
  assert.equal(scanned.jobs, 0);
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

test('auditRepo: respects the breadcrumb-coverage-ok exemption annotation', () => {
  const workflowDir = mkTmpDir('bc-wf-');
  const scriptsDir = mkTmpDir('bc-scripts-');
  fs.writeFileSync(path.join(workflowDir, 'fake.yml'), [
    '# breadcrumb-coverage-ok: known false positive, tracked in card #999',
    'jobs:',
    '  drain:',
    '    steps:',
    '      - name: Clear stuck flag',
    '        run: node scripts/fake-clear.js',
    '      - name: Push review-texts',
    '        uses: ./.github/actions/push-review-texts',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(scriptsDir, 'fake-clear.js'), `
function run(fp, data) {
  delete data.humanReviewScore;
  safeWriteReview(fp, data, { force: true });
}
`);
  const { gaps } = auditRepo({
    workflowDir,
    scriptsDir,
    protectedFields: ['humanReviewScore'],
    breadcrumbKeys: new Set(),
  });
  assert.equal(gaps.length, 0);
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

// ── Real-repo acceptance check (Notion 3b9637c5 acceptance criteria) ──
// Running the audit against the REAL repo must NOT re-flag the 3 fields/field
// families already fixed reactively — proving the gate doesn't just re-surface
// already-fixed work. If this ever starts failing, either a real regression
// landed in review-write-guard.js's CLEAR_BREADCRUMBS, or the heuristic itself
// regressed (both are worth investigating, not silencing).
test('auditRepo against the real repo: does not re-flag the 3 already-fixed field families', () => {
  const { gaps } = auditRepo({
    workflowDir: path.join(repoRoot, '.github/workflows'),
    scriptsDir: path.join(repoRoot, 'scripts'),
    protectedFields: PROTECTED_FIELDS,
    breadcrumbKeys: new Set(Object.keys(CLEAR_BREADCRUMBS)),
  });
  const flagged = new Set(gaps.map((g) => `${g.script}::${g.field}`));
  const mustNotFlag = [
    'audit-stuck-rescore-flags.js::needsRescore',
    'audit-stuck-rescore-flags.js::rescoreReason',
    'audit-stuck-rescore-flags.js::lateStarAnchorBand',
    'strip-stale-single-model-scores.js::assignedScore',
    'strip-stale-single-model-scores.js::llmScore',
    'strip-stale-single-model-scores.js::llmMetadata',
    'strip-stale-single-model-scores.js::ensembleData',
    'apply-audit-flags.js::fullText',
    'apply-audit-flags.js::assignedScore',
    'apply-audit-flags.js::ensembleData',
  ];
  for (const key of mustNotFlag) {
    assert.ok(!flagged.has(key), `expected no gap for ${key}, got gaps: ${JSON.stringify(gaps)}`);
  }
});

// ── Positive controls (second-opinion review, BRO-250): the tests above only
// prove already-fixed fields aren't re-flagged. That's indistinguishable from
// a silently-broken detector that finds NOTHING. These assert the detector
// finds the EXACT known field sets in the real, messy source files (large
// files, generic var names like `d`/`data`), not just "isn't in the bad
// list" — proof the parser+window heuristic actually works on real code. ──

test('findForceTrueClearSites: exact field match on the real apply-audit-flags.js (positive control)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/apply-audit-flags.js'), 'utf8');
  const sites = findForceTrueClearSites(src, new Set(PROTECTED_FIELDS));
  const fields = new Set(sites.flatMap((s) => s.fields));
  assert.deepEqual([...fields].sort(), ['assignedScore', 'ensembleData', 'fullText']);
});

test('findForceTrueClearSites: exact field match on the real audit-stuck-rescore-flags.js (positive control)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/audit-stuck-rescore-flags.js'), 'utf8');
  const sites = findForceTrueClearSites(src, new Set(PROTECTED_FIELDS));
  const fields = new Set(sites.flatMap((s) => s.fields));
  assert.deepEqual([...fields].sort(), ['lateStarAnchorBand', 'needsRescore', 'rescoreReason']);
});

test('findForceTrueClearSites: exact field match on the real strip-stale-single-model-scores.js (positive control, null-assignment idiom)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/strip-stale-single-model-scores.js'), 'utf8');
  const sites = findForceTrueClearSites(src, new Set(PROTECTED_FIELDS));
  const fields = new Set(sites.flatMap((s) => s.fields));
  assert.deepEqual([...fields].sort(), ['assignedScore', 'ensembleData', 'llmMetadata', 'llmScore']);
});

test('findForceTrueClearSites: correctly resolves 5 independent call sites in the real rebuild-all-reviews.js with no cross-attribution (positive control, large-file/generic-var-name case the second-opinion review flagged)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const sites = findForceTrueClearSites(src, new Set(PROTECTED_FIELDS));
  // Exactly 5 call sites carry a protected clear as of this writing; each
  // one's fields come only from its own immediately-preceding statements.
  assert.equal(sites.length, 5);
  for (const s of sites) {
    for (const f of s.fields) {
      assert.ok(['wrongProductionNote', 'wrongProductionReason', 'wrongFullText'].includes(f),
        `unexpected field "${f}" at line ${s.line} — possible cross-attribution from an unrelated call site`);
    }
  }
});

test('findForceTrueClearSites: detects empty-string/array clears (_isEmptyValue parity — booleans/0 are deliberately excluded)', () => {
  const src = `
function foo(fp, data) {
  data.wrongFullText = '';
  data.someList = [];
  data.someBool = false;
  safeWriteReview(fp, data, { force: true });
}
`;
  const sites = findForceTrueClearSites(src, new Set(['wrongFullText', 'someList', 'someBool']));
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].fields.sort(), ['someList', 'wrongFullText']);
  assert.ok(!sites[0].fields.includes('someBool'), 'false is not an empty value under _isEmptyValue — must not be flagged as a clear');
});

test('auditRepo: scans a clear between TWO push-review-texts steps in the same job (opening-night-express.yml shape)', () => {
  const workflowDir = mkTmpDir('bc-wf-');
  const scriptsDir = mkTmpDir('bc-scripts-');
  fs.writeFileSync(path.join(workflowDir, 'fake.yml'), [
    'jobs:',
    '  express:',
    '    steps:',
    '      - name: Push review texts (first)',
    '        uses: ./.github/actions/push-review-texts',
    '      - name: Score reviews (clears a field between the two restores)',
    '        run: node scripts/fake-clear.js',
    '      - name: Push scored review texts (second)',
    '        uses: ./.github/actions/push-review-texts',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(scriptsDir, 'fake-clear.js'), `
function run(fp, data) {
  delete data.humanReviewScore;
  safeWriteReview(fp, data, { force: true });
}
`);
  const { gaps } = auditRepo({
    workflowDir,
    scriptsDir,
    protectedFields: ['humanReviewScore'],
    breadcrumbKeys: new Set(),
  });
  assert.equal(gaps.length, 1, 'a clear between the first and second push-review-texts step must still be flagged');
  fs.rmSync(workflowDir, { recursive: true, force: true });
  fs.rmSync(scriptsDir, { recursive: true, force: true });
});

test('auditRepo against the real repo: the 3 known scripts are actually reached (co-location detection works)', () => {
  // A gate that never sees these scripts because the job/step co-location
  // logic is broken would ALSO report zero gaps for them — indistinguishable
  // from "correctly fixed" without this check. Prove they're in scope.
  const { scanned } = auditRepo({
    workflowDir: path.join(repoRoot, '.github/workflows'),
    scriptsDir: path.join(repoRoot, 'scripts'),
    protectedFields: PROTECTED_FIELDS,
    breadcrumbKeys: new Set(Object.keys(CLEAR_BREADCRUMBS)),
  });
  for (const script of ['audit-stuck-rescore-flags.js', 'strip-stale-single-model-scores.js', 'apply-audit-flags.js']) {
    assert.ok(scanned.scripts.has(script), `expected ${script} to be reached by the same-job scan`);
  }
});
