// The scraper-spend ledger is merge=union, so it is not in time order after
// concurrent pushes. Rotation must drop the OLDEST rows, not the first lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trimLedgerLines, MAX_LEDGER_LINES } = require('./provider-telemetry.js');

const row = (ts, n) => JSON.stringify({ ts, provider: 'scrapingdog', n });

test('keeps the newest rows by ts when the file is out of order', () => {
  const lines = [
    row('2026-09-29T12:51:49.781Z', 1), // union merge put a recent row first
    row('2026-09-19T16:30:17.892Z', 2),
    row('2026-09-29T16:59:46.275Z', 3),
    row('2026-09-20T00:00:00.000Z', 4),
  ];
  const kept = trimLedgerLines(lines, 2).map((l) => JSON.parse(l).n);
  assert.deepEqual(kept, [1, 3]);
});

test('under the cap the lines are returned untouched, order included', () => {
  const lines = [row('2026-09-29T12:00:00.000Z', 1), row('2026-09-28T12:00:00.000Z', 2)];
  assert.equal(trimLedgerLines(lines, 5), lines);
});

test('equal timestamps keep file order; lines without a ts prefix drop first', () => {
  const lines = ['not json', row('2026-09-29T00:00:00.000Z', 1), row('2026-09-29T00:00:00.000Z', 2)];
  assert.deepEqual(trimLedgerLines(lines, 2).map((l) => JSON.parse(l).n), [1, 2]);
});

test('the cap holds at least two days at 2026-09 volume (15K rows/day)', () => {
  assert.ok(MAX_LEDGER_LINES >= 30000, `MAX_LEDGER_LINES=${MAX_LEDGER_LINES}`);
});

test('ledger sums accept a { from, to } window as well as a UTC day', () => {
  const { creditsByProvider, topCallersByCredits, countCallsByProvider } = require('./provider-telemetry.js');
  const rows = [
    { ts: '2026-09-28T12:59:59.000Z', provider: 'scrapingdog', script: 'a.js', credits: 5 },
    { ts: '2026-09-28T13:00:00.000Z', provider: 'scrapingdog', script: 'a.js', credits: 5 },
    { ts: '2026-09-29T05:00:00.000Z', provider: 'scrapingdog', script: 'b.js', credits: 10 },
    { ts: '2026-09-29T13:00:00.000Z', provider: 'scrapingdog', script: 'b.js', credits: 10 },
  ];
  const win = { from: '2026-09-28T13:00:00.000Z', to: '2026-09-29T13:00:00.000Z' };
  assert.deepEqual(creditsByProvider(rows, win), { scrapingdog: 15 });
  assert.deepEqual(creditsByProvider(rows, '2026-09-28'), { scrapingdog: 10 });
  assert.deepEqual(topCallersByCredits(rows, win, 'scrapingdog').map((t) => t.script), ['b.js', 'a.js']);
  assert.deepEqual(countCallsByProvider(rows, '2026-09-29'), { scrapingdog: 2 });
});

test('trimming drops exact duplicate rows left by a union merge of a moved block', () => {
  const a = row('2026-09-29T10:00:00.000Z', 1);
  const b = row('2026-09-29T11:00:00.000Z', 2);
  assert.deepEqual(trimLedgerLines([b, a, b, a, row('2026-09-01T00:00:00.000Z', 0)], 2), [a, b]);
});
