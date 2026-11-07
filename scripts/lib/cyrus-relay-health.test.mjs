import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessCyrusRelay } = require('./cyrus-relay-health.js');

const NOW = Date.parse('2026-08-15T12:00:00.000Z');
const fresh = (extra = {}) => ({
  ok: true,
  depth: 0,
  oldestAgeSeconds: 0,
  at: '2026-08-15T11:59:50.000Z',
  ...extra,
});

test('a healthy drain says nothing', () => {
  const r = assessCyrusRelay(fresh(), NOW);
  assert.equal(r.status, 'ok');
  assert.equal(r.message, null);
});

test('no status file is unknown, never an alarm', () => {
  // Machines that do not run Cyrus must not get a scary line in the digest.
  for (const absent of [null, undefined]) {
    const r = assessCyrusRelay(absent, NOW);
    assert.equal(r.status, 'unknown');
    assert.equal(r.message, null);
  }
});

test('a drain that stopped checking in is an error, with the restart command', () => {
  const r = assessCyrusRelay(fresh({ at: '2026-08-15T11:00:00.000Z' }), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /has not checked in for 60 min/);
  assert.match(r.message, /launchctl kickstart/);
});

test('a drain that cannot reach the relay reports the error text', () => {
  const r = assessCyrusRelay(fresh({ ok: false, error: 'drain GET 503: relay not configured' }), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /503/);
});

test('a backed-up queue warns with depth and age', () => {
  const r = assessCyrusRelay(fresh({ depth: 4, oldestAgeSeconds: 900 }), NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /4 webhooks stuck/);
  assert.match(r.message, /15 min/);
});

test('a queue below the backlog threshold stays quiet', () => {
  // Ordinary in-flight deliveries must not produce a daily false alarm.
  const r = assessCyrusRelay(fresh({ depth: 1, oldestAgeSeconds: 12 }), NOW);
  assert.equal(r.status, 'ok');
});

test('an unparseable timestamp is an error, not a silent pass', () => {
  const r = assessCyrusRelay(fresh({ at: 'not a date' }), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /unreadable/);
});
