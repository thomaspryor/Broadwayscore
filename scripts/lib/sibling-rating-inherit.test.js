'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../../data/pending-fixes/bro-6806.json');
const { applyReviewFieldEdit } = require('./review-field-edit');
const { inheritUrlFromDuplicateLosers } = require('./duplicate-fold-url');
const { siblingRatingForClamp } = require('./sibling-rating-inherit');
const { canonicalizeUrlForDedup } = require('./review-guards');
const { detectBandFromReviewFile } = require('./star-reliability');

const target = 'othello-west-end-2022/whatsonstage--unknown.json';
const winnerFile = 'whatsonstage--sarah-crompton.json';
const loserFile = 'whatsonstage--unknown.json';
const wrongUrl = 'https://www.whatsonstage.com/news/othello-starring-david-harewood-toby-jones-and-caitlin-fitzgerald-west-end-review_1701279/';
const winner = {
  url: null,
  criticName: 'Sarah Crompton',
  outletId: 'whatsonstage',
  publishDate: '2022-11-30',
  source: 'theatre-record',
};
const loser = {
  url: wrongUrl,
  criticName: 'Sarah Crompton',
  outletId: 'whatsonstage',
  publishDate: 'November 4th, 2025',
  duplicateOf: winnerFile,
  duplicateReason: 'criticName-override-collided-at-rename',
  wrongProduction: true,
  starRating: '2/5',
};

test('BRO-6806 plan clears only the incorrect production link, with a durable breadcrumb first', () => {
  assert.equal(plan.issueNumber, 'bro-6806');
  assert.deepEqual(plan.plan.actions.map(({ type, file, field }) => ({ type, file, field })), [
    { type: 'review-field-edit', file: target, field: 'duplicateClearReason' },
    { type: 'review-field-edit', file: target, field: 'duplicateOf' },
  ]);
  const clear = plan.plan.actions[1];
  assert.equal(clear.oldValue, winnerFile);
  assert.equal(clear.newValue, null);
  assert.match(plan.plan.actions[0].newValue, /2025.*2022/s);
  assert.equal(applyReviewFieldEdit(loser, clear, { fixId: plan.planId, at: plan.createdAt }).ok, false);
});

test('BRO-6806 repair stops URL inheritance from the 2025 duplicate without changing the canonical', () => {
  const files = { [winnerFile]: structuredClone(winner), [loserFile]: structuredClone(loser) };
  const names = Object.keys(files);
  const load = (name) => files[name] || null;
  assert.equal(inheritUrlFromDuplicateLosers(winnerFile, files[winnerFile], names, load), wrongUrl);

  for (const action of plan.plan.actions) {
    const result = applyReviewFieldEdit(files[loserFile], action, { fixId: plan.planId, at: plan.createdAt });
    assert.equal(result.ok, true, result.reason);
    files[loserFile] = result.record;
  }

  assert.equal(inheritUrlFromDuplicateLosers(winnerFile, files[winnerFile], names, load), null);
  assert.equal(files[loserFile].wrongProduction, true);
  assert.equal(files[loserFile].url, wrongUrl);
  assert.ok(files[loserFile].duplicateClearReason);
  assert.deepEqual(files[winnerFile], winner);
});

test('the wrong-production duplicate cannot supply the 2022 review rating', () => {
  const files = { [winnerFile]: winner, [loserFile]: loser };
  assert.equal(siblingRatingForClamp(
    winnerFile, winner, Object.keys(files), (name) => files[name],
    canonicalizeUrlForDedup, detectBandFromReviewFile,
  ), null);
});

test('legitimate duplicate donors retain URL inheritance, including persisted venue flags', () => {
  const url = 'https://example.com/review';
  for (const flags of [{}, { wrongProduction: true }, { wrongProduction: true, wrongProductionOverride: true }]) {
    const files = { 'winner.json': { url: null }, 'loser.json': { url, duplicateOf: 'winner.json', ...flags } };
    assert.equal(inheritUrlFromDuplicateLosers('winner.json', files['winner.json'], Object.keys(files), (name) => files[name]), url);
  }
});
