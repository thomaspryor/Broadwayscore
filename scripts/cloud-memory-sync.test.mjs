// scripts/cloud-memory-sync.test.mjs — BRO-103 acceptance suite.
//
// The bug: scripts/sync-memory-to-repo.sh mirrored the local memory dir into
// cloud-memory/ with `rsync -a --delete`, so any memo a cloud or parallel
// session had committed directly into cloud-memory/ was deleted on the next
// local session-stop (2026-05-24: feedback_nonprofit_venue_vs_production.md,
// wiped 12 minutes after it was committed).
//
// These tests exercise the real functions and the real shell script — nothing
// is restated here (CLAUDE.md rule 15). The load-bearing cases are the two
// named "BRO-103 regression": one at the decision-function level, one driving
// scripts/sync-memory-to-repo.sh end-to-end on scratch dirs.
//
// Run: node --test scripts/cloud-memory-sync.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SYNC_SH = path.join(REPO_ROOT, 'scripts', 'sync-memory-to-repo.sh');

const {
  planSync,
  applySync,
  hashDir,
  sha256,
  readManifest,
  writeManifest,
  defaultManifestPath,
  CONFLICT_DIR,
} = require(path.join(REPO_ROOT, 'scripts', 'lib', 'cloud-memory-merge.js'));

const h = (text) => sha256(Buffer.from(text));

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-memory-sync-'));
  const src = path.join(root, 'memory');
  const repo = path.join(root, 'repo');
  const dest = path.join(repo, 'cloud-memory');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  return { root, src, repo, dest, manifestPath: path.join(repo, '.git-manifest.json') };
}

const write = (dir, name, body) => fs.writeFileSync(path.join(dir, name), body);
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const listMd = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

describe('planSync — deletion decisions', () => {
  test('BRO-103 regression: a mirror-only file we never mirrored is adopted, never deleted', () => {
    // A cloud session committed feedback_nonprofit_venue_vs_production.md into
    // cloud-memory/. It is absent from the local source and absent from the
    // manifest, because this machine never put it there.
    const plan = planSync({
      src: { 'MEMORY.md': h('index') },
      dest: { 'MEMORY.md': h('index'), 'feedback_nonprofit_venue_vs_production.md': h('cloud memo') },
      manifest: { 'MEMORY.md': h('index') },
    });
    assert.deepEqual(plan.deleteFromDest, [], 'must not delete a foreign mirror-side file');
    assert.deepEqual(plan.adoptToSrc, ['feedback_nonprofit_venue_vs_production.md']);
    assert.equal(
      plan.nextManifest['feedback_nonprofit_venue_vs_production.md'],
      h('cloud memo'),
      'the adopted file becomes part of the tracked mirror state',
    );
  });

  test('a genuine local deletion still propagates to the mirror', () => {
    const plan = planSync({
      src: { 'MEMORY.md': h('index') },
      dest: { 'MEMORY.md': h('index'), 'stale.md': h('outdated') },
      manifest: { 'MEMORY.md': h('index'), 'stale.md': h('outdated') },
    });
    assert.deepEqual(plan.deleteFromDest, ['stale.md']);
    assert.deepEqual(plan.adoptToSrc, []);
    assert.ok(!('stale.md' in plan.nextManifest));
  });

  test('a file we mirrored but that changed in the mirror is adopted, not deleted', () => {
    // Deleted locally, but edited on the mirror side since our last sync —
    // deleting would discard that edit.
    const plan = planSync({
      src: {},
      dest: { 'memo.md': h('edited by a cloud session') },
      manifest: { 'memo.md': h('what we last wrote') },
    });
    assert.deepEqual(plan.deleteFromDest, []);
    assert.deepEqual(plan.adoptToSrc, ['memo.md']);
  });

  test('bootstrap (no manifest) deletes nothing and adopts every mirror-only file', () => {
    const plan = planSync({
      src: { 'MEMORY.md': h('index') },
      dest: { 'MEMORY.md': h('index'), 'a.md': h('a'), 'b.md': h('b') },
      manifest: null,
    });
    assert.equal(plan.bootstrap, true);
    assert.deepEqual(plan.deleteFromDest, []);
    assert.deepEqual(plan.adoptToSrc, ['a.md', 'b.md']);
  });
});

describe('planSync — content decisions', () => {
  test('a new local memo is copied to the mirror', () => {
    const plan = planSync({ src: { 'new.md': h('x') }, dest: {}, manifest: {} });
    assert.deepEqual(plan.copyToDest, ['new.md']);
    assert.deepEqual(plan.conflicts, []);
  });

  test('local-side edit wins when the mirror is untouched since the last sync', () => {
    const plan = planSync({
      src: { 'memo.md': h('v2') },
      dest: { 'memo.md': h('v1') },
      manifest: { 'memo.md': h('v1') },
    });
    assert.deepEqual(plan.copyToDest, ['memo.md']);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.adoptToSrc, []);
  });

  test('mirror-side edit is adopted when the local copy is untouched since the last sync', () => {
    const plan = planSync({
      src: { 'memo.md': h('v1') },
      dest: { 'memo.md': h('cloud edit') },
      manifest: { 'memo.md': h('v1') },
    });
    assert.deepEqual(plan.adoptToSrc, ['memo.md']);
    assert.deepEqual(plan.copyToDest, []);
    assert.equal(plan.nextManifest['memo.md'], h('cloud edit'));
  });

  test('both sides changed: local wins in the mirror, but the file is flagged for preservation', () => {
    const plan = planSync({
      src: { 'memo.md': h('local v2') },
      dest: { 'memo.md': h('cloud v2') },
      manifest: { 'memo.md': h('v1') },
    });
    assert.deepEqual(plan.conflicts, ['memo.md']);
    assert.deepEqual(plan.copyToDest, ['memo.md']);
  });

  test('a mirror-side deletion does not propagate back — the local memo is restored', () => {
    // Deliberate asymmetry: the local dir is where the owner and the memory
    // tooling curate memories, so a file vanishing from the mirror (a bad
    // merge, a stray `git rm`) must not delete the real memory. It gets
    // re-mirrored instead.
    const plan = planSync({
      src: { 'memo.md': h('still here locally') },
      dest: {},
      manifest: { 'memo.md': h('still here locally') },
    });
    assert.deepEqual(plan.copyToDest, ['memo.md']);
    assert.deepEqual(plan.deleteFromDest, []);
  });

  test('identical content on both sides is a no-op', () => {
    const plan = planSync({
      src: { 'memo.md': h('same') },
      dest: { 'memo.md': h('same') },
      manifest: { 'memo.md': h('same') },
    });
    assert.deepEqual(plan.copyToDest, []);
    assert.deepEqual(plan.adoptToSrc, []);
    assert.deepEqual(plan.deleteFromDest, []);
    assert.deepEqual(plan.unchanged, ['memo.md']);
  });
});

describe('applySync — real filesystem', () => {
  test('BRO-103 regression: a memo written into the mirror by a cloud session survives the next sync', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'MEMORY.md', '# index\n');
    write(src, 'feedback_local.md', 'local memo\n');
    applySync({ src, dest, manifestPath }); // establishes the common ancestor

    // A cloud session (no ~/.claude at all) commits a memo straight into the mirror.
    write(dest, 'feedback_nonprofit_venue_vs_production.md', 'nonprofit venue != production\n');

    const result = applySync({ src, dest, manifestPath });

    assert.ok(
      exists(dest, 'feedback_nonprofit_venue_vs_production.md'),
      'the cloud-written memo must still be in the mirror (this is the 2026-05-24 data loss)',
    );
    assert.equal(read(src, 'feedback_nonprofit_venue_vs_production.md'), 'nonprofit venue != production\n');
    assert.deepEqual(result.deleteFromDest, []);
    assert.deepEqual(result.adoptToSrc, ['feedback_nonprofit_venue_vs_production.md']);
  });

  test('a locally deleted memo is removed from the mirror', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'MEMORY.md', '# index\n');
    write(src, 'wrong.md', 'a memo that turned out to be wrong\n');
    applySync({ src, dest, manifestPath });
    assert.ok(exists(dest, 'wrong.md'));

    fs.rmSync(path.join(src, 'wrong.md'));
    const result = applySync({ src, dest, manifestPath });

    assert.deepEqual(result.deleteFromDest, ['wrong.md']);
    assert.ok(!exists(dest, 'wrong.md'));
    assert.deepEqual(listMd(dest), ['MEMORY.md']);
  });

  test('a two-sided conflict keeps the local version and preserves the mirror version', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'memo.md', 'v1\n');
    applySync({ src, dest, manifestPath });

    write(src, 'memo.md', 'local v2\n');
    write(dest, 'memo.md', 'cloud v2\n');
    const result = applySync({ src, dest, manifestPath, now: new Date('2026-08-30T12:00:00Z') });

    assert.deepEqual(result.conflicts, ['memo.md']);
    assert.equal(read(dest, 'memo.md'), 'local v2\n');
    assert.equal(result.conflictCopies.length, 1);
    assert.equal(fs.readFileSync(result.conflictCopies[0], 'utf8'), 'cloud v2\n', 'the losing side must survive on disk');
    assert.ok(result.conflictCopies[0].includes(`${path.sep}${CONFLICT_DIR}${path.sep}`));
    // The conflict dir is a subdirectory, so it is never mirrored back.
    assert.deepEqual(listMd(dest), ['memo.md']);
  });

  test('a missing or corrupt manifest degrades to bootstrap — no deletions', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'MEMORY.md', '# index\n');
    write(dest, 'from_the_cloud.md', 'written elsewhere\n');

    fs.writeFileSync(manifestPath, '{ this is not json');
    assert.equal(readManifest(manifestPath), null, 'a corrupt manifest must read as unknown, not as empty');

    const result = applySync({ src, dest, manifestPath });
    assert.equal(result.bootstrap, true);
    assert.deepEqual(result.deleteFromDest, []);
    assert.ok(exists(dest, 'from_the_cloud.md'));
    assert.ok(exists(src, 'from_the_cloud.md'));
    assert.ok(readManifest(manifestPath), 'a usable manifest is written for the next run');
  });

  test('non-.md files and subdirectories are left alone on both sides', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'MEMORY.md', '# index\n');
    fs.writeFileSync(path.join(src, 'checkpoint.json'), '{}');
    fs.mkdirSync(path.join(src, '_drafts'));
    write(path.join(src, '_drafts'), 'draft.md', 'not a real memory yet\n');
    fs.writeFileSync(path.join(dest, 'README.txt'), 'keep me');

    applySync({ src, dest, manifestPath });

    assert.deepEqual(listMd(dest), ['MEMORY.md']);
    assert.ok(!fs.existsSync(path.join(dest, 'checkpoint.json')), 'non-.md source files are not mirrored');
    assert.ok(!fs.existsSync(path.join(dest, '_drafts')), 'source subdirectories are not mirrored');
    assert.ok(fs.existsSync(path.join(dest, 'README.txt')), 'non-.md mirror files are not deleted');
  });

  test('sync is idempotent — a second run changes nothing', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'MEMORY.md', '# index\n');
    write(src, 'a.md', 'a\n');
    applySync({ src, dest, manifestPath });
    const before = hashDir(dest);

    const second = applySync({ src, dest, manifestPath });
    assert.deepEqual(second.copyToDest, []);
    assert.deepEqual(second.adoptToSrc, []);
    assert.deepEqual(second.deleteFromDest, []);
    assert.deepEqual(second.conflicts, []);
    assert.deepEqual(hashDir(dest), before);
  });

  test('dry-run touches nothing', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'a.md', 'a\n');
    write(dest, 'from_the_cloud.md', 'elsewhere\n');
    const result = applySync({ src, dest, manifestPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.deepEqual(listMd(dest), ['from_the_cloud.md']);
    assert.deepEqual(listMd(src), ['a.md']);
    assert.ok(!fs.existsSync(manifestPath));
  });

  test('an adopted file is not re-adopted or deleted on subsequent runs', () => {
    const { src, dest, manifestPath } = scratch();
    write(src, 'MEMORY.md', '# index\n');
    applySync({ src, dest, manifestPath });
    write(dest, 'cloud.md', 'from the cloud\n');
    applySync({ src, dest, manifestPath });

    const third = applySync({ src, dest, manifestPath });
    assert.deepEqual(third.adoptToSrc, []);
    assert.deepEqual(third.deleteFromDest, []);
    assert.ok(exists(dest, 'cloud.md'));
    assert.ok(exists(src, 'cloud.md'));
  });
});

describe('manifest plumbing', () => {
  test('round-trips through write/read', () => {
    const { manifestPath } = scratch();
    writeManifest(manifestPath, { 'a.md': h('a') });
    assert.deepEqual(readManifest(manifestPath), { 'a.md': h('a') });
  });

  test('a manifest of an unknown version reads as unknown', () => {
    const { manifestPath } = scratch();
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 999, files: { 'a.md': h('a') } }));
    assert.equal(readManifest(manifestPath), null);
  });

  test('the manifest lives inside .git, so it is never committed and never leaves the machine', () => {
    const resolved = defaultManifestPath(REPO_ROOT);
    assert.ok(resolved, 'a checkout must resolve a manifest path');
    assert.ok(
      resolved.includes(`${path.sep}.git${path.sep}`),
      `manifest must be under .git, got ${resolved}`,
    );
    // From a worktree (.git is a FILE), it must resolve to the shared common
    // git dir — not a per-worktree copy that would see a mirror it never wrote.
    assert.ok(!resolved.includes(`${path.sep}worktrees${path.sep}`), `got a per-worktree manifest: ${resolved}`);
  });

  test('defaultManifestPath returns null when there is no .git at all', () => {
    const { root } = scratch();
    assert.equal(defaultManifestPath(root), null);
  });
});

describe('sync-memory-to-repo.sh end-to-end', () => {
  const runSync = (src, repo, args = []) =>
    execFileSync('bash', [SYNC_SH, ...args], {
      env: { ...process.env, MEMORY_SYNC_SRC: src, MEMORY_SYNC_REPO: repo },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  test('BRO-103 regression: the shipped script does not delete a cloud-written memo', () => {
    const { src, repo, dest } = scratch();
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); // manifest home
    write(src, 'MEMORY.md', '# index\n');
    write(src, 'feedback_local.md', 'local\n');
    runSync(src, repo);
    assert.deepEqual(listMd(dest), ['MEMORY.md', 'feedback_local.md']);

    // Cloud session commits a memo directly into the mirror, then this machine
    // ends a session and the SessionStop hook runs the sync.
    write(dest, 'feedback_nonprofit_venue_vs_production.md', 'nonprofit venue != production\n');
    runSync(src, repo);

    assert.deepEqual(
      listMd(dest),
      ['MEMORY.md', 'feedback_local.md', 'feedback_nonprofit_venue_vs_production.md'],
      'the cloud-written memo must survive the shipped shell script',
    );
    assert.ok(exists(src, 'feedback_nonprofit_venue_vs_production.md'), 'and be adopted into the local memory dir');
    assert.ok(
      fs.existsSync(path.join(repo, '.git', 'cloud-memory-sync-manifest.json')),
      'the shell script must point the merge at a .git-resident manifest',
    );
  });

  test('the shipped script still propagates a real local deletion', () => {
    const { src, repo, dest } = scratch();
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(src, 'MEMORY.md', '# index\n');
    write(src, 'wrong.md', 'wrong\n');
    runSync(src, repo);
    assert.ok(exists(dest, 'wrong.md'));

    fs.rmSync(path.join(src, 'wrong.md'));
    runSync(src, repo);
    assert.ok(!exists(dest, 'wrong.md'));
  });

  test('--dry-run reports without writing', () => {
    const { src, repo, dest } = scratch();
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(src, 'a.md', 'a\n');
    runSync(src, repo, ['--dry-run']);
    assert.deepEqual(listMd(dest), []);
  });

  test('a missing source dir is a clean no-op (cloud sandbox)', () => {
    const { root, repo } = scratch();
    const out = runSync(path.join(root, 'does-not-exist'), repo);
    assert.equal(out, '');
  });
});
