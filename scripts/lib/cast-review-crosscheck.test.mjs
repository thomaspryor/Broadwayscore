import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { crossCheckCast, isEvidenceReview, explainContradiction, HAND_CHECKED } = require('./cast-review-crosscheck');

const pad = ' The staging moves briskly through two acts of comic invention and quiet feeling.'.repeat(25);
const review = (names) => `${names} take the stage. ${pad}`;

// Real shapes: King of the Yees, Signature Theatre 2026 (cast scraped from another company's production).
const WRONG = [{ name: 'Sandra Lee' }, { name: 'Rob Narita' }, { name: 'Nick Ong' }, { name: 'Madeleine Tran' }, { name: 'Heath Hyun Houghton' }];
const RIGHT = [{ name: 'Francis Jue' }, { name: 'Kelly Marie Tran' }, { name: 'David Shih' }, { name: 'Maureen Sebastian' }, { name: 'Jon Norman Schneider' }];
const TEXTS = [
  review('Francis Jue and Kelly Marie Tran'),
  review('Maureen Sebastian, David Shih and Jon Norman Schneider'),
  review('Jue is Larry; Tran plays Lauren'),
];

test('contradicted: the cast on file is named in none of the reviews', () => {
  const r = crossCheckCast(WRONG, TEXTS);
  assert.equal(r.verdict, 'contradicted');
  assert.equal(r.named.length, 0);
});

test('ok: the real cast is named', () => {
  const r = crossCheckCast(RIGHT, TEXTS);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.named.length, 5);
});

test('first and last name as separate words count (middle names, "Jue" alone does not)', () => {
  const r = crossCheckCast([{ name: 'Kelly Tran' }, { name: 'Francis Jue' }], TEXTS);
  assert.deepEqual(r.named.sort(), ['Francis Jue', 'Kelly Tran']);
  const only = crossCheckCast([{ name: 'Jue Wong' }, { name: 'Tran Smith' }], TEXTS);
  assert.equal(only.verdict, 'contradicted');
});

test('insufficient: fewer than three full reviews, or fewer than two named people', () => {
  assert.equal(crossCheckCast(WRONG, TEXTS.slice(0, 2)).verdict, 'insufficient');
  assert.equal(crossCheckCast([{ name: 'Madonna' }, { name: 'Sting' }], TEXTS).verdict, 'insufficient');
  assert.equal(crossCheckCast(WRONG, [TEXTS[0], TEXTS[1], 'short stub']).verdict, 'insufficient');
});

test('suspect (advisory): a big cast list with almost nobody named', () => {
  const big = Array.from({ length: 12 }, (_, i) => ({ name: `Actor${String.fromCharCode(97 + i)} Surname${String.fromCharCode(97 + i)}` }));
  big[0] = { name: 'Francis Jue' };
  assert.equal(crossCheckCast(big, TEXTS).verdict, 'suspect');
});

test('accents and case fold', () => {
  const r = crossCheckCast([{ name: 'Adrián González' }, { name: 'Marin Hinkle' }], [review('ADRIAN GONZALEZ and Marin Hinkle'), TEXTS[0], TEXTS[1]]);
  assert.equal(r.verdict, 'ok');
});

test('isEvidenceReview skips stubs, rejected and wrong-production files', () => {
  const base = { fullText: 'x', contentTier: 'complete' };
  assert.equal(isEvidenceReview(base), true);
  assert.equal(isEvidenceReview({ ...base, contentTier: 'stub' }), false);
  assert.equal(isEvidenceReview({ ...base, rejectedAt: '2026-10-20' }), false);
  assert.equal(isEvidenceReview({ ...base, wrongProduction: true }), false);
  assert.equal(isEvidenceReview({ ...base, isRoundupArticle: true }), false);
  assert.equal(isEvidenceReview({ contentTier: 'complete' }), false);
});

// BRO-5857: Operation Mincemeat 2025 lists the 2026 replacement company; reviews name the opening company.
const OBC = [{ name: 'Francis Jue' }, { name: 'Kelly Marie Tran' }, { name: 'David Shih' }];
const LATER = [{ name: 'Brandon Contreras' }, { name: 'Jessi Kirtley' }];
const open = (extra) => ({ status: 'open', openingDate: '2025-03-20', cast: LATER, ...extra });

test('current-cast: open row lists the cast file currentCast and the opening cast is named', () => {
  assert.equal(crossCheckCast(LATER, TEXTS).verdict, 'contradicted');
  assert.equal(explainContradiction(open(), { openingNightCast: OBC, currentCast: LATER }, TEXTS), 'current-cast');
});

test('no excuse when the row cast is not the file currentCast, the opening cast is not named, or the run is closed', () => {
  assert.equal(explainContradiction(open({ cast: WRONG }), { openingNightCast: OBC, currentCast: LATER }, TEXTS), null);
  assert.equal(explainContradiction(open(), { openingNightCast: WRONG, currentCast: LATER }, TEXTS), null);
  assert.equal(explainContradiction(open({ status: 'closed' }), { openingNightCast: OBC, currentCast: LATER }, TEXTS), null);
});

test('no excuse for run length alone: a wrong cast on a ten-year run with no opening cast on file stays contradicted', () => {
  assert.equal(explainContradiction(open({ openingDate: '2014-09-18', cast: WRONG }), null, TEXTS), null);
  assert.equal(explainContradiction(open({ openingDate: '2014-09-18', cast: WRONG }), { openingNightCast: [], currentCast: null }, TEXTS), null);
});

test('hand-checked: listed row excused only while it still carries rowHas and the entry has not expired', () => {
  const id = 'les-miserables-west-end-2021';
  const { rowHas, until } = HAND_CHECKED[id];
  const row = (cast) => ({ id, status: 'open', cast });
  assert.equal(explainContradiction(row([{ name: rowHas }, ...WRONG]), null, TEXTS, '2026-10-21'), 'hand-checked');
  assert.equal(explainContradiction(row(WRONG), null, TEXTS, '2026-10-21'), null);
  assert.equal(explainContradiction(row([{ name: rowHas }, ...WRONG]), null, TEXTS, until.replace(/^(\d{4})/, (y) => String(+y + 1))), null);
  assert.equal(explainContradiction({ ...row([{ name: rowHas }, ...WRONG]), id: 'some-other-show' }, null, TEXTS, '2026-10-21'), null);
});
