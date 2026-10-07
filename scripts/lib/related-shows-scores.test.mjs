import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildScoreMap } = require('./related-shows-scores.js');

function makeReviews(showId, scores) {
  return scores.map(assignedScore => ({ showId, assignedScore }));
}

describe('buildScoreMap (#1906)', () => {
  test('scores a show from reviews.json-sourced rows alone', () => {
    const shows = [{ id: 'hamilton-2015' }];
    const reviews = makeReviews('hamilton-2015', [90, 92, 88, 95, 91]);

    const result = buildScoreMap(reviews, shows);
    assert.equal(result.get('hamilton-2015'), 91);
  });

  test('scores a show whose only rows came from blog-reviews-for-scoring.json (via loadReviewsWithBlog concatenation)', () => {
    const shows = [{ id: 'blog-only-show-2026' }];
    // loadReviewsWithBlog() concatenates blog rows onto the reviews.json
    // array before this function ever sees them — buildScoreMap has no
    // awareness of source, so a blog-only show must score the same as any
    // other show once its rows are in the merged array.
    const reviews = makeReviews('blog-only-show-2026', [70, 75, 80, 65, 72]);

    const result = buildScoreMap(reviews, shows);
    assert.equal(result.get('blog-only-show-2026'), 72);
  });

  test('excludes a show with fewer than 5 scored reviews', () => {
    const shows = [{ id: 'too-few-2020' }];
    const reviews = makeReviews('too-few-2020', [90, 92, 88]);

    const result = buildScoreMap(reviews, shows);
    assert.equal(result.has('too-few-2020'), false);
  });

  test('ignores rows with a null assignedScore when counting toward the 5-review threshold', () => {
    const shows = [{ id: 'mixed-nulls-2021' }];
    const reviews = [
      ...makeReviews('mixed-nulls-2021', [90, 92, 88, 95, 91]),
      { showId: 'mixed-nulls-2021', assignedScore: null },
      { showId: 'mixed-nulls-2021', assignedScore: null },
    ];

    const result = buildScoreMap(reviews, shows);
    assert.equal(result.get('mixed-nulls-2021'), 91);
  });

  test('does not cross-contaminate scores between shows', () => {
    const shows = [{ id: 'show-a' }, { id: 'show-b' }];
    const reviews = [
      ...makeReviews('show-a', [100, 100, 100, 100, 100]),
      ...makeReviews('show-b', [50, 50, 50, 50, 50]),
    ];

    const result = buildScoreMap(reviews, shows);
    assert.equal(result.get('show-a'), 100);
    assert.equal(result.get('show-b'), 50);
  });
});
