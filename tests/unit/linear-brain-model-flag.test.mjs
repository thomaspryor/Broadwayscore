// linear-brain create --model (BRO-4535): a bad or missing value exits 2
// before any Linear call. LINEAR_API_KEY is blanked, so a run that got past
// the check would fail on auth with a different message, not this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function create(...extra) {
  return spawnSync(
    process.execPath,
    ['scripts/linear-brain.js', 'create', 'bro-4535 model flag probe', '--park', 'probe of the model flag validation', ...extra],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env, LINEAR_API_KEY: '' } },
  );
}

test('linear-brain create --model gpt exits 2 and names the allowed values', () => {
  const res = create('--model', 'gpt');
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr + res.stdout, /model must be one of opus\|sonnet, got "gpt"/);
});

test('linear-brain create with a bare --model exits 2', () => {
  const res = create('--model');
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr + res.stdout, /model must be one of opus\|sonnet/);
});

test('linear-brain create --model opus with conflicting notes exits 2', () => {
  const res = create('--model', 'opus', '--notes', 'Model: Sonnet');
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr + res.stdout, /conflicts with --model opus/);
});
