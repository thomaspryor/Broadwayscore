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

// The 28 distinct issue strings the verifier stored on real byline-only
// rejections (review-texts, 2026-11-02), with that row's critic and outlet.
const REAL_POSITIVES = [
  ["Sandi Durell", "Theater Pizzazz", "Critic name not found in scraped content; expected 'Sandi Durell' but no byline is present"],
  ["Sandi Durell", "Theater Pizzazz", "Outlet name not found in scraped content; expected 'Theater Pizzazz' but no outlet attribution is present"],
  ["Rosie Vaughn", "Theatre is Easy", "Critic name not found in scraped content \u2014 Expected 'Rosie Vaughn' but no byline is present"],
  ["Rosie Vaughn", "Theatre is Easy", "Outlet/publication name not found \u2014 Expected 'Theatre is Easy' but no outlet attribution appears in scraped text"],
  ["Callum Wallace", "West End Best Friend", "Missing critic attribution: Expected critic 'Callum Wallace' is not named anywhere in the scraped text"],
  ["Callum Wallace", "West End Best Friend", "Missing outlet attribution: Expected outlet 'West End Best Friend' is not named anywhere in the scraped text"],
  ["Nicole Serratore", "Exeunt Magazine", "Critic byline missing: scraped content does not name Nicole Serratore as the author"],
  ["Nicole Serratore", "Exeunt Magazine", "Outlet missing: no attribution to Exeunt Magazine found in scraped text"],
  ["David Sheward", "Theater Life", "Critic attribution missing: The expected critic is David Sheward, but no byline is present in the scraped content."],
  ["David Sheward", "Theater Life", "Outlet attribution missing: The expected outlet is Theater Life, but no outlet attribution is present in the scraped content."],
  ["Elyse Trevers", "Stage Buddy", "Critic byline missing \u2014 no author name ('Elyse Trevers' expected) appears in the scraped text"],
  ["Elyse Trevers", "Stage Buddy", "Outlet attribution missing \u2014 no outlet name ('Stage Buddy' expected) appears in the scraped text"],
  ["Michael Sidhu", "Radio Times", "Critic name 'Michael Sidhu' does not appear anywhere in the scraped content"],
  ["Michael Sidhu", "Radio Times", "Outlet 'Radio Times' is not identified in the scraped content"],
  ["Michael Sidhu", "Radio Times", "No byline or critic attribution is present in the article"],
  ["Lane Williamson", "Exeunt Magazine", "Critic byline 'Lane Williamson' is not mentioned anywhere in the scraped text; cannot verify attribution to stated critic"],
  ["Lane Williamson", "Exeunt Magazine", "Outlet attribution to 'Exeunt Magazine' cannot be verified from the scraped content"],
  ["Brian Scott Lipton", "Theater Pizzazz", "Critic name missing: Expected critic 'Brian Scott Lipton' but no byline is present in the scraped content"],
  ["Brian Scott Lipton", "Theater Pizzazz", "Outlet name missing: Expected outlet 'Theater Pizzazz' but no outlet attribution is present in the scraped content"],
  ["Paulanne Simmons", "Theater Life", "Missing critic byline: Expected critic 'Paulanne Simmons' not found in scraped content"],
  ["Paulanne Simmons", "Theater Life", "Missing outlet attribution: Expected outlet 'Theater Life' not found in scraped content"],
  ["Ken Kaissar", "Theatre is Easy", "Critic attribution missing: the byline/author 'Ken Kaissar' is not present anywhere in the scraped content"],
  ["Ken Kaissar", "Theatre is Easy", "Outlet attribution missing: 'Theatre is Easy' is not identified anywhere in the scraped content"],
  ["Cameron Kelsall", "Exeunt Magazine", "Critic byline missing: Expected Cameron Kelsall from Exeunt Magazine, but no byline or outlet attribution appears in scraped text"],
  ["Michael Sommers", "New York Stage Review", "Critic byline missing: Expected outlet 'New York Stage Review' and critic 'Michael Sommers' are not named in the scraped text"],
  ["Michael Sommers", "New York Stage Review", "Cannot verify outlet or critic attribution from scraped content"],
  ["Frank Scheck", "New York Stage Review", "Critic attribution missing: byline does not appear in scraped content. Expected critic is Frank Scheck; no critic name is present in the review text."],
  ["Frank Scheck", "New York Stage Review", "Outlet attribution missing: byline does not appear in scraped content. Expected outlet is New York Stage Review; no outlet/publication name is present in the review text."],
];

// Synthetic strings for the Cameron Kelsall / Exeunt Magazine fixtures below.
const ABSENCE = [
  'Critic byline missing: Expected Cameron Kelsall from Exeunt Magazine, but no byline or outlet attribution appears in scraped text',
  "Outlet attribution to 'Exeunt Magazine' cannot be verified from the scraped content",
  'Critic byline missing: scraped content does not name Cameron Kelsall as the author',
  'Outlet missing: no attribution to Exeunt Magazine found in scraped text',
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
  // a misspelled name is not matched (no edit distance): this real string stays rejected
  'Outlet not identified in scraped content: No Exeunt Magazine attribution or Cameron Kalsall byline found',
  'Byline not found; written by Cameron Kelsel',
  'The critic is Cameron Kelsel',
  // wrong article / non-review / other content issues
  'No outlet attribution; this is a roundup of several shows.',
  'Known excerpt not found in scraped content',
  'Cannot verify match to expected critic (Cameron Kelsall) or outlet (Exeunt Magazine) from provided excerpt',
  'Review publish date (2025-03-10) cannot be verified from the scraped text',
  'Venue not named in scraped text',
  // stub / no-body pages that do carry the byline (review of 7b9a00e76)
  'No review content; only the byline and outlet name',
  'Text is only the byline, no article body',
  'Page does not contain the review, only author byline',
  'No review text, author missing',
  'Text only contains the critic name and outlet, no review',
  '',
];

// Review of 72db03b4b, critic Jesse Green / The New York Times.
const NYT = { criticName: 'Jesse Green', outletName: 'The New York Times' };
const NOT_ABSENCE_NYT = [
  'None of the review text; no author',
  'Cannot verify critic without any of the article text',
  'Neither the scraped content nor the byline is present',
  'No scraped article, byline missing',
  'Missing the provided review; no byline',
  'No byline; author appears to be Jesse Greer',
  'Outlet not named; author appears as Jesse Greer',
  'Author Jesse Greer, outlet missing',
  'Author not credited; review is by Jesse Greer',
  'Critic name Jesse Greer does not appear anywhere in the scraped content',
  'No review content; only the byline and outlet name',
  'Text is only the byline, no article body',
  'Page does not contain the review, only author byline',
  'No review text, author missing',
  'Text only contains the critic name and outlet, no review',
];

test('every real byline-only issue string matches a template', () => {
  for (const [criticName, outletName, issue] of REAL_POSITIVES) {
    assert.equal(isAttributionAbsenceIssue(issue, { criticName, outletName }), true, issue);
  }
});

test('a real string naming its critic/outlet does not match under other names', () => {
  for (const [criticName, outletName, issue] of REAL_POSITIVES) {
    if (!issue.includes(criticName) && !issue.includes(outletName)) continue;
    assert.equal(isAttributionAbsenceIssue(issue, NYT), false, issue);
  }
});

test('reviewer false-accept strings are rejected', () => {
  for (const s of NOT_ABSENCE_NYT) assert.equal(isAttributionAbsenceIssue(s, NYT), false, s);
  // With the exact name, only the "author is X" shapes stay rejected; the plain absence clause is a real positive.
  for (const s of NOT_ABSENCE_NYT.filter((x) => /Greer/.test(x) && !/does not appear/.test(x))) {
    assert.equal(isAttributionAbsenceIssue(s.replace(/Jesse Greer/g, 'Jesse Green'), NYT), false, s);
  }
  assert.equal(isAttributionAbsenceIssue('Critic name Jesse Green does not appear anywhere in the scraped content', NYT), true);
});

test('whole-string absence-of-byline/outlet clauses are recognised', () => {
  for (const s of ABSENCE) assert.equal(isAttributionAbsenceIssue(s, names), true, s);
});

test('truncation, different-critic, wrong-article and other issues are not', () => {
  for (const s of NOT_ABSENCE) assert.equal(isAttributionAbsenceIssue(s, names), false, s);
});

test('a name that is not the expected critic/outlet keeps the issue', () => {
  assert.equal(isAttributionAbsenceIssue('Critic name Jane Doe does not appear anywhere in the scraped content', names), false);
  assert.equal(isAttributionAbsenceIssue('Critic name Cameron Kelsall does not appear anywhere in the scraped content', names), true);
  assert.equal(isAttributionAbsenceIssue('Critic name Cameron Kelsall does not appear anywhere in the scraped content', {}), false);
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
  assert.equal(applyAttributionAbsenceCarveout(null, names).isValid, false);
  assert.equal(applyAttributionAbsenceCarveout({ ...clean, issues: [ABSENCE[4]] }, null).applied, true);
  assert.equal(applyAttributionAbsenceCarveout({ ...clean, issues: [ABSENCE[0]] }, null).applied, false);
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
