/**
 * BRO-4272: the SERP-burst ledger's per-show lastBurstAt must survive the UTC date
 * rollover (Broadway's opening window crosses 00:00 UTC, and the hourly spacing is
 * computed from it), and Broadway bursts count in their own bucket.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-burst-ledger-'));
process.env.SERP_BURST_LEDGER_PATH = path.join(tmp, 'serp-burst-ledger.json');

const require = createRequire(import.meta.url);
const { loadSerpBurstLedger, incrementSerpBurstLedger } = require('../../scripts/opening-night-poller.js');

test('Broadway burst at 23:30 UTC is still visible after midnight; daily counts reset', () => {
  const before = new Date('2026-09-28T23:30:00Z');
  incrementSerpBurstLedger('show-a', before, { bucket: 'bw' });
  const sameDay = loadSerpBurstLedger(new Date('2026-09-28T23:50:00Z'));
  assert.equal(sameDay.bw.perShow['show-a'], 1);
  assert.equal(sameDay.bw.globalBursts, 1);
  assert.equal(sameDay.globalBursts, 0, 'WE bucket untouched by a Broadway burst');

  const after = loadSerpBurstLedger(new Date('2026-09-29T00:10:00Z'));
  assert.equal(after.bw.globalBursts, 0, 'daily counts reset at the date rollover');
  assert.equal(after.lastBurstAt['show-a'], before.toISOString(), 'lastBurstAt survives the rollover');
});

test('WE bursts keep counting in the top-level bucket', () => {
  const at = new Date('2026-09-30T08:00:00Z');
  const l = incrementSerpBurstLedger('we-show', at);
  assert.equal(l.globalBursts, 1);
  assert.equal(l.perShow['we-show'], 1);
  assert.equal(l.bw.globalBursts, 0);
  assert.equal(l.lastBurstAt['we-show'], at.toISOString());
});

test('lastBurstAt entries older than 2 days are dropped', () => {
  const l = loadSerpBurstLedger(new Date('2026-10-03T00:00:00Z'));
  assert.equal(l.lastBurstAt['show-a'], undefined);
});
