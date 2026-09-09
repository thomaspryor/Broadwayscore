// BRO-2258: disk hit 100% (117Mi free of 460Gi) with no warning anywhere,
// silently breaking cmux runtime spawning and headless job logging. Asserts
// (a) the disk-space check classifies free bytes at the required ~5GB warn /
// ~1GB error thresholds and parses real `df -k` output, (b) session-start.sh
// is actually wired to both checks (not just the libs existing unused), and
// (c) job-log retention prunes stale ~/Library/Logs/bsc-jobs entries while
// leaving fresh ones, bounded by a cooldown so concurrent sessions don't
// each redo the same fs work. Real functions via require() — never copies
// (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DEFAULT_WARN_BYTES,
  DEFAULT_ERROR_BYTES,
  parseDfKbOutput,
  checkDiskSpace,
  formatDiskSpaceMessage,
} = require('../../scripts/lib/disk-space-check.js');
const {
  DEFAULT_MAX_AGE_MS,
  selectStaleLogNames,
  pruneJobLogs,
  pruneDue,
  pruneJobLogsIfDue,
} = require('../../scripts/lib/job-log-retention.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── disk-space-check.js ──────────────────────────────────────────────────

test('checkDiskSpace: acceptance-criteria thresholds — warn below ~5GB, error below ~1GB', () => {
  assert.equal(DEFAULT_WARN_BYTES, 5 * 1024 ** 3);
  assert.equal(DEFAULT_ERROR_BYTES, 1 * 1024 ** 3);

  assert.equal(checkDiskSpace({ freeBytes: 10 * 1024 ** 3 }).level, 'ok');
  assert.equal(checkDiskSpace({ freeBytes: 5 * 1024 ** 3 }).level, 'ok', 'exactly at warn threshold is still ok');
  assert.equal(checkDiskSpace({ freeBytes: 4.9 * 1024 ** 3 }).level, 'warn');
  assert.equal(checkDiskSpace({ freeBytes: 1 * 1024 ** 3 }).level, 'warn', 'exactly at error threshold is still warn');
  assert.equal(checkDiskSpace({ freeBytes: 0.9 * 1024 ** 3 }).level, 'error');
  assert.equal(checkDiskSpace({ freeBytes: 0 }).level, 'error', 'a fully-full volume (0 free) is error, not a parse failure');
});

test('checkDiskSpace: rejects non-finite input rather than silently reporting ok', () => {
  assert.throws(() => checkDiskSpace({ freeBytes: NaN }));
});

test('formatDiskSpaceMessage: only warn/error levels produce a message', () => {
  assert.equal(formatDiskSpaceMessage(checkDiskSpace({ freeBytes: 10 * 1024 ** 3 })), null);
  assert.match(formatDiskSpaceMessage(checkDiskSpace({ freeBytes: 2 * 1024 ** 3 })), /LOW DISK SPACE/);
  assert.match(formatDiskSpaceMessage(checkDiskSpace({ freeBytes: 0.5 * 1024 ** 3 })), /DISK CRITICAL/);
});

test('parseDfKbOutput: parses real macOS `df -Pk /` output', () => {
  const sample = [
    'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1   482797652  12343464  83050812    13%    /',
  ].join('\n');
  assert.equal(parseDfKbOutput(sample), 83050812 * 1024);
});

test('parseDfKbOutput: parses real Linux coreutils `df -Pk /` output (cloud sandboxes)', () => {
  const sample = [
    'Filesystem     1024-blocks    Used Available Use% Mounted on',
    'overlay          61255492 8214332  49882344   15% /',
  ].join('\n');
  assert.equal(parseDfKbOutput(sample), 49882344 * 1024);
});

test('parseDfKbOutput: tolerates a wrapped record (long filesystem name on its own line)', () => {
  const sample = [
    'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1',
    '  482797652  12343464  83050812    13%    /',
  ].join('\n');
  assert.equal(parseDfKbOutput(sample), 83050812 * 1024);
});

test('parseDfKbOutput: throws on unrecognized output rather than guessing', () => {
  assert.throws(() => parseDfKbOutput('nonsense'));
});

// ── session-start.sh wiring ───────────────────────────────────────────────

test('session-start.sh (repo copy) is wired to both disk-space-check.js and job-log-retention.js', () => {
  const hookSrc = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh'), 'utf8');
  assert.match(hookSrc, /scripts\/lib\/disk-space-check\.js/, 'hook must require the disk-space check, not just leave the lib unused');
  assert.match(hookSrc, /runDiskSpaceCheck/);
  assert.match(hookSrc, /scripts\/lib\/job-log-retention\.js/, 'hook must require the job-log retention lib, not just leave it unused');
  assert.match(hookSrc, /pruneJobLogsIfDue/);
});

test('session-start.sh (global ~/.claude copy) carries the same wiring — local sessions self-skip the repo copy', () => {
  const globalPath = path.join(os.homedir(), '.claude', 'hooks', 'session-start.sh');
  if (!fs.existsSync(globalPath)) return; // cloud sandboxes have no ~/.claude
  const hookSrc = fs.readFileSync(globalPath, 'utf8');
  assert.match(hookSrc, /scripts\/lib\/disk-space-check\.js/);
  assert.match(hookSrc, /scripts\/lib\/job-log-retention\.js/);
});

// ── job-log-retention.js ─────────────────────────────────────────────────

test('selectStaleLogNames: pure function over synthetic entries', () => {
  const now = Date.now();
  const entries = [
    { name: 'old.log', mtimeMs: now - 20 * 24 * 60 * 60 * 1000 },
    { name: 'fresh.log', mtimeMs: now - 1 * 24 * 60 * 60 * 1000 },
  ];
  assert.deepEqual(selectStaleLogNames(entries, { now, maxAgeMs: DEFAULT_MAX_AGE_MS }), ['old.log']);
});

test('pruneJobLogs: deletes only log files older than maxAgeMs, from a real temp dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2258-joblog-'));
  try {
    const oldFile = path.join(dir, 'old.log');
    const freshFile = path.join(dir, 'fresh.log');
    const nonLogFile = path.join(dir, 'not-a-log.txt');
    fs.writeFileSync(oldFile, 'x'.repeat(1000));
    fs.writeFileSync(freshFile, 'y'.repeat(500));
    fs.writeFileSync(nonLogFile, 'z'.repeat(2000));

    const now = Date.now();
    const twentyDaysAgo = (now - 20 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, twentyDaysAgo, twentyDaysAgo);
    fs.utimesSync(nonLogFile, twentyDaysAgo, twentyDaysAgo);

    const result = pruneJobLogs({ dir, now });

    assert.deepEqual(result.deleted, ['old.log']);
    assert.equal(result.bytesFreed, 1000);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(oldFile), false, 'stale log deleted');
    assert.equal(fs.existsSync(freshFile), true, 'fresh log survives');
    assert.equal(fs.existsSync(nonLogFile), true, 'non-.log files are never touched, however old');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneJobLogs: a missing directory is a no-op, never throws (fresh machine / cloud sandbox)', () => {
  const missingDir = path.join(os.tmpdir(), 'bro-2258-does-not-exist-' + Date.now());
  const result = pruneJobLogs({ dir: missingDir });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.errors, []);
});

test('pruneJobLogs: refuses to delete when the recheck-before-unlink sees a different mtime than the scan (TOCTOU guard)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2258-toctou-'));
  const target = path.join(dir, 'raced.log');
  const realStatSync = fs.statSync;
  try {
    fs.writeFileSync(target, 'x'.repeat(10));
    const now = Date.now();
    const twentyDaysAgo = (now - 20 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(target, twentyDaysAgo, twentyDaysAgo);

    // Deterministically simulate the race pruneJobLogs guards against: the
    // scan's statSync call (1st, during the initial per-file loop) sees the
    // real stale mtime; the recheck's statSync call (2nd, immediately before
    // unlink) sees a DIFFERENT mtime, as if some other process replaced the
    // file in between. A real race is not reproducible deterministically at
    // the JS layer (fs.statSync is synchronous, single call stack), so this
    // patches the exact seam job-log-retention.js calls through.
    let callsForTarget = 0;
    fs.statSync = (p, ...rest) => {
      const result = realStatSync(p, ...rest);
      if (p === target) {
        callsForTarget++;
        if (callsForTarget === 2) return { ...result, mtimeMs: Date.now() };
      }
      return result;
    };

    const result = pruneJobLogs({ dir, now });
    assert.deepEqual(result.deleted, [], 'recheck mismatch blocks the delete');
    assert.match(result.errors[0], /mtime changed since scan/);
    assert.equal(fs.existsSync(target), true, 'file survives the race');
  } finally {
    fs.statSync = realStatSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneDue: atomic mkdir claim — true once, false until the window elapses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2258-cooldown-'));
  try {
    const markerPath = path.join(dir, 'prune.lock');
    const now = Date.now();
    assert.equal(pruneDue({ markerPath, cooldownMs: 60 * 60 * 1000, now }), true, 'no lock yet — due, claims it');
    assert.ok(fs.statSync(markerPath).isDirectory(), 'claim is a real directory (atomic mkdir, not a JSON file)');
    assert.equal(pruneDue({ markerPath, cooldownMs: 60 * 60 * 1000, now: now + 1000 }), false, 'inside cooldown');
    assert.equal(pruneDue({ markerPath, cooldownMs: 60 * 60 * 1000, now: now + 61 * 60 * 1000 }), true, 'cooldown elapsed — reclaims');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneDue: two "concurrent" claimants in the same window — only the first wins (atomicity, not just a race that usually resolves fine)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2258-atomic-'));
  try {
    const markerPath = path.join(dir, 'prune.lock');
    const now = Date.now();
    const results = [
      pruneDue({ markerPath, cooldownMs: 60 * 60 * 1000, now }),
      pruneDue({ markerPath, cooldownMs: 60 * 60 * 1000, now }),
      pruneDue({ markerPath, cooldownMs: 60 * 60 * 1000, now }),
    ];
    assert.deepEqual(results, [true, false, false], 'exactly one claimant wins per window — mkdir EEXIST rejects the rest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneJobLogsIfDue: bounded age retention actually runs when due, and skips when on cooldown (prevents unbounded growth from silently refilling the disk)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2258-ifdue-'));
  try {
    const markerPath = path.join(dir, 'prune.lock');
    const oldFile = path.join(dir, 'old.log');
    fs.writeFileSync(oldFile, 'x'.repeat(1000));
    const now = Date.now();
    const twentyDaysAgo = (now - 20 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, twentyDaysAgo, twentyDaysAgo);

    const first = pruneJobLogsIfDue({ dir, markerPath, cooldownMs: 60 * 60 * 1000, now });
    assert.ok(first, 'first call is due and returns a prune result');
    assert.deepEqual(first.deleted, ['old.log']);
    assert.equal(fs.existsSync(oldFile), false);

    // Recreate the same stale file to prove the cooldown, not "nothing left
    // to delete", is what suppresses the second call.
    fs.writeFileSync(oldFile, 'x'.repeat(1000));
    fs.utimesSync(oldFile, twentyDaysAgo, twentyDaysAgo);
    const second = pruneJobLogsIfDue({ dir, markerPath, cooldownMs: 60 * 60 * 1000, now: now + 1000 });
    assert.equal(second, null, 'still on cooldown — skipped, even though there is stale work to do');
    assert.equal(fs.existsSync(oldFile), true, 'file untouched while on cooldown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
