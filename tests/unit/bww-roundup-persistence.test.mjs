/**
 * Tests for scripts/lib/bww-roundup-persistence.js (Scraping v2 Sprint 1 T6):
 * write-once shows.json persistence + the negative-cache miss-ledger's pure
 * cooldown decision function.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createShowsWriteGuard } = require('../../scripts/lib/shows-write-guard.js');
const {
  persistBwwRoundupUrlIfMissing,
  clearStaleBwwRoundupUrl,
  recordRoundupMiss,
  readRoundupMisses,
  lastMissForShow,
  isInRoundupMissCooldown,
  OPENING_WINDOW_DAYS,
} = require('../../scripts/lib/bww-roundup-persistence.js');

let tmpDir;
let showsPath;
let guard;

function seed(shows) {
  fs.writeFileSync(
    showsPath,
    JSON.stringify({ _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' }, shows }, null, 2) + '\n'
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bww-roundup-persistence-'));
  showsPath = path.join(tmpDir, 'shows.json');
  guard = createShowsWriteGuard(showsPath);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('persistBwwRoundupUrlIfMissing', () => {
  test('writes bwwRoundupUrl when absent', () => {
    seed([{ id: 'a', title: 'Show A' }]);
    const wrote = persistBwwRoundupUrlIfMissing('a', 'https://example.com/rr', guard);
    assert.equal(wrote, true);
    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows[0].bwwRoundupUrl, 'https://example.com/rr');
  });

  test('write-once: does NOT overwrite an existing bwwRoundupUrl', () => {
    seed([{ id: 'a', title: 'Show A', bwwRoundupUrl: 'https://example.com/original' }]);
    const wrote = persistBwwRoundupUrlIfMissing('a', 'https://example.com/new', guard);
    assert.equal(wrote, false);
    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows[0].bwwRoundupUrl, 'https://example.com/original');
  });

  test('no-ops on unknown showId', () => {
    seed([{ id: 'a', title: 'Show A' }]);
    assert.equal(persistBwwRoundupUrlIfMissing('nonexistent', 'https://x', guard), false);
  });

  test('no-ops on missing url', () => {
    seed([{ id: 'a', title: 'Show A' }]);
    assert.equal(persistBwwRoundupUrlIfMissing('a', '', guard), false);
    assert.equal(persistBwwRoundupUrlIfMissing('a', null, guard), false);
  });

  test('concurrent writer to a DIFFERENT show survives the merge', () => {
    seed([{ id: 'a', title: 'A' }, { id: 'b', title: 'B', status: 'open' }]);
    // Simulate a concurrent writer touching show b between load and save.
    const data = guard.loadShows();
    fs.writeFileSync(showsPath, JSON.stringify({
      _meta: {}, shows: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', status: 'closed' }],
    }));
    data.shows.find(s => s.id === 'a').bwwRoundupUrl = 'https://example.com/rr';
    guard.saveShows(data);
    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal(onDisk.shows.find(s => s.id === 'a').bwwRoundupUrl, 'https://example.com/rr');
    assert.equal(onDisk.shows.find(s => s.id === 'b').status, 'closed', 'concurrent status write must survive');
  });
});

describe('clearStaleBwwRoundupUrl', () => {
  test('clears an existing bwwRoundupUrl (404 revalidation)', () => {
    seed([{ id: 'a', title: 'A', bwwRoundupUrl: 'https://stale.example.com' }]);
    const cleared = clearStaleBwwRoundupUrl('a', guard);
    assert.equal(cleared, true);
    const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    assert.equal('bwwRoundupUrl' in onDisk.shows[0], false);
  });

  test('idempotent no-op when nothing is set', () => {
    seed([{ id: 'a', title: 'A' }]);
    assert.equal(clearStaleBwwRoundupUrl('a', guard), false);
  });

  test('no-ops on unknown showId', () => {
    seed([{ id: 'a', title: 'A' }]);
    assert.equal(clearStaleBwwRoundupUrl('nonexistent', guard), false);
  });
});

describe('miss-ledger append/read', () => {
  test('records and reads back a miss entry', () => {
    const ledgerPath = path.join(tmpDir, 'miss-ledger.jsonl');
    const entry = recordRoundupMiss('show-a', ledgerPath);
    assert.equal(entry.showId, 'show-a');
    assert.ok(entry.ts);
    const entries = readRoundupMisses(ledgerPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].showId, 'show-a');
  });

  test('readRoundupMisses returns [] for a missing file', () => {
    assert.deepEqual(readRoundupMisses(path.join(tmpDir, 'does-not-exist.jsonl')), []);
  });

  test('skips corrupt lines without throwing', () => {
    const ledgerPath = path.join(tmpDir, 'miss-ledger.jsonl');
    fs.writeFileSync(ledgerPath, '{"showId":"a","ts":"2026-01-01T00:00:00.000Z"}\nnot json\n{"showId":"b","ts":"2026-01-02T00:00:00.000Z"}\n');
    const entries = readRoundupMisses(ledgerPath);
    assert.equal(entries.length, 2);
  });

  test('recordRoundupMiss requires a showId', () => {
    assert.throws(() => recordRoundupMiss(null, path.join(tmpDir, 'l.jsonl')));
  });

  test('lastMissForShow picks the most recent entry', () => {
    const entries = [
      { showId: 'a', ts: '2026-01-01T00:00:00.000Z' },
      { showId: 'a', ts: '2026-01-03T00:00:00.000Z' },
      { showId: 'a', ts: '2026-01-02T00:00:00.000Z' },
      { showId: 'b', ts: '2026-01-05T00:00:00.000Z' },
    ];
    const last = lastMissForShow('a', entries);
    assert.equal(last.ts, '2026-01-03T00:00:00.000Z');
  });

  test('lastMissForShow returns null when no entries match', () => {
    assert.equal(lastMissForShow('nope', []), null);
  });
});

describe('isInRoundupMissCooldown — pure decision (T6)', () => {
  const NOW = new Date('2026-08-01T00:00:00.000Z').getTime();

  test('never in cooldown when there is no prior miss', () => {
    const show = { openingDate: '2026-01-01' };
    assert.equal(isInRoundupMissCooldown(show, null, NOW), false);
  });

  test('opening-window exemption: within OPENING_WINDOW_DAYS, never cooldown even with a recent miss', () => {
    // Opened 3 days ago — inside the 7-day window.
    const show = { openingDate: '2026-07-29' };
    const miss = { showId: 'a', ts: new Date(NOW - 60 * 60 * 1000).toISOString() }; // 1h ago
    assert.equal(isInRoundupMissCooldown(show, miss, NOW), false);
  });

  test('opening-window exemption also covers not-yet-opened shows', () => {
    const show = { openingDate: '2026-08-03' }; // opens in 2 days
    const miss = { showId: 'a', ts: new Date(NOW - 60 * 60 * 1000).toISOString() };
    assert.equal(isInRoundupMissCooldown(show, miss, NOW), false);
  });

  test('past the opening window, a recent miss puts the show in cooldown', () => {
    // Opened 30 days ago — well past the 7-day window.
    const show = { openingDate: '2026-07-02' };
    const miss = { showId: 'a', ts: new Date(NOW - 60 * 60 * 1000).toISOString() }; // 1h ago
    assert.equal(isInRoundupMissCooldown(show, miss, NOW), true);
  });

  test('cooldown expires after MISS_COOLDOWN_MS', () => {
    const show = { openingDate: '2026-07-02' };
    const miss = { showId: 'a', ts: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }; // 25h ago (default cooldown 24h)
    assert.equal(isInRoundupMissCooldown(show, miss, NOW), false);
  });

  test('no openingDate on record — never suppress (fail-open, same spirit as T4)', () => {
    const show = {};
    const miss = { showId: 'a', ts: new Date(NOW - 60 * 60 * 1000).toISOString() };
    assert.equal(isInRoundupMissCooldown(show, miss, NOW), false);
  });

  test('OPENING_WINDOW_DAYS is exported and matches the documented 7-day window', () => {
    assert.equal(OPENING_WINDOW_DAYS, 7);
  });
});
