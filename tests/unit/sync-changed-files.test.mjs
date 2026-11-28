import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Exercises the REAL script used by .github/actions/push-aggregator-archive
// (scripts/lib/sync-changed-files.sh), not a JS reimplementation of its
// logic — CLAUDE.md §15. Covers the same 4-way decision as
// core-data-sync-decision.js (copy-new / copy-changed / skip-unchanged /
// skip-missing), plus nested subdirectories (which push-aggregator-archive
// has and push-core-data's fixed file list does not) and --allow-delete
// (deletion propagation, opt-in — added 2026-07-14 after adversarial review
// found the no-delete default silently defeated
// scripts/lib/lbo-roundup-discover.js's quarantine-by-rename pattern).

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/lib/sync-changed-files.sh');

function runSync(srcDir, snapshotDir, destDir, { allowDelete = false } = {}) {
  const args = allowDelete ? ['--allow-delete', srcDir, snapshotDir, destDir] : [srcDir, snapshotDir, destDir];
  return execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
}

function makeTmpDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-changed-files-'));
  const src = path.join(base, 'src');
  const snapshot = path.join(base, 'snapshot');
  const dest = path.join(base, 'dest');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(snapshot, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  return { base, src, snapshot, dest };
}

test('unchanged file (identical to snapshot) is left alone in dest — the incident case', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.writeFileSync(path.join(src, 'a.txt'), 'unchanged content\n');
  fs.writeFileSync(path.join(snapshot, 'a.txt'), 'unchanged content\n');
  // dest already has a DIFFERENT (e.g. concurrently-pushed) version — must survive.
  fs.writeFileSync(path.join(dest, 'a.txt'), 'concurrently pushed content\n');

  runSync(src, snapshot, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'concurrently pushed content\n');
  fs.rmSync(base, { recursive: true, force: true });
});

test('workflow-modified file (differs from snapshot) is copied', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.writeFileSync(path.join(src, 'b.txt'), 'new content\n');
  fs.writeFileSync(path.join(snapshot, 'b.txt'), 'original content\n');

  runSync(src, snapshot, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'new content\n');
  fs.rmSync(base, { recursive: true, force: true });
});

test('new file this run (no snapshot entry) is copied', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.writeFileSync(path.join(src, 'c.txt'), 'brand new\n');

  runSync(src, snapshot, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'c.txt'), 'utf8'), 'brand new\n');
  fs.rmSync(base, { recursive: true, force: true });
});

test('file missing from src is never restored or removed from dest WITHOUT --allow-delete (push-core-data-style caller)', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.writeFileSync(path.join(snapshot, 'd.txt'), 'was here\n');
  fs.writeFileSync(path.join(dest, 'd.txt'), 'was here\n');
  // src/d.txt intentionally absent

  runSync(src, snapshot, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'd.txt'), 'utf8'), 'was here\n');
  fs.rmSync(base, { recursive: true, force: true });
});

test('file missing from src IS removed from dest WITH --allow-delete (aggregator-archive quarantine case)', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.writeFileSync(path.join(snapshot, 'bad.html'), 'wrong show page\n');
  fs.writeFileSync(path.join(dest, 'bad.html'), 'wrong show page\n');
  // src/bad.html absent — simulates lbo-roundup-discover.js renaming it to bad.html.mismatch

  const output = runSync(src, snapshot, dest, { allowDelete: true });

  assert.equal(fs.existsSync(path.join(dest, 'bad.html')), false);
  assert.match(output, /DELETED=1/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('--allow-delete does not touch dest files with no snapshot counterpart (never invents deletions)', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  // dest has a file that was never part of the tracked snapshot (e.g. pushed
  // by a concurrent workflow after this job's checkout) — must survive.
  fs.writeFileSync(path.join(dest, 'concurrent.html'), 'added by another job\n');

  runSync(src, snapshot, dest, { allowDelete: true });

  assert.equal(fs.readFileSync(path.join(dest, 'concurrent.html'), 'utf8'), 'added by another job\n');
  fs.rmSync(base, { recursive: true, force: true });
});

test('nested subdirectories are synced with the same per-file rules', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.mkdirSync(path.join(src, 'outlet-a'), { recursive: true });
  fs.mkdirSync(path.join(snapshot, 'outlet-a'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'outlet-a'), { recursive: true });

  fs.writeFileSync(path.join(src, 'outlet-a', 'unchanged.html'), 'same\n');
  fs.writeFileSync(path.join(snapshot, 'outlet-a', 'unchanged.html'), 'same\n');
  fs.writeFileSync(path.join(dest, 'outlet-a', 'unchanged.html'), 'stale-from-elsewhere\n');

  fs.writeFileSync(path.join(src, 'outlet-a', 'new.html'), 'brand new nested\n');

  runSync(src, snapshot, dest);

  assert.equal(
    fs.readFileSync(path.join(dest, 'outlet-a', 'unchanged.html'), 'utf8'),
    'stale-from-elsewhere\n',
  );
  assert.equal(
    fs.readFileSync(path.join(dest, 'outlet-a', 'new.html'), 'utf8'),
    'brand new nested\n',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test('nested subdirectory deletion propagates with --allow-delete', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.mkdirSync(path.join(snapshot, 'lbo-roundups'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'lbo-roundups'), { recursive: true });
  fs.writeFileSync(path.join(snapshot, 'lbo-roundups', 'wicked-2021.html'), 'wrong page\n');
  fs.writeFileSync(path.join(dest, 'lbo-roundups', 'wicked-2021.html'), 'wrong page\n');
  // Quarantine renamed it locally: src has the .mismatch file, not the original.
  fs.mkdirSync(path.join(src, 'lbo-roundups'), { recursive: true });
  fs.writeFileSync(path.join(src, 'lbo-roundups', 'wicked-2021.html.mismatch'), 'wrong page\n');

  runSync(src, snapshot, dest, { allowDelete: true });

  assert.equal(fs.existsSync(path.join(dest, 'lbo-roundups', 'wicked-2021.html')), false);
  assert.equal(
    fs.readFileSync(path.join(dest, 'lbo-roundups', 'wicked-2021.html.mismatch'), 'utf8'),
    'wrong page\n',
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test('reports accurate copied/skipped/deleted counts', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.writeFileSync(path.join(src, 'same.txt'), 'x\n');
  fs.writeFileSync(path.join(snapshot, 'same.txt'), 'x\n');
  fs.writeFileSync(path.join(src, 'diff.txt'), 'y\n');
  fs.writeFileSync(path.join(snapshot, 'diff.txt'), 'z\n');
  fs.writeFileSync(path.join(src, 'new.txt'), 'w\n');

  const output = runSync(src, snapshot, dest);

  assert.match(output, /COPIED=2 SKIPPED=1 DELETED=0/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('missing src dir entirely is a no-op (0 copied, 0 skipped, 0 deleted), never throws', () => {
  const { base, src, snapshot, dest } = makeTmpDirs();
  fs.rmSync(src, { recursive: true, force: true });

  const output = runSync(src, snapshot, dest, { allowDelete: true });

  assert.match(output, /COPIED=0 SKIPPED=0 DELETED=0/);
  fs.rmSync(base, { recursive: true, force: true });
});
