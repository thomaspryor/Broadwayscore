import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isFreshRecoupmentNews } = require('./recoupment-news.js');

const WEEK = ['2026-07-20', '2026-07-26'];

test('backfilled historical recoupment never surfaces (2026-07-26 regression)', () => {
  // Real entries from the 2026-07-20 commercial sweep: firstAdded this week,
  // but the announcements are months-to-years old.
  for (const recoupedDate of ['2022-11', '2024-04', '2024-11', '2026-05']) {
    assert.equal(
      isFreshRecoupmentNews({ recouped: true, recoupedDate, firstAdded: '2026-07-20T13:19:29.864Z' }, ...WEEK),
      false, `recoupedDate ${recoupedDate} should be stale`);
  }
});

test('genuinely fresh recoupment passes once', () => {
  const entry = { recouped: true, recoupedDate: '2026-07', firstAdded: '2026-07-22T09:00:00Z' };
  assert.equal(isFreshRecoupmentNews(entry, ...WEEK), true);
});

test('fresh recoupment suppressed in later weeks (firstAdded outside window)', () => {
  const entry = { recouped: true, recoupedDate: '2026-07', firstAdded: '2026-07-22T09:00:00Z' };
  assert.equal(isFreshRecoupmentNews(entry, '2026-07-27', '2026-08-02'), false);
});

test('week straddling a month boundary accepts both months', () => {
  const entry = { recouped: true, recoupedDate: '2026-06', firstAdded: '2026-06-30T12:00:00Z' };
  assert.equal(isFreshRecoupmentNews(entry, '2026-06-29', '2026-07-05'), true);
});

test('legacy entry without firstAdded passes on announcement month alone', () => {
  assert.equal(isFreshRecoupmentNews({ recouped: true, recoupedDate: '2026-07' }, ...WEEK), true);
  assert.equal(isFreshRecoupmentNews({ recouped: true, recoupedDate: '2026-06' }, ...WEEK), false);
});

test('rejects malformed / non-recouped entries', () => {
  assert.equal(isFreshRecoupmentNews(null, ...WEEK), false);
  assert.equal(isFreshRecoupmentNews({ recouped: false, recoupedDate: '2026-07' }, ...WEEK), false);
  assert.equal(isFreshRecoupmentNews({ recouped: true, recoupedDate: '2026' }, ...WEEK), false);
  assert.equal(isFreshRecoupmentNews({ recouped: true }, ...WEEK), false);
});
