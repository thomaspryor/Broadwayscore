// TESTS-VS-DERIVED-DATA-EXEMPT: tests validate-data.js exit-code + sentinel-file behavior using shows.json as fixture input; no factual pins.
/**
 * validate-data.js must write /tmp/.skip-push-core-data when it exits with errors,
 * and clear it when it exits 0. This sentinel gates .github/actions/push-core-data.
 *
 * Notion 362637c5-416f-8174 — 64 workflows use push-core-data with `if: always()`.
 * Without this gate, validate-data.js exit-1 doesn't prevent corrupt rows from
 * reaching the private repo. Composite action reads the sentinel and refuses.
 *
 * This test plants a synthetic corrupt row and runs the real script, but against
 * a throwaway copy of shows.json — never the real data/shows.json (task #1649:
 * the old backup/mutate/restore-in-place approach raced parallel sessions and CI,
 * which write shows.json every ~30 min, leaving a window of transient corruption
 * in the source of truth). validate-data.js reads VALIDATE_DATA_SHOWS_JSON to
 * override the shows.json path it validates; every other data file it reads
 * still resolves against the real data/ dir.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const VALIDATE = join(ROOT, 'scripts/validate-data.js');
const REAL_SHOWS_JSON = join(ROOT, 'data/shows.json');
// Mirror validate-data.js: prefer RUNNER_TEMP, fall back to /tmp.
const TMP_DIR = process.env.RUNNER_TEMP || '/tmp';
const SENTINEL = join(TMP_DIR, '.skip-push-core-data');

// Per-test throwaway copy of shows.json — never the real path. mkdtempSync gives
// each test its own directory so parallel `node --test` runs can't collide.
let fixtureDir;
function freshFixtureCopy() {
  fixtureDir = mkdtempSync(join(tmpdir(), 'validate-data-sentinel-'));
  const fixturePath = join(fixtureDir, 'shows.json');
  copyFileSync(REAL_SHOWS_JSON, fixturePath);
  return fixturePath;
}
function cleanupFixture() {
  if (fixtureDir) { try { rmSync(fixtureDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ } }
  fixtureDir = undefined;
}
process.on('exit', cleanupFixture);

function plantSyntheticBadRow(fixturePath) {
  const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
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
  writeFileSync(fixturePath, JSON.stringify(data, null, 2));
}

function runValidate(fixturePath) {
  try {
    execFileSync('node', [VALIDATE], {
      stdio: 'pipe',
      env: { ...process.env, VALIDATE_DATA_SHOWS_JSON: fixturePath },
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

describe('validate-data.js — push-refusal sentinel contract (Notion 362637c5-416f-8174)', () => {
  // Skip the whole suite if data isn't symlinked (CI without core-data checkout).
  if (!existsSync(REAL_SHOWS_JSON)) {
    test('[skip] data/shows.json absent in this context', () => {});
    return;
  }

  test('clean shows.json → exit 0, no sentinel written', () => {
    const fixturePath = freshFixtureCopy();
    try {
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
      const code = runValidate(fixturePath);
      assert.strictEqual(code, 0, 'expected exit 0 on clean shows.json');
      assert.strictEqual(existsSync(SENTINEL), false,
        'sentinel was written even though validate succeeded — push-core-data would be wrongly blocked');
    } finally {
      cleanupFixture();
    }
  });

  test('corrupt shows.json → exit 1, sentinel written with marker', () => {
    const fixturePath = freshFixtureCopy();
    try {
      plantSyntheticBadRow(fixturePath);
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
      const code = runValidate(fixturePath);
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
      cleanupFixture();
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
    }
  });

  test('stale sentinel from prior failure → cleared on subsequent success', () => {
    // Plant a stale sentinel, then run validate on clean data, assert it's gone.
    const fixturePath = freshFixtureCopy();
    try {
      writeFileSync(SENTINEL, 'stale sentinel from a prior run\n');
      const code = runValidate(fixturePath);
      assert.strictEqual(code, 0, 'expected exit 0 on clean shows.json');
      assert.strictEqual(existsSync(SENTINEL), false,
        'success path did not clear stale sentinel — a single past failure would permanently block push');
    } finally {
      cleanupFixture();
    }
  });

  // Codex found two process.exit(1) paths in validate-data.js that bypassed the
  // sentinel before the refactor (missing shows.json, parse error). These tests
  // lock the coverage: if a future edit splits a new exit path off without going
  // through exitWithError(), this test fails.
  test('unparseable shows.json → exit 1, sentinel written (early-exit path coverage)', () => {
    const fixturePath = freshFixtureCopy();
    try {
      writeFileSync(fixturePath, '{not json'); // truncated/invalid
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
      const code = runValidate(fixturePath);
      assert.strictEqual(code, 1, 'expected exit 1 on unparseable shows.json');
      assert.strictEqual(existsSync(SENTINEL), true,
        'sentinel NOT written on parse-error exit path — push-core-data would be unguarded');
      assert.match(readFileSync(SENTINEL, 'utf8'), /parse error/i,
        'sentinel reason should mention the parse error');
    } finally {
      cleanupFixture();
      if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
    }
  });
});
