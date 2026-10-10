// TESTS-VS-DERIVED-DATA-EXEMPT: structural check only — asserts editable
// field names exist as keys on data/shows.json, pins no specific show facts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  FEEDBACK_EDITABLE_FIELDS,
  AUTO_FIX_EDITABLE_FIELDS,
  pickEditableFields,
  buildShowSnapshot,
  castValueProblem,
  rejectedUrlsValueProblem,
} = require('../../scripts/lib/feedback-pipeline-fields.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..', '..');

describe('feedback-pipeline-fields', () => {
  test('every shows.json editable field exists on real show data', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
    const shows = raw.shows || raw;
    const realFieldNames = new Set();
    for (const show of shows) {
      for (const key of Object.keys(show)) realFieldNames.add(key);
    }

    // Real fields that only the pipeline writes, so no row may have one yet:
    // rejectedImageUrls is read by scripts/lib/image-source-match.js (BRO-4996).
    const writtenByPipeline = new Set(['rejectedImageUrls']);
    for (const field of FEEDBACK_EDITABLE_FIELDS['shows.json']) {
      if (writtenByPipeline.has(field)) continue;
      assert.ok(
        realFieldNames.has(field),
        `"${field}" in FEEDBACK_EDITABLE_FIELDS['shows.json'] doesn't exist on any show in data/shows.json`
      );
    }
  });

  test('previewDate typo does not reappear in the canonical list', () => {
    assert.ok(!FEEDBACK_EDITABLE_FIELDS['shows.json'].includes('previewDate'));
    assert.ok(FEEDBACK_EDITABLE_FIELDS['shows.json'].includes('previewsStartDate'));
  });

  test('generate-remediation-plan.js and execute-approved-fix.js (human-approved path) resolve to the same field set', () => {
    const sharedFiles = ['shows.json', 'commercial.json', 'audience-buzz.json'];
    const remediationPlan = pickEditableFields(sharedFiles);
    const executeFix = pickEditableFields(sharedFiles);

    for (const file of sharedFiles) {
      assert.deepEqual(remediationPlan[file], FEEDBACK_EDITABLE_FIELDS[file]);
      assert.deepEqual(executeFix[file], FEEDBACK_EDITABLE_FIELDS[file]);
    }
  });

  test('AUTO_FIX_EDITABLE_FIELDS (unattended path) is a strict subset of FEEDBACK_EDITABLE_FIELDS and excludes lifecycle/financial fields', () => {
    for (const [file, fields] of Object.entries(AUTO_FIX_EDITABLE_FIELDS)) {
      for (const field of fields) {
        assert.ok(
          FEEDBACK_EDITABLE_FIELDS[file]?.includes(field),
          `AUTO_FIX_EDITABLE_FIELDS['${file}'] has "${field}" not present in FEEDBACK_EDITABLE_FIELDS['${file}']`
        );
      }
    }

    // Fields only the human-approved path (generate-remediation-plan.js ->
    // execute-approved-fix.js) may touch — never the unattended auto-fix.
    const humanOnly = {
      'shows.json': ['status', 'openingDate', 'closingDate', 'previewsStartDate', 'creativeTeam', 'images', 'cast'],
      'commercial.json': ['recouped', 'recoupedDate', 'recoupedSource', 'sources', 'humanReviewedDesignation', 'weeklyRunningCostSource'],
    };
    for (const [file, fields] of Object.entries(humanOnly)) {
      for (const field of fields) {
        assert.ok(FEEDBACK_EDITABLE_FIELDS[file].includes(field),
          `FEEDBACK_EDITABLE_FIELDS['${file}'] must include human-approved field "${field}"`);
        assert.ok(!AUTO_FIX_EDITABLE_FIELDS[file].includes(field),
          `AUTO_FIX_EDITABLE_FIELDS['${file}'] must not include human-approval-only field "${field}"`);
      }
    }
  });

  test('awards.json is scoped out of generate-remediation-plan.js / execute-approved-fix.js allowlists', () => {
    const scoped = pickEditableFields(['shows.json', 'commercial.json', 'audience-buzz.json']);
    assert.equal(scoped['awards.json'], undefined);
  });

  test('all 4 consumer scripts import the shared module instead of hand-declaring an allowlist', () => {
    const consumers = [
      'scripts/auto-fix-feedback-bug.js',
      'scripts/generate-remediation-plan.js',
      'scripts/execute-approved-fix.js',
      'scripts/diagnose-feedback-bug.js',
    ];
    for (const rel of consumers) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(
        content.includes("feedback-pipeline-fields.js"),
        `${rel} does not import scripts/lib/feedback-pipeline-fields.js`
      );
    }
  });

  test('no hand-declared ALLOWED_FIELDS/ALLOWED_DATA_FIELDS object literals remain', () => {
    const checks = [
      'scripts/auto-fix-feedback-bug.js',
      'scripts/generate-remediation-plan.js',
      'scripts/execute-approved-fix.js',
    ];
    for (const rel of checks) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(
        !/const ALLOWED_(DATA_)?FIELDS\s*=\s*\{/.test(content),
        `${rel} still hand-declares an ALLOWED_FIELDS/ALLOWED_DATA_FIELDS object literal`
      );
    }
  });

  test('buildShowSnapshot exposes identity fields plus every editable shows.json field', () => {
    const show = { id: 'x-1', title: 'X', slug: 'x', venue: 'Some Theatre', extraneous: 'not editable' };
    const snapshot = buildShowSnapshot(show);

    assert.equal(snapshot.id, 'x-1');
    assert.equal(snapshot.title, 'X');
    assert.equal(snapshot.slug, 'x');
    assert.equal(snapshot.venue, 'Some Theatre');
    // Real fields that only the pipeline writes, so no row may have one yet:
    // rejectedImageUrls is read by scripts/lib/image-source-match.js (BRO-4996).
    const writtenByPipeline = new Set(['rejectedImageUrls']);
    for (const field of FEEDBACK_EDITABLE_FIELDS['shows.json']) {
      if (writtenByPipeline.has(field)) continue;
      assert.ok(field in snapshot, `buildShowSnapshot() omits editable field "${field}"`);
    }
    assert.ok(!('extraneous' in snapshot));
  });

  test('buildShowSnapshot never drops a field key via JSON.stringify — missing values become null (or [] for creativeTeam)', () => {
    const show = { id: 'x-2', title: 'Y', slug: 'y' }; // no other fields at all
    const snapshot = buildShowSnapshot(show);
    const serialized = JSON.parse(JSON.stringify(snapshot));

    // Real fields that only the pipeline writes, so no row may have one yet:
    // rejectedImageUrls is read by scripts/lib/image-source-match.js (BRO-4996).
    const writtenByPipeline = new Set(['rejectedImageUrls']);
    for (const field of FEEDBACK_EDITABLE_FIELDS['shows.json']) {
      if (writtenByPipeline.has(field)) continue;
      assert.ok(field in serialized, `"${field}" was dropped by JSON.stringify (undefined value) — issue #582 regression`);
    }
    assert.deepEqual(serialized.creativeTeam, []);
    assert.equal(serialized.synopsis, null);
  });

  test('castValueProblem accepts [] and {name, role} arrays, refuses other shapes (BRO-4432)', () => {
    assert.equal(castValueProblem([]), null);
    assert.equal(castValueProblem([{ name: 'Rob Madge', role: 'Performer' }, { name: 'A N Other' }]), null);
    assert.match(castValueProblem(null), /must be an array/);
    assert.match(castValueProblem('Rob Madge'), /must be an array/);
    assert.match(castValueProblem([{ role: 'Rosalind' }]), /name/);
    assert.match(castValueProblem([{ name: '  ' }]), /name/);
    assert.match(castValueProblem([{ name: 'X', role: 3 }]), /role/);
    assert.match(castValueProblem([['X']]), /must be an object/);
  });

  test('buildShowSnapshot emits cast as [] when the show has none', () => {
    assert.deepEqual(buildShowSnapshot({ id: 'x', title: 'X', slug: 'x' }).cast, []);
  });

  test('rejectedUrlsValueProblem: http(s) URLs only, add-only (BRO-4996)', () => {
    const a = 'https://x.test/a.jpg', b = 'https://x.test/b.jpg';
    assert.equal(rejectedUrlsValueProblem([a], null), null);
    assert.equal(rejectedUrlsValueProblem([a, b], [a]), null);
    assert.match(rejectedUrlsValueProblem([b], [a]), /only add/);
    assert.match(rejectedUrlsValueProblem(null, null), /must be an array/);
    assert.match(rejectedUrlsValueProblem(['manual:x'], null), /http/);
    assert.match(rejectedUrlsValueProblem([3], null), /http/);
  });

  test('buildShowSnapshot emits rejectedImageUrls as [] when the show has none', () => {
    assert.deepEqual(buildShowSnapshot({ id: 'x', title: 'X', slug: 'x' }).rejectedImageUrls, []);
  });
});
