import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planWrongShowRoundupClear: planRecordEdit } = require('../../scripts/lib/aggregator-page-show-guard.js');

const rows = [{ excerpt: 'Wendy and Peter Pan soars.', stars: 3 }, { excerpt: 'Another row.', stars: 4 }];

test('BRO-3564: clears a planted excerpt and its star, queues rescore when the star scored it', () => {
  const rec = { outlet: 'The Times', westEndTheatreExcerpt: ' Wendy and Peter Pan soars. ', westEndTheatreScore: 80,
    scoreSource: 'westendtheatre-star-rating', rescoreCompletedAt: '2026-01-01' };
  const out = planRecordEdit(rec, rows);
  assert.equal(out.westEndTheatreExcerpt, undefined);
  assert.equal(out.westEndTheatreScore, undefined);
  assert.equal(out.needsRescore, true);
  assert.equal(out.rescoreCompletedAt, undefined);
  assert.equal(out.wrongShowRoundupCleared.source, 'westendtheatre');
  assert.equal(rec.westEndTheatreExcerpt, ' Wendy and Peter Pan soars. ', 'input is not mutated');
});

test('leaves the score alone when it came from elsewhere', () => {
  const out = planRecordEdit({ westEndTheatreExcerpt: 'Another row.', scoreSource: 'llm' }, rows);
  assert.equal(out.needsRescore, undefined);
  assert.equal(out.westEndTheatreExcerpt, undefined);
});

test('no edit when the excerpt is not from the rejected page, or absent', () => {
  assert.equal(planRecordEdit({ westEndTheatreExcerpt: 'Its own excerpt.' }, rows), null);
  assert.equal(planRecordEdit({ outlet: 'X' }, rows), null);
});

test('drops the sourceless star the row relayed, keeps an outlet-sourced star', () => {
  const relayed = planRecordEdit({ westEndTheatreExcerpt: 'Wendy and Peter Pan soars.', aggregatorStars: '3/5',
    scoreSource: 'westendtheatre-star-rating' }, rows);
  assert.equal(relayed.aggregatorStars, undefined);
  const own = planRecordEdit({ westEndTheatreExcerpt: 'Another row.', aggregatorStars: '4/5 stars',
    aggregatorStarsSource: 'telegraph-svg-stars' }, rows);
  assert.equal(own.aggregatorStars, '4/5 stars');
  const other = planRecordEdit({ westEndTheatreExcerpt: 'Another row.', aggregatorStars: '2/5' }, rows);
  assert.equal(other.aggregatorStars, '2/5', 'a different star is not the row relay');
});
