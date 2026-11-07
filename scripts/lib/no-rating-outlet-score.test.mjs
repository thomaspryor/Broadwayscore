/**
 * BRO-5064: gather-reviews createReviewFile stored Show Score's star rating as originalScore on
 * london-theatre rows (an outlet that publishes no critic rating), which failed the P0
 * check-score-integrity gate. Runs the real createReviewFile (temp review-texts dir) and the real
 * mergeReviews; three real cases from the failing files plus a star-outlet control.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5064-'));
process.env.REVIEW_TEXTS_DIR = tmp; // read by reviewTextsDirFromEnv at gather-reviews load
let gather;
before(() => { gather = require('../gather-reviews.js'); });

const cases = [
  ['a-tupperware-of-ashes-west-end-2024', 'Julia Rank', 'https://www.londontheatre.co.uk/reviews/a-tupperware-of-ashes-review-national-theatre', '4/5'],
  ['downstate-west-end-2019', 'Mark Shenton', 'https://www.londontheatre.co.uk/reviews/review-bruce-norris-downstate-at-the-national-theatre', '4/5'],
  ['elektra-west-end-2025', 'Olivia Rook', 'https://www.londontheatre.co.uk/reviews/elektra-review-brie-larson-stockard-channing-duke-of-yorks', '3/5'],
];

for (const [showId, critic, url, rating] of cases) {
  test(`createReviewFile stores no originalScore for london-theatre (${showId})`, () => {
    const r = gather.createReviewFile(showId, {
      outletId: 'london-theatre', outlet: 'London Theatre', criticName: critic, url,
      originalRating: rating, source: 'show-score-playwright',
    }, { allowWestEnd: true });
    assert.ok(r, 'file created');
    const dir = path.join(tmp, showId);
    const f = fs.readdirSync(dir).find((n) => n.startsWith('london-theatre--'));
    assert.ok(f, 'london-theatre file written');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(rec.originalScore, null);
    assert.equal(rec.aggregatorStars, undefined);
  });
}

test('control: an outlet that prints stars keeps its Show Score rating', () => {
  gather.createReviewFile('control-show-2020', {
    outletId: 'guardian', outlet: 'The Guardian', criticName: 'Michael Billington',
    url: 'https://www.theguardian.com/stage/2020/jan/01/control-show-review',
    originalRating: '4/5', source: 'show-score-playwright',
  }, { allowWestEnd: true });
  const dir = path.join(tmp, 'control-show-2020');
  const f = fs.readdirSync(dir).find((n) => n.includes('--'));
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.ok(rec.originalScore === 80 || rec.aggregatorStars === 80, `got ${rec.originalScore}/${rec.aggregatorStars}`);
});

test('mergeReviews does not copy an incoming originalScore onto a london-theatre file', () => {
  const { mergeReviews } = require('./review-normalization');
  const existing = { outletId: 'london-theatre', criticName: 'Mark Shenton', url: 'https://www.londontheatre.co.uk/reviews/x', originalScore: null };
  const merged = mergeReviews(existing, { outletId: 'london-theatre', criticName: 'Mark Shenton', url: existing.url, originalScore: 80, originalRating: '4/5', source: 'x' }, {}, {});
  assert.ok(merged.originalScore == null);
  const star = mergeReviews({ ...existing, outletId: 'guardian' }, { outletId: 'guardian', criticName: 'Mark Shenton', url: existing.url, originalScore: 80, originalRating: '4/5', source: 'x' }, {}, {});
  assert.equal(star.originalScore, 80);
});
