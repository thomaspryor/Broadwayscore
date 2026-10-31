// BRO-4512: keep the card's acceptance command runnable. The private-data
// check reads the recovered file, including its historical Victor Gluck slug.
// Public checkouts still exercise the real gap classifier with offline cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap, classifyGapCardState, GAP_CARD_STATE } = require('../lib/t1-silent-gap');
const { hasValidScore, isIncludableForRebuild } = require('../lib/review-guards');
const { classifyReviewUrl } = require('../lib/non-review-url-patterns');

const root = fileURLToPath(new URL('../../', import.meta.url));
const showId = 'burning-leaves-off-broadway-2026';
const filename = 'theater-scene--victor-gluck.json';
const articleUrl = 'https://www.theaterscene.net/plays/offbway-plays/burning-leaves/tony-marinelli/';
const now = new Date('2026-10-15T12:00:00Z');
const args = { show: {}, tier: 2, outletScored: false, now };
const unscored = {
  showId, outletId: 'theater-scene', criticName: 'Tony Marinelli',
  url: articleUrl, contentTier: 'complete',
  fullText: 'The actors give the drama a precise emotional rhythm. '.repeat(40),
  textFetchedAt: '2026-10-12T02:11:22.669Z',
};

test('an old unscored review remains an open gap', () => {
  assert.equal(classifySilentGap({ ...args, file: unscored })?.type, 'unscored');
  assert.equal(classifyGapCardState({ ...args, file: unscored }), GAP_CARD_STATE.OPEN);
});

test('a scored review clears the gap, while an editorial exclusion is not collected', () => {
  const scored = { ...unscored, assignedScore: 90, llmScore: { score: 90 } };
  assert.equal(classifySilentGap({ ...args, file: scored }), null);
  assert.equal(classifyGapCardState({ ...args, file: scored }), GAP_CARD_STATE.COLLECTED);
  const excluded = { ...scored, wrongShow: true };
  assert.equal(classifyGapCardState({ ...args, file: excluded }), GAP_CARD_STATE.NO_REVIEW);
});

test('Theater Scene tag page is refused and the corrected article is accepted', () => {
  assert.deepEqual(classifyReviewUrl('https://www.theaterscene.net/tag/burning-leaves/'),
    { ok: false, reason: 'tag-index-page' });
  assert.equal(classifyReviewUrl(articleUrl).ok, true);
});

const reviewRoot = path.join(root, 'data/review-texts');
const showDir = path.join(reviewRoot, showId);
test('BRO-4512: the actual Burning Leaves review is scored, includable and no longer stuck', {
  // Other suites create temporary show directories under review-texts in CI.
  // Those fixtures do not mean this show's private data is available.
  skip: !fs.existsSync(showDir) && 'Private Burning Leaves data is not checked out; live recovery is unverified',
}, () => {
  const filePath = path.join(showDir, filename);
  // A present show directory with a missing target must fail, never skip.
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const shows = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8')).shows;
  const show = shows.find(s => s.id === showId);
  assert.ok(show, `${showId} must exist in shows.json`);
  assert.equal(file.showId, showId);
  assert.equal(file.criticName, 'Tony Marinelli', 'use the corrected byline, not the historical filename');
  assert.equal(file.url, articleUrl);
  assert.equal(file.contentTier, 'complete');
  assert.ok(file.fullText?.length > 933, 'must contain the recovered article, not the old tag-page stub');
  assert.ok(Number.isFinite(file.llmScore?.score), 'ensemble scoring must have completed');
  assert.ok(hasValidScore(file), 'canonical score validation must pass');
  assert.ok(isIncludableForRebuild(file, show, filePath), 'an excluded file cannot satisfy recovery');
  // Do not let a different review from the same outlet mask this file.
  const liveArgs = { ...args, file, show, filePath };
  assert.equal(classifySilentGap(liveArgs), null);
  assert.equal(classifyGapCardState(liveArgs), GAP_CARD_STATE.COLLECTED);
});
