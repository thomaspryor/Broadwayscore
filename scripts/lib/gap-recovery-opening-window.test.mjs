// BRO-7389: NYT text recovery must run inside the opening window, not only at
// the 01:30 nightly. Run: node --test scripts/lib/gap-recovery-opening-window.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectOpeningWindowShows, driverArgsFor, inNightlyWindow } = require('./gap-recovery-opening-window.js');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const SHOWS = [
  { id: 'the-verge-off-broadway-2026', category: 'off-broadway', openingDate: '2026-11-05', status: 'open' },
  { id: 'the-unbelievers-off-broadway-2026', category: 'off-broadway', openingDate: '2026-11-05', status: 'open' },
  { id: 'the-charioteer-off-broadway-2026', category: 'off-broadway', openingDate: '2026-11-08', status: 'open' },
  { id: 'old-show', category: 'broadway', openingDate: '2026-09-01', status: 'open' },
  { id: 'cancelled-show', category: 'broadway', openingDate: '2026-11-08', status: 'cancelled' },
  { id: 'regional', category: 'regional', openingDate: '2026-11-08', status: 'open' },
];

test('the three BRO-7389 shows are in the window on their opening night + 1 day', () => {
  const ids = selectOpeningWindowShows(SHOWS, { nowMs: Date.parse('2026-11-06T03:00:00Z') });
  assert.ok(ids.includes('the-verge-off-broadway-2026'));
  assert.ok(ids.includes('the-unbelievers-off-broadway-2026'));
  const ids2 = selectOpeningWindowShows(SHOWS, { nowMs: Date.parse('2026-11-09T03:00:00Z') });
  assert.ok(ids2.includes('the-charioteer-off-broadway-2026'));
});

test('old, cancelled and non-NY/WE shows are not in the window', () => {
  const ids = selectOpeningWindowShows(SHOWS, { nowMs: Date.parse('2026-11-09T03:00:00Z') });
  assert.deepEqual(ids.filter((i) => ['old-show', 'cancelled-show', 'regional'].includes(i)), []);
});

test('a show whose window passed drops out (4 days)', () => {
  const ids = selectOpeningWindowShows(SHOWS, { nowMs: Date.parse('2026-11-15T03:00:00Z') });
  assert.ok(!ids.includes('the-verge-off-broadway-2026'));
});

test('driver runs nytimes only for the show', () => {
  assert.deepEqual(driverArgsFor('x'), ['--show=x', '--outlet=nytimes', '--recent-only']);
});

test('a launchd job runs the opening-window script on a sub-hour interval', () => {
  const plist = fs.readFileSync(path.join(ROOT, 'scripts/launchd/com.broadwayscore.gap-recovery-opening-window.plist'), 'utf8');
  assert.match(plist, /gap-recovery-opening-window\.js/);
  const m = plist.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  assert.ok(m && Number(m[1]) <= 3600, 'interval must be <= 1h');
});

test('ticks stay out of the nightly window', () => {
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 1, 30)), true);
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 12, 0)), false);
});

// BRO-8215 class guard: every market the window selects must have a subscriber outlet, and the UK
// openings that missed The Stage's text at the first pass must be selected and routed to thestage.
test('BRO-8215: off-west-end / west-end openings recover thestage text in the window', () => {
  const uk = [
    { id: 'act-of-god-off-west-end-2026', category: 'off-west-end', openingDate: '2026-11-11', status: 'open' },
    { id: 'eurotrash-off-west-end-2026', category: 'off-west-end', openingDate: '2026-11-17', status: 'open' },
    { id: 'the-ugly-one-off-west-end-2026', category: 'off-west-end', openingDate: '2026-11-20', status: 'open' },
    { id: 'cloud-9-west-end-2026', category: 'west-end', openingDate: '2026-11-10', status: 'open' },
  ];
  const ids = selectOpeningWindowShows(uk, { nowMs: Date.parse('2026-11-12T03:00:00Z') });
  assert.ok(ids.includes('act-of-god-off-west-end-2026'));
  assert.ok(ids.includes('cloud-9-west-end-2026'));
  assert.deepEqual(driverArgsFor('act-of-god-off-west-end-2026', 'off-west-end'), ['--show=act-of-god-off-west-end-2026', '--outlet=thestage', '--recent-only']);
  assert.deepEqual(driverArgsFor('x', 'west-end'), ['--show=x', '--outlet=thestage', '--recent-only']);
  assert.deepEqual(driverArgsFor('y', 'off-broadway'), ['--show=y', '--outlet=nytimes', '--recent-only']);
});

test('regional shows are still not selected', () => {
  assert.deepEqual(selectOpeningWindowShows([{ id: 'r', category: 'regional', openingDate: '2026-11-08', status: 'open' }], { nowMs: Date.parse('2026-11-09T03:00:00Z') }), []);
});
