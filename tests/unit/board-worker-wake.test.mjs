// BRO-6715: waking the board worker is fail-soft and only calls the one allowed URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wakeBoardWorker } = require('../../scripts/lib/board-worker-wake.js');
const URL_OK = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef/fire';

test('not configured: nothing is called', async () => {
  let called = false;
  const r = await wakeBoardWorker({ env: {}, fetchImpl: async () => { called = true; } });
  assert.deepEqual([r.fired, r.why, called], [false, 'not-configured', false]);
});

test('a URL that is not the routine fire endpoint is refused before any request', async () => {
  let called = false;
  const r = await wakeBoardWorker({ env: { BOARD_WORKER_FIRE_URL: 'https://evil.example/fire', BOARD_WORKER_FIRE_TOKEN: 't' }, fetchImpl: async () => { called = true; } });
  assert.deepEqual([r.fired, r.why, called], [false, 'bad-url', false]);
});

test('fires with bearer token and the beta header, returns the session link', async () => {
  let seen;
  const r = await wakeBoardWorker({ env: { BOARD_WORKER_FIRE_URL: URL_OK, BOARD_WORKER_FIRE_TOKEN: 'sk-ant-oat01-x' }, reason: 'BRO-1',
    fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_1' }) }; } });
  assert.equal(r.fired, true);
  assert.equal(r.session, 'https://claude.ai/code/session_1');
  assert.equal(seen.u, URL_OK);
  assert.equal(seen.o.headers.Authorization, 'Bearer sk-ant-oat01-x');
  assert.equal(seen.o.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
});

test('http errors and thrown errors come back as not fired, never throw', async () => {
  const env = { BOARD_WORKER_FIRE_URL: URL_OK, BOARD_WORKER_FIRE_TOKEN: 't' };
  assert.equal((await wakeBoardWorker({ env, fetchImpl: async () => ({ ok: false, status: 429 }) })).why, 'http-429');
  assert.match((await wakeBoardWorker({ env, fetchImpl: async () => { throw new Error('boom'); } })).why, /^error: boom/);
});

test('debounce: another successful wake run in the window skips; the current run and errors do not', async () => {
  const { recentWakeRun } = require('../../scripts/lib/board-worker-wake.js');
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', GITHUB_RUN_ID: '100' };
  const ok = (runs) => async () => ({ ok: true, json: async () => ({ workflow_runs: runs }) });
  assert.equal((await recentWakeRun({ env, fetchImpl: ok([{ id: 99, created_at: 'x' }]) })).id, 99);
  assert.equal(await recentWakeRun({ env, fetchImpl: ok([{ id: 100 }]) }), null, 'this run does not count');
  assert.equal(await recentWakeRun({ env, fetchImpl: ok([]) }), null);
  assert.equal(await recentWakeRun({ env, fetchImpl: async () => ({ ok: false }) }), null, 'fail-open');
  assert.equal(await recentWakeRun({ env, fetchImpl: async () => { throw new Error('x'); } }), null, 'fail-open');
  assert.equal(await recentWakeRun({ env: {}, fetchImpl: ok([{ id: 1 }]) }), null, 'no token, no check');
});

test('requestWake only dispatches inside GitHub Actions and never throws', async () => {
  const { requestWake } = require('../../scripts/lib/board-worker-wake.js');
  let calls = 0;
  const fetchImpl = async (u, o) => { calls++; assert.match(u, /actions\/workflows\/board-worker-wake\.yml\/dispatches$/); return { ok: true }; };
  assert.equal((await requestWake({ env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, fetchImpl })).why, 'not-in-actions');
  assert.equal(calls, 0, 'a dev machine or a unit test never starts a run');
  assert.equal((await requestWake({ env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, fetchImpl })).why, 'not-in-actions', 'opt-in flag required');
  assert.equal(calls, 0);
  const env = { BOARD_WORKER_WAKE_ENABLED: 'true', GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
  assert.equal((await requestWake({ env, fetchImpl, reason: 'BRO-1' })).requested, true);
  assert.equal((await requestWake({ env, fetchImpl: async () => ({ ok: false, status: 403 }) })).why, 'http-403');
  assert.match((await requestWake({ env, fetchImpl: async () => { throw new Error('net'); } })).why, /^error: net/);
});
