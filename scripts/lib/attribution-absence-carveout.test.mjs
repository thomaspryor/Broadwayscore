// TESTS-VS-DERIVED-DATA-EXEMPT: pure-function unit tests against synthetic fixtures, no live shows.json facts asserted.
// BRO-6491: content-verifier rejections that only say the byline/outlet is absent.
// Run: node --test scripts/lib/attribution-absence-carveout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAttributionAbsenceIssue, applyAttributionAbsenceCarveout } = require('./attribution-absence-carveout.js');
const { verifyContent } = require('./content-verifier.js');

const names = { criticName: 'Cameron Kelsall', outletName: 'Exeunt Magazine' };
const clean = { isValid: false, wrongArticle: false, wrongProduction: false, isFilmTv: false, truncated: false, articleType: 'review' };

// Issue strings in the shape the verifier stored on Exeunt rows.
const ABSENCE = [
  'Critic byline missing: Expected Cameron Kelsall from Exeunt Magazine, but no byline or outlet attribution appears in scraped text',
  'Outlet not identified in scraped content: No Exeunt Magazine attribution or Cameron Kalsall byline found',
  'Critic byline missing: scraped content does not name Cameron Kelsall as the author',
  'Outlet missing: no attribution to Exeunt Magazine found in scraped text',
  "Outlet attribution to 'Exeunt Magazine' cannot be verified from the scraped content",
  'Cannot verify outlet or critic attribution from scraped content',
];

const NOT_ABSENCE = [
  // truncation
  'Byline absent and the article is truncated mid-word.',
  'Text is truncated mid-sentence at 3341 characters',
  'Critic byline missing; text ends mid-sentence',
  // different critic / outlet (explicit conflicting attribution)
  'No expected byline; this is a different article by a different critic.',
  'Critic byline is John Smith, not Cameron Kelsall',
  'Review is not by Cameron Kelsall',
  'Byline is not Cameron Kelsall',
  'The outlet is not Exeunt Magazine',
  'The outlet appears to be AP (Associated Press), not Exeunt Magazine.',
  'No byline for Cameron Kelsall; written by Jane Doe',
  'Critic byline mismatch: scraped content does not identify the critic as Cameron Kelsall',
  'Outlet mismatch: Expected outlet is Exeunt Magazine, but scraped content does not identify the publishing outlet or byline',
  // wrong article / non-review / other content issues
  'No outlet attribution; this is a roundup of several shows.',
  'Known excerpt not found in scraped content',
  'Cannot verify match to expected critic (Cameron Kelsall) or outlet (Exeunt Magazine) from provided excerpt',
  'Review publish date (2025-03-10) cannot be verified from the scraped text',
  'Venue not named in scraped text',
  '',
];

test('whole-string absence-of-byline/outlet clauses are recognised', () => {
  for (const s of ABSENCE) assert.equal(isAttributionAbsenceIssue(s, names), true, s);
});

test('truncation, different-critic, wrong-article and other issues are not', () => {
  for (const s of NOT_ABSENCE) assert.equal(isAttributionAbsenceIssue(s, names), false, s);
});

test('a name that is not the expected critic/outlet keeps the issue', () => {
  assert.equal(isAttributionAbsenceIssue('No byline for Jane Doe found', names), false);
  assert.equal(isAttributionAbsenceIssue('No byline for Cameron Kelsall found', names), true);
});

test('restores a verdict whose only issues are missing attribution', () => {
  const r = applyAttributionAbsenceCarveout({ ...clean, issues: ABSENCE.slice(0, 2) }, names);
  assert.equal(r.applied, true);
  assert.equal(r.isValid, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.dropped.length, 2);
});

test('leaves the verdict unchanged when any other issue remains', () => {
  for (const other of NOT_ABSENCE.filter(Boolean)) {
    const v = { ...clean, issues: [ABSENCE[0], other] };
    const r = applyAttributionAbsenceCarveout(v, names);
    assert.equal(r.applied, false, other);
    assert.equal(r.isValid, false);
    assert.deepEqual(r.issues, v.issues);
  }
});

test('never overrides a wrongArticle / wrongProduction / isFilmTv / truncated flag or a non-review type', () => {
  for (const flag of [{ wrongArticle: true }, { wrongProduction: true }, { isFilmTv: true }, { truncated: true }, { articleType: 'preview' }, { articleType: 'listicle' }]) {
    const r = applyAttributionAbsenceCarveout({ ...clean, ...flag, issues: [ABSENCE[0]] }, names);
    assert.equal(r.applied, false, JSON.stringify(flag));
    assert.equal(r.isValid, false);
  }
});

test('no-ops on valid verdicts and empty issue lists', () => {
  assert.equal(applyAttributionAbsenceCarveout({ ...clean, isValid: true, issues: [ABSENCE[0]] }, names).applied, false);
  assert.equal(applyAttributionAbsenceCarveout({ ...clean, issues: [] }, names).applied, false);
  assert.equal(applyAttributionAbsenceCarveout(null, names).applied, false);
});

test('verifyContent applies it to a live verdict, and keeps a truncated one rejected', async () => {
  const run = (verdict) => verifyContent({
    scrapedText: 'The Example has excellent acting and direction. '.repeat(30),
    showTitle: 'The Example', outletName: 'Exeunt Magazine', criticName: 'Cameron Kelsall',
    provider: { name: 'offline-regression', call: async () => JSON.stringify({ confidence: 'high', ...verdict }) },
  });
  const ok = await run({ ...clean, issues: [ABSENCE[0], ABSENCE[3]] });
  assert.equal(ok.isValid, true);
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.attributionAbsenceCarveoutApplied, true);

  const cut = await run({ ...clean, truncated: true, issues: [ABSENCE[0], 'Text is truncated mid-sentence'] });
  assert.equal(cut.isValid, false);
  assert.equal(cut.issues.length, 2);
  assert.equal(cut.attributionAbsenceCarveoutApplied, false);

  const other = await run({ ...clean, issues: [ABSENCE[0], 'Critic byline is John Smith, not Cameron Kelsall'] });
  assert.equal(other.isValid, false);
});
