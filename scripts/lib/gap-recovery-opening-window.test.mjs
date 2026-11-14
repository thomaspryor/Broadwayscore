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

test('ticks stay out of the nightly window and West End shows are not selected', () => {
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 1, 30)), true);
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 12, 0)), false);
  const ids = selectOpeningWindowShows([{ id: 'w', category: 'west-end', openingDate: '2026-11-08', status: 'open' }], { nowMs: Date.parse('2026-11-09T03:00:00Z') });
  assert.deepEqual(ids, []);
});
