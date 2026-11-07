// BRO-5228: the create_session model for a cloud worker session. Uses the real
// scripts/lib/cloud-worker-pick.js functions and runs the real CLI for its
// argument checks (no Linear call is made on those paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
  const modelOf = modelPicker();
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

// BRO-6502: the real CLI with Linear stubbed through a preload that patches getIssue.
function runCli(cards) {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-model-'));
  const preload = path.join(dir, 'stub.js');
  writeFileSync(preload, `const c = require(${JSON.stringify(path.join(REPO_ROOT, 'scripts/lib/linear-client.js'))});
const cards = ${JSON.stringify(cards)};
c.getIssue = async (id) => cards[id] || null;`);
  const res = spawnSync(process.execPath, ['-r', preload, path.join(REPO_ROOT, 'scripts', 'session-model.js'), ...Object.keys(cards)], { encoding: 'utf8', env: { ...process.env, LINEAR_API_KEY: 'stub' } });
  rmSync(dir, { recursive: true, force: true });
  return res;
}
const card = (identifier, over) => ({ identifier, priority: 3, description: 'Do the thing.', comments: { nodes: [] }, ...over });

test('a NO-DISPATCH card is refused: exit 3, no model to pass to create_session (BRO-6502)', () => {
  const res = runCli({ 'BRO-6066': card('BRO-6066', { priority: 1, description: 'Do it.\n\nNO-DISPATCH: coordinator freeze until 2026-10-30 12:00Z' }) });
  assert.equal(res.status, 3, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.refused, ['BRO-6066']);
  assert.equal(out.model, undefined);
  // one held card in a batch refuses the whole batch
  const batch = runCli({ 'BRO-1': card('BRO-1'), 'BRO-2': card('BRO-2', { description: 'NO-DISPATCH: hold' }) });
  assert.equal(batch.status, 3);
  assert.deepEqual(JSON.parse(batch.stdout).refused, ['BRO-2']);
});

test('a P0 picks Opus with no cap note, however much Opus ran today (BRO-6502)', () => {
  const res = runCli({ 'BRO-4290': card('BRO-4290', { priority: 1 }) });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.model, DISPATCH_OPUS);
  assert.doesNotMatch(out.modelReason, /cap/i);
});

test('a comment quoting NO-DISPATCH does not hold a card (BRO-6502)', () => {
  const res = runCli({ 'BRO-3': card('BRO-3', { comments: { nodes: [{ body: 'NO-DISPATCH: quoted from the old description' }] } }) });
  assert.equal(res.status, 0, res.stderr);
});
