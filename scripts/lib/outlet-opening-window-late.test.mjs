// BRO-7574: One Minute Critic posts days after press night. It must be polled and matched in the
// opening-window poller past the 0-3 day window. Shows are the real ones the sweep had to find.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const ow = createRequire(import.meta.url)('./outlet-opening-window.js');

const DAY = 86400000;
const shows = [
  { id: 'the-visitors-off-broadway-2026', category: 'off-broadway', openingDate: '2026-11-09' },
  { id: 'slanted-floors-off-broadway-2026', category: 'off-broadway', openingDate: '2026-11-02' },
];
const now = Date.parse('2026-11-14T17:10:00Z'); // minutes after OMC published The Visitors (+5d)
const strategies = { 'one-minute-critic': { strategy: 'rss', url: 'https://1minutecritic.com/feed' } };

test('the 0-3 day window alone misses The Visitors at +5 days (the original gap)', () => {
  assert.equal(ow.selectWindowShows(shows, now).length, 0);
});

test('late window includes The Visitors and polls one-minute-critic', () => {
  const late = ow.selectLateWindowShows(shows, now);
  assert.deepEqual(late.map((s) => s.id), ['the-visitors-off-broadway-2026']);
  assert.deepEqual(ow.lateOutletsToPoll(late, strategies, {}), ['one-minute-critic']);
});

test('one-minute-critic matches The Visitors; other outlets keep the 0-3 day pool', () => {
  const win = ow.selectWindowShows(shows, now);
  const late = ow.selectLateWindowShows(shows, now);
  assert.deepEqual(ow.poolForOutlet('one-minute-critic', win, late, now).map((s) => s.id), ['the-visitors-off-broadway-2026']);
  assert.deepEqual(ow.poolForOutlet('variety', win, late, now), win);
});

test('late window ends: no polling 11+ days past opening', () => {
  const late = ow.selectLateWindowShows(shows, Date.parse('2026-11-21T00:00:00Z'));
  assert.equal(late.length, 0);
  assert.deepEqual(ow.lateOutletsToPoll(late, strategies, {}), []);
});

test('outlet without a window strategy is not polled', () => {
  assert.deepEqual(ow.lateOutletsToPoll([{ id: 'x' }], {}, {}), []);
});

// BRO-8035: LondonTheatre1 reviewed The Lives of Others (West End, opened 2026-10-29) on 2026-11-02,
// day 4, past the 3-day West End window. Reverting londontheatre1 in LATE_PUBLISHER_WINDOW_DAYS fails this.
test('londontheatre1 is matched against The Lives of Others at +4 days (BRO-8035)', () => {
  const lives = [{ id: 'the-lives-of-others-west-end-2026', category: 'west-end', openingDate: '2026-10-29' }];
  const at = Date.parse('2026-11-02T00:20:00Z'); // minutes after LondonTheatre1 published
  const win = ow.selectWindowShows(lives, at);
  const late = ow.selectLateWindowShows(lives, at);
  assert.equal(win.length, 0);
  assert.deepEqual(ow.lateOutletsToPoll(late, {}, { londontheatre1: {} }), ['londontheatre1']);
  assert.deepEqual(ow.poolForOutlet('londontheatre1', win, late, at).map((s) => s.id), ['the-lives-of-others-west-end-2026']);
});
