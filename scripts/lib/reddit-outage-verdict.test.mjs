import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { redditOutageVerdict } = createRequire(import.meta.url)('./reddit-dispatch-cooldown.js');
const now = Date.parse('2026-11-11T06:00:00Z');
const row = (iso, host = 'reddit.com') => ({ ts: iso, host });
const many = (n, iso) => Array.from({ length: n }, () => row(iso));
test('calls after the last write with no new write = outage', () => {
  const v = redditOutageVerdict({ lastWriteMs: Date.parse('2026-11-09T03:40:00Z'), rows: many(12, '2026-11-10T20:00:00Z'), nowMs: now });
  assert.equal(v.outage, true);
});
test('few calls is not an outage', () => {
  assert.equal(redditOutageVerdict({ lastWriteMs: 0, rows: many(3, '2026-11-10T20:00:00Z'), nowMs: now }).outage, false);
});
test('calls before the last write do not count (a fresh write resolves)', () => {
  const v = redditOutageVerdict({ lastWriteMs: Date.parse('2026-11-11T05:00:00Z'), rows: many(40, '2026-11-10T20:00:00Z'), nowMs: now });
  assert.equal(v.outage, false);
});
test('other hosts ignored', () => {
  assert.equal(redditOutageVerdict({ lastWriteMs: null, rows: Array.from({ length: 30 }, () => row('2026-11-10T20:00:00Z', 'broadwayworld.com')), nowMs: now }).outage, false);
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('readRedditLedgerRows finds Reddit rows even when the file tail is out of time order', () => {
  const { readRedditLedgerRows } = createRequire(import.meta.url)('./reddit-dispatch-cooldown.js');
  const f = path.join(os.tmpdir(), `rd-ledger-${process.pid}.jsonl`);
  const lines = [JSON.stringify({ ts: '2026-11-10T20:00:00Z', host: 'reddit.com' })];
  for (let i = 0; i < 5000; i++) lines.push(JSON.stringify({ ts: i === 0 ? '2026-11-01T00:00:00Z' : '2026-11-11T00:00:00Z', host: 'x.com' }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.equal(readRedditLedgerRows(f).length, 1);
  fs.unlinkSync(f);
});
