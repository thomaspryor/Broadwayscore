/**
 * Tests for scripts/lib/review-field-edit.js (BRO-4216).
 * Run: node --test scripts/lib/review-field-edit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { applyReviewFieldEdit, resolveReviewPath, REVIEW_TEXT_EDITABLE_FIELDS } = require('./review-field-edit.js');

const stamp = { fixId: 'bro-4202', at: '2026-09-28T00:00:00.000Z' };

test('sets a verdict flag when the old value matches, and stamps provenance', () => {
  // mass-west-end-2026 times-uk--dominic-maxwell (BRO-4202)
  const rec = { outletId: 'times-uk', criticName: 'Dominic Maxwell' };
  const res = applyReviewFieldEdit(rec, { field: 'wrongAttribution', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, true);
  assert.equal(res.record.wrongAttribution, true);
  assert.deepEqual(res.record.approvedFixes, [{ fixId: 'bro-4202', field: 'wrongAttribution', at: stamp.at }]);
  assert.equal(rec.wrongAttribution, undefined, 'input record is not mutated');
});

test('clears a stale rejection (english-2025 NYT, BRO-4202)', () => {
  const rec = { rejectedAt: '2026-03-02T23:19:38.824Z', rejectedBy: 'ensemble-scoreability-check' };
  const res = applyReviewFieldEdit(rec, { field: 'rejectedAt', oldValue: '2026-03-02T23:19:38.824Z', newValue: null }, stamp);
  assert.equal(res.ok, true);
  assert.equal(res.record.rejectedAt, null);
});

test('refuses fields outside the allowlist (scores, text, lock)', () => {
  for (const field of ['assignedScore', 'llmScore', 'originalScore', 'fullText', '_locked', 'approvedFixes']) {
    assert.equal(REVIEW_TEXT_EDITABLE_FIELDS.includes(field), false, field);
    const res = applyReviewFieldEdit({}, { field, oldValue: null, newValue: 1 }, stamp);
    assert.equal(res.ok, false, field);
  }
  // url is allowlisted only as a guarded REPAIR (BRO-4430, see
  // coverage-date-url-slot.test.mjs): a real review url is never replaceable.
  const real = { outletId: 'nytimes', url: 'https://www.nytimes.com/2026/01/01/theater/x-review.html' };
  const res = applyReviewFieldEdit(real, { field: 'url', oldValue: real.url, newValue: 'https://www.nytimes.com/2026/01/02/theater/y-review.html' }, stamp);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not provably wrong/);
});

test('compare-and-set: refuses when the value changed since the plan was written', () => {
  const res = applyReviewFieldEdit({ criticName: 'Jesse Green' }, { field: 'criticName', oldValue: 'Jesse Schulman', newValue: 'X' }, stamp);
  assert.equal(res.ok, false);
  assert.match(res.reason, /changed since plan/);
});

test('refuses _locked records and non-scalar values', () => {
  assert.equal(applyReviewFieldEdit({ _locked: true }, { field: 'criticName', oldValue: null, newValue: 'A' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({}, { field: 'criticName', oldValue: null, newValue: { a: 1 } }, stamp).ok, false);
});

test('clearing duplicateOf requires a clear reason first', () => {
  const res = applyReviewFieldEdit({ duplicateOf: 'a.json' }, { field: 'duplicateOf', oldValue: 'a.json', newValue: null }, stamp);
  assert.equal(res.ok, false);
  const ok = applyReviewFieldEdit({ duplicateOf: 'a.json', duplicateClearReason: 'x' }, { field: 'duplicateOf', oldValue: 'a.json', newValue: null }, stamp);
  assert.equal(ok.ok, true);
});

test('resolveReviewPath keeps paths inside review-texts', () => {
  const root = '/tmp/rt';
  assert.equal(resolveReviewPath(root, 'english-2025/nytimes--jesse-green.json'), path.join(root, 'english-2025/nytimes--jesse-green.json'));
  for (const bad of ['../x/y.json', 'english-2025/../../etc.json', '/abs/x.json', 'english-2025/x.txt', 'a/b/c.json', 'x.json', null]) {
    assert.equal(resolveReviewPath(root, bad), null, String(bad));
  }
});

// Ship-check finding: the write guard can add side effects (auto-flag
// wrongProduction on a date edit, duplicateOf on a URL collision). Those must
// fail the action instead of reporting success.
test('unexpectedChanges: ignores the edited field and the stamp, reports anything else', () => {
  const { unexpectedChanges } = require('./review-field-edit.js');
  const before = { criticName: 'A', publishDate: '2024-01-01', wrongProduction: undefined };
  assert.deepEqual(unexpectedChanges(before, { ...before, publishDate: '2024-02-01', approvedFixes: [{}] }, 'publishDate'), []);
  assert.deepEqual(
    unexpectedChanges(before, { ...before, publishDate: '2024-02-01', wrongProduction: true, duplicateOf: 'x.json' }, 'publishDate'),
    ['duplicateOf', 'wrongProduction'],
  );
  assert.deepEqual(unexpectedChanges({ a: null }, {}, 'b'), [], 'null and missing are the same');
});

// BRO-4275: score override and pull quote, each value-checked.
test('humanReviewScore: integer 1-100 only, stamped like any other edit', () => {
  const ok = applyReviewFieldEdit({ llmScore: { score: 81 } }, { field: 'humanReviewScore', oldValue: null, newValue: 90 }, stamp);
  assert.equal(ok.ok, true);
  assert.equal(ok.record.humanReviewScore, 90);
  assert.equal(ok.record.approvedFixes.at(-1).field, 'humanReviewScore');
  for (const bad of [0, 101, 88.5, '90', true]) {
    assert.equal(applyReviewFieldEdit({}, { field: 'humanReviewScore', oldValue: null, newValue: bad }, stamp).ok, false, String(bad));
  }
  // A clear would be silently restored by the write guard, so it is refused up front.
  assert.equal(applyReviewFieldEdit({ humanReviewScore: 70 }, { field: 'humanReviewScore', oldValue: 70, newValue: null }, stamp).ok, false);
});

test('humanReviewScoreProvisional must be boolean; humanReviewNote non-empty', () => {
  assert.equal(applyReviewFieldEdit({}, { field: 'humanReviewScoreProvisional', oldValue: null, newValue: false }, stamp).ok, true);
  assert.equal(applyReviewFieldEdit({}, { field: 'humanReviewScoreProvisional', oldValue: null, newValue: 'no' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({}, { field: 'humanReviewNote', oldValue: null, newValue: 'rave misread' }, stamp).ok, true);
  assert.equal(applyReviewFieldEdit({}, { field: 'humanReviewNote', oldValue: null, newValue: '  ' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ humanReviewNote: 'x' }, { field: 'humanReviewNote', oldValue: 'x', newValue: null }, stamp).ok, false);
});

test('llmPullQuote must be verbatim from fullText (quote marks and spacing ignored)', () => {
  const rec = { fullText: 'For what is clearly one of the past decade\u2019s most loved plays, this Broadway debut is a beautiful homecoming.' };
  const ok = applyReviewFieldEdit(rec, { field: 'llmPullQuote', oldValue: null, newValue: "this Broadway debut is a  beautiful homecoming." }, stamp);
  assert.equal(ok.ok, true);
  assert.equal(applyReviewFieldEdit(rec, { field: 'llmPullQuote', oldValue: null, newValue: 'An invented rave that the critic never wrote.' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({}, { field: 'llmPullQuote', oldValue: null, newValue: 'No stored text to check this against.' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit(rec, { field: 'llmPullQuote', oldValue: null, newValue: 'too short' }, stamp).ok, false);
});

// BRO-4432: a plan-set flag beside a stale machine auto-clear stayed
// ineffective (isEffectivelyWrongProductionOrShow reads the auto-clear first).
test('setting wrongProduction true retracts a stale auto-clear, reported as an expected side effect', () => {
  const { isEffectivelyWrongProductionOrShow } = require('./content-quality.js');
  const { unexpectedChanges } = require('./review-field-edit.js');
  const record = {
    url: 'https://www.theguardian.com/stage/2020/mar/01/pass-over-kiln-review',
    wrongProduction: false,
    wrongProductionAutoCleared: 'rebuild: WE/OB exempt from URL-year guard (was: URL contains year 2020)',
    wrongProductionAutoClearedAt: '2026-06-01',
  };
  const res = applyReviewFieldEdit(record, { field: 'wrongProduction', oldValue: false, newValue: true }, stamp);
  assert.equal(res.ok, true);
  assert.equal(res.record.wrongProductionAutoCleared, undefined);
  assert.equal(res.record.wrongProductionAutoClearedAt, undefined);
  assert.ok(res.sideEffectKeys.includes('wrongProductionAutoCleared'));
  assert.match(res.msg, /retracted/);
  assert.equal(isEffectivelyWrongProductionOrShow(res.record).effectivelyWrongProduction, true);
  // The executor passes sideEffectKeys, so the retraction is not "unexpected".
  assert.deepEqual(unexpectedChanges(record, res.record, 'wrongProduction', res.sideEffectKeys), []);
  assert.ok(unexpectedChanges(record, res.record, 'wrongProduction').includes('wrongProductionAutoCleared'));
});

test('setting a flag with no auto-clear present has no side effects', () => {
  const res = applyReviewFieldEdit({ url: 'u' }, { field: 'wrongProduction', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, true);
  assert.deepEqual(res.sideEffectKeys, []);
  const off = applyReviewFieldEdit({ url: 'u', wrongProduction: true }, { field: 'wrongProduction', oldValue: true, newValue: false }, stamp);
  assert.deepEqual(off.sideEffectKeys, []);
});

// BRO-4888: duplicate-pointer plans. The write guard resolves a same-url pair on
// its own; that outcome must not be reported as an unexpected change, but a
// guard that SETS a pointer while the plan edits a reason field still must.
test('unexpectedChanges: duplicate-pointer side effects the guard is expected to make', () => {
  const { unexpectedChanges } = require('./review-field-edit.js');
  // Hemming: writing the clear reason makes the guard clear duplicateOf/duplicateReason.
  const hemmingBefore = { duplicateOf: 'bano.json', duplicateReason: 'criticName-override-collided-at-rename', duplicateClearReason: null };
  const hemmingAfter = { duplicateOf: null, duplicateReason: null, duplicateClearReason: 'auto-cleared at write: refusing cycle' };
  assert.deepEqual(unexpectedChanges(hemmingBefore, hemmingAfter, 'duplicateClearReason'), []);
  // Bano: setting duplicateOf makes the guard stamp its own duplicateReason.
  const banoBefore = { duplicateOf: null, duplicateReason: null };
  const banoAfter = { duplicateOf: 'hemming.json', duplicateReason: 'url-collision-detected-at-write' };
  assert.deepEqual(unexpectedChanges(banoBefore, banoAfter, 'duplicateOf'), []);
  // A reason the plan or a human wrote is not the guard's stamp, so it is reported.
  assert.deepEqual(unexpectedChanges({ duplicateOf: null, duplicateReason: 'human note' }, { duplicateOf: 'hemming.json', duplicateReason: null }, 'duplicateOf'), ['duplicateReason']);
});

test('unexpectedChanges: a guard that sets a duplicate pointer while a reason field is edited is still reported', () => {
  const { unexpectedChanges } = require('./review-field-edit.js');
  const before = { duplicateOf: null, duplicateReason: null };
  // The plan edits duplicateReason; the guard set duplicateOf on top: not the plan's intent.
  assert.deepEqual(unexpectedChanges(before, { duplicateOf: 'x.json', duplicateReason: 'y' }, 'duplicateReason'), ['duplicateOf']);
  // The plan edits duplicateClearReason; the guard SET duplicateOf instead of clearing it.
  assert.deepEqual(
    unexpectedChanges({ duplicateOf: null }, { duplicateOf: 'x.json', duplicateClearReason: 'z' }, 'duplicateClearReason'),
    ['duplicateOf'],
  );
  // Unrelated fields are never excused by the duplicate allowance.
  assert.deepEqual(
    unexpectedChanges({ duplicateOf: null }, { duplicateOf: 'x.json', wrongProduction: true }, 'duplicateOf'),
    ['wrongProduction'],
  );
});

test('unexpectedChanges: a guard that sets duplicateClearReason while the plan sets duplicateOf is reported', () => {
  const { unexpectedChanges } = require('./review-field-edit.js');
  assert.deepEqual(
    unexpectedChanges({ duplicateOf: null }, { duplicateOf: 'h.json', duplicateReason: 'url-collision-detected-at-write', duplicateClearReason: 'guard text' }, 'duplicateOf'),
    ['duplicateClearReason'],
  );
});

// BRO-4888 end to end with the REAL write guard: two review files with the same
// url, one stamped a duplicate of the other the wrong way round (the FT
// Hemming/Bano pair; the real Bano file also carries duplicateTextOf: Hemming,
// which is what makes the guard refuse the cycle). The two plan actions, run the way execute-approved-fix.js
// runs them (apply, safeWriteReview, read back, compare, unexpectedChanges),
// must both succeed and leave the Hemming file canonical.
test('FT pair: the plan actions succeed through the real write guard and leave Hemming canonical', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-audit-'));
  const { safeWriteReview } = require('./review-write-guard.js');
  const { unexpectedChanges } = require('./review-field-edit.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-ft-')), 'into-the-woods-west-end-2025');
  fs.mkdirSync(dir, { recursive: true });
  const body = 'Into the Woods is one of Stephen Sondheim\u2019s most popular musicals, but this Bridge Theatre staging is a spellbinding thing. '.repeat(40);
  const base = { showId: 'into-the-woods-west-end-2025', outlet: 'Financial Times', outletId: 'financialtimes', url: 'https://www.ft.com/content/9da2a948-bb09-4c48-9cf3-969d00f35e62', publishDate: '2025-12-12', fullText: body, textQuality: 'full' };
  const H = 'financialtimes--sarah-hemming.json';
  const B = 'financialtimes--tim-bano.json';
  fs.writeFileSync(path.join(dir, H), JSON.stringify({ ...base, criticName: 'Sarah Hemming', assignedScore: 95, duplicateOf: B, duplicateReason: 'criticName-override-collided-at-rename' }, null, 2));
  fs.writeFileSync(path.join(dir, B), JSON.stringify({ ...base, criticName: 'Tim Bano', assignedScore: 89, duplicateTextOf: H }, null, 2));
  const guardText = 'auto-cleared at write: refusing duplicateOf cycle with financialtimes--tim-bano.json (it already points back at us)';
  const plan = [
    { file: H, field: 'duplicateClearReason', oldValue: null, newValue: guardText },
    { file: B, field: 'duplicateOf', oldValue: null, newValue: H },
  ];
  for (const action of plan) {
    const p = path.join(dir, action.file);
    const record = JSON.parse(fs.readFileSync(p, 'utf8'));
    const res = applyReviewFieldEdit(record, action, stamp);
    assert.equal(res.ok, true, `${action.field}: ${res.reason}`);
    safeWriteReview(p, res.record, {});
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(after[action.field] === undefined ? null : after[action.field], action.newValue, `${action.field} kept by the write guard`);
    assert.deepEqual(unexpectedChanges(record, after, action.field, res.sideEffectKeys || []), [], `${action.field} unexpected changes`);
  }
  const hemming = JSON.parse(fs.readFileSync(path.join(dir, H), 'utf8'));
  const bano = JSON.parse(fs.readFileSync(path.join(dir, B), 'utf8'));
  assert.equal(hemming.duplicateOf ?? null, null, 'Hemming is canonical');
  assert.equal(bano.duplicateOf, H, 'the Bano copy is the duplicate');
});
