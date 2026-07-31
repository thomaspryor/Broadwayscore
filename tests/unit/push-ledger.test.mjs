// Task #677: CI-side delayed re-verification for push-with-retry.sh's
// content-survival check (task #619). Pure ledger-entry logic tested here;
// git plumbing lives in scripts/record-push-ledger.js / check-push-ledger.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildLedgerEntry,
  parseLedgerLines,
  serializeEntries,
  selectEntriesInWindow,
  pruneToWindow,
} = require('../../scripts/lib/push-ledger.js');

test('buildLedgerEntry: throws without a sha', () => {
  assert.throws(() => buildLedgerEntry({ branch: 'main' }), /sha is required/);
});

test('buildLedgerEntry: defaults branch, ts, and optional fields', () => {
  const line = buildLedgerEntry({ sha: 'abc123' });
  const parsed = JSON.parse(line);
  assert.equal(parsed.sha, 'abc123');
  assert.equal(parsed.branch, 'main');
  assert.equal(typeof parsed.ts, 'string');
  assert.equal(parsed.workflow, '');
});

test('buildLedgerEntry: preserves explicit fields', () => {
  const line = buildLedgerEntry({
    sha: 'deadbeef',
    branch: 'main',
    ts: '2026-07-30T12:00:00.000Z',
    workflow: 'Rebuild Reviews Data',
    runId: '12345',
    runAttempt: '1',
  });
  assert.deepEqual(JSON.parse(line), {
    sha: 'deadbeef',
    branch: 'main',
    ts: '2026-07-30T12:00:00.000Z',
    workflow: 'Rebuild Reviews Data',
    runId: '12345',
    runAttempt: '1',
  });
});

test('parseLedgerLines: parses valid JSONL', () => {
  const content = [
    buildLedgerEntry({ sha: 'a1', ts: '2026-07-30T10:00:00.000Z' }),
    buildLedgerEntry({ sha: 'a2', ts: '2026-07-30T11:00:00.000Z' }),
  ].join('\n');
  const entries = parseLedgerLines(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sha, 'a1');
  assert.equal(entries[1].sha, 'a2');
});

test('parseLedgerLines: skips blank and malformed lines without throwing', () => {
  const content = [
    buildLedgerEntry({ sha: 'good1', ts: '2026-07-30T10:00:00.000Z' }),
    '',
    '{not valid json',
    '{"sha": 123, "ts": "2026-07-30T10:00:00.000Z"}', // sha wrong type
    '{"ts": "2026-07-30T10:00:00.000Z"}', // missing sha
    buildLedgerEntry({ sha: 'good2', ts: '2026-07-30T11:00:00.000Z' }),
  ].join('\n');
  const entries = parseLedgerLines(content);
  assert.deepEqual(entries.map(e => e.sha), ['good1', 'good2']);
});

test('parseLedgerLines: empty/missing content returns empty array', () => {
  assert.deepEqual(parseLedgerLines(''), []);
  assert.deepEqual(parseLedgerLines(undefined), []);
});

test('serializeEntries: round-trips through parseLedgerLines', () => {
  const entries = [
    JSON.parse(buildLedgerEntry({ sha: 'a1', ts: '2026-07-30T10:00:00.000Z' })),
    JSON.parse(buildLedgerEntry({ sha: 'a2', ts: '2026-07-30T11:00:00.000Z' })),
  ];
  const serialized = serializeEntries(entries);
  assert.deepEqual(parseLedgerLines(serialized), entries);
});

test('serializeEntries: empty array serializes to empty string', () => {
  assert.equal(serializeEntries([]), '');
});

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
function entryMinutesAgo(sha, minutes) {
  return { sha, ts: new Date(NOW - minutes * 60 * 1000).toISOString() };
}

test('selectEntriesInWindow: excludes entries newer than minAgeMs (too fresh to have revealed a revert)', () => {
  const entries = [entryMinutesAgo('fresh', 1)];
  const selected = selectEntriesInWindow(entries, { nowMs: NOW, minAgeMs: 5 * 60 * 1000, maxAgeMs: 90 * 60 * 1000 });
  assert.deepEqual(selected, []);
});

test('selectEntriesInWindow: excludes entries older than maxAgeMs (stale)', () => {
  const entries = [entryMinutesAgo('stale', 200)];
  const selected = selectEntriesInWindow(entries, { nowMs: NOW, minAgeMs: 5 * 60 * 1000, maxAgeMs: 90 * 60 * 1000 });
  assert.deepEqual(selected, []);
});

test('selectEntriesInWindow: includes entries within [minAgeMs, maxAgeMs]', () => {
  const entries = [entryMinutesAgo('in-window', 20)];
  const selected = selectEntriesInWindow(entries, { nowMs: NOW, minAgeMs: 5 * 60 * 1000, maxAgeMs: 90 * 60 * 1000 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sha, 'in-window');
});

test('selectEntriesInWindow: boundary is inclusive on both ends', () => {
  const entries = [entryMinutesAgo('at-min', 5), entryMinutesAgo('at-max', 90)];
  const selected = selectEntriesInWindow(entries, { nowMs: NOW, minAgeMs: 5 * 60 * 1000, maxAgeMs: 90 * 60 * 1000 });
  assert.deepEqual(selected.map(e => e.sha).sort(), ['at-max', 'at-min']);
});

test('selectEntriesInWindow: excludes entries with an unparseable timestamp', () => {
  const entries = [{ sha: 'bad-ts', ts: 'not-a-date' }];
  const selected = selectEntriesInWindow(entries, { nowMs: NOW, minAgeMs: 0, maxAgeMs: Infinity });
  assert.deepEqual(selected, []);
});

test('pruneToWindow: drops entries older than maxAgeMs', () => {
  const entries = [entryMinutesAgo('keep', 30), entryMinutesAgo('drop', 200)];
  const kept = pruneToWindow(entries, { nowMs: NOW, maxAgeMs: 90 * 60 * 1000 });
  assert.deepEqual(kept.map(e => e.sha), ['keep']);
});

test('pruneToWindow: drops entries with an unparseable timestamp', () => {
  const entries = [entryMinutesAgo('keep', 10), { sha: 'bad-ts', ts: 'nonsense' }];
  const kept = pruneToWindow(entries, { nowMs: NOW, maxAgeMs: 90 * 60 * 1000 });
  assert.deepEqual(kept.map(e => e.sha), ['keep']);
});

test('pruneToWindow: keeps everything when nothing is stale', () => {
  const entries = [entryMinutesAgo('a', 1), entryMinutesAgo('b', 2)];
  const kept = pruneToWindow(entries, { nowMs: NOW, maxAgeMs: 90 * 60 * 1000 });
  assert.equal(kept.length, 2);
});
