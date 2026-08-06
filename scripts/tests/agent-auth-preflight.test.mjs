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

test('formatPreflightResult: oauth mode is ok, exit 0, stdout line is MODE=oauth', () => {
  const r = formatPreflightResult({ ok: true, mode: 'oauth' });
  assert.equal(r.exitCode, 0);
  assert.match(r.stderrMessage, /ok \(mode=oauth\)/);
  assert.equal(r.stdoutLine, 'MODE=oauth');
});

test('formatPreflightResult: api-key fallback mode is still ok, exit 0, stdout line is MODE=api-key', () => {
  const r = formatPreflightResult({ ok: true, mode: 'api-key' });
  assert.equal(r.exitCode, 0);
  assert.match(r.stderrMessage, /mode=api-key/);
  assert.equal(r.stdoutLine, 'MODE=api-key');
});

test('formatPreflightResult: a revoked/failed credential refuses with exit 1, the detail, and no stdout line', () => {
  const r = formatPreflightResult({ ok: false, mode: 'fail', detail: 'OAuth access token has been revoked' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderrMessage, /REFUSING/);
  assert.match(r.stderrMessage, /OAuth access token has been revoked/);
  assert.match(r.stderrMessage, /claude auth login/); // repair hint present
  assert.equal(r.stdoutLine, null); // a bash `AUTH_MODE=$(...)` caller must never see a fake mode on failure
});

test('formatPreflightResult: missing detail still refuses clearly rather than throwing', () => {
  const r = formatPreflightResult({ ok: false, mode: 'fail' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderrMessage, /no working credential/);
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

test('main(): stdout carries exactly one MODE= line on success — a bash `VAR=$(...)` caller must get a clean value', () => {
  const logged = [];
  const origLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const exitCode = main([], { preflightAuthFn: () => ({ ok: true, mode: 'api-key' }) });
    assert.equal(exitCode, 0);
    assert.deepEqual(logged, ['MODE=api-key']);
  } finally {
    console.log = origLog;
  }
});

test('main(): stdout is empty on failure — a bash `VAR=$(...)` caller never captures a fake mode', () => {
  const logged = [];
  const origLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const exitCode = main([], { preflightAuthFn: () => ({ ok: false, mode: 'fail', detail: 'revoked' }) });
    assert.equal(exitCode, 1);
    assert.deepEqual(logged, []);
  } finally {
    console.log = origLog;
  }
});
