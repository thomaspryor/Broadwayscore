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

test('cross-outlet verification persists through the real writer and clears the audit', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-outlet-verified-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'show'));
  const file = 'show/guardian--david-cote.json';
  const rec = { showId: 'show', outletId: 'guardian', criticName: 'David Cote', assignedScore: 51 };
  fs.writeFileSync(path.join(root, file), JSON.stringify(rec));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const note = 'BRO-4695: the outlet page explicitly credits David Cote.';
  for (const [field, newValue] of [['crossOutletVerifiedNote', note], ['crossOutletVerified', true]]) {
    const res = executeReviewFieldEditIn(root, { file, field, oldValue: null, newValue }, stamp);
    assert.equal(res.ok, true, res.reason);
  }
  const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.equal(after.crossOutletVerified, true);
  assert.equal(after.crossOutletVerifiedNote, note);
  assert.equal(after.assignedScore, rec.assignedScore);
  const { isTriagedOut } = require('./cross-outlet-triage.js');
  const { explainExclusion } = require('./review-guards.js');
  assert.equal(isTriagedOut(after, explainExclusion), true);
});

test('cross-outlet verification requires an evidence note and cannot contradict wrongAttribution', () => {
  const action = { field: 'crossOutletVerified', oldValue: null, newValue: true };
  assert.equal(applyReviewFieldEdit({}, action, stamp).ok, false);
  const rec = { crossOutletVerifiedNote: 'BRO-4695: page byline checked against the stored critic.' };
  assert.equal(applyReviewFieldEdit(rec, action, stamp).ok, true);
  assert.equal(applyReviewFieldEdit({ ...rec, wrongAttribution: true }, action, stamp).ok, false);
  for (const newValue of [false, null, 1, 'true']) {
    assert.equal(applyReviewFieldEdit(rec, { ...action, newValue }, stamp).ok, false);
  }
  for (const newValue of [null, '', '   ', 'too short', true]) {
    assert.equal(applyReviewFieldEdit({}, { field: 'crossOutletVerifiedNote', oldValue: null, newValue }, stamp).ok, false);
  }
  assert.equal(applyReviewFieldEdit({ ...rec, crossOutletVerified: true }, action, stamp).ok, false, 'compare-and-set still applies');
  assert.equal(applyReviewFieldEdit({ ...rec, _locked: true }, action, stamp).ok, false, 'locks still apply');
});

test('sets a verdict flag when the old value matches, and stamps provenance', () => {
  // mass-west-end-2026 times-uk--dominic-maxwell (BRO-4202)
  const rec = { outletId: 'times-uk', criticName: 'Dominic Maxwell' };
  const res = applyReviewFieldEdit(rec, { field: 'wrongAttribution', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, true);
  assert.equal(res.record.wrongAttribution, true);
  const { approvedFixBinding } = require('./approved-fix-flag.js');
  assert.deepEqual(res.record.approvedFixes, [{ fixId: 'bro-4202', field: 'wrongAttribution', at: stamp.at, newValue: true, boundTo: approvedFixBinding(res.record) }]);
  assert.equal(rec.wrongAttribution, undefined, 'input record is not mutated');
});

test('clears a stale rejection (english-2025 NYT, BRO-4202)', () => {
  const rec = { rejectedAt: '2026-03-02T23:19:38.824Z', rejectedBy: 'ensemble-scoreability-check' };
  const res = applyReviewFieldEdit(rec, { field: 'rejectedAt', oldValue: '2026-03-02T23:19:38.824Z', newValue: null }, stamp);
  assert.equal(res.ok, true);
  assert.equal(res.record.rejectedAt, null);
});

test('refuses fields outside the allowlist (scores, text, lock)', () => {
  for (const field of ['assignedScore', 'llmScore', 'originalScoreNormalized', 'originalScoreSource', 'originalScoreCleared', 'scoreSource', 'fullText', '_locked', 'approvedFixes']) {
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

// BRO-5796: an edit the extractor's write guard refuses would be re-extracted over.
test('llmPullQuote edit cut mid-word is refused', () => {
  const rec = { fullText: 'The play has lost its essential velocity in the move from Lincoln Center Theater, where it began.' };
  const r = applyReviewFieldEdit(rec, { field: 'llmPullQuote', oldValue: null, newValue: 'The play has lost its essential velocity in the move from Lincoln Cent' }, stamp);
  assert.equal(r.ok, false);
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

// BRO-4599: a human wrongShow flag over a SCRIPT-made wrongShowOverride was a
// silent no-op (wrongShowCleared reads the override first). Driven through the
// real write guard: without CLEAR_BREADCRUMBS entries the guard restored the override.
test('wrongShow flag retracts a script wrongShowOverride and survives the write guard', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-audit-'));
  const { safeWriteReview } = require('./review-write-guard.js');
  const { unexpectedChanges } = require('./review-field-edit.js');
  const { wrongShowCleared } = require('./review-guards.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-ws-')), 'magic-mike-live-west-end-2021');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'timeout-london--andrzej-lukowski.json');
  const rec = {
    showId: 'magic-mike-live-west-end-2021', outletId: 'timeout-london', criticName: 'Andrzej Lukowski',
    url: 'https://www.timeout.com/london/theatre/example-review', fullText: 'Placeholder body. '.repeat(80),
    isCombinedReview: true, rejectionReason: null,
    wrongShowOverride: true,
    wrongShowOverrideReason: 'flag-combined-reviews.js: URL co-occurs across 2 show dirs — joint review',
    wrongShowOverrideAt: '2026-06-01T00:00:00.000Z',
  };
  fs.writeFileSync(p, JSON.stringify(rec, null, 2));
  const action = { field: 'wrongShow', oldValue: null, newValue: true };
  const res = applyReviewFieldEdit(rec, action, stamp);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual([...res.sideEffectKeys].sort().filter((k) => k.startsWith('wrongShowOverride')),
    ['wrongShowOverride', 'wrongShowOverrideAt', 'wrongShowOverrideReason']);
  safeWriteReview(p, res.record, {});
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(after.wrongShow, true);
  assert.equal(after.wrongShowOverride, undefined, 'override not restored by the guard');
  assert.equal(wrongShowCleared(after), false, 'flag is effective at rebuild');
  assert.match(after._previousWrongShowClear.reason, /^flag-combined-reviews\.js/);
  assert.deepEqual(unexpectedChanges(rec, after, 'wrongShow', res.sideEffectKeys), []);
});

test('wrongShow flag refuses over wrongShowManualClear or a non-script override', () => {
  const manual = applyReviewFieldEdit({ wrongShowManualClear: true }, { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(manual.ok, false);
  const human = applyReviewFieldEdit({ wrongShowOverride: true, wrongShowOverrideReason: 'checked by hand: joint review of both shows' },
    { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(human.ok, false);
});

test('wrongShow flag refuses when a wrongProduction clear still masks it', () => {
  const res = applyReviewFieldEdit({ wrongProductionManualClear: true }, { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, false);
  assert.match(res.reason, /still masks/);
});

test('wrongShow flag with no clear markers has no side effects', () => {
  const res = applyReviewFieldEdit({ outletId: 'x' }, { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, true);
  assert.deepEqual(res.sideEffectKeys, []);
});

// BRO-5280: the-peewee-herman-show-2010 canadian-press--mark-kennedy got an
// approved wrongAttribution over crossOutletVerified + wrongArticleManualClear,
// and the leftover clears failed audit-self-contradictory-clears on main.
test('wrongAttribution flag retracts its paired clear breadcrumbs and survives the write guard', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-audit-'));
  const { safeWriteReview } = require('./review-write-guard.js');
  const { unexpectedChanges } = require('./review-field-edit.js');
  const { detectAllSelfContradictoryClears } = require('./flag-contradiction.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-wa-')), 'the-peewee-herman-show-2010');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'canadian-press--mark-kennedy.json');
  const rec = {
    showId: 'the-peewee-herman-show-2010', outletId: 'canadian-press', criticName: 'Mark Kennedy',
    url: 'https://www.google.com/hostednews/canadianpress/article/example', contentTier: 'excerpt',
    crossOutletVerified: true, crossOutletVerifiedNote: 'AP wire syndicated under the original byline',
    wrongArticleManualClear: true,
  };
  fs.writeFileSync(p, JSON.stringify(rec, null, 2));
  const res = applyReviewFieldEdit(rec, { field: 'wrongAttribution', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.crossOutletVerified, undefined);
  assert.equal(res.record.wrongArticleManualClear, undefined);
  assert.ok(res.sideEffectKeys.includes('crossOutletVerified') && res.sideEffectKeys.includes('wrongArticleManualClear'));
  assert.match(res.record.clearBreadcrumbRetracted, /approved fix bro-4202/);
  safeWriteReview(p, res.record, {});
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(after.wrongAttribution, true);
  assert.equal(after.crossOutletVerified, undefined, 'breadcrumb not restored by the guard');
  assert.equal(after.crossOutletVerifiedNote, undefined, 'stale explanation of the clear is dropped too');
  assert.deepEqual(detectAllSelfContradictoryClears(after), []);
  assert.deepEqual(unexpectedChanges(rec, after, 'wrongAttribution', res.sideEffectKeys), []);
});

test('wrongAttribution flag refuses over a human wrong-article clear or one that also masks wrongFullText', () => {
  const act = { field: 'wrongAttribution', oldValue: null, newValue: true };
  const human = applyReviewFieldEdit({ url: 'u', wrongArticleManualClear: true, humanReviewedWrongArticle: false, nonReviewManualClear: true }, act, stamp);
  assert.equal(human.ok, false);
  assert.match(human.reason, /human wrong-article clear/);
  const ft = applyReviewFieldEdit({ url: 'u', wrongArticleManualClear: true, wrongFullText: true }, act, stamp);
  assert.equal(ft.ok, false);
  assert.match(ft.reason, /wrongFullText/);
});

test('setting a flag false or a non-paired flag leaves clear breadcrumbs alone', () => {
  const rec = { url: 'u', wrongAttribution: true, crossOutletVerified: true };
  const off = applyReviewFieldEdit(rec, { field: 'wrongAttribution', oldValue: true, newValue: false }, stamp);
  assert.equal(off.record.crossOutletVerified, true);
  assert.deepEqual(off.sideEffectKeys, []);
  const other = applyReviewFieldEdit({ url: 'u', crossOutletVerified: true, isNonReviewReason: 'manual (not a review): test' }, { field: 'isNonReview', oldValue: null, newValue: true }, stamp);
  assert.equal(other.record.crossOutletVerified, true);
});

test('hasApprovedFlag: only an approved true for that field counts', () => {
  const { hasApprovedFlag } = require('./review-field-edit.js');
  assert.equal(hasApprovedFlag({ approvedFixes: [{ field: 'wrongShow', newValue: true }] }, 'wrongShow'), true);
  assert.equal(hasApprovedFlag({ approvedFixes: [{ field: 'wrongShow', newValue: false }] }, 'wrongShow'), false);
  assert.equal(hasApprovedFlag({ approvedFixes: [{ field: 'wrongProduction', newValue: true }] }, 'wrongShow'), false);
  assert.equal(hasApprovedFlag({}, 'wrongShow'), false);
});

test('a url fix undoes an outlet-split relabel that was made from the wrong url (BRO-4190 Hercules)', () => {
  const { unexpectedChanges } = require('./review-field-edit.js');
  const bad = 'https://www.britishtheatre.com/shows/disneys-hercules/cast';
  const btg = 'https://www.britishtheatreguide.info/reviews/disney-s-hercul-theatre-royal-d-24528';
  const rec = {
    outletId: 'britishtheatrecom', outlet: 'BritishTheatre.com', criticName: 'Howard Loxton', url: bad,
    outletIdCorrectedFrom: 'british-theatre',
    outletIdCorrectedReason: `outlet-split: ${bad} resolves to britishtheatrecom (2026-10-12)`,
  };
  const r = applyReviewFieldEdit(rec, { field: 'url', oldValue: bad, newValue: btg }, { fixId: 'f', at: 'now' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.record.outletId, 'british-theatre');
  assert.equal(r.record.outletIdCorrectedFrom, 'britishtheatrecom');
  assert.deepEqual(unexpectedChanges(rec, r.record, 'url'), []);
  // the marker left on the file does not excuse a later outletId change
  const later = { ...r.record, outletId: 'britishtheatrecom', url: 'https://www.britishtheatreguide.info/reviews/x-1' };
  assert.deepEqual(unexpectedChanges(r.record, later, 'url'), ['outletId']);
  // no split marker: a cross-outlet url is still refused
  const plain = { ...rec, outletIdCorrectedFrom: undefined, outletIdCorrectedReason: undefined };
  assert.match(applyReviewFieldEdit(plain, { field: 'url', oldValue: bad, newValue: btg }, { fixId: 'f', at: 'now' }).reason, /another outlet/);
  // a split made from some other url does not license the undo
  const other = { ...rec, outletIdCorrectedReason: 'outlet-split: https://www.britishtheatre.com/review-x/ resolves to britishtheatrecom (2026-10-12)' };
  assert.equal(applyReviewFieldEdit(other, { field: 'url', oldValue: bad, newValue: btg }, { fixId: 'f', at: 'now' }).ok, false);
});

// BRO-4849: originalScore corrects a rating a human checked on the outlet page; the
// rest of the rating set is derived (verified-original-score.js).
const { unexpectedChanges } = require('./review-field-edit.js');
const { getBestScore } = require('./rebuild-helpers.js');
const fixStamp = { fixId: 'bro-4849-f', at: '2026-10-12T00:00:00.000Z' };

test('originalScore: corrects a wrong stored star and derives the rating set', () => {
  // beetlejuice-west-end-2026 shinylife: stored 5/5, page shows 4/5
  const rec = { outletId: 'shinylife', originalScore: '5/5', originalScoreNormalized: 100, originalScoreSource: 'numeric-stars', scoreSource: 'numeric-stars', scoreConfidence: 'low', starRating: '5/5' };
  const res = applyReviewFieldEdit(rec, { field: 'originalScore', oldValue: '5/5', newValue: '4/5' }, fixStamp);
  assert.equal(res.ok, true, res.reason);
  const r = res.record;
  assert.equal(r.originalScore, '4/5');
  assert.equal(r.originalScoreNormalized, 80);
  assert.equal(r.originalScoreSource, 'manual-verified');
  assert.equal(r.scoreSource, 'manual-verified');
  assert.equal(r.scoreConfidence, null);
  assert.equal(r.starRating, null, 'a disagreeing starRating would keep binding the band');
  assert.equal(r.originalScoreCorrectedFrom, '5/5');
  assert.equal(r.previousOriginalScore, undefined, 'not stored as a star an adjudication relied on');
  assert.deepEqual(unexpectedChanges(rec, r, 'originalScore', res.sideEffectKeys), [], 'every derived key is declared');
  assert.equal(getBestScore(r).score, 80, 'the rebuild uses the corrected rating');
});

test('originalScore: a correction on a cleared file un-clears it (else the rebuild skips it)', () => {
  const rec = { outletId: 'shinylife', originalScore: null, originalScoreCleared: true, originalScoreClearedReason: 'p0 audit' };
  const res = applyReviewFieldEdit(rec, { field: 'originalScore', oldValue: null, newValue: '4/5' }, fixStamp);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.originalScoreCleared, false, 'explicit false: a deleted protected field is restored');
  assert.match(res.record.originalScoreClearedReason, /^un-cleared .*was: p0 audit$/, 'rewritten, not nulled: the guard restores a nulled reason');
  assert.equal(getBestScore(res.record).score, 80);
});

test('originalScore: null clears with the write-guard breadcrumb and drops a star-sided adjudication', () => {
  // matilda telegraph: low-reliability star-class 3/5 contradicting the text
  const rec = { outletId: 'telegraph', originalScore: '3/5 stars', originalScoreNormalized: 60, originalScoreSource: 'star-class', scoreSource: 'star-class',
    adjudicatedScore: 60, adjudicationHistory: [{ sidedWith: 'stars' }], llmScore: 88 };
  const res = applyReviewFieldEdit(rec, { field: 'originalScore', oldValue: '3/5 stars', newValue: null }, fixStamp);
  assert.equal(res.ok, true, res.reason);
  const r = res.record;
  assert.equal(r.originalScore, null);
  assert.equal(r.originalScoreNormalized, null);
  assert.equal(r.originalScoreSource, null);
  assert.equal(r.originalScoreCleared, true);
  assert.match(r.originalScoreClearedReason, /bro-4849-f/);
  assert.equal(r.adjudicatedScore, null, 'an adjudication that sided with the wrong star is dropped');
  assert.deepEqual(unexpectedChanges(rec, r, 'originalScore', res.sideEffectKeys), []);
});

test('originalScore: refuses ambiguous, unparseable, outlet-less and stale edits', () => {
  const base = { outletId: 'ew', originalScore: 'B' };
  const bad = [
    [{ ...base }, '75', /unambiguous/],
    [{ ...base }, 'great', /unambiguous/],
    [{ originalScore: 'B' }, 'B+', /outletId/],
    [{ outletId: 'guardian', originalScore: 'B' }, 'B+', /does not parse/],
  ];
  for (const [rec, v, re] of bad) {
    const res = applyReviewFieldEdit(rec, { field: 'originalScore', oldValue: 'B', newValue: v }, fixStamp);
    assert.equal(res.ok, false, v);
    assert.match(res.reason, re);
  }
  assert.equal(applyReviewFieldEdit({ ...base }, { field: 'originalScore', oldValue: 'B', newValue: 'B+' }, fixStamp).ok, true, 'EW letter grade parses');
  assert.equal(applyReviewFieldEdit({ ...base }, { field: 'originalScore', oldValue: 'A', newValue: 'B+' }, fixStamp).ok, false, 'compare-and-set');
  assert.equal(applyReviewFieldEdit({ ...base, _locked: true }, { field: 'originalScore', oldValue: 'B', newValue: 'B+' }, fixStamp).ok, false, '_locked');
});

test('originalScore: un-clear and adjudication drop survive the real write guard on disk', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-audit-'));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-os-'));
  const show = 'fixture-show-2026';
  fs.mkdirSync(path.join(root, show));
  const base = { showId: show, outlet: 'Daily Mail', outletId: 'daily-mail', criticName: 'Patrick Marmion', url: 'https://www.dailymail.co.uk/x' };
  const write = (f, d) => fs.writeFileSync(path.join(root, show, f), JSON.stringify({ ...base, ...d }, null, 2));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, show, f), 'utf8'));
  write('a.json', { originalScore: '5/5 stars', originalScoreCleared: true, originalScoreClearedReason: 'audit' });
  write('b.json', { url: 'https://www.dailymail.co.uk/y', originalScore: '5/5 stars', adjudicatedScore: 40, adjudicationNote: 'sided with the stars', adjudicationHistory: [{ sidedWith: 'stars' }] });
  const a = executeReviewFieldEditIn(root, { file: `${show}/a.json`, field: 'originalScore', oldValue: '5/5 stars', newValue: '3/5 stars' }, fixStamp);
  assert.equal(a.ok, true, a.reason);
  const ra = read('a.json');
  assert.equal(ra.originalScoreCleared, false);
  assert.match(ra.originalScoreClearedReason, /^un-cleared/);
  const b = executeReviewFieldEditIn(root, { file: `${show}/b.json`, field: 'originalScore', oldValue: '5/5 stars', newValue: '3/5 stars' }, fixStamp);
  assert.equal(b.ok, true, b.reason);
  const rb = read('b.json');
  assert.equal(rb.adjudicatedScore, null, 'the guard must not restore a retracted adjudication');
  assert.equal(rb.adjudicationNote, null);
  assert.equal(rb.adjudicatedScoreInvalidated.score, 40);
});

test('originalScore: a verified rating is protected from the collector re-extracting over it', async () => {
  const fs = await import('node:fs');
  const { isHumanVerifiedRating } = require('./verified-original-score.js');
  const rec = { outletId: 'shinylife', originalScore: '5/5' };
  const res = applyReviewFieldEdit(rec, { field: 'originalScore', oldValue: '5/5', newValue: '4/5' }, fixStamp);
  // The scorer re-stamps scoreSource after the fix; the verified marker must still hold.
  assert.equal(isHumanVerifiedRating({ ...res.record, scoreSource: 'anchored-v6' }), true);
  assert.equal(isHumanVerifiedRating({ originalScoreSource: 'lbo-css-stars', originalScore: '4/5' }), false);
  // updateReviewJson is not exported, so pin that both extraction overwrites consult the predicate.
  const src = fs.readFileSync(new URL('../collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(src, /hasUnverifiedSSScore = isSSSource && data\.originalScore && !humanVerified/);
  assert.match(src, /isUnverifiedOrAggregator =\s*!isLlmSource && !humanVerified/);
});

test('aggregator excerpts are clear-only (BRO-4251: Fat Ham text on Shucked\'s Variety quote)', () => {
  const bad = '"The funniest... "Fat Ham" recasts its source material."';
  const rec = { nycTheatreExcerpt: bad };
  const cleared = applyReviewFieldEdit(rec, { field: 'nycTheatreExcerpt', oldValue: bad, newValue: null }, stamp);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.record.nycTheatreExcerpt, null);
  const rewrite = applyReviewFieldEdit(rec, { field: 'nycTheatreExcerpt', oldValue: bad, newValue: 'Some new excerpt text here' }, stamp);
  assert.equal(rewrite.ok, false);
  assert.match(rewrite.reason, /may only clear/);
  const stale = applyReviewFieldEdit(rec, { field: 'nycTheatreExcerpt', oldValue: 'something else', newValue: null }, stamp);
  assert.equal(stale.ok, false);
});

// BRO-5232: king-lear-2019 guardian--jesse-green.json (a web-search phantom
// carrying the real Guardian review's aggregator excerpt) could not be fixed by
// any plan: the write guard strips the cloned excerpt on every write and the
// executor refused the edit as an unexpected change. Driven through the real
// write guard on disk.
test('a verdict fix on a phantom row survives the guard stripping its cloned excerpt', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-audit-'));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-ce-'));
  const show = 'king-lear-2019';
  fs.mkdirSync(path.join(root, show));
  const excerpt = 'Jackson’s Lear is magnificent in its specificity, a performance that feels both ancient and startlingly contemporary.';
  const body = `Glenda Jackson returns to Broadway as Lear. ${excerpt} `.repeat(30);
  const write = (f, d) => fs.writeFileSync(path.join(root, show, f), JSON.stringify(d, null, 2));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, show, f), 'utf8'));
  write('guardian--alexis-soloski.json', { showId: show, outlet: 'The Guardian', outletId: 'guardian', criticName: 'Alexis Soloski', url: 'https://www.theguardian.com/stage/2019/apr/04/king-lear-shakespeare-glenda-jackson-broadway', fullText: body, contentTier: 'complete', dtliExcerpt: excerpt, showScoreExcerpt: excerpt });
  write('guardian--jesse-green.json', { showId: show, outlet: 'The Guardian', outletId: 'guardian', criticName: 'Jesse Green', source: 'web-search', sources: ['web-search'], url: 'https://www.theguardian.com/stage/2019/apr/04/king-lear-review-glenda-jackson-cort-theatre-broadway', contentTier: 'excerpt', dtliExcerpt: excerpt, showScoreExcerpt: excerpt });
  const a = executeReviewFieldEditIn(root, { file: `${show}/guardian--jesse-green.json`, field: 'wrongAttribution', oldValue: null, newValue: true }, stamp);
  assert.equal(a.ok, true, a.reason);
  assert.match(a.msg, /stripped cloned dtliExcerpt, showScoreExcerpt/);
  const ghost = read('guardian--jesse-green.json');
  assert.equal(ghost.wrongAttribution, true);
  assert.equal(ghost.dtliExcerpt, null);
  assert.equal(read('guardian--alexis-soloski.json').dtliExcerpt, excerpt, 'the owner keeps its excerpt');
  // An excerpt nulled without the guard's rule naming it is still reported.
  const { unexpectedChanges } = require('./review-field-edit.js');
  assert.deepEqual(unexpectedChanges({ dtliExcerpt: 'q', wrongAttribution: null }, { dtliExcerpt: null, wrongAttribution: true }, 'wrongAttribution'), ['dtliExcerpt']);
});

test('crossOutletDuplicate: clear-only, with a non-empty breadcrumb (BRO-3870)', () => {
  const rec = { crossOutletDuplicate: true, crossOutletPrimaryFile: 's/gone.json' };
  assert.equal(applyReviewFieldEdit({ ...rec }, { field: 'crossOutletDuplicate', oldValue: false, newValue: true }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ crossOutletDuplicate: false }, { field: 'crossOutletDuplicate', oldValue: false, newValue: true }, stamp).ok, false);
  const why = applyReviewFieldEdit({ ...rec }, { field: 'crossOutletClearReason', oldValue: null, newValue: 'primary gone, twin wrongProduction' }, stamp);
  assert.equal(why.ok, true, why.reason);
  assert.equal(applyReviewFieldEdit({ ...rec }, { field: 'crossOutletClearReason', oldValue: null, newValue: ' ' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ ...rec }, { field: 'crossOutletDuplicate', oldValue: true, newValue: false }, stamp).ok, false, 'reason must come first');
  const res = applyReviewFieldEdit({ ...rec, crossOutletClearReason: 'why' }, { field: 'crossOutletDuplicate', oldValue: true, newValue: false }, stamp);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.crossOutletDuplicate, false);
});

// BRO-3065: a url naming another show, already held in that show's folder, is
// provably wrong for this file (Here There Are Blueberries held WhatsOnStage's
// Here We Are review url).
test('url repair: allowed when another show folder already holds the current url', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { urlOwnedByOtherShow } = require('./review-slot-guards.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-oos-'));
  const wrong = 'https://www.whatsonstage.com/news/here-we-are-at-the-national-theatre-review_1676732/';
  fs.mkdirSync(path.join(root, 'here-we-are-west-end-2025'));
  fs.writeFileSync(path.join(root, 'here-we-are-west-end-2025', 'whatsonstage--sarah-crompton.json'),
    JSON.stringify({ outletId: 'whatsonstage', criticName: 'Sarah Crompton', url: wrong }));
  const detect = (folder, url) => (url.includes('here-we-are') ? { matchedShowId: 'here-we-are-west-end-2025' } : null);
  const args = { reviewTextsDir: root, folder: 'here-there-are-blueberries-west-end-2026', url: wrong, detect };
  assert.deepEqual(urlOwnedByOtherShow(args), { showId: 'here-we-are-west-end-2025', filename: 'whatsonstage--sarah-crompton.json' });
  // url not held there, or detector silent, or the holder already flagged: no proof
  assert.equal(urlOwnedByOtherShow({ ...args, url: wrong.replace('1676732', '1') }), null);
  assert.equal(urlOwnedByOtherShow({ ...args, detect: () => null }), null);
  fs.writeFileSync(path.join(root, 'here-we-are-west-end-2025', 'whatsonstage--sarah-crompton.json'),
    JSON.stringify({ outletId: 'whatsonstage', url: wrong, wrongShow: true }));
  assert.equal(urlOwnedByOtherShow(args), null);

  const rec = { outletId: 'whatsonstage', url: wrong };
  const good = 'https://www.whatsonstage.com/news/here-there-are-blueberries-at-stratford-east-review_1711989/';
  const action = { field: 'url', oldValue: wrong, newValue: good };
  assert.match(applyReviewFieldEdit(rec, action, stamp).reason, /not provably wrong/);
  const ok = applyReviewFieldEdit(rec, action, stamp, { currentUrlOwnedByOtherShow: true });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.record.url, good);
});

// BRO-5295: the write guard honours a clear only when it is NEW (incoming carries the
// breadcrumb, disk does not). A rating re-added to an already-cleared file (Her Campus:
// "1992 starring" read as 2/5 the day after BRO-305 cleared it) therefore could not be
// removed by a plan: "write guard kept 2/5".
test('originalScore -> null removes a rating that was re-added to an already-cleared record', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-audit-'));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-oc-'));
  const show = 'death-becomes-her-tour-2026';
  fs.mkdirSync(path.join(root, show));
  const file = path.join(root, show, 'hercampus--jessica-sprague.json');
  const base = { showId: show, outlet: 'Hercampus', outletId: 'hercampus', criticName: 'Jessica Sprague', url: 'https://www.hercampus.com/school/youngstown/death-becomes-her-review/', fullText: 'x'.repeat(400), contentTier: 'complete', originalScore: '2/5', originalScoreNormalized: 40, originalScoreSource: 'numeric-stars', scoreSource: 'numeric-stars', originalScoreCleared: true, originalScoreClearedReason: 'approved fix earlier: rating verified against the outlet page' };
  fs.writeFileSync(file, JSON.stringify(base, null, 2));
  const r = executeReviewFieldEditIn(root, { file: `${show}/hercampus--jessica-sprague.json`, field: 'originalScore', oldValue: '2/5', newValue: null }, stamp);
  assert.equal(r.ok, true, r.reason);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.originalScore, null);
  assert.equal(after.originalScoreNormalized, null);
  assert.equal(after.originalScoreSource, null);
  assert.equal(after.originalScoreCleared, true);
  assert.equal(after.fullText.length, 400, 'nothing else on the record changes');
});

test('BRO-4415: a syndication mark naming another file clears only on the heal decision (ctx.syndicatedHeal)', () => {
  const rec = { isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'bug-2026/cbsnews--shania-russell.json' };
  const ctx = { folder: 'bug-2026', file: 'ew--shania-russell.json' };
  const flag = { field: 'isSyndicatedDuplicate', oldValue: true, newValue: false };
  const ptr = { field: 'syndicatedPrimaryFile', oldValue: rec.syndicatedPrimaryFile, newValue: null };
  for (const a of [flag, ptr]) {
    assert.equal(applyReviewFieldEdit(rec, a, stamp, ctx).ok, false, `${a.field}: refused without the heal decision`);
    assert.equal(applyReviewFieldEdit(rec, a, stamp, { ...ctx, syndicatedHeal: true }).ok, true, `${a.field}: allowed with it`);
  }
  assert.equal(applyReviewFieldEdit(rec, { ...flag, newValue: true }, stamp, { ...ctx, syndicatedHeal: true }).ok, false, 'never sets the mark');
});

test('BRO-5396: a dangling syndication pointer clears only with no live copy, and repoints only to the live copy the executor found', () => {
  const rec = { isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'bug-2026/gone--pat.json' };
  const ctx = { folder: 'bug-2026', file: 'ny--pat.json' };
  const flag = { field: 'isSyndicatedDuplicate', oldValue: true, newValue: false };
  const clear = { field: 'syndicatedPrimaryFile', oldValue: rec.syndicatedPrimaryFile, newValue: null };
  const repoint = { field: 'syndicatedPrimaryFile', oldValue: rec.syndicatedPrimaryFile, newValue: 'bug-2026/live--pat.json' };
  for (const a of [flag, clear]) {
    assert.equal(applyReviewFieldEdit(rec, a, stamp, ctx).ok, false, `${a.field}: refused without the dangling context`);
    assert.equal(applyReviewFieldEdit(rec, a, stamp, { ...ctx, syndicatedDanglingClear: true }).ok, true, `${a.field}: cleared when no live copy`);
  }
  assert.equal(applyReviewFieldEdit(rec, repoint, stamp, ctx).ok, false, 'repoint refused without the executor finding a copy');
  assert.equal(applyReviewFieldEdit(rec, repoint, stamp, { ...ctx, syndicatedRepointTo: 'other--pat.json' }).ok, false, 'repoint refused to a different file');
  const ok = applyReviewFieldEdit(rec, repoint, stamp, { ...ctx, syndicatedRepointTo: 'live--pat.json' });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.syndicatedPrimaryFile, 'bug-2026/live--pat.json');
});

test('isRoundupArticle is clear-only (BRO-4914): false passes, true and null are refused', () => {
  const rec = { outletId: 'theater-life', isRoundupArticle: true, roundupDetail: '4 other shows mentioned 3+ times' };
  const ok = applyReviewFieldEdit(rec, { field: 'isRoundupArticle', oldValue: true, newValue: false }, stamp);
  assert.equal(ok.ok, true);
  assert.equal(ok.record.isRoundupArticle, false);
  assert.ok(REVIEW_TEXT_EDITABLE_FIELDS.includes('isRoundupArticle'));
  for (const bad of [true, null]) {
    const res = applyReviewFieldEdit({ isRoundupArticle: false }, { field: 'isRoundupArticle', oldValue: false, newValue: bad }, stamp);
    assert.equal(res.ok, false, `newValue ${bad} must be refused`);
  }
  const stale = applyReviewFieldEdit(rec, { field: 'isRoundupArticle', oldValue: false, newValue: false }, stamp);
  assert.equal(stale.ok, false, 'oldValue must match current');
});

test('allowCrossMarket can be set true (a UK critic who reviewed the NYC production), never false or other values (BRO-5499)', () => {
  assert.ok(REVIEW_TEXT_EDITABLE_FIELDS.includes('allowCrossMarket'));
  const rec = { outletId: 'attitude', criticName: 'Kyle Torrence' };
  const ok = applyReviewFieldEdit(rec, { field: 'allowCrossMarket', oldValue: null, newValue: true }, stamp);
  assert.equal(ok.ok, true);
  assert.equal(ok.record.allowCrossMarket, true);
  assert.equal(applyReviewFieldEdit(rec, { field: 'allowCrossMarket', oldValue: null, newValue: false }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit(rec, { field: 'allowCrossMarket', oldValue: null, newValue: 'yes' }, stamp).ok, false);
});

// BRO-5858: stranger-things WhatsOnStage. A stale bulk fabricatedEntry kept Alex
// Wood's real review out, so the rebuild scored a same-url twin under the wrong critic.
test('fabricatedEntry can only be cleared (BRO-5858)', () => {
  const rec = { outletId: 'whatsonstage', criticName: 'Alex Wood', fabricatedEntry: true };
  const cleared = applyReviewFieldEdit(rec, { field: 'fabricatedEntry', oldValue: true, newValue: false }, stamp);
  assert.equal(cleared.ok, true, cleared.reason);
  assert.equal(cleared.record.fabricatedEntry, false);
  assert.equal(applyReviewFieldEdit({ ...rec, fabricatedEntry: false }, { field: 'fabricatedEntry', oldValue: false, newValue: true }, stamp).ok, false);
});

// BRO-5557: a tag index url is provably wrong. A Ghost in Your Ear's TheaterMania
// review was auto-pinned onto theatermania.com/tags/<show>/, which the rebuild
// drops, and classifyReviewUrl alone did not call it wrong, so it could not be repaired.
test('url repair: a tag-index url is repairable to the real review url', () => {
  const tags = 'https://www.theatermania.com/tags/a-ghost-in-your-ear/';
  const real = 'https://www.theatermania.com/news/review-a-ghost-in-your-ear-the-curse-of-daddy-issues-in-an-audiobook_1857147/';
  const res = applyReviewFieldEdit({ outletId: 'theatermania', url: tags }, { field: 'url', oldValue: tags, newValue: real }, stamp);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.url, real);
  // a real review url is still never replaced
  const keep = applyReviewFieldEdit({ outletId: 'theatermania', url: real }, { field: 'url', oldValue: real, newValue: tags }, stamp);
  assert.equal(keep.ok, false);
});

test('aggregatorStars: sourceless stars clear and queue a rescore (BRO-6018)', () => {
  const rec = { outletId: 'mail-on-sunday', aggregatorStars: '4/5', assignedScore: 91, rescoreCompletedAt: '2026-10-01T00:00:00.000Z' };
  const res = applyReviewFieldEdit(rec, { field: 'aggregatorStars', oldValue: '4/5', newValue: null }, stamp);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.aggregatorStars, null);
  assert.equal(res.record.needsRescore, true);
  assert.match(res.record.rescoreReason, /sourceless aggregatorStars cleared/);
  assert.equal(res.record.rescoreCompletedAt, undefined);
  assert.ok(res.sideEffectKeys.includes('needsRescore'), 'rescore flags are declared side effects, not surprises');
  assert.equal(rec.needsRescore, undefined, 'input record is not mutated');
});

test('aggregatorStars: refuses stars with a source, writes, and a stale oldValue', () => {
  const sourced = { aggregatorStars: '4/5', aggregatorStarsSource: 'json-ld' };
  assert.equal(applyReviewFieldEdit(sourced, { field: 'aggregatorStars', oldValue: '4/5', newValue: null }, stamp).ok, false);
  const bare = { aggregatorStars: '4/5' };
  assert.equal(applyReviewFieldEdit(bare, { field: 'aggregatorStars', oldValue: '4/5', newValue: '5/5' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit(bare, { field: 'aggregatorStars', oldValue: '3/5', newValue: null }, stamp).ok, false);
});

test('aggregatorStars clear survives the real writer and leaves the file queued for rescore (BRO-6018)', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-stars-clear-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'show'));
  const file = 'show/mail-on-sunday--critic.json';
  fs.writeFileSync(path.join(root, file), JSON.stringify({ showId: 'show', outletId: 'mail-on-sunday', criticName: 'A Critic', assignedScore: 91, aggregatorStars: '5/5' }));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const res = executeReviewFieldEditIn(root, { file, field: 'aggregatorStars', oldValue: '5/5', newValue: null }, stamp);
  assert.equal(res.ok, true, res.reason);
  const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.equal(after.aggregatorStars == null, true, 'the guard must not restore the cleared stars');
  assert.equal(after.needsRescore, true);
  // A round-up scraper refilling the empty field (sourceless) must not bring the copied stars back.
  const { safeWriteReview } = require('./review-write-guard.js');
  safeWriteReview(path.join(root, file), { ...after, aggregatorStars: '5/5' }, {});
  const refilled = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.equal(refilled.aggregatorStars == null, true, 'a sourceless refill must not undo the approved clear');
});

test('scoreProvenance: stamps page-parsed on a body-less LLM-relabelled file only (BRO-6052)', () => {
  const rec = { outletId: 'thestage', originalScore: 60, scoreSource: 'llm-v6', fullText: null };
  const res = applyReviewFieldEdit(rec, { field: 'scoreProvenance', oldValue: null, newValue: 'page-parsed' }, stamp);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.scoreProvenance, 'page-parsed');
  const { bodylessScoreProvenance } = require('./review-guards');
  assert.equal(bodylessScoreProvenance(rec), 'aggregator-inherited');
  assert.equal(bodylessScoreProvenance(res.record), 'page-parsed');
  assert.equal(rec.scoreProvenance, undefined, 'input record is not mutated');
});

test('scoreProvenance: refuses other values, true aggregator sources, bodies, scoreless and stamped files', () => {
  const base = { originalScore: 60, scoreSource: 'llm-v6', fullText: null };
  const edit = (rec, newValue = 'page-parsed', oldValue = null) => applyReviewFieldEdit(rec, { field: 'scoreProvenance', oldValue, newValue }, stamp);
  assert.equal(edit(base, 'aggregator-inherited').ok, false);
  assert.equal(edit({ ...base, scoreSource: 'london-box-office' }).ok, false);
  assert.equal(edit({ ...base, fullText: 'x'.repeat(300) }).ok, false);
  assert.equal(edit({ originalScore: null, scoreSource: 'llm-v6' }).ok, false);
  assert.equal(edit({ ...base, scoreProvenance: 'aggregator-inherited' }, 'page-parsed', 'aggregator-inherited').ok, false);
});

test('scoreProvenance: refuses relabelled aggregator relays and mismatched-page files (BRO-6052 review)', () => {
  const base = { originalScore: 60, scoreSource: 'anchored-v6', fullText: null };
  const edit = (rec) => applyReviewFieldEdit(rec, { field: 'scoreProvenance', oldValue: null, newValue: 'page-parsed' }, stamp);
  assert.equal(edit({ ...base, aggregatorStarsSource: 'lbo-star-rating' }).ok, false);
  assert.equal(edit({ ...base, originalScoreSource: 'show-score-stars' }).ok, false);
  assert.equal(edit({ ...base, incompleteReason: 'url_content_mismatch' }).ok, false);
  assert.equal(edit({ ...base, incompleteReason: 'paywall' }).ok, true);
});

test('scoreProvenance: any content-verdict incompleteReason refuses (BRO-6052 ship-check)', () => {
  const base = { originalScore: 60, scoreSource: 'anchored-v6', fullText: null };
  for (const incompleteReason of ['wrong_content', 'roundup_only', 'no_url', 'url_dead', 'scraper_garbage']) {
    const res = applyReviewFieldEdit({ ...base, incompleteReason }, { field: 'scoreProvenance', oldValue: null, newValue: 'page-parsed' }, stamp);
    assert.equal(res.ok, false, incompleteReason);
  }
});

test('scoreProvenance: an access-failure incompleteReason (paywall, scraper_timeout) is allowed', () => {
  for (const incompleteReason of ['paywall', 'scraper_timeout']) {
    const res = applyReviewFieldEdit({ originalScore: 60, scoreSource: 'anchored-v6', fullText: null, incompleteReason }, { field: 'scoreProvenance', oldValue: null, newValue: 'page-parsed' }, stamp);
    assert.equal(res.ok, true, incompleteReason);
  }
});

test('outletId relabels an AP wire page to ap through the real writer (BRO-5289)', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-relabel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'show'));
  const file = 'show/wsj--mark-kennedy.json';
  const url = 'https://online.wsj.com/article/AP216f8806ddad4b8b9837a6702e4b81cb.html';
  fs.writeFileSync(path.join(root, file), JSON.stringify({ showId: 'show', outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Mark Kennedy', url, fullText: 'NEW YORK — a review.' }));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const res = executeReviewFieldEditIn(root, { file, field: 'outletId', oldValue: 'wsj', newValue: 'ap' }, stamp);
  assert.equal(res.ok, true, res.reason);
  const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.equal(after.outletId, 'ap');
  assert.equal(after.outlet, 'Associated Press');
  assert.equal(after.outletIdCorrectedFrom, 'wsj');
  assert.equal(after.url, url);
});

test('outletId relabel to ap also clears the AP-scan duplicate flags so the review is not excluded (BRO-5289)', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-relabel-flags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'show'));
  const url = 'https://online.wsj.com/article/AP216f8806ddad4b8b9837a6702e4b81cb.html';
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  for (const pointer of ['show/ap--associated-press.json', 'show/wsj--mark-kennedy.json']) {
    const file = 'show/wsj--mark-kennedy.json';
    fs.writeFileSync(path.join(root, file), JSON.stringify({ showId: 'show', outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Mark Kennedy', url, fullText: 'NEW YORK — a review.', isSyndicatedDuplicate: true, syndicatedPrimaryFile: pointer, _apContentDetected: true }));
    const res = executeReviewFieldEditIn(root, { file, field: 'outletId', oldValue: 'wsj', newValue: 'ap' }, stamp);
    assert.equal(res.ok, true, res.reason);
    const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(after.outletId, 'ap');
    assert.ok(!after.isSyndicatedDuplicate, pointer);
    assert.ok(!after.syndicatedPrimaryFile, pointer);
    assert.ok(!after._apContentDetected);
  }
});

test('an ap row with an AP wire url can drop its leftover AP-scan duplicate flags even when the pointer target is an empty stub (BRO-5289)', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'show'));
  const url = 'https://online.wsj.com/article/AP216f8806ddad4b8b9837a6702e4b81cb.html';
  const body = 'NEW YORK — a review of the revival with plenty of words. '.repeat(30);
  fs.writeFileSync(path.join(root, 'show/ap--associated-press.json'), JSON.stringify({ showId: 'show', outletId: 'ap', url, fullText: '' }));
  fs.writeFileSync(path.join(root, 'show/wsj--other.json'), JSON.stringify({ showId: 'show', outletId: 'wsj', url: 'https://stream.wsj.com/x', fullText: body }));
  fs.writeFileSync(path.join(root, 'show/ap--mark-kennedy.json'), JSON.stringify({ showId: 'show', outletId: 'ap', url, fullText: body, isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'show/ap--associated-press.json', _apContentDetected: true }));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const a = executeReviewFieldEditIn(root, { file: 'show/ap--mark-kennedy.json', field: 'isSyndicatedDuplicate', oldValue: true, newValue: false }, stamp);
  assert.equal(a.ok, true, a.reason);
  const b = executeReviewFieldEditIn(root, { file: 'show/ap--mark-kennedy.json', field: 'syndicatedPrimaryFile', oldValue: 'show/ap--associated-press.json', newValue: null }, stamp);
  assert.equal(b.ok, true, b.reason);
  // a non-ap row with the same leftovers is not covered
  fs.writeFileSync(path.join(root, 'show/wsj--other.json'), JSON.stringify({ showId: 'show', outletId: 'wsj', url, fullText: body, isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'show/ap--associated-press.json', _apContentDetected: true }));
  const c = executeReviewFieldEditIn(root, { file: 'show/wsj--other.json', field: 'isSyndicatedDuplicate', oldValue: true, newValue: false }, stamp);
  assert.equal(c.ok, false);
});

test('outletId relabel is refused for any other outlet, a non-AP url, or a stale oldValue', () => {
  const wire = { outletId: 'wsj', url: 'https://online.wsj.com/article/AP216f8806ddad4b8b9837a6702e4b81cb.html' };
  const act = { field: 'outletId', oldValue: 'wsj', newValue: 'ap' };
  assert.equal(applyReviewFieldEdit(wire, act, stamp).ok, true);
  assert.equal(applyReviewFieldEdit(wire, { ...act, newValue: 'nytimes' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ outletId: 'wsj', url: 'https://www.wsj.com/articles/hamilton-review-1438821601' }, act, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ ...wire, outletId: 'nypost' }, act, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ ...wire, _locked: true }, act, stamp).ok, false);
});

test('outletId relabel tests the url path, not a query string (BRO-5289)', () => {
  const rec = { outletId: 'nytimes', url: 'https://www.nytimes.com/2013/x.html?ref=/article/AP216f8806ddad4b8b9837a6702e4b81cb' };
  assert.equal(applyReviewFieldEdit(rec, { field: 'outletId', oldValue: 'nytimes', newValue: 'ap' }, stamp).ok, false);
});

test('outletId relabel (BRO-5995): to the registry outlet the record label names, never higher tier, ap path unchanged', () => {
  const rec = { outletId: 'cleveland-plain-dealer', outlet: "Cleveland's Star 102", url: 'https://www.audacy.com/star102cleveland/latest/x' };
  const act = (v, r = rec) => applyReviewFieldEdit(r, { field: 'outletId', oldValue: r.outletId, newValue: v }, stamp);
  const ok = act('clevelands-star-102');
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.record.outletId, 'clevelands-star-102');
  assert.equal(ok.record.outletIdCorrectedFrom, 'cleveland-plain-dealer');
  assert.match(ok.record.outletIdCorrectedReason, /own outlet label/);
  assert.doesNotMatch(ok.record.outletIdCorrectedReason, /Associated Press/);
  // not in registry / label does not name the target / tier promotion
  assert.match(act('no-such-outlet-xyz').reason, /not in the outlet registry/);
  assert.match(act('nytimes').reason, /does not name nytimes/);
  const promo = act('nytimes', { ...rec, outlet: 'The New York Times' });
  assert.equal(promo.ok, false);
  assert.match(promo.reason || '', /raise the review's tier/);
  // AP side effects never fire on a label relabel
  const synd = act('clevelands-star-102', { ...rec, _apContentDetected: true, isSyndicatedDuplicate: true });
  assert.equal(synd.record.isSyndicatedDuplicate, true);
  // ap path unchanged
  assert.match(act('ap').reason, /needs an AP wire url/);
});

// BRO-6488: a plan url edit on an auto-pinned file whose url another critic's
// file holds goes through the real executor, and the pin lift is not refused as
// an unexpected side effect.
test('approved url edit repairs an auto-pinned url another critic holds', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6488-exec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const WRONG = 'https://www.whatsonstage.com/news/arcadia-at-the-soon-to-be-tom-stoppard-theatre-review_1726588/';
  const RIGHT = 'https://www.whatsonstage.com/news/tom-stoppards-arcadia-at-the-old-vic-review_1711215/';
  fs.mkdirSync(path.join(root, 'arcadia-west-end-2026'));
  fs.writeFileSync(path.join(root, 'arcadia-west-end-2026/whatsonstage--alex-wood.json'),
    JSON.stringify({ showId: 'arcadia-west-end-2026', outletId: 'whatsonstage', criticName: 'Alex Wood', url: WRONG, publishDate: '2026-07-01' }));
  const file = 'arcadia-west-end-2026/whatsonstage--sarah-crompton.json';
  fs.writeFileSync(path.join(root, file), JSON.stringify({
    showId: 'arcadia-west-end-2026', outletId: 'whatsonstage', criticName: 'Sarah Crompton', url: WRONG, publishDate: '2026-07-01',
    urlVerified: true, urlVerifiedAuto: true, urlVerifiedNote: 'Auto-pinned 2026-08-17',
  }));
  const res = executeReviewFieldEditIn(root, { file, field: 'url', oldValue: WRONG, newValue: RIGHT }, stamp);
  assert.equal(res.ok, true, res.reason);
  const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.equal(after.url, RIGHT);
  assert.equal(after.urlVerifiedAuto, undefined);
});

// BRO-6676: a human-approved negative flag binds to the url + body it judged.
test('hasApprovedFlag: a bound approval stops applying once the body or url changes (The Heart / bro-4953)', () => {
  const { hasApprovedFlag } = require('./review-field-edit.js');
  const placeholder = { url: 'https://www.nytimes.com/2026/10/29/theater/the-heart-review.html', nycTheatreExcerpt: "'The Heart of Rock and Roll' is not going to be the subject of think pieces" };
  const res = applyReviewFieldEdit(placeholder, { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, true);
  assert.equal(hasApprovedFlag(res.record, 'wrongShow'), true, 'still binds to the content it judged');
  assert.equal(hasApprovedFlag({ ...res.record, fullText: 'A bracing new musical pulses with life. '.repeat(40) }, 'wrongShow'), false, 'real body arrived');
  assert.equal(hasApprovedFlag({ ...res.record, url: 'https://www.nytimes.com/2026/10/29/theater/other.html' }, 'wrongShow'), false, 'url changed');
  assert.equal(hasApprovedFlag({ approvedFixes: [{ field: 'wrongShow', newValue: true }], fullText: 'x' }, 'wrongShow'), true, 'legacy unbound entries keep applying');
});

test('hasApprovedFlag: excerpt churn and whitespace re-cleans keep a bound approval (BRO-4599 guard)', () => {
  const { hasApprovedFlag } = require('./review-field-edit.js');
  const res = applyReviewFieldEdit({ url: 'https://example.com/a', fullText: 'A bracing   new musical.\n', metaExcerpt: 'old' }, { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(hasApprovedFlag({ ...res.record, metaExcerpt: 'refreshed', dtliExcerpt: 'new excerpt' }, 'wrongShow'), true, 'excerpt churn');
  assert.equal(hasApprovedFlag({ ...res.record, fullText: 'a bracing new musical.' }, 'wrongShow'), true, 'whitespace/case re-clean');
  const ex = applyReviewFieldEdit({ url: 'https://example.com/b', dtliExcerpt: 'x' }, { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(hasApprovedFlag({ ...ex.record, playbillExcerpt: 'later excerpt' }, 'wrongShow'), true, 'later aggregator excerpt');
});

test('hasApprovedFlag: a cosmetic url swap (https, www, tracking params) keeps a bound approval', () => {
  const { hasApprovedFlag } = require('./review-field-edit.js');
  const res = applyReviewFieldEdit({ url: 'http://www.example.com/a/', fullText: 'Body text.' }, { field: 'wrongShow', oldValue: null, newValue: true }, stamp);
  assert.equal(hasApprovedFlag({ ...res.record, url: 'https://example.com/a?utm_source=x' }, 'wrongShow'), true);
  assert.equal(hasApprovedFlag({ ...res.record, url: 'https://example.com/b' }, 'wrongShow'), false);
});
