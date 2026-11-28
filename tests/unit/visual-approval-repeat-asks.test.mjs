// BRO-8164: an owner yes for a visual change must hold until the UI diff itself changes, not until the commit hash,
// the container, or the screenshot run changes. Real functions only (CLAUDE.md rule 15), real throwaway git repos.
//   1. new (untracked) UI files: the working-tree id used to be '', so the verdict had no id and nothing minted.
//   2. the verdict contentHash used to include headSha, so a re-run after a test-only commit rotated it.
//   3. the durable marker lived only on origin; a failed/killed push meant the next push asked again.
// Each case also proves the gate still re-asks when the design changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { computeContentHash } from '../../scripts/lib/verdict-hash.mjs';

const D = createRequire(import.meta.url)('../../scripts/lib/visual-approval-durable.js');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bro8164-'));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/A.tsx'), 'export const A = () => <div className="a" />;\n');
  fs.writeFileSync(path.join(dir, 'src/util.ts'), 'export const x = 1;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feat');
  return dir;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test('a NEW UI file screenshotted before commit gets an id equal to the committed id (so the approval can be kept)', () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, 'src/New.tsx'), 'export const N = () => <section className="n">new</section>;\n');
    fs.writeFileSync(path.join(dir, 'src/A.tsx'), 'export const A = () => <div className="b" />;\n');
    const before = git(dir, 'status', '--porcelain');
    const wt = D.uiPatchIdWorkingTree(dir);
    assert.ok(wt && wt.length === 20, `untracked new component must still yield an id (got ${JSON.stringify(wt)})`);
    assert.equal(git(dir, 'status', '--porcelain'), before, 'the real index is untouched (New.tsx is still untracked)');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'ui');
    assert.equal(D.uiPatchId(dir), wt, 'committing the screenshotted content keeps the same id');
    // Design change after the screenshot: different id, so the gate asks again.
    fs.writeFileSync(path.join(dir, 'src/New.tsx'), 'export const N = () => <section className="m">new</section>;\n');
    assert.notEqual(D.uiPatchIdWorkingTree(dir), wt);
  } finally { rm(dir); }
});

test('same UI diff, different commit: contentHash stays put; a different UI diff (or no id) still rotates it', () => {
  const base = { schemaVersion: 2, paths: ['/'], widths: [390, 1440], screenshotsDigest: [{ bytesSha: 's1' }], overallPass: true };
  const a = { ...base, headSha: 'aaa111', uiPatchId: 'p'.repeat(20), timestamp: '1' };
  const b = { ...base, headSha: 'bbb222', uiPatchId: 'p'.repeat(20), timestamp: '2' };
  assert.equal(computeContentHash(a), computeContentHash(b), 'a test-only commit or rebase must not rotate the hash');
  assert.notEqual(computeContentHash(a), computeContentHash({ ...b, uiPatchId: 'q'.repeat(20) }), 'a changed UI diff rotates it');
  assert.notEqual(computeContentHash({ ...a, uiPatchId: undefined }), computeContentHash({ ...b, uiPatchId: undefined }),
    'with no UI-diff id the commit still binds the hash (fail closed)');
  assert.notEqual(computeContentHash(a), computeContentHash({ ...a, screenshotsDigest: [{ bytesSha: 's2' }] }), 'new pixels rotate it');
});

test('an approval holds even when the origin marker push fails; another diff and an expired mark do not', () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, 'src/A.tsx'), 'export const A = () => <div className="b" />;\n');
    git(dir, 'commit', '-qam', 'ui');
    const id = D.uiPatchId(dir);
    const offline = (a) => { if (a[0] === 'push' || a[0] === 'ls-remote') throw new Error('offline'); return git(dir, ...a); };
    assert.equal(D.hasDurableApproval(dir, id, { run: offline }), false, 'nothing approved yet');
    assert.equal(D.mintDurableApproval(dir, 'HEAD', id, { run: offline }), true, 'mint succeeds locally with origin unreachable');
    assert.equal(D.hasDurableApproval(dir, id, { run: offline }), true, 'the next push finds the approval: no second ask');
    // Test-only follow-up commit: same UI diff, still approved.
    fs.writeFileSync(path.join(dir, 'src/util.ts'), 'export const x = 2;\n'); git(dir, 'commit', '-qam', 'non-ui');
    assert.equal(D.hasDurableApproval(dir, D.uiPatchId(dir), { run: offline }), true);
    // Design change: new id, not approved.
    fs.writeFileSync(path.join(dir, 'src/A.tsx'), 'export const A = () => <div className="c" />;\n'); git(dir, 'commit', '-qam', 'ui2');
    assert.equal(D.hasDurableApproval(dir, D.uiPatchId(dir), { run: offline }), false, 'a changed design is asked again');
    // A verdict for another diff can never mint.
    assert.equal(D.mintDurableApproval(dir, 'HEAD', id, { run: offline }), false);
    // TTL still applies to the local marker.
    const old = new Date(Date.now() - 10 * 86400000);
    git(dir, 'update-ref', '-d', git(dir, 'for-each-ref', '--format=%(refname)', D.LOCAL_PREFIX));
    D.mintDurableApproval(dir, 'HEAD~2', id, { run: offline, now: old });
    assert.equal(D.hasDurableApproval(dir, id, { run: offline }), false, '10-day-old local marker is past the TTL');
  } finally { rm(dir); }
});

test('markerMatches: exact id only, both remote and local ref forms, TTL cutoff', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  assert.equal(D.markerMatches('abc\trefs/heads/visual-approved/20261126-abcdef', 'abcdef', now), true);
  assert.equal(D.markerMatches('refs/visual-approved-local/20261126-abcdef', 'abcdef', now), true);
  assert.equal(D.markerMatches('refs/visual-approved-local/20261126-abcdef0', 'abcdef', now), false);
  assert.equal(D.markerMatches('refs/visual-approved-local/20261101-abcdef', 'abcdef', now), false);
  assert.equal(D.markerMatches('refs/heads/other/20261126-abcdef', 'abcdef', now), false);
  assert.equal(D.markerMatches('', '', now), false);
});
