/**
 * BRO-2276: rebuild-all-reviews.js's review-count regression guard only ever
 * warned and proceeded with the write, even at 99%+ loss, with zero
 * local-vs-CI awareness. A cloud-bootstrapped worktree whose data/review-texts
 * was a stub/partial checkout triggered the guard against a real, symlinked
 * reviews.json (BRO-749, 2026-08-21) — caught and reverted manually that time,
 * but nothing in the code would have stopped a less careful session, or one
 * that auto-commits, from pushing near-total data loss.
 *
 * evaluateReviewCountRegression() (scripts/lib/regression-guard.js) is the
 * pure decision function wired into rebuild-all-reviews.js's guard, now with
 * a local-only hard block above LOCAL_HARD_BLOCK_PCT loss. checkReviewTextsPreflight()
 * (scripts/lib/review-texts-preflight.js) is the earlier line of defense wired
 * into gather-reviews.js's rebuildReviewsJson(): it refuses to even spawn the
 * rebuild subprocess against a stub review-texts checkout.
 *
 * Run: node --test tests/unit/rebuild-all-reviews.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateReviewCountRegression,
  isRunningInCI,
  WARN_THRESHOLD_PCT,
  LOCAL_HARD_BLOCK_PCT,
} = require('../../scripts/lib/regression-guard.js');
const { checkReviewTextsPreflight, MIN_SHOW_DIRS } = require('../../scripts/lib/review-texts-preflight.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('evaluateReviewCountRegression', () => {
  test('no existing reviews.json (first run) → ok, no crash', () => {
    const d = evaluateReviewCountRegression({ existingCount: 0, newCount: 500, forceWrite: false, isCI: false });
    assert.equal(d.action, 'ok');
  });

  test('count increased → ok', () => {
    const d = evaluateReviewCountRegression({ existingCount: 1000, newCount: 1200, forceWrite: false, isCI: false });
    assert.equal(d.action, 'ok');
  });

  test(`loss within ${WARN_THRESHOLD_PCT}% threshold → ok (proceeds silently-ish)`, () => {
    const d = evaluateReviewCountRegression({ existingCount: 1000, newCount: 990, forceWrite: false, isCI: false });
    assert.equal(d.action, 'ok');
    assert.equal(d.lost, 10);
  });

  test('CI run losing 20% → warn, not block (CI always has a fresh full checkout)', () => {
    const d = evaluateReviewCountRegression({ existingCount: 1000, newCount: 800, forceWrite: false, isCI: true });
    assert.equal(d.action, 'warn');
  });

  test('CI run losing 99.8% → still only warn, never block (CI is trusted to have a full checkout)', () => {
    const d = evaluateReviewCountRegression({ existingCount: 20000, newCount: 35, forceWrite: false, isCI: true });
    assert.equal(d.action, 'warn');
  });

  test(`local run losing 20% (above warn, at/below ${LOCAL_HARD_BLOCK_PCT}% ceiling) → warn, not block`, () => {
    const d = evaluateReviewCountRegression({ existingCount: 1000, newCount: 800, forceWrite: false, isCI: false });
    assert.equal(d.action, 'warn');
  });

  test('local run losing >50% → BLOCK — the exact BRO-749 scenario (99.8% loss, stub review-texts)', () => {
    const d = evaluateReviewCountRegression({ existingCount: 19912, newCount: 35, forceWrite: false, isCI: false });
    assert.equal(d.action, 'block');
    assert.equal(d.lost, 19877);
    assert.equal(d.pctLost, 99.8);
  });

  test('--force-write always overrides the block, even for a local >50% loss', () => {
    const d = evaluateReviewCountRegression({ existingCount: 19912, newCount: 35, forceWrite: true, isCI: false });
    assert.equal(d.action, 'warn-suppressed');
  });

  test('--force-write also overrides a CI warn', () => {
    const d = evaluateReviewCountRegression({ existingCount: 1000, newCount: 500, forceWrite: true, isCI: true });
    assert.equal(d.action, 'warn-suppressed');
  });
});

describe('isRunningInCI', () => {
  test('detects CI=true', () => {
    assert.equal(isRunningInCI({ CI: 'true' }), true);
  });
  test('detects GITHUB_ACTIONS=true', () => {
    assert.equal(isRunningInCI({ GITHUB_ACTIONS: 'true' }), true);
  });
  test('neither set → false', () => {
    assert.equal(isRunningInCI({}), false);
  });
});

describe('checkReviewTextsPreflight (simulated stub review-texts dir)', () => {
  let tmpDir;
  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2276-review-texts-'));
  });
  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('missing directory entirely → not ok', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const r = checkReviewTextsPreflight(missing);
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not exist/);
  });

  test('stub dir with 1 show (BRO-749: cloud-bootstrap scoped to one show) → not ok', () => {
    fs.mkdirSync(path.join(tmpDir, 'some-show-2026'));
    const r = checkReviewTextsPreflight(tmpDir);
    assert.equal(r.ok, false);
    assert.equal(r.showDirCount, 1);
    assert.match(r.reason, /stub\/partial checkout/);
  });

  test(`dir with ${MIN_SHOW_DIRS} show directories → ok`, () => {
    for (let i = 0; i < MIN_SHOW_DIRS; i++) {
      fs.mkdirSync(path.join(tmpDir, `show-${i}`));
    }
    const r = checkReviewTextsPreflight(tmpDir);
    assert.equal(r.ok, true);
    assert.equal(r.showDirCount, MIN_SHOW_DIRS);
  });

  test('custom minShowDirs override is respected', () => {
    fs.mkdirSync(path.join(tmpDir, 'show-a'));
    fs.mkdirSync(path.join(tmpDir, 'show-b'));
    const r = checkReviewTextsPreflight(tmpDir, { minShowDirs: 2 });
    assert.equal(r.ok, true);
  });

  test('stray files and dotfiles in review-texts are not counted as show dirs', () => {
    fs.writeFileSync(path.join(tmpDir, 'failed-fetches.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.mkdirSync(path.join(tmpDir, 'real-show'));
    const r = checkReviewTextsPreflight(tmpDir, { minShowDirs: 1 });
    assert.equal(r.showDirCount, 1);
  });
});

describe('wiring: rebuild-all-reviews.js guard', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'rebuild-all-reviews.js'), 'utf8');

  test('requires evaluateReviewCountRegression + isRunningInCI from lib/regression-guard', () => {
    assert.match(src, /require\(['"]\.\/lib\/regression-guard['"]\)/);
    assert.match(src, /evaluateReviewCountRegression/);
    assert.match(src, /isRunningInCI\(\)/);
  });

  test('a block action calls process.exit(1) before returning', () => {
    const guardBlockIdx = src.indexOf("action === 'block'");
    assert.ok(guardBlockIdx > -1, 'guard must branch on action === "block"');
    const afterBlock = src.slice(guardBlockIdx, guardBlockIdx + 2000);
    assert.match(afterBlock, /process\.exit\(1\)/,
      'the block branch must call process.exit(1) so the write never happens');
  });

  test('--force-write flag is still parsed and threaded through', () => {
    assert.match(src, /forceWrite\s*=\s*process\.argv\.includes\(['"]--force-write['"]\)/);
  });

  test('the guard block sits BEFORE the reviews.json write', () => {
    const guardIdx = src.indexOf('REVIEW COUNT REGRESSION GUARD');
    const writeIdx = src.indexOf('Write output atomically');
    assert.ok(guardIdx > -1 && writeIdx > -1, 'both the guard and the write step must exist');
    assert.ok(guardIdx < writeIdx, 'the guard must run before the write, or blocking it is pointless');
  });
});

describe('wiring: gather-reviews.js preflight', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'gather-reviews.js'), 'utf8');

  test('requires checkReviewTextsPreflight + isRunningInCI', () => {
    assert.match(src, /require\(['"]\.\/lib\/review-texts-preflight['"]\)/);
    assert.match(src, /checkReviewTextsPreflight/);
  });

  test('rebuildReviewsJson() checks the preflight before spawning rebuild-all-reviews.js, and returns early on failure', () => {
    const fnStart = src.indexOf('async function rebuildReviewsJson()');
    assert.ok(fnStart > -1, 'rebuildReviewsJson function not found');
    const fnEnd = src.indexOf('\n}', fnStart);
    const body = src.slice(fnStart, fnEnd);
    const preflightIdx = body.indexOf('checkReviewTextsPreflight(');
    const execIdx = body.indexOf('execSync(');
    assert.ok(preflightIdx > -1, 'rebuildReviewsJson must call checkReviewTextsPreflight');
    assert.ok(execIdx > -1, 'rebuildReviewsJson must still spawn rebuild-all-reviews.js on the happy path');
    assert.ok(preflightIdx < execIdx, 'the preflight check must run before the rebuild subprocess is spawned');
    assert.match(body, /if\s*\(!preflight\.ok\)\s*{[\s\S]*?return;/,
      'a failed preflight must return early — never fall through to execSync');
  });
});
