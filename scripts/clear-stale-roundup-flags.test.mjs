/**
 * Tests for scripts/clear-stale-roundup-flags.js (BRO-2323).
 *
 * BRO-2323's complaint was that the predicate script existed
 * (isLikelyStaleRoundupFlag, already exhaustively unit-tested in
 * tests/unit/is-likely-stale-roundup-flag.test.mjs) but had no scheduled
 * workflow, so the backlog it finds silently grows forever. Two things need
 * covering, matching the acceptance criteria:
 *
 *   1. A scheduled workflow actually exists and wires up this script — a
 *      config-only regression (workflow file renamed/deleted, cron removed)
 *      would otherwise reopen exactly this bug with no test noticing.
 *   2. The script itself, run end-to-end as the real CLI (not a copy of its
 *      logic — CLAUDE.md §15), correctly clears stale isRoundupArticle flags
 *      and leaves genuine roundup articles alone, via its --dir= override
 *      against a throwaway fixture directory.
 *
 * Run: node --test scripts/clear-stale-roundup-flags.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'clear-stale-roundup-flags.js');
const REPO_ROOT = path.join(__dirname, '..');

const longReviewText = 'A real critic review with substance. '.repeat(40); // ~1480 chars, clears the 800-char gate

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clear-stale-roundup-flags-'));
}

function writeReview(dir, showId, file, data) {
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n');
}

function readReview(dir, showId, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, showId, file), 'utf8'));
}

function run(dir, args = []) {
  return execFileSync(process.execPath, [SCRIPT, `--dir=${dir}`, ...args], { encoding: 'utf8' });
}

// --- 1. Scheduled workflow exists ---

test('a scheduled GitHub Actions workflow runs clear-stale-roundup-flags.js', () => {
  const workflowPath = path.join(REPO_ROOT, '.github', 'workflows', 'clear-stale-roundup-flags.yml');
  assert.ok(fs.existsSync(workflowPath),
    'no .github/workflows/clear-stale-roundup-flags.yml — the script has no scheduled workflow (BRO-2323)');

  const yml = fs.readFileSync(workflowPath, 'utf8');
  assert.match(yml, /\n\s*schedule:\n(?:\s*#.*\n)*\s*-\s*cron:\s*'[^']+'/,
    'workflow file exists but has no schedule/cron trigger — a workflow_dispatch-only file would still leave the backlog to grow unattended');
  assert.match(yml, /clear-stale-roundup-flags\.js/,
    'workflow file exists but never invokes scripts/clear-stale-roundup-flags.js');
});

// --- 2. Predicate applied end-to-end via the real CLI ---

test('--apply clears a stale flag (individual review on a whitelisted per-outlet URL) and leaves a genuine roundup page flagged', () => {
  const dir = makeFixtureDir();
  try {
    // Stale: Clyde Fitch Report individual-review URL, long text, isFullReview.
    writeReview(dir, 'fixture-show-2026', 'clydefitchreport--critic.json', {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.clydefitchreport.com/2026/03/fixture-show-review/',
    });
    // Genuine roundup: The Stage round-ups page — must NOT be cleared.
    writeReview(dir, 'fixture-show-2026', 'thestage--roundup.json', {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.thestage.co.uk/review-round-ups/fixture-show',
    });
    // Not flagged at all — must stay completely untouched.
    writeReview(dir, 'fixture-show-2026', 'unflagged--critic.json', {
      isRoundupArticle: false,
      fullText: longReviewText,
      url: 'https://example.com/fixture-show-review',
    });

    const dryRun = run(dir);
    assert.match(dryRun, /Stale \(would clear\): 1/);

    // Dry run must not have written anything.
    assert.equal(readReview(dir, 'fixture-show-2026', 'clydefitchreport--critic.json').isRoundupArticle, true);

    const applied = run(dir, ['--apply']);
    assert.match(applied, /APPLIED — cleared 1 files\./);

    const stale = readReview(dir, 'fixture-show-2026', 'clydefitchreport--critic.json');
    assert.equal(stale.isRoundupArticle, false, 'stale flag on the individual review must be cleared');
    const today = new Date().toISOString().slice(0, 10);
    assert.match(stale.roundupArticleClearedNote, new RegExp(`^\\[${today} cleared stale isRoundupArticle`),
      'note must stamp the CURRENT date, not a hardcoded one — a hardcoded date silently mis-dates every future run of the scheduled cron');

    const genuine = readReview(dir, 'fixture-show-2026', 'thestage--roundup.json');
    assert.equal(genuine.isRoundupArticle, true, 'genuine roundup page must keep its flag');
    assert.equal(genuine.roundupArticleClearedNote, undefined);

    const unflagged = readReview(dir, 'fixture-show-2026', 'unflagged--critic.json');
    assert.equal(unflagged.isRoundupArticle, false);
    assert.equal(unflagged.roundupArticleClearedNote, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--show= filter limits the sweep to a single show directory', () => {
  const dir = makeFixtureDir();
  try {
    writeReview(dir, 'fixture-show-a', 'clydefitchreport--critic.json', {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.clydefitchreport.com/2026/03/fixture-show-a-review/',
    });
    writeReview(dir, 'fixture-show-b', 'interestedbystander--critic.json', {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.interestedbystander.com/2026/03/fixture-show-b-review.html',
    });

    run(dir, ['--apply', '--show=fixture-show-a']);

    assert.equal(readReview(dir, 'fixture-show-a', 'clydefitchreport--critic.json').isRoundupArticle, false);
    assert.equal(readReview(dir, 'fixture-show-b', 'interestedbystander--critic.json').isRoundupArticle, true,
      'show outside the --show= filter must be left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. Surge guard ---

function writeSurgeFixtures(dir, count) {
  for (let i = 0; i < count; i++) {
    writeReview(dir, `fixture-surge-show-${i}`, 'clydefitchreport--critic.json', {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: `https://www.clydefitchreport.com/2026/03/fixture-surge-${i}/`,
    });
  }
}

test('surge guard refuses a >50-file --apply without --force-bulk, and writes nothing', () => {
  const dir = makeFixtureDir();
  try {
    writeSurgeFixtures(dir, 51);

    assert.throws(() => run(dir, ['--apply']), /Command failed/);

    // Refused surge — every file must still carry its original flag.
    for (let i = 0; i < 51; i++) {
      assert.equal(
        readReview(dir, `fixture-surge-show-${i}`, 'clydefitchreport--critic.json').isRoundupArticle,
        true,
        `fixture-surge-show-${i} was written despite the surge guard refusing`
      );
    }

    // --force-bulk overrides the refusal.
    const forced = run(dir, ['--apply', '--force-bulk']);
    assert.match(forced, /APPLIED — cleared 51 files\./);
    assert.equal(readReview(dir, 'fixture-surge-show-0', 'clydefitchreport--critic.json').isRoundupArticle, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('surge guard does NOT refuse exactly at the threshold (50 files)', () => {
  const dir = makeFixtureDir();
  try {
    writeSurgeFixtures(dir, 50);

    const applied = run(dir, ['--apply']);
    assert.match(applied, /APPLIED — cleared 50 files\./);
    assert.equal(readReview(dir, 'fixture-surge-show-0', 'clydefitchreport--critic.json').isRoundupArticle, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
