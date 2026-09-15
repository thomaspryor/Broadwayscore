/**
 * BRO-282 residual half — scripts/lib/in-review-backlog.js.
 *
 * The bug this file exists to prevent recurring: 120 finished issues sat in
 * Linear's `In Review` state, 100 of them 14+ days, with nothing anywhere
 * reading that state. Every assertion below is written against a behaviour
 * that failure needed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isRealInReview,
  buildInReviewRows,
  buildInReviewSection,
  IDLE_AFTER_MS,
} = require('../../scripts/lib/in-review-backlog.js');

const NOW = new Date('2026-09-15T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function issue(over = {}) {
  return {
    identifier: 'BRO-1',
    title: 'a finished thing',
    url: 'https://linear.app/x/issue/BRO-1',
    priority: 2,
    updatedAt: daysAgo(20),
    state: { name: 'In Review', type: 'started' },
    ...over,
  };
}

describe('isRealInReview', () => {
  test('accepts an In Review issue', () => {
    assert.equal(isRealInReview(issue()), true);
  });

  test('rejects every other state, including the other started-type one', () => {
    for (const name of ['In Progress', 'Todo', 'Backlog', 'Done', 'Canceled']) {
      assert.equal(isRealInReview(issue({ state: { name, type: 'started' } })), false, name);
    }
  });

  test('drops the two automated producers that legitimately live in In Review', () => {
    assert.equal(isRealInReview(issue({ title: 'BSC Daily: Workflow repeat-failure: Test Suite' })), false);
    assert.equal(isRealInReview(issue({ title: 'CANARY: autofix probe' })), false);
  });

  test('a title that merely CONTAINS the noise words is real work', () => {
    assert.equal(isRealInReview(issue({ title: 'Fix: BSC Daily: Workflow repeat-failure' })), true);
  });

  test('survives a malformed issue rather than throwing', () => {
    assert.equal(isRealInReview(null), false);
    assert.equal(isRealInReview({}), false);
    assert.equal(isRealInReview({ state: null }), false);
  });
});

describe('buildInReviewRows ranking', () => {
  test('urgent sorts above older non-urgent — an Urgent card must not be buried by age alone', () => {
    const rows = buildInReviewRows(
      [
        issue({ identifier: 'BRO-old', priority: 2, updatedAt: daysAgo(30) }),
        issue({ identifier: 'BRO-urgent', priority: 1, updatedAt: daysAgo(4) }),
      ],
      { now: NOW }
    );
    assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-urgent', 'BRO-old']);
  });

  test('oldest first within a tier', () => {
    const rows = buildInReviewRows(
      [
        issue({ identifier: 'BRO-newer', updatedAt: daysAgo(5) }),
        issue({ identifier: 'BRO-older', updatedAt: daysAgo(28) }),
      ],
      { now: NOW }
    );
    assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-older', 'BRO-newer']);
  });

  test('an undateable row sorts LAST, never to the top', () => {
    const rows = buildInReviewRows(
      [
        issue({ identifier: 'BRO-nodate', updatedAt: null }),
        issue({ identifier: 'BRO-dated', updatedAt: daysAgo(6) }),
      ],
      { now: NOW }
    );
    assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-dated', 'BRO-nodate']);
    assert.equal(rows[1].idleMs, null);
  });

  test('a garbage updatedAt is treated as undateable, not as age zero', () => {
    const [row] = buildInReviewRows([issue({ updatedAt: 'not-a-date' })], { now: NOW });
    assert.equal(row.idleMs, null);
    assert.equal(row.detail, 'finished, unreviewed');
  });

  test('an updatedAt in the future clamps to zero rather than going negative', () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    const [row] = buildInReviewRows([issue({ updatedAt: future })], { now: NOW });
    assert.equal(row.idleMs, 0);
  });

  test('the row carries the identifier and a working url so the owner can click through', () => {
    const [row] = buildInReviewRows([issue({ identifier: 'BRO-282', title: 'No channel tells the owner' })], { now: NOW });
    assert.equal(row.title, 'BRO-282: No channel tells the owner');
    assert.match(row.url, /^https:\/\//);
    assert.match(row.detail, /finished, unreviewed 20d/);
  });
});

describe('buildInReviewSection', () => {
  test('returns null when nothing has crossed the idle threshold — no standing zero row', () => {
    assert.equal(buildInReviewSection([issue({ updatedAt: daysAgo(1) })], { now: NOW }), null);
    assert.equal(buildInReviewSection([], { now: NOW }), null);
    assert.equal(buildInReviewSection(null, { now: NOW }), null);
  });

  test('a card younger than the threshold is normal throughput, not a leak', () => {
    const justUnder = new Date(NOW.getTime() - IDLE_AFTER_MS + 1000).toISOString();
    assert.equal(buildInReviewSection([issue({ updatedAt: justUnder })], { now: NOW }), null);
  });

  test('the banner counts EVERY idle item, not just the printed rows', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      issue({ identifier: `BRO-${i}`, updatedAt: daysAgo(20 + i) })
    );
    const s = buildInReviewSection(many, { now: NOW });
    assert.match(s.bannerText, /^30 finished items nobody has reviewed/);
    assert.equal(s.items.length, 6);
    assert.equal(s.moreCount, 24);
  });

  test('banner calls out urgent and 14d+ counts, the two things that make this actionable', () => {
    const s = buildInReviewSection(
      [
        issue({ identifier: 'BRO-a', priority: 1, updatedAt: daysAgo(28) }),
        issue({ identifier: 'BRO-b', priority: 2, updatedAt: daysAgo(20) }),
        issue({ identifier: 'BRO-c', priority: 2, updatedAt: daysAgo(5) }),
      ],
      { now: NOW }
    );
    assert.equal(s.bannerText, '3 finished items nobody has reviewed · 1 urgent · 2 idle 14d+');
  });

  test('singular reads correctly', () => {
    const s = buildInReviewSection([issue({ updatedAt: daysAgo(10) })], { now: NOW });
    assert.match(s.bannerText, /^1 finished item nobody has reviewed/);
    assert.equal(s.moreCount, 0);
  });

  test('noise and other states never reach the count', () => {
    const s = buildInReviewSection(
      [
        issue({ identifier: 'BRO-real', updatedAt: daysAgo(20) }),
        issue({ identifier: 'BRO-noise', title: 'CANARY: probe', updatedAt: daysAgo(20) }),
        issue({ identifier: 'BRO-prog', state: { name: 'In Progress', type: 'started' }, updatedAt: daysAgo(20) }),
      ],
      { now: NOW }
    );
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].title, 'BRO-real: a finished thing');
    assert.match(s.bannerText, /^1 finished item /);
  });

  test('the shape is renderNamedDigestBlock-compatible', () => {
    const s = buildInReviewSection([issue({ updatedAt: daysAgo(20) })], { now: NOW });
    assert.equal(typeof s.generatedAt, 'string');
    assert.equal(Number.isNaN(new Date(s.generatedAt).getTime()), false);
    assert.equal(typeof s.bannerText, 'string');
    assert.ok(Array.isArray(s.items));
    for (const it of s.items) {
      assert.equal(typeof it.title, 'string');
      assert.equal(typeof it.detail, 'string');
      assert.equal(typeof it.url, 'string');
    }
    assert.equal(typeof s.moreCount, 'number');
  });

  test('the real 2026-09-15 backlog shape reports the numbers that triggered this work', () => {
    // 120 real + 5 noise; 8 urgent; 100 at 14d+.
    const issues = [];
    for (let i = 0; i < 8; i++) issues.push(issue({ identifier: `BRO-u${i}`, priority: 1, updatedAt: daysAgo(20) }));
    for (let i = 0; i < 92; i++) issues.push(issue({ identifier: `BRO-s${i}`, priority: 2, updatedAt: daysAgo(18) }));
    for (let i = 0; i < 20; i++) issues.push(issue({ identifier: `BRO-f${i}`, priority: 2, updatedAt: daysAgo(6) }));
    for (let i = 0; i < 5; i++) issues.push(issue({ identifier: `BRO-n${i}`, title: 'BSC Daily: noise', updatedAt: daysAgo(20) }));
    const s = buildInReviewSection(issues, { now: NOW });
    assert.equal(s.bannerText, '120 finished items nobody has reviewed · 8 urgent · 100 idle 14d+');
    assert.equal(s.moreCount, 114);
    // Every printed row is one of the urgent ones — that is the whole point.
    assert.ok(s.items.every((r) => r.urgent));
  });
});
