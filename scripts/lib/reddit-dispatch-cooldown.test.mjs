import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const c = require('./reddit-dispatch-cooldown.js');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const row = (hoursAgo, success, extra = {}) => ({
  ts: new Date(NOW - hoursAgo * 3600e3).toISOString(),
  provider: 'scrapingbee', host: 'reddit.com', success, status: success ? 200 : 'timeout', ...extra,
});
const fails = (n, startH = 1) => Array.from({ length: n }, (_, i) => row(startH + i * 0.1, false));

test('host verdict protects other hosts and isolates null-host evidence', () => {
  const rows = fails(6).map(r => ({ ...r, host: 'realmericanmedia.com' }));
  assert.equal(c.sbHostVerdict(rows, { host: 'realmericanmedia.com', nowMs: NOW }).allowed, false);
  assert.equal(c.sbHostVerdict(rows, { host: 'broadwayworld.com', nowMs: NOW }).allowed, true);
  const missing = fails(6).map(r => ({ ...r, host: null }));
  assert.equal(c.sbHostVerdict(missing, { host: null, nowMs: NOW }).allowed, false);
  assert.equal(c.sbHostVerdict(missing, { host: 'realmericanmedia.com', nowMs: NOW }).allowed, true);
});

test('host verdict normalizes www/case, ignores skips and preserves working hosts', () => {
  const rows = fails(6).map(r => ({ ...r, host: 'www.Example.com' }));
  assert.equal(c.sbHostVerdict(rows, { host: 'example.com', nowMs: NOW }).allowed, false);
  assert.equal(c.sbHostVerdict([...rows, row(10, true, { host: 'example.com' })], { host: 'example.com', nowMs: NOW }).allowed, true);
  const skips = rows.map(r => ({ ...r, status: 'run-memo-skip', credits: 0 }));
  assert.equal(c.sbHostVerdict(skips, { host: 'example.com', nowMs: NOW }).allowed, true);
  assert.equal(c.sbHostVerdict(rows.map(r => ({ ...r, ts: new Date(NOW + 1).toISOString() })), { host: 'example.com', nowMs: NOW }).allowed, true);
});

test('other-host failed probe re-arms, success reopens, and old rows expire', () => {
  const rows = fails(6, 7).map(r => ({ ...r, host: 'example.com' }));
  const verdict = data => c.sbHostVerdict(data, { host: 'example.com', nowMs: NOW });
  assert.equal(verdict(rows).probe, true);
  assert.equal(verdict([...rows, row(0.1, false, { host: 'example.com' })]).allowed, false);
  assert.equal(verdict([...rows, row(0.1, true, { host: 'example.com' })]).allowed, true);
  assert.equal(verdict(rows.map(r => ({ ...r, ts: new Date(NOW - 49 * 3600e3).toISOString() }))).probe, false);
});

test('too few SB calls: allowed', () => {
  const v = c.sbRedditVerdict(fails(5), { nowMs: NOW });
  assert.equal(v.allowed, true);
  assert.equal(v.probe, false);
});

test('window of failures, newest recent: cooling down', () => {
  const v = c.sbRedditVerdict(fails(10), { nowMs: NOW });
  assert.equal(v.allowed, false);
});

test('one success inside the window reopens the leg', () => {
  const rows = [...fails(5), row(1.2, true)];
  assert.equal(c.sbRedditVerdict(rows, { nowMs: NOW }).allowed, true);
});

test('failures older than the probe delay: one probe is allowed', () => {
  const v = c.sbRedditVerdict(fails(6, 7), { nowMs: NOW });
  assert.equal(v.allowed, true);
  assert.equal(v.probe, true);
});

test('rows outside 48h, other providers, other hosts and budget_capped rows are ignored', () => {
  const noise = [
    ...fails(10, 60),
    ...fails(10).map((r) => ({ ...r, provider: 'scrapingdog' })),
    ...fails(10).map((r) => ({ ...r, host: 'playbill.com' })),
    ...fails(10).map((r) => ({ ...r, status: 'budget_capped' })),
  ];
  assert.equal(c.sbRedditVerdict(noise, { nowMs: NOW }).allowed, true);
});

test('failed probe re-arms the cooldown (new fresh failure row)', () => {
  const rows = [...fails(6, 8), row(0.1, false)];
  assert.equal(c.sbRedditVerdict(rows, { nowMs: NOW }).allowed, false);
});

test('in-run breaker opens at the limit', () => {
  assert.equal(c.sbRunBreakerOpen(c.SB_RUN_FAILURE_LIMIT - 1), false);
  assert.equal(c.sbRunBreakerOpen(c.SB_RUN_FAILURE_LIMIT), true);
});

test('stale verdict: old write + recent attempts = stale; idle scraper = not stale', () => {
  const old = NOW - 60 * 3600e3;
  assert.equal(c.redditStaleVerdict({ lastWriteMs: old, attemptsInWindow: 40, nowMs: NOW }).stale, true);
  assert.equal(c.redditStaleVerdict({ lastWriteMs: old, attemptsInWindow: 0, nowMs: NOW }).stale, false);
  assert.equal(c.redditStaleVerdict({ lastWriteMs: NOW - 3600e3, attemptsInWindow: 40, nowMs: NOW }).stale, false);
  assert.equal(c.redditStaleVerdict({ lastWriteMs: null, attemptsInWindow: 1, nowMs: NOW }).stale, true);
});

test('readLedgerTail skips the torn first line and bad rows', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'l.jsonl');
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ ts: new Date(NOW).toISOString(), i }));
  lines.splice(10, 0, '{not json');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const rows = c.readLedgerTail(f, { sinceMs: NOW - 3600e3, chunk: 300 });
  assert.equal(rows.length, 50); // window never reached, so the whole file; torn line dropped
  assert.ok(rows.every((r) => Number.isInteger(r.i)));
  assert.equal(rows[rows.length - 1].i, 49);
  assert.deepEqual(c.readLedgerTail('/nonexistent/file'), []);
});

test('readLedgerTail keeps reading back until it covers the time window', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'l.jsonl');
  // 200 rows, one per minute ending at NOW; a 300-byte chunk covers ~3 of them
  const lines = Array.from({ length: 200 }, (_, i) =>
    JSON.stringify({ ts: new Date(NOW - (199 - i) * 60e3).toISOString(), i }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const rows = c.readLedgerTail(f, { sinceMs: NOW - 120 * 60e3, chunk: 300 });
  assert.ok(Date.parse(rows[0].ts) < NOW - 120 * 60e3, 'oldest row predates the window');
  assert.equal(rows[rows.length - 1].i, 199);
  // whole file when the window is older than everything
  assert.equal(c.readLedgerTail(f, { sinceMs: NOW - 1e9, chunk: 300 }).length, 200);
});

test('idle verdict is flagged so the caller leaves an open incident alone', () => {
  const v = c.redditStaleVerdict({ lastWriteMs: NOW - 60 * 3600e3, attemptsInWindow: 0, nowMs: NOW });
  assert.equal(v.idle, true);
  assert.equal(v.stale, false);
});
