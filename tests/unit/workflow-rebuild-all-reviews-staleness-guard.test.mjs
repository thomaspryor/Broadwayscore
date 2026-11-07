import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * BRO-3162: every workflow job that runs scripts/rebuild-all-reviews.js must
 * carry the stale-checkout race guard. Without it, a review-texts push that
 * lands between the job's checkout and its rebuild is invisible to the
 * rebuild, which exits 0 and silently drops the new review from reviews.json
 * (BRO-3161: Kimberly Akimbo / The Times (UK), 2026-09-10). Only 3 of 23
 * callers had the guard; this test is glob-driven so a NEW caller is caught
 * by CI instead of by a later audit.
 *
 * Per job, for every step that invokes rebuild-all-reviews.js:
 *   - review-texts is checked out via ./.github/actions/checkout-review-texts
 *     earlier in the job (it records the checkout-time SHA);
 *   - a drift-sync step precedes it: ./.github/actions/sync-review-texts-drift,
 *     or the original inline guard (shouldRetryForStaleCheckout) in the
 *     same step (rebuild-reviews.yml / rebuild-fast.yml /
 *     fetch-guardian-reviews.yml);
 *   - a later step in the job runs scripts/check-rebuild-staleness.js
 *     (blocking) or scripts/check-rebuild-staleness-advisory.js (report-only,
 *     continue-on-error) with the same shows file.
 *
 * EXEMPT: step ids that deliberately skip the guard, with the reason.
 */
const EXEMPT = new Map([
  // Local-only readiness rebuild (continue-on-error, never published). It
  // runs after the fast_path rebuild, whose sync + verify already guard this
  // job; a second sync would treat the first sync's files as job-written.
  ['opening-night-poller.yml#poll#readiness_rebuild', 'local readiness-only rebuild'],
]);

const SHOWS_FILE = '/tmp/stale-checkout-shows.txt';

function invokesRebuild(run) {
  if (typeof run !== 'string') return false;
  return run.split('\n').some((line) => {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('echo')) return false;
    return /(^|\s|then\s+|if\s+)node scripts\/rebuild-all-reviews\.js\b/.test(t);
  });
}

function hasInlineGuard(step) {
  return typeof step.run === 'string' && step.run.includes('shouldRetryForStaleCheckout');
}

function isSyncStep(step) {
  return step.uses === './.github/actions/sync-review-texts-drift';
}

function isPreRebuildSync(step) {
  return isSyncStep(step) && !(step.with && step.with.mode === 'restore');
}

// Blocking guard (check-rebuild-staleness.js, the 3 original callers) or the
// report-only one (check-rebuild-staleness-advisory.js, BRO-3162 rollout).
const VERIFY_RE = /scripts\/check-rebuild-staleness(-advisory)?\.js/;

function isVerifyStep(step) {
  return typeof step.run === 'string'
    && VERIFY_RE.test(step.run)
    && step.run.includes(`--shows-file=${SHOWS_FILE}`);
}

function loadWorkflows() {
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((file) => ({ file, doc: yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')) }));
}

function rebuildSites() {
  const sites = [];
  for (const { file, doc } of loadWorkflows()) {
    for (const [jobId, job] of Object.entries((doc && doc.jobs) || {})) {
      const steps = (job && job.steps) || [];
      steps.forEach((step, idx) => {
        if (invokesRebuild(step.run)) sites.push({ file, jobId, steps, idx, step });
      });
    }
  }
  return sites;
}

test('rebuild-all-reviews.js is invoked by many workflows (matcher sanity)', () => {
  const files = new Set(rebuildSites().map((s) => s.file));
  assert.ok(files.size >= 15, `expected >=15 workflows to invoke rebuild-all-reviews.js, matcher found ${files.size}`);
  assert.ok(files.has('rebuild-reviews.yml'));
  assert.ok(files.has('gather-reviews.yml'));
});

test('every rebuild-all-reviews.js step carries the stale-checkout race guard', () => {
  const failures = [];
  for (const { file, jobId, steps, idx, step } of rebuildSites()) {
    const key = `${file}#${jobId}#${step.id || step.name}`;
    if (EXEMPT.has(key)) continue;
    const before = steps.slice(0, idx);
    const after = steps.slice(idx + 1);
    if (!before.some((s) => s.uses === './.github/actions/checkout-review-texts')) {
      failures.push(`${key}: no ./.github/actions/checkout-review-texts step before the rebuild`);
    }
    if (!hasInlineGuard(step) && !before.some(isPreRebuildSync)) {
      failures.push(`${key}: no ./.github/actions/sync-review-texts-drift step before the rebuild`);
    }
    if (!after.some(isVerifyStep)) {
      failures.push(`${key}: no check-rebuild-staleness.js --shows-file=${SHOWS_FILE} step after the rebuild`);
    }
  }
  assert.deepEqual(failures, [], `Unguarded rebuild-all-reviews.js callers:\n${failures.join('\n')}`);
});

test('the sync step sits right before its rebuild and shares its condition', () => {
  const failures = [];
  for (const { file, jobId, steps, idx, step } of rebuildSites()) {
    if (hasInlineGuard(step)) continue;
    const key = `${file}#${jobId}#${step.id || step.name}`;
    if (EXEMPT.has(key)) continue;
    const prev = steps[idx - 1];
    if (!prev || !isPreRebuildSync(prev)) {
      failures.push(`${key}: the step right before the rebuild must be the drift sync (anything in between reopens the race)`);
      continue;
    }
    if ((prev.if || '') !== (step.if || '')) {
      failures.push(`${key}: sync if: (${prev.if || 'none'}) differs from rebuild if: (${step.if || 'none'})`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('action-based verify steps are anchored on the rebuild outcome and stay advisory (rule 19)', () => {
  const failures = [];
  for (const { file, jobId, steps, idx, step } of rebuildSites()) {
    if (hasInlineGuard(step)) continue;
    const key = `${file}#${jobId}#${step.id || step.name}`;
    if (EXEMPT.has(key)) continue;
    const verify = steps.slice(idx + 1).find(isVerifyStep);
    if (!verify) continue; // reported by the coverage test above
    if (!step.id || !String(verify.if || '').includes(`steps.${step.id}.outcome == 'success'`)) {
      failures.push(`${key}: verify step must be gated on steps.<rebuild id>.outcome == 'success'`);
    }
    if (verify.run.includes('check-rebuild-staleness-advisory.js') && verify['continue-on-error'] !== true) {
      failures.push(`${key}: the advisory verify step must carry continue-on-error: true`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

function isRestoreStep(step) {
  return isSyncStep(step) && step.with && step.with.mode === 'restore';
}

test('action-based syncs are undone (mode: restore, if: always()) after the verify and before any review-texts push', () => {
  // Without the restore, the synced upstream files stay as uncommitted
  // checkout->tip diffs and push-review-texts' `git pull --rebase --autostash`
  // replays them over a NEWER tip: reverting later upstream edits or
  // resurrecting deleted files (BRO-3162 review finding).
  const failures = [];
  for (const { file, jobId, steps, idx, step } of rebuildSites()) {
    if (hasInlineGuard(step)) continue;
    const key = `${file}#${jobId}#${step.id || step.name}`;
    if (EXEMPT.has(key)) continue;
    const after = steps.slice(idx + 1);
    const verifyIdx = after.findIndex(isVerifyStep);
    const restoreIdx = after.findIndex(isRestoreStep);
    const pushIdx = after.findIndex((s) => s.uses === './.github/actions/push-review-texts'
      || (typeof s.run === 'string' && /cd data\/review-texts|-C data\/review-texts (push|commit)/.test(s.run)));
    if (restoreIdx === -1) {
      failures.push(`${key}: no sync-review-texts-drift (mode: restore) step after the rebuild`);
      continue;
    }
    if (verifyIdx !== -1 && restoreIdx < verifyIdx) {
      failures.push(`${key}: restore runs before the post-rebuild check, which needs the synced files`);
    }
    if (pushIdx !== -1 && pushIdx < restoreIdx) {
      failures.push(`${key}: a review-texts push runs before the restore`);
    }
    if (!String(after[restoreIdx].if || '').includes('always()')) {
      failures.push(`${key}: the restore step must run with if: always()`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('checkout-review-texts records the checkout-time SHA the sync action reads', () => {
  const action = fs.readFileSync(path.join(REPO_ROOT, '.github/actions/checkout-review-texts/action.yml'), 'utf8');
  assert.match(action, /review-texts-checkout-sha/);
  const sync = fs.readFileSync(path.join(REPO_ROOT, 'scripts/sync-review-texts-drift.js'), 'utf8');
  assert.match(sync, /review-texts-checkout-sha/);
});
