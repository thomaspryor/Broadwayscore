// visual-approval-durable.js (BRO-7628): approval survives restarts and test-only pushes, never covers another UI diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const D = createRequire(import.meta.url)('./visual-approval-durable.js');

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vad-'));
  const remote = path.join(root, 'remote.git'); const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(work, 'src')); fs.writeFileSync(path.join(work, 'src/A.tsx'), 'export const A = () => <div className="flex-col" />;\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin');
  git(work, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(work, 'src/A.tsx'), 'export const A = () => <div className="flex-row" />;\n');
  git(work, 'commit', '-qam', 'ui');
  return { root, work };
}
const rm = (f) => fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test('mint then check: approved, and still approved after a test-only follow-up commit', () => {
  const f = fixture();
  try {
    const id = D.uiPatchId(f.work); assert.ok(id);
    assert.equal(D.hasDurableApproval(f.work, id), false);
    assert.equal(D.mintDurableApproval(f.work, 'HEAD', id), true);
    assert.equal(D.hasDurableApproval(f.work, id), true);
    fs.mkdirSync(path.join(f.work, 'tests')); fs.writeFileSync(path.join(f.work, 'tests/x.test.mjs'), '1');
    git(f.work, 'add', '.'); git(f.work, 'commit', '-qm', 'test only');
    assert.equal(D.uiPatchId(f.work), id, 'UI diff unchanged by a test-only commit');
  } finally { rm(f); }
});

test('a verdict for another diff cannot mint; whitespace-only UI edits get a new id (re-blocked)', () => {
  const f = fixture();
  try {
    const id = D.uiPatchId(f.work);
    assert.equal(D.mintDurableApproval(f.work, 'HEAD', 'deadbeef'), false);
    assert.equal(D.mintDurableApproval(f.work, 'HEAD', null), false);
    fs.writeFileSync(path.join(f.work, 'src/A.tsx'), 'export const A = () => <div className="flex -row" />;\n');
    git(f.work, 'commit', '-qam', 'edit');
    assert.notEqual(D.uiPatchId(f.work), id);
  } finally { rm(f); }
});

test('a network or git error is "not approved" (falls to the normal flow), and old markers expire', () => {
  const f = fixture();
  try {
    const id = D.uiPatchId(f.work);
    assert.equal(D.hasDurableApproval(f.work, id, { run: () => { throw new Error('offline'); } }), false);
    D.mintDurableApproval(f.work, 'HEAD', id, { now: new Date(Date.now() - 10 * 86400000) });
    assert.equal(D.hasDurableApproval(f.work, id), false, '10-day-old marker is past the 7-day TTL');
    assert.equal(D.uiPatchId(f.root + '/nope'), null);
  } finally { rm(f); }
});

test('no UI files changed -> no id', () => {
  const f = fixture();
  try {
    git(f.work, 'reset', '-q', '--hard', 'origin/main');
    assert.equal(D.uiPatchId(f.work), null);
  } finally { rm(f); }
});

test('CLI mint refuses unless the gate hook sets VISUAL_GATE_MINT (a session cannot self-approve)', async () => {
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env }; delete env.VISUAL_GATE_MINT;
  const r = spawnSync('node', [new URL('./visual-approval-durable.js', import.meta.url).pathname, 'mint', '--repo=.', '--ref=HEAD', '--verdict-id=x'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate/);
});
