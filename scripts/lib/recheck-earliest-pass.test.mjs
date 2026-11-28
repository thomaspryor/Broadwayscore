// BRO-8426: the earliest date a recheck command can possibly pass. BRO-7437 and
// BRO-7669 were stamped RECHECK-AFTER days before their quiet windows ended, so
// the nightly recheck failed both and filed a card nobody could act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { earliestPassFor } = require('./recheck-earliest-pass.js');
const { earliestClassPass } = require('../recurrence-detector.js');
const { earliestPass } = require('../check-alert-condition-absent.js');
const { absenceQuietHoursFor } = require('./owner-alert-router.js');

const H = 36e5;
const NOW = Date.parse('2026-11-28T11:00:00Z');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString();
const noReplay = { replay: () => null };

test('only registered probe scripts are looked up; anything else is "no window known"', () => {
  assert.equal(earliestPassFor('node scripts/check-never-audited-backlog.js --max=100', NOW), null);
  assert.equal(earliestPassFor('npx tsc --noEmit', NOW), null);
  assert.equal(earliestPassFor('', NOW), null);
  assert.equal(earliestPassFor('node scripts/recurrence-detector.js', NOW), null, 'no --check-class');
});

test('recurrence class: QUIET_DAYS after the last case (BRO-7437: case 11-23 -> 12-14)', () => {
  const snap = { lastSeenByKey: { 'shows missing poster synopsis tickets': '2026-11-23T12:41:17.620Z' } };
  const r = earliestClassPass('shows-missing-poster-synopsis-tickets', snap, NOW);
  assert.equal(new Date(r.atMs).toISOString().slice(0, 10), '2026-12-14');
  assert.match(r.why, /21 quiet days/);
  assert.equal(earliestClassPass('shows-missing-poster-synopsis-tickets', snap, Date.parse('2026-12-15T00:00:00Z')), null, 'window over');
  assert.equal(earliestClassPass('never-seen-class', snap, NOW), null, 'unknown class');
});

const ledger = (conditions) => [{ path: 'fixture', conditions: { 'heartbeat:x': { status: 'open', lastSeen: iso(1) }, ...conditions } }];

test('alert row: lastSeen + the router family quiet hours (BRO-7669 shape: opening-night-* 168h)', () => {
  const key = 'opening-night-fulltext-mentions-show:some-show';
  const r = earliestPass(ledger({ [key]: { status: 'open', lastSeen: iso(156) } }), key, NOW, noReplay);
  assert.equal(r.atMs, NOW - 156 * H + 168 * H);
  assert.equal(absenceQuietHoursFor(key), 168);
  const gap = 'gap:show/outlet--a.json';
  assert.equal(earliestPass(ledger({ [gap]: { status: 'open', lastSeen: iso(200) } }), gap, NOW, noReplay).atMs, NOW - 200 * H + 336 * H, 'gap: family waits 336h');
});

test('alert row: never resolved by quiet -> never; resolved, past window or stale ledger -> null', () => {
  const odd = 'some-unknown-family:x';
  assert.equal(earliestPass(ledger({ [odd]: { status: 'open', lastSeen: iso(2) } }), odd, NOW, noReplay).never, true);
  const key = 'opening-night-fulltext-mentions-show:s';
  assert.equal(earliestPass(ledger({ [key]: { status: 'resolved', lastSeen: iso(5), resolvedAt: iso(4) } }), key, NOW, noReplay), null);
  assert.equal(earliestPass(ledger({ [key]: { status: 'open', lastSeen: iso(170) } }), key, NOW, noReplay), null);
  const stale = [{ path: 'old', conditions: { [key]: { status: 'open', lastSeen: iso(100) } } }];
  assert.equal(earliestPass(stale, key, NOW, noReplay), null, 'a stale ledger proves nothing');
});

test('alert row: the latest row across ledgers wins; a replay that decides means no wait', () => {
  const key = 'opening-night-fulltext-mentions-show:s';
  const two = [...ledger({ [key]: { status: 'open', lastSeen: iso(150) } }), { path: 'b', conditions: { [key]: { status: 'open', lastSeen: iso(10) } } }];
  assert.equal(earliestPass(two, key, NOW, noReplay).atMs, NOW - 10 * H + 168 * H);
  const rk = 'opening-night-revival-unverified-the-ugly-one';
  const l = ledger({ [rk]: { status: 'open', lastSeen: iso(6) } });
  assert.equal(earliestPass(l, rk, NOW, { replay: () => ({ code: 0, message: 'PASS' }) }), null);
  assert.ok(earliestPass(l, rk, NOW, noReplay).atMs > NOW, 'replay undecided -> ledger window');
});
