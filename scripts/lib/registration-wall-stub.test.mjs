// BRO-6190: registration-wall / paywall stubs must not classify or score as reviews.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { isRegistrationWallStub } = require('./paywall-detector.js');
const { isGarbageContent, classifyContentTier } = require('./content-quality.js');
const { isRegistrationWallStubExclusion, explainExclusion } = require('./review-guards.js');

const WALL = 'Create a free account to continue reading. A minimum of 8 characters At least 1 letter At least 1 number Youll receive regular news updates';
const BYLINE = 'Avenue Q review: puppets are gleefully outrageous. Marianka Swain has been a culture and features writer for the Telegraph since 2018. ';
const stub = BYLINE + 'The coming-of-age storyline is raucous and heart-warming. ' + WALL;
const prose = 'The staging is sharp and the cast of the musical commands the stage with real comic timing. '.repeat(40);
const longArticleWithFooterWall = prose + WALL;
const FT = 'Mamma Mia review. Subscribe to unlock this article Try unlimited access Only $1 for 4 weeks Then $75 per month. Complete digital access to quality FT journalism on any device. ' + 'Keep reading for $1 What is included Global news and analysis. '.repeat(8);

test('isRegistrationWallStub: wall behind a byline is a stub, wall after a long article is not', () => {
  assert.equal(isRegistrationWallStub(stub), true);
  assert.equal(isRegistrationWallStub(longArticleWithFooterWall), false);
  assert.equal(isRegistrationWallStub(null), false);
  assert.equal(isRegistrationWallStub('A joyous revival with a minimum of fuss.'), false);
});

test('isGarbageContent flags the stub with the Registration wall reason, not the footer case', () => {
  const g = isGarbageContent(stub);
  assert.equal(g.isGarbage, true);
  assert.match(g.reason, /^Registration wall stub/);
  assert.doesNotMatch(isGarbageContent(longArticleWithFooterWall).reason || '', /^Registration wall stub/);
});

test('classifyContentTier: stub is invalid with a Garbage content reason', () => {
  const c = classifyContentTier({ fullText: stub, outletId: 'telegraph', publishDate: '2026-04-17' });
  assert.equal(c.contentTier, 'invalid');
  assert.match(c.tierReason, /^Garbage content: Registration wall stub/);
});

test('classifyContentTier: manual complete cannot hide a wall stub or a short paywall page', () => {
  const a = classifyContentTier({ fullText: stub, outletId: 'telegraph', manualContentTier: 'complete' });
  assert.equal(a.contentTier, 'invalid');
  assert.ok(FT.length < 3000);
  const b = classifyContentTier({ fullText: FT, outletId: 'financialtimes', manualContentTier: 'complete' });
  assert.equal(b.contentTier, 'invalid');
  assert.match(b.tierReason, /overrides manualContentTier/);
});

test('classifyContentTier: manual complete on a long real review is kept', () => {
  const c = classifyContentTier({ fullText: longArticleWithFooterWall, outletId: 'telegraph', manualContentTier: 'complete' });
  assert.equal(c.contentTier, 'complete');
});

test('isRegistrationWallStubExclusion: excluded unless a score never read the body', () => {
  assert.equal(isRegistrationWallStubExclusion({ fullText: stub }), true);
  assert.equal(isRegistrationWallStubExclusion({ fullText: prose }), false);
  assert.equal(isRegistrationWallStubExclusion({ fullText: longArticleWithFooterWall }), false);
  assert.equal(isRegistrationWallStubExclusion(null), false);
});

test('isRegistrationWallStubExclusion: page-markup or aggregator stars keep a stub, a cleared one does not', () => {
  const base = { fullText: stub, originalScoreNormalized: 80 };
  assert.equal(isRegistrationWallStubExclusion({ ...base, originalScoreSource: 'telegraph-svg-stars' }), false);
  assert.equal(isRegistrationWallStubExclusion({ ...base, originalScoreSource: 'telegraph-svg-stars', originalScoreCleared: true }), true);
  assert.equal(isRegistrationWallStubExclusion({ ...base, originalScoreSource: 'llm-gemini' }), true);
  assert.equal(isRegistrationWallStubExclusion({ fullText: stub, aggregatorStars: 4 }), false);
});

test('wall cutoff: wall starting before 2500 chars is a stub, at 2500 or later is not', () => {
  const pre = (n) => 'x'.repeat(n);
  const off = WALL.search(/A minimum of 8 characters/);
  assert.equal(isRegistrationWallStub(pre(2499 - off) + WALL), true);
  assert.equal(isRegistrationWallStub(pre(2500 - off) + WALL), false);
});

test('short paywall cutoff under a manual complete stamp: 2999 chars invalid, 3000 kept', () => {
  const pw = (n) => ('Subscribe to unlock this article Try unlimited access Only $1 for 4 weeks. ' + 'y '.repeat(n)).slice(0, n);
  assert.equal(classifyContentTier({ fullText: pw(2999), outletId: 'financialtimes', manualContentTier: 'complete' }).contentTier, 'invalid');
  assert.notEqual(classifyContentTier({ fullText: pw(3000), outletId: 'financialtimes', manualContentTier: 'complete' }).manualOverrideRejected, true);
});

test('manual-complete 404 page is rejected and excluded; explainExclusion reports it', () => {
  const nf = '404 PAGE NOT FOUND Sorry, the link you are trying to access is either broken or no longer exists. Please use the search bar.';
  const c = classifyContentTier({ fullText: nf, outletId: 'columbus-dispatch', manualContentTier: 'complete' });
  assert.equal(c.contentTier, 'invalid');
  assert.equal(c.manualOverrideRejected, true);
  assert.equal(isRegistrationWallStubExclusion({ fullText: nf, manualContentTier: 'complete' }), true);
  assert.equal(explainExclusion({ fullText: stub, outletId: 'telegraph', showId: 'x' }) !== null, true);
});

for (const manualContentTier of ['complete', 'truncated', 'excerpt', 'stub']) {
  test(`short paywall exclusion follows rejected manual ${manualContentTier} tier`, () => {
    const data = { fullText: FT, outletId: 'financialtimes', manualContentTier };
    assert.equal(classifyContentTier(data).manualOverrideRejected, true);
    assert.equal(isRegistrationWallStubExclusion(data), true);
    assert.equal(explainExclusion(data), 'registrationWallStub');
    assert.equal(isRegistrationWallStubExclusion({ ...data, aggregatorStars: 4 }), false);
    assert.equal(isRegistrationWallStubExclusion({ ...data, originalScoreSource: 'telegraph-svg-stars', originalScoreNormalized: 80 }), false);
  });
}

test('404 exclusions have an error-page label for every rejected manual tier', () => {
  for (const manualContentTier of ['complete', 'truncated', 'excerpt', 'stub']) {
    const data = { fullText: '404 PAGE NOT FOUND Sorry, the link you are trying to access is either broken or no longer exists. Please use the search bar.', manualContentTier };
    assert.equal(explainExclusion(data), 'errorPage');
  }
});

const { classifyRebuildExclusion, classifyLlmExclusion } = require('./llm-scoring-parity.js');

test('parity classifiers model wall, rejected manual tiers and error-page exclusions', () => {
  for (const classify of [classifyRebuildExclusion, classifyLlmExclusion]) {
    assert.equal(classify({ fullText: stub }), 'registrationWallStub');
    assert.equal(classify({ fullText: FT, manualContentTier: 'truncated' }), 'registrationWallStub');
    assert.equal(classify({ fullText: prose }), '');
    assert.equal(classify({ fullText: stub, aggregatorStars: 4 }), '');
    assert.equal(classify({ fullText: '404 PAGE NOT FOUND Sorry, the link you are trying to access is either broken or no longer exists. Please use the search bar.', manualContentTier: 'excerpt' }), 'errorPage');
  }
});

test('all manual tiers retain long real reviews and respect the 3000-character paywall cutoff', () => {
  const pw = n => ('Subscribe to unlock this article Try unlimited access Only $1 for 4 weeks. ' + 'y '.repeat(n)).slice(0, n);
  for (const manualContentTier of ['complete', 'truncated', 'excerpt', 'stub']) {
    assert.equal(isRegistrationWallStubExclusion({ fullText: pw(2999), manualContentTier }), true);
    assert.equal(isRegistrationWallStubExclusion({ fullText: pw(3000), manualContentTier }), false);
    assert.equal(isRegistrationWallStubExclusion({ fullText: longArticleWithFooterWall, manualContentTier }), false);
  }
});
