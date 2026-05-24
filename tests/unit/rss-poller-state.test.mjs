// Unit tests for the RSS poller's pure state-diff function.
// Per feedback_test_extraction_pattern.md — tests the real module via require().

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { diffNewItems, matchShow, RECOUP_REGEX } = require('../../scripts/poll-trade-press-rss');

// Helper: build a feed item with a pubDate N hours ago.
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
const item = (guid, hoursOld, title = 't', description = 'd') => ({
  guid, title, description, link: `http://x/${guid}`, pubDate: hoursAgo(hoursOld),
});

describe('diffNewItems', () => {
  it('returns all in-window items on first ever poll (no lastSeenGuid)', () => {
    const items = [item('a', 1), item('b', 5), item('c', 10)];
    const result = diffNewItems(items, null, 24 * 60 * 60 * 1000);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map(r => r.guid), ['a', 'b', 'c']);
  });

  it('stops at lastSeenGuid when present in list', () => {
    const items = [item('a', 1), item('b', 2), item('c', 3)];
    const result = diffNewItems(items, 'b', 24 * 60 * 60 * 1000);
    assert.equal(result.length, 1);
    assert.equal(result[0].guid, 'a');
  });

  it('returns nothing when lastSeenGuid is the most recent item', () => {
    const items = [item('a', 1), item('b', 2)];
    const result = diffNewItems(items, 'a', 24 * 60 * 60 * 1000);
    assert.equal(result.length, 0);
  });

  it('fail-open when lastSeenGuid not found (aged out of feed)', () => {
    const items = [item('a', 1), item('b', 2)];
    const result = diffNewItems(items, 'gone-guid', 24 * 60 * 60 * 1000);
    assert.equal(result.length, 2);
  });

  it('rejects items older than 60 days even if before lastSeenGuid', () => {
    // 'a' is 1h old, 'old' is 70 days old. Even if there's no lastSeenGuid,
    // 'old' must be excluded by the 60-day reject.
    const oldItem = item('old', 24 * 70);
    const items = [item('a', 1), oldItem];
    const result = diffNewItems(items, null, 365 * 24 * 60 * 60 * 1000);
    assert.equal(result.length, 1);
    assert.equal(result[0].guid, 'a');
  });

  it('respects window-hours filter', () => {
    const items = [item('recent', 1), item('outOfWindow', 30)];
    const result = diffNewItems(items, null, 24 * 60 * 60 * 1000);
    assert.equal(result.length, 1);
    assert.equal(result[0].guid, 'recent');
  });

  it('drops items with no pubDate', () => {
    const items = [{ guid: 'a', title: 't', link: 'x', pubDate: null }, item('b', 1)];
    const result = diffNewItems(items, null, 24 * 60 * 60 * 1000);
    assert.equal(result.length, 1);
    assert.equal(result[0].guid, 'b');
  });

  it('drops items with invalid pubDate', () => {
    const items = [{ guid: 'a', title: 't', link: 'x', pubDate: new Date('not-a-date') }, item('b', 1)];
    const result = diffNewItems(items, null, 24 * 60 * 60 * 1000);
    assert.equal(result.length, 1);
    assert.equal(result[0].guid, 'b');
  });
});

describe('matchShow', () => {
  const candidates = [
    { slug: 'giant', title: 'Giant' },
    { slug: 'just-in-time', title: 'Just in Time' },
    { slug: 'hamilton', title: 'Hamilton' },
  ];

  it('matches show in RSS title', () => {
    const m = matchShow("John Lithgow Play 'Giant' Recoups", '', candidates);
    assert.equal(m?.slug, 'giant');
  });

  it('matches show via description if title misses', () => {
    const m = matchShow('Broadway milestone news', 'The musical Hamilton paid back investors', candidates);
    assert.equal(m?.slug, 'hamilton');
  });

  it('returns null when no candidate matches', () => {
    const m = matchShow('Some unrelated Broadway article', '', candidates);
    assert.equal(m, null);
  });

  it('matches multi-word title via titleMatchesShow 80% rule', () => {
    const m = matchShow("Broadway's Bobby Darin Musical 'Just In Time' Recoups", '', candidates);
    assert.equal(m?.slug, 'just-in-time');
  });
});

describe('RECOUP_REGEX', () => {
  it('matches recoup, recouped, recoupment, recoups', () => {
    assert.ok(RECOUP_REGEX.test('Hamilton has recouped'));
    assert.ok(RECOUP_REGEX.test('Show recoups in 10 weeks'));
    assert.ok(RECOUP_REGEX.test('Recoupment announced'));
    assert.ok(RECOUP_REGEX.test('On track to recoup'));
  });

  it('matches "earned back"', () => {
    assert.ok(RECOUP_REGEX.test('earned back its investment'));
  });

  it('does NOT match "paid off" or "profit" (puff-piece traps)', () => {
    assert.ok(!RECOUP_REGEX.test('The show paid off handsomely'));
    assert.ok(!RECOUP_REGEX.test('Profit margins tightened'));
    assert.ok(!RECOUP_REGEX.test('Non-profit theatre announces season'));
  });
});
