import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNewRunTooFreshToClose } = require('../../scripts/lib/showscore-closure-guard');

test('Slam Frank: opens today, ShowScore Closed is held', () => {
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-10-04', previewsStartDate: '2026-09-17' }, '2026-10-04'), true);
});
test('future opening is held', () => {
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-11-01' }, '2026-10-04'), true);
});
test('opened 7 days ago still held, 8 days ago not', () => {
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-09-27' }, '2026-10-04'), true);
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-09-26' }, '2026-10-04'), false);
});
test('no openingDate falls back to previews start (14 days)', () => {
  assert.equal(isNewRunTooFreshToClose({ previewsStartDate: '2026-09-25' }, '2026-10-04'), true);
  assert.equal(isNewRunTooFreshToClose({ previewsStartDate: '2026-09-10' }, '2026-10-04'), false);
});
test('Slam Frank on 2026-10-14: stale todaytixId keeps it held past the window', () => {
  const show = {
    openingDate: '2026-10-04',
    todaytixId: 45252,
    ticketLinks: [{ platform: 'TodayTix', url: 'https://www.todaytix.com/nyc/shows/47340-slam-frank' }],
  };
  assert.equal(isNewRunTooFreshToClose(show, '2026-10-14'), true);
});
test('matching todaytixId does not hold a show past the window', () => {
  const show = {
    openingDate: '2026-09-01',
    todaytixId: 47340,
    ticketLinks: [{ platform: 'TodayTix', url: 'https://www.todaytix.com/nyc/shows/47340-slam-frank' }],
  };
  assert.equal(isNewRunTooFreshToClose(show, '2026-10-14'), false);
});
test('opening more than 30 days away is not held (cancelled-before-opening can close)', () => {
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-12-01' }, '2026-10-04'), false);
});
test('no dates: not held', () => {
  assert.equal(isNewRunTooFreshToClose({}, '2026-10-04'), false);
});
