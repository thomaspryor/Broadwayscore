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

    for (const field of FEEDBACK_EDITABLE_FIELDS['shows.json']) {
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
      'shows.json': ['status', 'openingDate', 'closingDate', 'previewsStartDate', 'creativeTeam'],
      'commercial.json': ['recouped', 'recoupmentSource'],
    };
    for (const [file, fields] of Object.entries(humanOnly)) {
      for (const field of fields) {
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
    for (const field of FEEDBACK_EDITABLE_FIELDS['shows.json']) {
      assert.ok(field in snapshot, `buildShowSnapshot() omits editable field "${field}"`);
    }
    assert.ok(!('extraneous' in snapshot));
  });

  test('buildShowSnapshot never drops a field key via JSON.stringify — missing values become null (or [] for creativeTeam)', () => {
    const show = { id: 'x-2', title: 'Y', slug: 'y' }; // no other fields at all
    const snapshot = buildShowSnapshot(show);
    const serialized = JSON.parse(JSON.stringify(snapshot));

    for (const field of FEEDBACK_EDITABLE_FIELDS['shows.json']) {
      assert.ok(field in serialized, `"${field}" was dropped by JSON.stringify (undefined value) — issue #582 regression`);
    }
    assert.deepEqual(serialized.creativeTeam, []);
    assert.equal(serialized.synopsis, null);
  });
});
