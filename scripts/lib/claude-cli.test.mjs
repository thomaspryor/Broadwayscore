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

// ---------------------------------------------------------------------------
// Task #713 auth containment (2026-08-01). Two bugs guarded here:
//
// 1. The ORIGINAL #713 bug: under launchd, process.env carries only the plist's
//    EnvironmentVariables block, so neither auth key was set, nothing was
//    forwarded, and every headless dispatch died exit-1 with the envelope
//    result "Not logged in · Please run /login".
// 2. The FIX'S OWN P0 (Codex review of commit fc4999cfc71): the first attempt
//    called loadEnv(), which publishes ALL 75 .env keys to the global
//    process.env — so Resend/Notion/scraper secrets would leak into any later
//    non-stripped spawn in the same process, defeating the containment
//    strippedEnv exists to provide. The replacement reads ONLY the two auth
//    keys into a LOCAL object and never writes process.env.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strippedEnv, resolveAuthEnv, AUTH_KEYS } from './claude-cli.js';
import { createRequire as _cr } from 'node:module';
const _require = _cr(import.meta.url);
// require() the REAL reader — never a copy of its logic (CLAUDE.md rule 15).
const { readEnvKeys, parseEnvFile } = _require('./load-env.js');

function tmpEnv(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-auth-'));
  fs.writeFileSync(path.join(dir, '.env'), contents);
  return dir;
}

test('parseEnvFile: handles export prefix, quotes, comments and BOM', () => {
  const parsed = parseEnvFile('﻿# comment\nexport A=1\nB="two"\nC=\'three\'\n\nD\nE=\n');
  assert.equal(parsed.A, '1');
  assert.equal(parsed.B, 'two');
  assert.equal(parsed.C, 'three');
  assert.equal(parsed.E, '');
  assert.ok(!('D' in parsed), 'a line with no = is not a key');
  assert.ok(!('# comment' in parsed));
});

test('readEnvKeys returns ONLY the requested keys — never the rest of .env', () => {
  const dir = tmpEnv('ANTHROPIC_API_KEY=sk-ant-test\nRESEND_API_KEY=re_secret\nNOTION_TOKEN=ntn_secret\n');
  delete process.env.ANTHROPIC_API_KEY;

  const got = readEnvKeys(['ANTHROPIC_API_KEY'], dir);

  assert.deepEqual(Object.keys(got), ['ANTHROPIC_API_KEY']);
  assert.equal(got.ANTHROPIC_API_KEY, 'sk-ant-test');
  assert.ok(!('RESEND_API_KEY' in got));
  assert.ok(!('NOTION_TOKEN' in got));
});

test('readEnvKeys NEVER mutates process.env (the loadEnv leak this replaced)', () => {
  const dir = tmpEnv('ANTHROPIC_API_KEY=sk-ant-test\nRESEND_API_KEY=re_secret\nNOTION_TOKEN=ntn_secret\n');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTION_TOKEN;

  readEnvKeys(['ANTHROPIC_API_KEY'], dir);

  assert.equal(process.env.ANTHROPIC_API_KEY, undefined, 'must not publish even the key it read');
  assert.equal(process.env.RESEND_API_KEY, undefined, 'must not publish unrelated secrets');
  assert.equal(process.env.NOTION_TOKEN, undefined, 'must not publish unrelated secrets');
});

test('readEnvKeys: a non-empty process.env value wins, an EMPTY one is topped up', () => {
  const dir = tmpEnv('ANTHROPIC_API_KEY=from-dotenv\nCLAUDE_CODE_OAUTH_TOKEN=tok-from-dotenv\n');
  process.env.ANTHROPIC_API_KEY = 'from-real-env'; // CI injects real secrets via env:
  process.env.CLAUDE_CODE_OAUTH_TOKEN = '';        // launchd/CI can export FOO= blank

  const got = readEnvKeys(AUTH_KEYS, dir);

  assert.ok(!('ANTHROPIC_API_KEY' in got), 'a real env secret must never be shadowed by .env');
  assert.equal(got.CLAUDE_CODE_OAUTH_TOKEN, 'tok-from-dotenv', 'blank counts as absent');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

test('strippedEnv forwards ONLY the allow-list — no .env key can widen it', () => {
  const allowed = new Set(['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', ...AUTH_KEYS]);
  const leaked = Object.keys(strippedEnv()).filter((k) => !allowed.has(k));
  assert.deepEqual(leaked, [], `strippedEnv leaked non-allow-listed vars: ${leaked.join(', ')}`);
});

test('strippedEnv: caller `extra` still beats the .env top-up (preflight oauth shape)', () => {
  // preflightAuth proves the oauth path by spawning with ANTHROPIC_API_KEY:'',
  // and the real spawn must be able to reproduce that exact shape — a .env
  // value re-populating it would make the probe prove nothing.
  assert.equal(strippedEnv({ ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY, '');
});

test('resolveAuthEnv returns only auth keys and leaves process.env alone', () => {
  const before = { ...process.env };
  const got = resolveAuthEnv();
  for (const k of Object.keys(got)) assert.ok(AUTH_KEYS.includes(k), `unexpected key ${k}`);
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
});
