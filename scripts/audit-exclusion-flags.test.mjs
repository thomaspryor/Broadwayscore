/**
 * BRO-2237: audit-exclusion-flags.js runs on a schedule, report-only.
 *
 * Pins three things:
 *   1. check-corpus-drift.yml (a scheduled workflow) runs the sweep with
 *      `--gate --max=0`, so any new essay-intro false positive surfaces.
 *   2. No workflow ever passes --apply to it (BRO-2090: an unattended
 *      exclusion-flag drain stripped 64 correct flags).
 *   3. The real script, pointed at a synthetic corpus, exits 1 with count 1 on
 *      one matching file, exits 0 on a clean corpus, and never writes to the
 *      review files or the tracked audit log.
 *
 * Run: node --test scripts/audit-exclusion-flags.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-exclusion-flags.js');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const TRACKED_LOG = path.join(ROOT, 'data', 'audit', 'exclusion-flags-audit.json');

// Same shape as tests/unit/essay-intro-nonreview-fp.test.mjs's DOLLY_FIXTURE,
// a confirmed real-corpus essay-intro false positive.
const BIO = 'Dolly Rebecca Parton is an American singer, songwriter, musician, actress, and philanthropist, widely recognized for her significant contributions to country music. '.repeat(3);
const BODY = 'ABOUT THE MUSICAL Directed by Tony Award winner Bartlett Sher, DOLLY: A True Original Musical premiered at the Fisher Center for the Performing Arts at Belmont University in Nashville. '
  + 'The cast delivers performances that remain faithful to the essence of each character. '.repeat(30)
  + 'A production filled with music, emotion, and talent that no theater lover should miss.';
const FP_FILE = {
  showId: 'dolly-a-true-original-musical-regional-2025',
  showTitle: 'Dolly: A True Original Musical',
  venue: 'Fisher Center for the Performing Arts, Nashville, TN',
  isNonReview: true,
  nonReviewType: 'preview',
  nonReviewClassifiedBy: 'gemini',
  fullText: BIO + BODY,
};
const CLEAN_FILE = { ...FP_FILE, isNonReview: false };

function workflowFiles() {
  return fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(WORKFLOWS, f));
}

test('check-corpus-drift.yml runs audit-exclusion-flags.js --gate --max=0 on a schedule', () => {
  const yml = fs.readFileSync(path.join(WORKFLOWS, 'check-corpus-drift.yml'), 'utf8');
  const onBlock = yml.slice(yml.indexOf('\non:'), yml.indexOf('\njobs:'));
  assert.match(onBlock, /\n\s+schedule:\s*\n(?:\s*#.*\n)*\s+-\s+cron:/, 'workflow must be scheduled');
  assert.match(yml, /node scripts\/audit-exclusion-flags\.js --gate --max=0 --json/, 'gated, zero-tolerance invocation present');
});

test('no workflow passes --apply to audit-exclusion-flags.js (BRO-2090)', () => {
  for (const file of workflowFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      if (/^\s*#/.test(line)) continue;
      // An invocation: `node [path/]audit-exclusion-flags.js ...` (an env
      // prefix before `node` is fine). Prose in echo messages is not one.
      if (/\bnode\s+(?:\S*\/)?audit-exclusion-flags\.js\b/.test(line)) {
        assert.ok(!/--apply/.test(line), `${path.basename(file)}:${i + 1} runs audit-exclusion-flags.js with --apply`);
      }
    }
  }
});

function runSweep(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2237-'));
  const corpus = path.join(dir, 'review-texts');
  const showDir = path.join(corpus, FP_FILE.showId);
  fs.mkdirSync(showDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(showDir, name), JSON.stringify(data, null, 2));
  const before = Object.fromEntries(Object.keys(files).map((n) => [n, fs.readFileSync(path.join(showDir, n), 'utf8')]));
  const log = path.join(dir, 'log.json');
  const trackedBefore = fs.existsSync(TRACKED_LOG) ? fs.readFileSync(TRACKED_LOG, 'utf8') : null;
  const res = spawnSync(process.execPath, [SCRIPT, '--gate', '--max=0', '--json'], {
    env: { ...process.env, REVIEW_TEXTS_DIR: corpus, EXCLUSION_FLAGS_AUDIT_LOG: log },
    encoding: 'utf8',
  });
  const after = Object.fromEntries(Object.keys(files).map((n) => [n, fs.readFileSync(path.join(showDir, n), 'utf8')]));
  const trackedAfter = fs.existsSync(TRACKED_LOG) ? fs.readFileSync(TRACKED_LOG, 'utf8') : null;
  return { res, before, after, log, trackedBefore, trackedAfter };
}

test('gate exits 1 with count 1 on one essay-intro false positive, and writes nothing to the corpus', () => {
  const { res, before, after, log, trackedBefore, trackedAfter } = runSweep({ 'fp.json': FP_FILE, 'clean.json': CLEAN_FILE });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scanned, 2);
  assert.equal(out.count, 1);
  assert.equal(out.applied, false);
  assert.deepEqual(after, before, 'report-only: review files unchanged');
  assert.ok(fs.existsSync(log), 'log written to the EXCLUSION_FLAGS_AUDIT_LOG override');
  assert.equal(trackedAfter, trackedBefore, 'tracked data/audit log untouched');
});

test('gate exits 0 on a corpus with no false positives', () => {
  const { res } = runSweep({ 'clean.json': CLEAN_FILE });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scanned, 1);
  assert.equal(out.count, 0);
});
