/**
 * validate-data.js must write /tmp/.skip-push-core-data when it exits with errors,
 * and clear it when it exits 0. This sentinel gates .github/actions/push-core-data.
 *
 * Notion 362637c5-416f-8174 — 64 workflows use push-core-data with `if: always()`.
 * Without this gate, validate-data.js exit-1 doesn't prevent corrupt rows from
 * reaching the private repo. Composite action reads the sentinel and refuses.
 *
 * This test plants a synthetic corrupt row, runs the real script, and asserts
 * the sentinel contract. It uses `--data-dir` if validate-data.js supports it;
 * otherwise it backs up + mutates + restores the real shows.json. Backups go
 * to /tmp so a crash doesn't leave the data file corrupt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const VALIDATE = join(ROOT, 'scripts/validate-data.js');
const SHOWS_JSON = join(ROOT, 'data/shows.json');
// Mirror validate-data.js: prefer RUNNER_TEMP, fall back to /tmp.
// Using process.pid in BACKUP path so parallel `node --test` runs don't collide.
const TMP_DIR = process.env.RUNNER_TEMP || '/tmp';
const SENTINEL = join(TMP_DIR, '.skip-push-core-data');
const BACKUP = join(TMP_DIR, `.shows-real-backup-sentinel-test-${process.pid}.json`);

let backupActive = false;
function backupShows() {
  copyFileSync(SHOWS_JSON, BACKUP);
  backupActive = true;
}
function restoreShows() {
  if (!backupActive) return;
  try { copyFileSync(BACKUP, SHOWS_JSON); } catch (_) { /* best-effort */ }
  try { unlinkSync(BACKUP); } catch (_) { /* best-effort */ }
  backupActive = false;
}
// Best-effort restore on signal — protects against Ctrl+C/SIGTERM leaving the
// real data file mutated. SIGKILL still wins, but we can't catch that.
function installSignalCleanup() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreShows(); process.exit(130); });
  }
  process.on('exit', restoreShows);
}
installSignalCleanup();

function plantSyntheticBadRow() {
  const data = JSON.parse(readFileSync(SHOWS_JSON, 'utf8'));
  data.shows.push({
    id: 'synthetic-sentinel-test-row',
    title: 'Sentinel Test',
    slug: 'synthetic-sentinel-test-row',
    venue: 'Test Venue',
    openingDate: '2025-01-01',
    closingDate: null,
    status: 'open',
    category: null,    // ← the gate that produces the error
    market: null,
    type: 'play',
    isRevival: false,
    tags: [],
    cast: [],
    creativeTeam: [],
    images: {},
    synopsis: '',
    runtime: null,
    intermissions: null,
    ageRecommendation: null,
    previewsStartDate: null,
  });
  writeFileSync(SHOWS_JSON, JSON.stringify(data, null, 2));
}

function runValidate() {
  try {
    execFileSync('node', [VALIDATE], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

describe('validate-data.js — push-refusal sentinel contract (Notion 362637c5-416f-8174)', () => {
  // Skip the whole suite if data isn't symlinked (CI without core-data checkout).
  if (!existsSync(SHOWS_JSON)) {
    test('[skip] data/shows.json absent in this context', () => {});
    return;
  }

  test('clean shows.json → exit 0, no sentinel written', () => {
    // Pre-state
    if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
    const code = runValidate();
    assert.strictEqual(code, 0, 'expected exit 0 on clean shows.json');
    assert.strictEqual(existsSync(SENTINEL), false,
      'sentinel was written even though validate succeeded — push-core-data would be wrongly blocked');
  });

  test('corrupt shows.json → exit 1, sentinel written with marker', () => {
    backupShows();
    try {
      plantSyntheticBadRow();
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
      const code = runValidate();
      assert.strictEqual(code, 1, 'expected exit 1 when shows.json has a null-category open show');
      assert.strictEqual(existsSync(SENTINEL), true,
        'sentinel was NOT written — push-core-data would push the corrupt row to the private repo');
      const content = readFileSync(SENTINEL, 'utf8');
      // Assert on the CONTRACT (refusal marker always present), not the brittle first-error
      // reason — validate-data runs many checks and any earlier unrelated error would
      // displace our synthetic one as errors[0]. The contract for push-core-data is "the
      // marker line exists"; the reason is operator-facing detail, not test surface.
      assert.match(content, /validate-data\.js refused push/, 'sentinel missing the refusal marker line');
      assert.match(content, /reason:/, 'sentinel missing the reason: prefix that operators key on');
    } finally {
      restoreShows();
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
    }
  });

  test('stale sentinel from prior failure → cleared on subsequent success', () => {
    // Plant a stale sentinel, then run validate on clean data, assert it's gone.
    writeFileSync(SENTINEL, 'stale sentinel from a prior run\n');
    const code = runValidate();
    assert.strictEqual(code, 0, 'expected exit 0 on clean shows.json');
    assert.strictEqual(existsSync(SENTINEL), false,
      'success path did not clear stale sentinel — a single past failure would permanently block push');
  });

  // Codex found two process.exit(1) paths in validate-data.js that bypassed the
  // sentinel before the refactor (missing shows.json, parse error). These tests
  // lock the coverage: if a future edit splits a new exit path off without going
  // through exitWithError(), this test fails.
  test('unparseable shows.json → exit 1, sentinel written (early-exit path coverage)', () => {
    backupShows();
    try {
      writeFileSync(SHOWS_JSON, '{not json'); // truncated/invalid
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
      const code = runValidate();
      assert.strictEqual(code, 1, 'expected exit 1 on unparseable shows.json');
      assert.strictEqual(existsSync(SENTINEL), true,
        'sentinel NOT written on parse-error exit path — push-core-data would be unguarded');
      assert.match(readFileSync(SENTINEL, 'utf8'), /parse error/i,
        'sentinel reason should mention the parse error');
    } finally {
      restoreShows();
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
    }
  });
});
