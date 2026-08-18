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

test('strippedEnv: forwards the resolved claude binary\'s directory on PATH so a nested spawn resolves too', () => {
  const bin = resolveClaudeBin(process.env);
  if (!path.isAbsolute(bin)) return; // nothing resolved on this machine — augmentation is a no-op, nothing to assert
  const dir = path.dirname(bin);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin';
    const parts = strippedEnv().PATH.split(path.delimiter);
    assert.ok(parts.includes(dir), `strippedEnv().PATH must include ${dir}: got ${strippedEnv().PATH}`);
    assert.deepEqual(parts, [dir, '/usr/bin', '/bin'], 'resolved dir is prepended, original PATH order preserved');

    // Already present: must not duplicate.
    process.env.PATH = `${dir}:/usr/bin`;
    const parts2 = strippedEnv().PATH.split(path.delimiter);
    assert.equal(parts2.filter((p) => p === dir).length, 1, 'must not duplicate an already-present dir');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('resolveAuthEnv returns only auth keys and leaves process.env alone', () => {
  const before = { ...process.env };
  const got = resolveAuthEnv();
  for (const k of Object.keys(got)) assert.ok(AUTH_KEYS.includes(k), `unexpected key ${k}`);
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
});

// ---------------------------------------------------------------------------
// Task #1184 S1: stream-json parsing + killed-session cost estimation.
// `--output-format json` only emitted its envelope on a CLEAN exit, so every
// timed-out fix session left no session id (unresumable) and no cost (spend
// breaker read $0). These pure helpers are what runClaudeCli now folds the
// stream through; event shapes verified against the real CLI 2026-08-10.
// ---------------------------------------------------------------------------
import { parseStreamLine, addUsage, estimateCostUSD } from './claude-cli.js';

test('parseStreamLine: captures session_id from ANY event (it arrives on the first one)', () => {
  const ev = parseStreamLine('{"type":"system","subtype":"init","session_id":"abc-123"}');
  assert.equal(ev.sessionId, 'abc-123');
  assert.equal(ev.result, null);
});

test('parseStreamLine: assistant events carry per-message usage', () => {
  const ev = parseStreamLine(JSON.stringify({
    type: 'assistant', session_id: 's', message: { usage: { input_tokens: 10, output_tokens: 4 } },
  }));
  assert.deepEqual(ev.usage, { input_tokens: 10, output_tokens: 4 });
});

test('parseStreamLine: result event maps to the old envelope fields', () => {
  const ev = parseStreamLine(JSON.stringify({
    type: 'result', subtype: 'success', session_id: 's1', result: 'pong',
    total_cost_usd: 0.05, usage: { output_tokens: 42 },
  }));
  assert.equal(ev.result.resultText, 'pong');
  assert.equal(ev.result.sessionId, 's1');
  assert.equal(ev.result.costUSD, 0.05);
});

test('parseStreamLine: corrupt/blank lines return null (SIGKILL can sever the last line)', () => {
  assert.equal(parseStreamLine(''), null);
  assert.equal(parseStreamLine('{"type":"resu'), null);
});

test('parseStreamLine: legacy typeless single-envelope (old --output-format json / fake-claude test binaries) parses as a result event', () => {
  // P0 task #1231: the stream-json switch made this shape a parse-error and
  // broke runMonitorPass against its fake claude on main.
  const ev = parseStreamLine(JSON.stringify({
    is_error: false, result: 'pass complete', session_id: 'fake-session-123',
    total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 },
  }));
  assert.equal(ev.result.resultText, 'pass complete');
  assert.equal(ev.result.sessionId, 'fake-session-123');
  assert.equal(ev.result.costUSD, 0.0123);
  assert.equal(ev.sessionId, 'fake-session-123');
});

test('addUsage accumulates across assistant events, starting from null', () => {
  let t = addUsage(null, { input_tokens: 10, output_tokens: 5 });
  t = addUsage(t, { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 100 });
  assert.equal(t.input_tokens, 30);
  assert.equal(t.output_tokens, 12);
  assert.equal(t.cache_read_input_tokens, 100);
});

test('estimateCostUSD: null without usage; opus > sonnet; unknown model estimates as sonnet', () => {
  assert.equal(estimateCostUSD(null, 'sonnet'), null);
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000 };
  const sonnet = estimateCostUSD(usage, 'sonnet');
  const opus = estimateCostUSD(usage, 'opus');
  assert.ok(sonnet > 0);
  assert.ok(opus > sonnet, 'opus rate must exceed sonnet');
  assert.equal(estimateCostUSD(usage, 'mystery-model'), sonnet, 'unknown model falls back to sonnet rates');
});

// ---------------------------------------------------------------------------
// Task #1768: spawn('claude', ...) resolved the binary by bare name through
// PATH, and launchd-parented plists carry a minimal PATH with no
// ~/.local/bin — 9 ENOENT spawn failures across 8 days. resolveClaudeBin()
// replaces PATH lookup with explicit resolution. These tests build FAKE
// candidate locations under a tmpdir (never assert against this machine's
// real ~/.local/bin/claude) so they hold on CI runners too, where no
// `claude` binary is installed at all.
// ---------------------------------------------------------------------------
import { resolveClaudeBin } from './claude-cli.js';

function fakeExecutable(dir, relPath) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '#!/bin/sh\necho fake\n');
  fs.chmodSync(full, 0o755);
  return full;
}

test('resolveClaudeBin: returns an absolute, existing, executable path under a minimal-PATH env with only ~/.local/bin/claude present', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
  const expected = fakeExecutable(home, '.local/bin/claude');

  const got = resolveClaudeBin({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home });

  assert.equal(got, expected);
  assert.ok(path.isAbsolute(got), 'must be an absolute path, not a bare name');
  assert.ok(fs.existsSync(got));
  assert.doesNotThrow(() => fs.accessSync(got, fs.constants.X_OK));
});

test('resolveClaudeBin: env.CLAUDE_BIN wins over the candidate list when executable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
  fakeExecutable(home, '.local/bin/claude'); // present but should be skipped
  const override = fakeExecutable(home, 'custom/claude');

  const got = resolveClaudeBin({ HOME: home, CLAUDE_BIN: override });

  assert.equal(got, override);
});

test('resolveClaudeBin: a stale/garbage CLAUDE_BIN fails open — falls through to the candidate list', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
  const expected = fakeExecutable(home, '.local/bin/claude');

  const got = resolveClaudeBin({ HOME: home, CLAUDE_BIN: '/no/such/binary' });

  assert.equal(got, expected);
});

test('resolveClaudeBin: falls back to the bare string "claude" when nothing resolves (never regress a working PATH)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-empty-'));

  // Empty candidate list injected explicitly — this machine's real global
  // candidates (e.g. /Applications/cmux.app/.../claude) would otherwise
  // resolve and make this "nothing found" case untestable in dev.
  const got = resolveClaudeBin({ HOME: home }, []);

  assert.equal(got, 'claude');
});

test('resolveClaudeBin: a DIRECTORY named claude never shadows a real binary later in the list', () => {
  // fs.accessSync(dir, X_OK) succeeds on any directory with search permission,
  // so an accessSync-only check selects the directory and then dies EACCES at
  // spawn — pointing at the wrong cause. Verified 2026-08-18; regression guard
  // for the ship-check finding on task #1768.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-dir-'));
  const decoy = path.join(dir, 'claude');
  fs.mkdirSync(decoy);                       // a DIRECTORY, not a file
  const real = path.join(dir, 'real-claude');
  fs.writeFileSync(real, '#!/bin/sh\necho ok\n');
  fs.chmodSync(real, 0o755);

  // Decoy first in preference order — it must be skipped, not selected.
  const got = resolveClaudeBin({ HOME: dir }, [decoy, real]);

  assert.equal(got, real, 'directory candidate must be skipped in favour of the real executable');
});

test('resolveClaudeBin: HOME missing from env still resolves (same os.homedir() fallback as strippedEnv)', () => {
  const got = resolveClaudeBin({});
  assert.ok(typeof got === 'string' && got.length > 0);
});

// ── task #1768 ship-check follow-ups (Codex + gpt-5.4-mini, 2026-08-18) ─────
import { pathWithClaudeBinDir } from './claude-cli.js';

test('resolveClaudeBin: a RELATIVE CLAUDE_BIN is rejected, not silently honoured', () => {
  // A relative pin resolves against the cwd, which differs per dispatch —
  // honouring it would run a different binary depending on where the job ran.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-rel-'));
  const real = path.join(dir, 'claude');
  fs.writeFileSync(real, '#!/bin/sh\necho ok\n');
  fs.chmodSync(real, 0o755);

  const got = resolveClaudeBin({ HOME: dir, CLAUDE_BIN: './claude' }, [real]);

  assert.equal(got, real, 'relative CLAUDE_BIN must fall through to candidate probing');
});

test('resolveClaudeBin: an unusable CLAUDE_BIN pin still falls through (fail open, never fail closed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-stale-'));
  const real = path.join(dir, 'claude');
  fs.writeFileSync(real, '#!/bin/sh\necho ok\n');
  fs.chmodSync(real, 0o755);

  const got = resolveClaudeBin({ HOME: dir, CLAUDE_BIN: '/nonexistent/claude' }, [real]);

  assert.equal(got, real, 'a stale pin must not take the dispatcher down');
});

test('pathWithClaudeBinDir: prepends the resolved binary dir and never duplicates it', () => {
  const out = pathWithClaudeBinDir('/usr/bin:/bin');
  const parts = out.split(path.delimiter).filter(Boolean);

  assert.ok(parts.includes('/usr/bin'), 'existing PATH entries are preserved');
  assert.equal(parts.length, new Set(parts).size, 'no duplicate PATH entries');

  // Idempotent: feeding its own output back must not grow the PATH.
  assert.equal(pathWithClaudeBinDir(out), out, 'must be idempotent');
});
