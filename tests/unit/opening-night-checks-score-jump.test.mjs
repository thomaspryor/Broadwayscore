import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const check = require('../../scripts/lib/opening-night-checks/unexplained-score-jump.check.js');
const { recordDailySnapshot } = require('../../scripts/lib/score-history-snapshot.js');

let tmpFile;

function makeContext() {
  return { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

describe('unexplained-score-jump check', () => {
  before(() => {
    tmpFile = path.join(os.tmpdir(), `score-history-test-${Date.now()}.jsonl`);
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('jump >8pts with 0 new reviews → warning', () => {
    writeJsonl(tmpFile, [
      { date: '2026-04-14', showId: 'test-2026', compositeScore: 60, reviewCount: 5 },
      { date: '2026-04-15', showId: 'test-2026', compositeScore: 72, reviewCount: 5 },
    ]);
    const show = { id: 'test-2026' };
    const result = check.run(show, makeContext(), tmpFile);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /jumped/);
    assert.match(result.message, /0 new reviews/);
  });

  it('jump >8pts but reviews also added → ok', () => {
    writeJsonl(tmpFile, [
      { date: '2026-04-14', showId: 'test-2026', compositeScore: 60, reviewCount: 5 },
      { date: '2026-04-15', showId: 'test-2026', compositeScore: 72, reviewCount: 8 },
    ]);
    const show = { id: 'test-2026' };
    const result = check.run(show, makeContext(), tmpFile);
    assert.equal(result.ok, true, result.message);
  });

  it('small change (≤8pts) with no new reviews → ok', () => {
    writeJsonl(tmpFile, [
      { date: '2026-04-14', showId: 'test-2026', compositeScore: 70, reviewCount: 5 },
      { date: '2026-04-15', showId: 'test-2026', compositeScore: 74, reviewCount: 5 },
    ]);
    const show = { id: 'test-2026' };
    const result = check.run(show, makeContext(), tmpFile);
    assert.equal(result.ok, true, result.message);
  });

  it('fewer than 2 snapshots → ok with informational message', () => {
    writeJsonl(tmpFile, [
      { date: '2026-04-15', showId: 'test-2026', compositeScore: 72, reviewCount: 5 },
    ]);
    const show = { id: 'test-2026' };
    const result = check.run(show, makeContext(), tmpFile);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /Fewer than 2/);
  });
});

describe('recordDailySnapshot', () => {
  before(() => {
    tmpFile = path.join(os.tmpdir(), `snapshot-test-${Date.now()}.jsonl`);
  });

  after(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it('appends one line per show', () => {
    const shows = [
      { id: 'show-a', compositeScore: 70, reviewCount: 5 },
      { id: 'show-b', compositeScore: 80, reviewCount: 10 },
    ];
    const { recorded } = recordDailySnapshot(shows, tmpFile);
    assert.equal(recorded, 2);
    const lines = fs.readFileSync(tmpFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const parsed = lines.map(l => JSON.parse(l));
    assert.ok(parsed.every(p => p.date && p.showId));
  });

  it('dedupes by (date, showId) — second call is a no-op', () => {
    const shows = [{ id: 'show-a', compositeScore: 70, reviewCount: 5 }];
    recordDailySnapshot(shows, tmpFile);
    const { recorded } = recordDailySnapshot(shows, tmpFile);
    assert.equal(recorded, 0, 'second call should record 0 (already written today)');
  });
});
