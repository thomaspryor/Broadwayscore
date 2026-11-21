/**
 * Unit tests for evaluateDateGuard — UK trusted-critic grace-period override
 * (scripts/lib/date-guard.js, added 2026-05-25).
 *
 * Default grace: 21 days before previews-start.
 * UK trusted critics on WE / off-WE shows: 35 days.
 *
 * Regression case (Matilda 2011): TheStage review dated 2011-10-25 for a show
 * with previewsStartDate=2011-11-24 → 30d gap. Was falsely flagged as
 * wrongProduction under the old 21d rule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { evaluateDateGuard } = require('../../scripts/lib/date-guard.js');

const matildaShow = {
  category: 'west-end',
  previewsStartDate: '2011-11-24',
  closingDate: null,
};

describe('evaluateDateGuard — UK trusted critic exemption', () => {
  test('Matilda regression: TheStage 2011-10-25 review (30d before previews) is NOT flagged', () => {
    const decision = evaluateDateGuard({
      pubDate: new Date('2011-10-25'),
      show: matildaShow,
      outletId: 'thestage',
    });
    assert.equal(decision.flag, false, 'must not flag — 30d falls inside 35d UK grace');
    assert.equal(decision.issue, null);
    assert.equal(decision.daysAllowedBefore, 35);
  });

  test('UK trusted critic on WE show: 36d before previews IS flagged (just past grace)', () => {
    const decision = evaluateDateGuard({
      pubDate: new Date('2011-10-19'), // 36 days before 2011-11-24
      show: matildaShow,
      outletId: 'thestage',
    });
    assert.equal(decision.flag, true);
    assert.equal(decision.issue, 'before_preview');
    assert.equal(decision.daysAllowedBefore, 35);
  });

  test('Non-UK outlet on WE show: 30d before previews IS flagged (default 21d cap)', () => {
    const decision = evaluateDateGuard({
      pubDate: new Date('2011-10-25'),
      show: matildaShow,
      outletId: 'nytimes', // US outlet — no exemption
    });
    assert.equal(decision.flag, true);
    assert.equal(decision.issue, 'before_preview');
    assert.equal(decision.daysAllowedBefore, 21);
  });

  test('UK trusted critic on Broadway show: NO exemption (only WE/off-WE)', () => {
    const broadwayShow = { ...matildaShow, category: 'broadway' };
    const decision = evaluateDateGuard({
      pubDate: new Date('2011-10-25'),
      show: broadwayShow,
      outletId: 'thestage',
    });
    assert.equal(decision.flag, true, 'broadway category should not get UK 35d grace');
    assert.equal(decision.daysAllowedBefore, 21);
  });

  test('UK outlet on off-west-end show DOES get exemption', () => {
    const owe = { ...matildaShow, category: 'off-west-end' };
    const decision = evaluateDateGuard({
      pubDate: new Date('2011-10-25'),
      show: owe,
      outletId: 'guardian',
    });
    assert.equal(decision.flag, false);
    assert.equal(decision.daysAllowedBefore, 35);
  });

  test('No outletId: falls back to default 21d grace, regardless of market', () => {
    const decision = evaluateDateGuard({
      pubDate: new Date('2011-10-25'),
      show: matildaShow,
      outletId: null,
    });
    assert.equal(decision.flag, true);
    assert.equal(decision.daysAllowedBefore, 21);
  });

  test('after_close still fires for late reviews (close+7d)', () => {
    const closedShow = { ...matildaShow, closingDate: '2026-01-31' };
    const decision = evaluateDateGuard({
      pubDate: new Date('2026-02-15'), // 15d after close
      show: closedShow,
      outletId: 'thestage',
    });
    assert.equal(decision.flag, true);
    assert.equal(decision.issue, 'after_close');
  });

  test('within-window review: no flag', () => {
    const decision = evaluateDateGuard({
      pubDate: new Date('2011-11-25'), // day after previews start
      show: matildaShow,
      outletId: 'thestage',
    });
    assert.equal(decision.flag, false);
  });

  test('no window info: never flag', () => {
    const decision = evaluateDateGuard({
      pubDate: new Date('2026-05-01'),
      show: { category: 'broadway' }, // no dates
      outletId: 'nytimes',
    });
    assert.equal(decision.flag, false);
  });
});
