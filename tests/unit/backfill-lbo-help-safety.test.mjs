/**
 * Regression tests for task #764: backfill-lbo-individual-stars.js's cousin
 * --help bug (#498 class — --help fell through to a real network+write
 * sweep) and the private-repo-wins candidate selection rule (the write path
 * previously kept whichever REVIEW_TEXTS_DIRS entry was scanned FIRST,
 * contradicting its own comment that the private repo is authoritative).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { safeWriteReview } = require('../../scripts/lib/review-write-guard');

const SCRIPT_PATH = path.join(process.cwd(), 'scripts/backfill-lbo-individual-stars.js');
const { selectCandidate, main } = require('../../scripts/backfill-lbo-individual-stars.js');

describe('backfill-lbo-individual-stars.js --help safety', () => {
  test('--help subprocess exits 0 and prints usage', () => {
    const stdout = execFileSync('node', [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
    assert.match(stdout, /backfill-lbo-individual-stars\.js/);
    assert.match(stdout, /Usage:/);
  });

  test('-h subprocess also exits 0 and prints usage', () => {
    const stdout = execFileSync('node', [SCRIPT_PATH, '-h'], { encoding: 'utf8' });
    assert.match(stdout, /Usage:/);
  });

  test('main() under --help never touches the filesystem (zero reads/writes)', async () => {
    const originalArgv = process.argv;
    const originalReaddir = fs.readdirSync;
    const originalWrite = fs.writeFileSync;
    const originalLog = console.log;
    let touched = false;
    const logs = [];
    fs.readdirSync = () => { touched = true; throw new Error('readdirSync must not run under --help'); };
    fs.writeFileSync = () => { touched = true; throw new Error('writeFileSync must not run under --help'); };
    console.log = (...args) => logs.push(args.join(' '));
    try {
      process.argv = ['node', SCRIPT_PATH, '--help'];
      await main();
    } finally {
      process.argv = originalArgv;
      fs.readdirSync = originalReaddir;
      fs.writeFileSync = originalWrite;
      console.log = originalLog;
    }
    assert.equal(touched, false, 'no fs read/write under --help');
    assert.ok(logs.some(l => l.includes('Usage:')), 'usage text printed');
  });
});

describe('selectCandidate — private-repo-wins rule', () => {
  test('no existing candidate: incoming wins regardless of private flag', () => {
    const incoming = { showDir: 's', file: 'f', url: 'u', private: false };
    assert.equal(selectCandidate(undefined, incoming), incoming);
  });

  test('main-repo entry found first, private-repo entry found second: private wins', () => {
    const mainEntry = { showDir: 's', file: 'f', url: 'https://main-repo-url', private: false };
    const privateEntry = { showDir: 's', file: 'f', url: 'https://private-repo-url', private: true };
    const result = selectCandidate(mainEntry, privateEntry);
    assert.equal(result, privateEntry);
    assert.equal(result.url, 'https://private-repo-url');
  });

  test('private-repo entry found first, main-repo entry found second: private still wins', () => {
    const privateEntry = { showDir: 's', file: 'f', url: 'https://private-repo-url', private: true };
    const mainEntry = { showDir: 's', file: 'f', url: 'https://main-repo-url', private: false };
    const result = selectCandidate(privateEntry, mainEntry);
    assert.equal(result, privateEntry);
    assert.equal(result.url, 'https://private-repo-url');
  });

  test('both entries private: existing (first-seen) is kept', () => {
    const first = { showDir: 's', file: 'f', url: 'https://first', private: true };
    const second = { showDir: 's', file: 'f', url: 'https://second', private: true };
    assert.equal(selectCandidate(first, second), first);
  });
});

describe('aggregator-contamination guard interaction (ship-check finding)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbo-star-write-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // Adversarial review (Codex + independent Claude subagent) flagged that
  // switching from raw fs.writeFileSync to safeWriteReview means
  // originalScoreNormalized can be nulled by review-write-guard.js's
  // aggregator-score contamination guard when the on-disk file already has a
  // non-null originalScore (merge mode restores it as a PROTECTED_FIELD
  // before the guard runs, so an explicit `originalScore = null` in the
  // script does NOT survive — it just gets restored). Verified this is not a
  // scoring regression: rebuild-helpers.js's getBestScore() reads
  // data.aggregatorStars directly for aggregator scoreSource (never
  // originalScoreNormalized, see effectiveOriginalScore ~line 559), so the
  // guard's normalization is the corpus-wide invariant working as intended,
  // not a bug in this script.
  test('common case: no pre-existing originalScore — aggregatorStars/scoreSource/originalScoreNormalized all land', () => {
    const fp = path.join(tmpDir, 'london-box-office--critic.json');
    fs.writeFileSync(fp, JSON.stringify({
      url: 'https://londonboxoffice.co.uk/review/x',
      source: 'lbo-individual',
    }, null, 2));

    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    d.aggregatorStars = '4/5';
    d.scoreSource = 'lbo-css-stars';
    d.originalScoreNormalized = 80;
    safeWriteReview(fp, d, { merge: true });

    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(after.aggregatorStars, '4/5');
    assert.equal(after.scoreSource, 'lbo-css-stars');
    assert.equal(after.originalScoreNormalized, 80);
  });

  test('legacy non-null originalScore on disk: guard normalizes originalScoreNormalized to null, but aggregatorStars (the field scoring reads) still lands', () => {
    const fp = path.join(tmpDir, 'london-box-office--critic2.json');
    fs.writeFileSync(fp, JSON.stringify({
      url: 'https://londonboxoffice.co.uk/review/y',
      source: 'lbo-individual',
      originalScore: '4/5', // stale legacy value from before this became an aggregator-scored file
    }, null, 2));

    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    d.aggregatorStars = '4/5';
    d.scoreSource = 'lbo-css-stars';
    d.originalScoreNormalized = 80;
    safeWriteReview(fp, d, { merge: true });

    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    // aggregatorStars is what rebuild-helpers.js getBestScore() actually
    // reads for aggregator scoreSource — this is the field that matters.
    assert.equal(after.aggregatorStars, '4/5');
    assert.equal(after.scoreSource, 'lbo-css-stars');
    // Documents the expected (not buggy) guard behavior: originalScore is a
    // PROTECTED_FIELD, so merge restores the stale value, and the
    // aggregator-contamination guard then nulls originalScore*/Normalized —
    // consistent with how gather-reviews.js/sweep-we-aggregators.js write.
    assert.equal(after.originalScore, null);
    assert.equal(after.originalScoreNormalized, null);
  });
});
