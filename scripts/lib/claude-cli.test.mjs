// Sprint 0 (task #713/#721): resolvePassAuth is the pure decision extracted
// from opening-night-monitor-launch.js's original auth-fallback logic, now
// generalized into claude-cli.js so notion-action-poll.js can share it.
// require()d directly per CLAUDE.md rule 15 — never re-implemented here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePassAuth } from './claude-cli.js';

test('resolvePassAuth: stored login OK wins regardless of API key state', () => {
  assert.deepEqual(
    resolvePassAuth({ storedLoginOk: true, apiKeyPresent: true, apiKeyPingOk: false }),
    { mode: 'oauth' }
  );
  assert.deepEqual(
    resolvePassAuth({ storedLoginOk: true, apiKeyPresent: false, apiKeyPingOk: false }),
    { mode: 'oauth' }
  );
});

test('resolvePassAuth: falls back to api-key only when the key is present AND pings ok', () => {
  assert.deepEqual(
    resolvePassAuth({ storedLoginOk: false, apiKeyPresent: true, apiKeyPingOk: true }),
    { mode: 'api-key' }
  );
});

test('resolvePassAuth: fails closed when stored login is down and the key is absent or unpingable', () => {
  assert.deepEqual(
    resolvePassAuth({ storedLoginOk: false, apiKeyPresent: false, apiKeyPingOk: false }),
    { mode: 'fail' }
  );
  assert.deepEqual(
    resolvePassAuth({ storedLoginOk: false, apiKeyPresent: true, apiKeyPingOk: false }),
    { mode: 'fail' }
  );
});
