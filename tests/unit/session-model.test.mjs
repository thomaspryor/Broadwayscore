// BRO-5228: the create_session model for a cloud worker session. Uses the real
// scripts/lib/cloud-worker-pick.js functions and runs the real CLI for its
// argument checks (no Linear call is made on those paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const { sessionModelFor, modelPicker } = require('../../scripts/lib/cloud-worker-pick.js');
const { DISPATCH_SONNET, DISPATCH_OPUS } = require('../../scripts/lib/models.js');

test('a session is Sonnet unless every card needs Opus', () => {
  assert.deepEqual(sessionModelFor([{ model: 'sonnet' }]), { model: DISPATCH_SONNET, opusCards: 0 });
  assert.deepEqual(sessionModelFor([{ model: 'opus' }]), { model: DISPATCH_OPUS, opusCards: 1 });
  assert.deepEqual(sessionModelFor([{ model: 'opus' }, { model: 'opus' }]), { model: DISPATCH_OPUS, opusCards: 2 });
  // One retry card in a P2 batch must not put the batch on Opus (the $12.76 session).
  assert.deepEqual(sessionModelFor([{ model: 'sonnet' }, { model: 'opus' }, { model: 'sonnet' }]), { model: DISPATCH_SONNET, opusCards: 1 });
});

test('no cards (owner-asked work) or junk input is Sonnet', () => {
  for (const picks of [[], undefined, null, [null]]) {
    assert.equal(sessionModelFor(picks).model, DISPATCH_SONNET, String(picks));
  }
});

test('the ids are ones the hook accepts', () => {
  assert.match(DISPATCH_SONNET, /^claude-sonnet-[0-9]/);
  assert.match(DISPATCH_OPUS, /^claude-opus-[0-9]/);
});

test('modelPicker applies the card policy: first P2 attempt Sonnet, P0 Opus, Model: Opus honored', () => {
  const modelOf = modelPicker(Date.parse('2026-10-13T00:00:00Z'));
  const issue = (over) => ({ identifier: 'BRO-1', priority: 3, description: '', comments: { nodes: [] }, ...over });
  assert.equal(modelOf(issue({})).model, 'sonnet');
  assert.equal(modelOf(issue({ priority: 1 })).model, 'opus');
  assert.equal(modelOf(issue({ description: 'Fix it.\n\nModel: Opus' })).model, 'opus');
  assert.equal(modelOf(issue({ priority: 1, description: 'Model: Sonnet' })).model, 'sonnet');
});

test('--no-card prints the Sonnet id without touching Linear', () => {
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'session-model.js'), '--no-card'], { encoding: 'utf8', env: { ...process.env, LINEAR_API_KEY: '' } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).model, DISPATCH_SONNET);
});

test('the CLI refuses missing or malformed card ids before touching Linear', () => {
  for (const args of [[], ['5228'], ['BRO-'], ['BRO-1', 'nope']]) {
    const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'session-model.js'), ...args], { encoding: 'utf8', env: { ...process.env, LINEAR_API_KEY: '' } });
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stderr}`);
  }
});
