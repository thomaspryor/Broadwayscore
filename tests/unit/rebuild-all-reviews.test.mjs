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

  test('50.04% loss blocks even though it would round to a displayed "50.0%" (compares the unrounded ratio, not the display value)', () => {
    // 5004 lost / 10000 existing = exactly 50.04% loss
    const d = evaluateReviewCountRegression({ existingCount: 10000, newCount: 4996, forceWrite: false, isCI: false });
    assert.equal(d.action, 'block');
    assert.equal(d.pctLost, 50.0); // display value still rounds to 50.0
  });

  test('exactly 50% loss does not block (boundary is > 50, not >=)', () => {
    const d = evaluateReviewCountRegression({ existingCount: 1000, newCount: 500, forceWrite: false, isCI: false });
    assert.equal(d.action, 'warn');
  });

  test('2026-03-24 historical incident, replayed: routine CI pipeline-cleanup drops (-756, -731, -335, -117, -109 of ~20,668) never block in CI', () => {
    // memory/roadmap.md "Rebuild Guard → Claude-Powered Drop Analysis": a prior
    // unconditional process.exit(1) on this file's guards blocked CI in a retry
    // loop for 10 days over drops that were routine dedup/flagging/domain-
    // validation cleanup, not corruption — the exits were removed in favor of
    // post-hoc qualitative review (analyze-rebuild-drops.js). The local hard
    // block added for BRO-2276 must never regress this: replayed in CI, every
    // one of these historical counts must resolve to 'warn' or 'ok', never 'block'.
    const existingCount = 20668;
    for (const lost of [756, 731, 335, 117, 109]) {
      const d = evaluateReviewCountRegression({ existingCount, newCount: existingCount - lost, forceWrite: false, isCI: true });
      assert.notEqual(d.action, 'block', `a CI drop of ${lost} reviews must never block`);
    }
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
  test('CI=false (a non-empty, truthy JS string) must NOT be misread as CI — a stray CI=false in the shell must not silently disable the local hard block', () => {
    assert.equal(isRunningInCI({ CI: 'false' }), false);
  });
  test('GITHUB_ACTIONS=0 must NOT be misread as CI', () => {
    assert.equal(isRunningInCI({ GITHUB_ACTIONS: '0' }), false);
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

  test('an unreadable/corrupted (but present) reviews.json blocks locally instead of silently falling through as "first run"', () => {
    const errIdx = src.indexOf('existingReadError');
    assert.ok(errIdx > -1, 'guard must track a distinct existingReadError (not just swallow every readFileSync/JSON.parse failure as first-run)');
    assert.match(src, /e\.code\s*!==\s*['"]ENOENT['"]/,
      'must distinguish "file genuinely does not exist" (ENOENT, a real first run) from any other read/parse failure (corrupted baseline)');
    const blockSection = src.slice(errIdx, errIdx + 1500);
    assert.match(blockSection, /existingReadError\s*&&\s*!forceWrite\s*&&\s*!isRunningInCI\(\)/,
      'the unreadable-baseline block must respect both --force-write and CI, same as the numeric block');
    assert.match(blockSection, /process\.exit\(1\)/,
      'an unreadable existing reviews.json must refuse the write, not proceed with an uncomputed loss %');
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
