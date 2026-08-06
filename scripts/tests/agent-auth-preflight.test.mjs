/**
 * agent-auth-preflight.test.mjs — task #1107.
 *
 * Six LaunchAgents embedded a session OAuth token snapshot directly in their
 * plist; every snapshot rotated out from under automation and the jobs ran
 * blind, producing nothing, reporting nothing. scripts/claude-auth-preflight.js
 * gives each wrapper a cheap exit-code gate before spawning `claude` for
 * real. CLAUDE.md §15: require() the real module, inject preflightAuth via
 * the opts param rather than mocking child_process — no real `claude` spawn,
 * no network call, no billing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main, formatPreflightResult } = require('../claude-auth-preflight.js');

test('formatPreflightResult: oauth mode is ok, exit 0', () => {
  const r = formatPreflightResult({ ok: true, mode: 'oauth' });
  assert.equal(r.exitCode, 0);
  assert.match(r.message, /ok \(mode=oauth\)/);
});

test('formatPreflightResult: api-key fallback mode is still ok, exit 0', () => {
  const r = formatPreflightResult({ ok: true, mode: 'api-key' });
  assert.equal(r.exitCode, 0);
  assert.match(r.message, /mode=api-key/);
});

test('formatPreflightResult: a revoked/failed credential refuses with exit 1 and the detail', () => {
  const r = formatPreflightResult({ ok: false, mode: 'fail', detail: 'OAuth access token has been revoked' });
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /REFUSING/);
  assert.match(r.message, /OAuth access token has been revoked/);
  assert.match(r.message, /claude auth login/); // repair hint present
});

test('formatPreflightResult: missing detail still refuses clearly rather than throwing', () => {
  const r = formatPreflightResult({ ok: false, mode: 'fail' });
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /no working credential/);
});

test('main(): a deliberately revoked token makes the job abort loudly (exit 1), never runs blind', () => {
  let called = false;
  const exitCode = main([], {
    preflightAuthFn: () => {
      called = true;
      return { ok: false, mode: 'fail', detail: '401 OAuth access token has been revoked' };
    },
  });
  assert.equal(called, true);
  assert.equal(exitCode, 1);
});

test('main(): a working credential (either mode) lets the job proceed (exit 0)', () => {
  const exitCode = main([], {
    preflightAuthFn: () => ({ ok: true, mode: 'oauth' }),
  });
  assert.equal(exitCode, 0);
});

test('main(): --help prints usage and exits 0 WITHOUT probing (never spends on --help)', () => {
  let called = false;
  const exitCode = main(['--help'], {
    preflightAuthFn: () => { called = true; return { ok: true, mode: 'oauth' }; },
  });
  assert.equal(called, false);
  assert.equal(exitCode, 0);
});

test('main(): -h is recognized the same as --help', () => {
  let called = false;
  const exitCode = main(['-h'], { preflightAuthFn: () => { called = true; return { ok: true }; } });
  assert.equal(called, false);
  assert.equal(exitCode, 0);
});
