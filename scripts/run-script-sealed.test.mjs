// BRO-5008: run-script.yml's runner seals output to the caller's key and never prints plaintext.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateKeyPair, open } = require('./lib/sealed-output.js');
const { extractOutput } = require('./cloud-run-script.js');
const { parseArgsJson } = require('./run-script-sealed.js');

function runSealed(env) {
  return spawnSync(process.execPath, ['scripts/run-script-sealed.js'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
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
  assert.match(open(JSON.parse(parsed.output.trim()), privateKey), /Usage: node scripts\/cloud-run-script\.js/);
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
