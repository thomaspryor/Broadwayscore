import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readSnapshots, summarizeSerpWeek } = require('../../scripts/lib/serp-volume-post-fix.js');
const row = (day, extra = {}) => ({ ts: `2026-10-${day}T12:00:00.000Z`, provider: 'scrapingbee',
  host: 'serp.scrapingbee', fn: 'serp', success: true, credits: 25, script: 'gather-reviews.js', fallback_from: null, ...extra });
const week = () => [row('18'), ...['19', '20', '21', '22', '23', '24', '25'].map(day => row(day)), row('26')];
const summarize = records => summarizeSerpWeek(records, '2026-10-19', '2026-10-26');

test('compares a UTC week with the cited baseline, retaining costs and fallback classes', () => {
  const report = summarize([...week(), row('20', { fallback_from: 'scrapingdog', credits: 0, success: false }),
    row('21', { fallback_from: 'brightdata', host: 'serp.scrapingbee.images' }),
    row('22', { fn: 'page', host: 'example.test', credits: 1 }),
    row('23', { fn: 'serp-cap-hit', credits: 0 }), row('24', { fn: 'day-cap', credits: 0 })]);
  assert.equal(report.sb.calls, 9);
  assert.equal(report.sb.credits, 200);
  assert.equal(report.sb.allCredits, 201);
  assert.deepEqual(report.sb.byFallback, { null: { calls: 7, credits: 175 },
    scrapingdog: { calls: 1, credits: 0 }, brightdata: { calls: 1, credits: 25 } });
  assert.equal(report.sb.nullFallbackShare, 7 / 9);
  assert.deepEqual(report.sb.topCallers, [{ script: 'gather-reviews.js', count: 9 }]);
  assert.deepEqual(report.sb.topCallersByCredits, [{ script: 'gather-reviews.js', credits: 200 }]);
  assert.equal(report.comparison.callsChangePct, (9 / 543 - 1) * 100);
  assert.equal(report.comparison.creditsChangePct, (200 / 12950 - 1) * 100);
  assert.equal(report.comparison.nullFallbackCallsChangePct, (7 / 543 - 1) * 100);
});

test('groups actual SD failures by status and scrubbed request shape, including missing diagnostics', () => {
  const detail = { msg: 'Something went wrong, please try again', quoted: true, ops: 3, nonAscii: false };
  const sd = extra => row('20', { provider: 'scrapingdog', host: 'serp.scrapingdog', success: false, credits: 0, status: 400, ...extra });
  const report = summarize([...week(), sd({ detail }), sd({ detail }),
    sd({ host: 'serp.scrapingdog.images' }), sd({ detail, success: true }),
    sd({ detail, fn: 'page' }), sd({ detail: { ...detail, ops: 1, nonAscii: true } })]);
  assert.equal(report.sd.failures, 4);
  assert.equal(report.sd.http400, 4);
  assert.equal(report.sd.missingDetail, 1);
  assert.equal(report.sd.failureGroups[0].calls, 2);
  assert.equal(report.sd.failureGroups[0].ops, 3);
  assert.equal(report.sd.failureGroups.length, 3);
});

test('missing tags and rotated or discontinuous input cannot verify a full week', () => {
  const untagged = row('20');
  delete untagged.fallback_from;
  const report = summarize([...week(), untagged]);
  assert.equal(report.sb.byFallback.missing.calls, 1);
  assert.equal(report.sb.byFallback.null.calls, 7);
  assert.equal(report.comparison, null);
  assert.equal(summarize(week().slice(0, -1)).comparison, null);
  assert.deepEqual(summarize(week().filter(r => !r.ts.startsWith('2026-10-22'))).coverage.missingDays, ['2026-10-22']);
  assert.equal(summarize([]).comparison, null);
});

test('overlapping raw snapshots deduplicate exact records and reject absent or malformed input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-week-'));
  try {
    const a = path.join(dir, 'a.jsonl'), b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, week().map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(b, JSON.stringify(row('20')) + '\n');
    assert.equal(summarize(readSnapshots([a, b])).sb.calls, 7);
    assert.throws(() => readSnapshots([path.join(dir, 'missing')]), /ENOENT/);
    fs.writeFileSync(b, 'broken json\n');
    assert.throws(() => readSnapshots([b]), SyntaxError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects invalid, short and pre-fix windows', () => {
  for (const [from, to] of [['2026-02-30', '2026-03-09'], ['2026-10-19', '2026-10-25'],
    ['2026-09-14', '2026-09-21'], ['bad', '2026-10-26']]) {
    assert.throws(() => summarizeSerpWeek([], from, to), /post-fix UTC week/);
  }
});
