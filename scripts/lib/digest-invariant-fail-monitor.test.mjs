/**
 * Task #1648: pins that a recorded digest content-invariant FAIL becomes a
 * visible health.errors row instead of the exit-code-with-no-consumer gap
 * card #1641 left behind. Also pins the BRO-231 / task #1221 absent-vs-empty
 * contract: a gitignored/absent ledger must report 'warn' (cannot verify),
 * never a vacuous 'pass'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessDigestInvariantFailRow, NAME } = require('./digest-invariant-fail-monitor.js');

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const at = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const rec = (h, violations = ['forbidden section reappeared']) => ({
  ts: at(h), violations,
});

test('null entries (ledger absent/unreadable) -> warn, never a false pass', () => {
  const r = assessDigestInvariantFailRow(null, { now: NOW });
  assert.equal(r.name, NAME);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /absent here/);
});

test('empty array (ledger present, genuinely clean) -> pass', () => {
  const r = assessDigestInvariantFailRow([], { now: NOW });
  assert.equal(r.status, 'pass');
});

test('a FAIL recorded within the window -> error, with the violation text surfaced', () => {
  const r = assessDigestInvariantFailRow([rec(20, ['forbidden section reappeared: triage'])], { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /1 digest content-invariant FAIL/);
  assert.match(r.message, /forbidden section reappeared: triage/);
});

test('multiple FAILs in window -> error, count reflected', () => {
  const r = assessDigestInvariantFailRow([rec(60), rec(20)], { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /2 digest content-invariant FAIL/);
});

test('FAIL older than the 3-day window is excluded -> pass', () => {
  const r = assessDigestInvariantFailRow([rec(4 * 24)], { now: NOW });
  assert.equal(r.status, 'pass');
});

test('a record exactly at the 3-day cutoff is still counted', () => {
  const r = assessDigestInvariantFailRow([rec(3 * 24)], { now: NOW });
  assert.equal(r.status, 'error');
});

test('a record with an unparseable ts is ignored, not counted', () => {
  const r = assessDigestInvariantFailRow([{ ts: 'not-a-date', violations: ['x'] }], { now: NOW });
  assert.equal(r.status, 'pass');
});

test('a record with no violations array falls back to a generic message', () => {
  const r = assessDigestInvariantFailRow([{ ts: at(1) }], { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /unspecified violation/);
});
