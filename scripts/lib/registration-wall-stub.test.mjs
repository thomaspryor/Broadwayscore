// BRO-6190: registration-wall / paywall stubs must not classify or score as reviews.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { isRegistrationWallStub } = require('./paywall-detector.js');
const { isGarbageContent, classifyContentTier } = require('./content-quality.js');
const { isRegistrationWallStubExclusion } = require('./review-guards.js');

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
  assert.notEqual(isGarbageContent(longArticleWithFooterWall).reason && /^Registration wall stub/.test(isGarbageContent(longArticleWithFooterWall).reason), true);
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
