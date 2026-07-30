import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// require() the REAL loader — never a copy of its logic (CLAUDE.md rule 15).
const { loadEnv } = require('../../scripts/lib/load-env.js');

function tmpRepo(envContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-env-'));
  if (envContents !== null) fs.writeFileSync(path.join(dir, '.env'), envContents);
  return dir;
}

// The bug this guards: launchd gives the job only PATH/HOME/CLAUDE_CODE_OAUTH_TOKEN,
// so RESEND_API_KEY was undefined and every escalation email was silently dropped.
test('loadEnv populates keys that launchd would not have provided', () => {
  const dir = tmpRepo('RESEND_API_KEY=re_test_123\nOWNER_EMAIL=owner@example.com\n');
  delete process.env.RESEND_API_KEY;
  delete process.env.OWNER_EMAIL;

  const res = loadEnv(dir);

  assert.equal(res.loaded, true);
  assert.equal(process.env.RESEND_API_KEY, 're_test_123');
  assert.equal(process.env.OWNER_EMAIL, 'owner@example.com');
  assert.deepEqual(res.keys.sort(), ['OWNER_EMAIL', 'RESEND_API_KEY']);

  delete process.env.RESEND_API_KEY;
  delete process.env.OWNER_EMAIL;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnv never clobbers a NON-EMPTY value already in process.env (CI secrets win)', () => {
  const dir = tmpRepo('LOADENV_CI_KEY=from_dotenv\n');
  process.env.LOADENV_CI_KEY = 'from_ci';

  const res = loadEnv(dir);

  assert.equal(process.env.LOADENV_CI_KEY, 'from_ci');
  assert.ok(!res.keys.includes('LOADENV_CI_KEY'), 'must not report keys it did not set');

  delete process.env.LOADENV_CI_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

// launchd/CI can export FOO= with no value. Treating that as "already set" would
// leave the credential blank — the exact silent failure this file exists to stop.
test('loadEnv DOES fill an empty-string env var from .env', () => {
  const dir = tmpRepo('LOADENV_EMPTY_KEY=real_value\n');
  process.env.LOADENV_EMPTY_KEY = '';

  const res = loadEnv(dir);

  assert.equal(process.env.LOADENV_EMPTY_KEY, 'real_value');
  assert.ok(res.keys.includes('LOADENV_EMPTY_KEY'));

  delete process.env.LOADENV_EMPTY_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnv strips a UTF-8 BOM so the first key is not mangled', () => {
  const dir = tmpRepo('﻿LOADENV_BOM_KEY=bom_value\n');
  delete process.env.LOADENV_BOM_KEY;
  loadEnv(dir);
  assert.equal(process.env.LOADENV_BOM_KEY, 'bom_value');
  assert.equal(process.env['﻿LOADENV_BOM_KEY'], undefined);
  delete process.env.LOADENV_BOM_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnv handles `export KEY=value` (shell-sourceable .env)', () => {
  const dir = tmpRepo('export LOADENV_EXPORT_KEY=exported\n');
  delete process.env.LOADENV_EXPORT_KEY;
  loadEnv(dir);
  assert.equal(process.env.LOADENV_EXPORT_KEY, 'exported');
  assert.equal(process.env['export LOADENV_EXPORT_KEY'], undefined);
  delete process.env.LOADENV_EXPORT_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

// It must NEVER throw — throwing kills the launchd job it exists to keep alive.
test('loadEnv returns cleanly when .env is unreadable (a directory)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-env-'));
  fs.mkdirSync(path.join(dir, '.env')); // a DIRECTORY named .env
  let res;
  assert.doesNotThrow(() => { res = loadEnv(dir); });
  assert.equal(res.loaded, false);
  assert.deepEqual(res.keys, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnv returns loaded:false when there is no .env (normal in CI)', () => {
  const dir = tmpRepo(null);
  const res = loadEnv(dir);
  assert.equal(res.loaded, false);
  assert.deepEqual(res.keys, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnv skips comments/blanks and strips surrounding quotes', () => {
  const dir = tmpRepo([
    '# a comment',
    '',
    'LOADENV_PLAIN=plain',
    'LOADENV_DQ="double quoted"',
    "LOADENV_SQ='single quoted'",
    'LOADENV_NOEQ',
  ].join('\n'));
  for (const k of ['LOADENV_PLAIN', 'LOADENV_DQ', 'LOADENV_SQ']) delete process.env[k];

  loadEnv(dir);

  assert.equal(process.env.LOADENV_PLAIN, 'plain');
  assert.equal(process.env.LOADENV_DQ, 'double quoted');
  assert.equal(process.env.LOADENV_SQ, 'single quoted');
  assert.equal(process.env.LOADENV_NOEQ, undefined, 'a line with no "=" is not a variable');

  for (const k of ['LOADENV_PLAIN', 'LOADENV_DQ', 'LOADENV_SQ']) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnv keeps "=" inside values intact', () => {
  const dir = tmpRepo('LOADENV_B64=abc==\n');
  delete process.env.LOADENV_B64;
  loadEnv(dir);
  assert.equal(process.env.LOADENV_B64, 'abc==');
  delete process.env.LOADENV_B64;
  fs.rmSync(dir, { recursive: true, force: true });
});

// dotenv is NOT in package.json — require('dotenv') would throw MODULE_NOT_FOUND
// and take the whole launchd job down. This asserts we never reintroduce it.
test('the loader has no dotenv dependency', () => {
  const src = fs.readFileSync(
    new URL('../../scripts/lib/load-env.js', import.meta.url),
    'utf8',
  );
  // Strip block + line comments first — the file explains in prose WHY it does
  // not use dotenv, and that explanation must not trip its own guard.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/require\(['"]dotenv['"]\)/.test(code), 'load-env.js must not require dotenv');
});
