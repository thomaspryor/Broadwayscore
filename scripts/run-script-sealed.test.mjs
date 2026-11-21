// BRO-5008: run-script.yml's runner seals output to the caller's key and never prints plaintext.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { generateKeyPair, open } = require('./lib/sealed-output.js');
const { extractOutput } = require('./cloud-run-script.js');
const { parseArgsJson, childEnv, chunk } = require('./run-script-sealed.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function runSealed(env) {
  return spawnSync(process.execPath, ['scripts/run-script-sealed.js'], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
  });
}

test('end to end: output is sealed in the log and opens only with the private key', () => {
  const { publicKey, privateKey } = generateKeyPair();
  // cloud-run-script.js with no script prints its usage to stderr and exits 2.
  const r = runSealed({
    RS_SCRIPT: 'scripts/cloud-run-script.js', RS_ARGS_JSON: '[]',
    RS_PUBKEY_B64: Buffer.from(publicKey).toString('base64'),
  });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /Usage:/, 'plaintext output leaked into the log');
  const log = r.stdout.split('\n').map((l) => `2026-10-10T21:00:00.0000000Z ${l}`).join('\n');
  const parsed = extractOutput(log);
  assert.equal(parsed.found, true);
  assert.equal(parsed.exitCode, 2);
  const blob = parsed.output.split('\n').join('');
  assert.match(open(JSON.parse(blob), privateKey), /Usage: node scripts\/cloud-run-script\.js/);
});

test('refuses without a public key, with a bad path, or with non-array args', () => {
  const pub = Buffer.from(generateKeyPair().publicKey).toString('base64');
  for (const env of [
    { RS_SCRIPT: 'scripts/cloud-run-script.js', RS_ARGS_JSON: '[]' },
    { RS_SCRIPT: 'scripts/../package.json', RS_ARGS_JSON: '[]', RS_PUBKEY_B64: pub },
    { RS_SCRIPT: 'scripts/does-not-exist.js', RS_ARGS_JSON: '[]', RS_PUBKEY_B64: pub },
    { RS_SCRIPT: 'scripts/cloud-run-script.js', RS_ARGS_JSON: '"--x; rm -rf /"', RS_PUBKEY_B64: pub },
  ]) {
    const r = runSealed(env);
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.doesNotMatch(r.stdout, /RUN-SCRIPT OUTPUT BEGIN/);
  }
});

test('parseArgsJson accepts only arrays of strings', () => {
  assert.deepEqual(parseArgsJson('["--days=91", "a b"]'), ['--days=91', 'a b']);
  assert.equal(parseArgsJson('[1]'), null);
  assert.equal(parseArgsJson('{}'), null);
  assert.equal(parseArgsJson('nope'), null);
});

test('the child never sees files Actions publishes, nor the request inputs', () => {
  const env = childEnv({ GITHUB_STEP_SUMMARY: '/s', GITHUB_OUTPUT: '/o', GITHUB_ENV: '/e', GITHUB_PATH: '/p',
    RS_PUBKEY_B64: 'k', RS_ARGS_JSON: '[]', POSTHOG_PERSONAL_API_KEY: 'x', PATH: '/bin' });
  assert.deepEqual(Object.keys(env).sort(), ['NODE_OPTIONS', 'PATH', 'POSTHOG_PERSONAL_API_KEY']);
});

test('a child that prints 2 MB and calls process.exit() delivers all of it (BRO-4317)', async () => {
  const { spawn } = await import('node:child_process');
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(2e6)); process.exit(0)'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let n = 0;
    c.stdout.on('data', (b) => { n += b.length; });
    c.on('close', () => resolve(n));
  });
  assert.equal(await run(childEnv({ PATH: process.env.PATH })), 2e6);
});

test('an existing NODE_OPTIONS is kept, with the blocking-stdio preload appended', () => {
  const env = childEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
  assert.match(env.NODE_OPTIONS, /^--max-old-space-size=4096 --require ".*blocking-stdio\.js"$/);
});

test('chunk splits a long blob into short lines that join back losslessly', () => {
  const s = 'a'.repeat(130001);
  const parts = chunk(s);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 60000));
  assert.equal(parts.join(''), s);
});
