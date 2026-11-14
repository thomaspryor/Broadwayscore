import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { emitStage, rotateIfNeeded } = require('../../scripts/lib/stage-latency.js');

function makeTempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-latency-'));
  return path.join(dir, 'stage-latency.jsonl');
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('emitStage appends three valid JSONL lines to the temp file', () => {
  const logFile = makeTempLog();
  process.env.STAGE_LATENCY_LOG = logFile;

  emitStage({ showId: 'show-a', reviewKey: 'bway-world:jane:https://example.com/r1', stage: 'review-first-seen' });
  emitStage({ showId: 'show-a', reviewKey: 'bway-world:jane:https://example.com/r1', stage: 'review-text-collected', metadata: { bytes: 4200 } });
  emitStage({ showId: 'show-a', stage: 'rebuilt', metadata: { reviewCount: 21 } });

  delete process.env.STAGE_LATENCY_LOG;

  const lines = readLines(logFile);
  assert.equal(lines.length, 3, 'should have 3 lines');

  assert.equal(lines[0].stage, 'review-first-seen');
  assert.equal(lines[0].showId, 'show-a');
  assert.equal(lines[0].reviewKey, 'bway-world:jane:https://example.com/r1');
  assert.ok(lines[0].at, 'should have at timestamp');

  assert.equal(lines[1].stage, 'review-text-collected');
  assert.deepEqual(lines[1].metadata, { bytes: 4200 });

  assert.equal(lines[2].stage, 'rebuilt');
  assert.equal(lines[2].reviewKey, null, 'missing reviewKey should be null');
  assert.deepEqual(lines[2].metadata, { reviewCount: 21 });
});

test('emitStage accepts an explicit at timestamp', () => {
  const logFile = makeTempLog();
  process.env.STAGE_LATENCY_LOG = logFile;

  const fixedAt = '2026-04-16T03:00:00.000Z';
  emitStage({ showId: 'show-b', stage: 'scored', at: fixedAt });

  delete process.env.STAGE_LATENCY_LOG;

  const lines = readLines(logFile);
  assert.equal(lines[0].at, fixedAt);
});

test('emitStage creates parent directory if it does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-latency-deep-'));
  const logFile = path.join(dir, 'nested', 'sub', 'stage-latency.jsonl');
  process.env.STAGE_LATENCY_LOG = logFile;

  emitStage({ showId: 'show-c', stage: 'deployed-live' });

  delete process.env.STAGE_LATENCY_LOG;

  assert.ok(fs.existsSync(logFile), 'log file should be created even in nested path');
  const lines = readLines(logFile);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stage, 'deployed-live');
});

test('rotateIfNeeded is a no-op below the size threshold', () => {
  const logFile = makeTempLog();
  fs.writeFileSync(logFile, '{"showId":"a","stage":"scored"}\n'.repeat(10));
  const before = fs.readFileSync(logFile, 'utf8');

  assert.equal(rotateIfNeeded(logFile, 1024 * 1024, 512 * 1024), false);
  assert.equal(fs.readFileSync(logFile, 'utf8'), before, 'file should be untouched');
});

test('rotateIfNeeded is a no-op when the file does not exist', () => {
  const logFile = makeTempLog();
  assert.equal(rotateIfNeeded(logFile, 100, 50), false);
});

test('rotateIfNeeded trims to newest lines, aligned to a line boundary', () => {
  const logFile = makeTempLog();
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    lines.push(JSON.stringify({ showId: `show-${i}`, stage: 'scored', seq: i }));
  }
  fs.writeFileSync(logFile, lines.join('\n') + '\n');
  const originalSize = fs.statSync(logFile).size;

  const rotated = rotateIfNeeded(logFile, 1024, 512);
  assert.equal(rotated, true);

  const size = fs.statSync(logFile).size;
  assert.ok(size <= 512, `rotated size ${size} should be <= retain bytes`);
  assert.ok(size < originalSize, 'file should have shrunk');

  const kept = readLines(logFile);
  assert.ok(kept.length > 0, 'should keep some lines');
  // Every kept line parses (checked by readLines) and they are the NEWEST ones
  assert.equal(kept[kept.length - 1].seq, 999, 'last line must be the newest entry');
  for (let i = 1; i < kept.length; i++) {
    assert.equal(kept[i].seq, kept[i - 1].seq + 1, 'kept lines must be contiguous');
  }
});

test('emitStage rotates an oversized log before appending', () => {
  const { MAX_LOG_BYTES, RETAIN_BYTES } = require('../../scripts/lib/stage-latency.js');
  const logFile = makeTempLog();
  const line = '{"showId":"old","stage":"scored"}\n';
  const repeats = Math.ceil((MAX_LOG_BYTES + 1024) / line.length);
  fs.writeFileSync(logFile, line.repeat(repeats));
  assert.ok(fs.statSync(logFile).size > MAX_LOG_BYTES, 'setup: file must exceed threshold');

  process.env.STAGE_LATENCY_LOG = logFile;
  emitStage({ showId: 'show-new', stage: 'rebuilt' });
  delete process.env.STAGE_LATENCY_LOG;

  const size = fs.statSync(logFile).size;
  assert.ok(size <= RETAIN_BYTES + 1024, `size ${size} should be near retain bytes after rotation`);

  const kept = readLines(logFile);
  assert.equal(kept[kept.length - 1].showId, 'show-new', 'append still lands after rotation');
});

// --- readTrackedShowIds (task #388) ------------------------------------------
// rebuild-all-reviews uses this to decide which shows get a per-show 'rebuilt'
// terminal. Too wide and the log rotates the SLA's history away every ~3.5 days
// (the bug this fixed); too narrow and a genuinely stuck review never clears.

test('readTrackedShowIds returns shows with a recent review-level event', () => {
  const logFile = makeTempLog();
  const now = new Date('2026-08-08T12:00:00Z');
  const at = days => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(logFile, [
    { showId: 'fresh-show', reviewKey: 'nyt:a:u1', stage: 'review-first-seen', at: at(1) },
    { showId: 'collected-show', reviewKey: 'var:b:u2', stage: 'review-text-collected', at: at(5) },
    { showId: 'scored-show', reviewKey: 'gua:c:u3', stage: 'scored', at: at(20) },
    { showId: 'stale-show', reviewKey: 'nyp:d:u4', stage: 'review-first-seen', at: at(40) },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');

  const { readTrackedShowIds } = require('../../scripts/lib/stage-latency.js');
  const tracked = readTrackedShowIds({ logFile, now });
  assert.ok(tracked.has('fresh-show'));
  assert.ok(tracked.has('collected-show'));
  assert.ok(tracked.has('scored-show'), '20 days is inside the 21-day window');
  assert.ok(!tracked.has('stale-show'), '40 days is outside the window');
});

test('readTrackedShowIds ignores rebuild/deploy lines — only review-level events track a show', () => {
  const logFile = makeTempLog();
  const now = new Date('2026-08-08T12:00:00Z');
  const recent = new Date(now.getTime() - 60 * 1000).toISOString();
  fs.writeFileSync(logFile, [
    { showId: 'rebuild-only-show', reviewKey: null, stage: 'rebuilt', at: recent, metadata: { reviewCount: 9 } },
    { showId: null, reviewKey: null, stage: 'deployed-live', at: recent },
    { showId: 'real-show', reviewKey: 'nyt:a:u', stage: 'review-first-seen', at: recent },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');

  const { readTrackedShowIds } = require('../../scripts/lib/stage-latency.js');
  const tracked = readTrackedShowIds({ logFile, now });
  assert.deepEqual([...tracked], ['real-show']);
});

test('readTrackedShowIds returns an empty set when the log does not exist', () => {
  const { readTrackedShowIds } = require('../../scripts/lib/stage-latency.js');
  const tracked = readTrackedShowIds({ logFile: path.join(os.tmpdir(), 'definitely-not-here-388.jsonl') });
  assert.equal(tracked.size, 0);
});

test('readTrackedShowIds drops the partial first line when scanning only the tail', () => {
  const logFile = makeTempLog();
  const now = new Date('2026-08-08T12:00:00Z');
  const recent = new Date(now.getTime() - 60 * 1000).toISOString();
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push(JSON.stringify({ showId: `pad-${i}`, reviewKey: `o:c:u${i}`, stage: 'scored', at: recent }));
  }
  lines.push(JSON.stringify({ showId: 'tail-show', reviewKey: 'o:c:tail', stage: 'review-first-seen', at: recent }));
  fs.writeFileSync(logFile, lines.join('\n') + '\n');

  const { readTrackedShowIds } = require('../../scripts/lib/stage-latency.js');
  // scanBytes small enough that the window starts mid-line
  const tracked = readTrackedShowIds({ logFile, now, scanBytes: 900 });
  assert.ok(tracked.has('tail-show'), 'the newest line is always readable');
  assert.ok(tracked.size < 201, 'only the scanned tail is considered');
  // Nothing malformed leaked in as a show id
  for (const id of tracked) assert.ok(/^(pad-\d+|tail-show)$/.test(id), `unexpected id ${id}`);
});

// --- selectTerminalShowIds (task #388) ---------------------------------------
// The which-shows-get-a-terminal decision, extracted from rebuild-all-reviews so
// it is covered (CLAUDE.md rule 15). Inline, an inverted condition would either
// flood the log again or emit terminals for NOBODY — which pages every
// in-flight review — and no test would fail.

test('selectTerminalShowIds keeps only shows that are both reviewed and tracked', () => {
  const { selectTerminalShowIds } = require('../../scripts/lib/stage-latency.js');
  const withReviews = ['tracked-a', 'untracked-b', 'tracked-c'];
  const tracked = new Set(['tracked-a', 'tracked-c', 'tracked-but-no-reviews']);
  assert.deepEqual(selectTerminalShowIds(withReviews, tracked), ['tracked-a', 'tracked-c']);
});

test('selectTerminalShowIds emits nothing when the tracked set is empty', () => {
  // The dangerous direction: no terminals at all means every in-flight review
  // looks stuck. This asserts the shape, so a regression that silently empties
  // the set is at least visible here rather than only in a 3am page.
  const { selectTerminalShowIds } = require('../../scripts/lib/stage-latency.js');
  assert.deepEqual(selectTerminalShowIds(['a', 'b'], new Set()), []);
  assert.deepEqual(selectTerminalShowIds(['a', 'b'], null), []);
});

test('selectTerminalShowIds does not invent shows that have no reviews', () => {
  const { selectTerminalShowIds } = require('../../scripts/lib/stage-latency.js');
  assert.deepEqual(selectTerminalShowIds([], new Set(['x', 'y'])), []);
});

test('selectTerminalShowIds accepts a plain array as the tracked set', () => {
  const { selectTerminalShowIds } = require('../../scripts/lib/stage-latency.js');
  assert.deepEqual(selectTerminalShowIds(['a', 'b'], ['b']), ['b']);
});
