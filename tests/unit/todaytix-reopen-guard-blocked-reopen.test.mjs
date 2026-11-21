// BRO-4524: a TodayTix reopen blocked by the guard must be recorded, not only
// console.logged, and unknown bookability-looking fields must be surfaced.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  unrecognizedBookabilityFields, buildBlockedReopenRecord, formatBlockedReopensSummary,
} = require('../../scripts/lib/todaytix-reopen-guard.js');
const { refreshTodayTixDates } = require('../../scripts/update-show-status.js');

test('unrecognizedBookabilityFields: flags unknown signals, ignores known and empty ones', () => {
  const tt = {
    id: 1, areRegularTicketsAvailable: false, showtimes: [], bookingEndDate: null,
    lotteryAvailable: true, rushTicketsOnSale: 'yes', rushList: [], ticketNote: '',
    displayName: 'x',
  };
  assert.deepStrictEqual(unrecognizedBookabilityFields(tt), {
    lotteryAvailable: 'true', rushTicketsOnSale: '"yes"',
  });
  assert.deepStrictEqual(unrecognizedBookabilityFields(null), {});
});

test('buildBlockedReopenRecord + summary carry the show, reason and unknown fields', () => {
  const rec = buildBlockedReopenRecord({ id: 'a-show-2025', title: 'A Show' },
    { id: 9, areRegularTicketsAvailable: false, lotteryOpen: true }, 'no-bookable-evidence');
  assert.strictEqual(rec.id, 'a-show-2025');
  assert.strictEqual(rec.reason, 'no-bookable-evidence');
  assert.deepStrictEqual(rec.unrecognizedBookabilityFields, { lotteryOpen: 'true' });
  const md = formatBlockedReopensSummary([rec]);
  assert.match(md, /a-show-2025/);
  assert.match(md, /lotteryOpen=true/);
  assert.strictEqual(formatBlockedReopensSummary([]), '');
});

test('refreshTodayTixDates records a ghost-listing reopen block in its result, summary and outputs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4524-'));
  const summary = path.join(dir, 'summary.md');
  const output = path.join(dir, 'output.txt');
  const prev = { s: process.env.GITHUB_STEP_SUMMARY, o: process.env.GITHUB_OUTPUT };
  process.env.GITHUB_STEP_SUMMARY = summary;
  process.env.GITHUB_OUTPUT = output;
  try {
    const data = { shows: [{
      id: 'ghost-show-2025', title: 'Ghost Show', status: 'closed', category: 'broadway',
      todaytixId: 4242, closingDate: '2026-01-01', venue: 'Some Theatre',
    }] };
    const ghost = { id: 4242, displayName: 'Ghost Show', areRegularTicketsAvailable: false,
      filteredShowtimeMaps: [], showtimes: [], bookingEndDate: null, lotteryOpen: true };
    const updates = [];
    const res = await refreshTodayTixDates(data, updates, { fetchShows: async (loc) => (loc === 1 ? [ghost] : []) });
    assert.strictEqual(data.shows[0].status, 'closed');
    assert.strictEqual(updates.length, 0);
    assert.strictEqual(res.blockedReopens.length, 1);
    assert.strictEqual(res.blockedReopens[0].id, 'ghost-show-2025');
    assert.match(fs.readFileSync(summary, 'utf8'), /ghost-show-2025/);
    const out = fs.readFileSync(output, 'utf8');
    assert.match(out, /blocked_reopens_count=1/);
    assert.match(out, /blocked_reopens=ghost-show-2025/);
  } finally {
    if (prev.s === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = prev.s;
    if (prev.o === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = prev.o;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshTodayTixDates: human-corrected closingDate blocks reopen and is recorded; zero-valued fields ignored', async () => {
  const data = { shows: [{
    id: 'held-show-2025', title: 'Held Show', status: 'closed', category: 'broadway',
    todaytixId: 77, closingDate: '2026-01-01', humanCorrectedClosingDate: true, venue: 'V',
  }] };
  const live = { id: 77, displayName: 'Held Show', areRegularTicketsAvailable: true, ticketCount: 0 };
  const res = await refreshTodayTixDates(data, [], { fetchShows: async (loc) => (loc === 1 ? [live] : []) });
  assert.strictEqual(data.shows[0].status, 'closed');
  assert.strictEqual(res.reopenedIds.size, 0);
  assert.strictEqual(res.blockedReopens.length, 1);
  assert.strictEqual(res.blockedReopens[0].reason, 'human-corrected-closing-date');
  assert.deepStrictEqual(res.blockedReopens[0].unrecognizedBookabilityFields, {});
});

test('refreshTodayTixDates: a bookable closed show reopens and nothing is recorded as blocked', async () => {
  const data = { shows: [{
    id: 'live-show-2025', title: 'Live Show', status: 'closed', category: 'broadway',
    todaytixId: 88, closingDate: '2026-01-01', venue: 'V',
  }] };
  const live = { id: 88, displayName: 'Live Show', areRegularTicketsAvailable: true };
  const res = await refreshTodayTixDates(data, [], { fetchShows: async (loc) => (loc === 1 ? [live] : []) });
  assert.strictEqual(data.shows[0].status, 'open');
  assert.strictEqual(res.blockedReopens.length, 0);
});
