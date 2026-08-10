import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Task #94: Lint Workflows was red because a stale regex in
// lint-write-routing.sh flagged notion-action-poll.js as writing to
// data/review-texts/ without safeWriteReview. It doesn't — its only
// writeFileSync targets scripts/agent-memory/, and 'data/review-texts'
// appears solely as a symlink dep-existence check in provisionActionWorktree().
// The fix was a documented exemption in .review-write-guard-exempt.txt.
// This test runs the REAL guard script (shared with the pre-push hook) so a
// future edit that reintroduces an actual unguarded review-texts write here
// still gets caught, instead of silently relying on the allowlist forever.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('notion-action-poll.js has no writeFileSync call touching data/review-texts/', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/notion-action-poll.js'), 'utf8');
  const writeFileCalls = src.match(/fs\.(writeFileSync|promises\.writeFile)\([^)]*\)/g) || [];
  for (const call of writeFileCalls) {
    assert.ok(
      !/review-texts|REVIEW_TEXTS_DIR|REVIEW_TEXTS_BASE|rtDir|reviewsDir|REVIEW_TEXTS_ROOT/.test(call),
      `write call targets a review-texts path — must route through safeWriteReview: ${call}`
    );
  }
});

test('notion-action-poll.js is either exempt-listed or safeWriteReview-wired — the CI gate passes', () => {
  const exempt = fs.readFileSync(path.join(REPO_ROOT, '.review-write-guard-exempt.txt'), 'utf8');
  const isExempt = exempt.split('\n').some((line) => line.trim().startsWith('notion-action-poll.js'));
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/notion-action-poll.js'), 'utf8');
  assert.ok(isExempt || src.includes('safeWriteReview'), 'must be allowlisted with a reason or import safeWriteReview');
});

test('lint-write-routing.sh review-texts exits 0 (the actual CI gate)', () => {
  const output = execFileSync('bash', ['scripts/lint-write-routing.sh', 'review-texts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.ok(!output.includes('notion-action-poll.js'), `guard still flags notion-action-poll.js:\n${output}`);
});
