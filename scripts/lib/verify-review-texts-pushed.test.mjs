// BRO-3954: unit tests for verify-review-texts-pushed.js, the shared helper
// that catches the exact incident class this card audits — a --apply script
// wrote review-text JSON locally, the session claimed it verified+pushed via
// a git-log check against the WRONG repo, and the data-repo edit was never
// pushed at all. Builds a real local origin+clone fixture per test (execFileSync
// git, same integration-over-mock approach push-diagnostics.test.mjs uses for
// its shell-adjacent logic) rather than mocking child_process, so a real git
// fetch/show round-trip is what's actually exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyReviewTextsPushed } from './verify-review-texts-pushed.js';

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

// origin (bare) + a clone that stands in for the local data/review-texts checkout.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-rt-pushed-'));
  const originDir = path.join(root, 'origin.git');
  const cloneDir = path.join(root, 'clone');
  sh('git', ['init', '--bare', '-b', 'main', originDir]);
  sh('git', ['clone', originDir, cloneDir]);
  sh('git', ['config', 'user.email', 'test@example.com'], cloneDir);
  sh('git', ['config', 'user.name', 'Test'], cloneDir);
  fs.mkdirSync(path.join(cloneDir, 'some-show'), { recursive: true });
  const filePath = path.join(cloneDir, 'some-show', 'outlet--critic.json');
  fs.writeFileSync(filePath, JSON.stringify({ wrongShow: false }, null, 2) + '\n');
  sh('git', ['add', '-A'], cloneDir);
  sh('git', ['commit', '-m', 'seed'], cloneDir);
  sh('git', ['push', 'origin', 'main'], cloneDir);
  return { root, cloneDir, filePath };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('ok:false when reviewTextsDir has no .git checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-rt-pushed-nogit-'));
  try {
    const result = verifyReviewTextsPushed([path.join(dir, 'x.json')], { reviewTextsDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not a git checkout/);
  } finally {
    cleanup(dir);
  }
});

test('ok:true when the written file is committed and pushed to origin/main', () => {
  const { root, cloneDir, filePath } = makeFixture();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ wrongShow: true }, null, 2) + '\n');
    sh('git', ['add', '-A'], cloneDir);
    sh('git', ['commit', '-m', 'promote wrongShow'], cloneDir);
    sh('git', ['push', 'origin', 'main'], cloneDir);

    const result = verifyReviewTextsPushed([filePath], { reviewTextsDir: cloneDir });
    assert.equal(result.ok, true);
  } finally {
    cleanup(root);
  }
});

test('ok:false — reproduces the BRO-3954 incident: written+committed locally, never pushed', () => {
  const { root, cloneDir, filePath } = makeFixture();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ wrongShow: true }, null, 2) + '\n');
    sh('git', ['add', '-A'], cloneDir);
    sh('git', ['commit', '-m', 'promote wrongShow (never pushed)'], cloneDir);
    // Deliberately no `git push` — this is the exact incident shape.

    const result = verifyReviewTextsPushed([filePath], { reviewTextsDir: cloneDir });
    assert.equal(result.ok, false);
    assert.deepEqual(result.notPushed, ['some-show/outlet--critic.json']);
  } finally {
    cleanup(root);
  }
});

test('ok:false — written on disk but never even committed', () => {
  const { root, cloneDir, filePath } = makeFixture();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ wrongShow: true }, null, 2) + '\n');
    // No add, no commit, no push.
    const result = verifyReviewTextsPushed([filePath], { reviewTextsDir: cloneDir });
    assert.equal(result.ok, false);
    assert.deepEqual(result.notPushed, ['some-show/outlet--critic.json']);
  } finally {
    cleanup(root);
  }
});

test('ok:true — key order / whitespace differences alone do not count as unpushed', () => {
  const { root, cloneDir, filePath } = makeFixture();
  try {
    // origin/main has {"wrongShow":false}; write a reformatted-but-equivalent
    // local copy with the SAME values, never committed.
    fs.writeFileSync(filePath, JSON.stringify({ wrongShow: false }, null, 4) + '\n\n');
    const result = verifyReviewTextsPushed([filePath], { reviewTextsDir: cloneDir });
    assert.equal(result.ok, true);
  } finally {
    cleanup(root);
  }
});

test('empty filePaths list is trivially ok (nothing to verify)', () => {
  const { root, cloneDir } = makeFixture();
  try {
    const result = verifyReviewTextsPushed([], { reviewTextsDir: cloneDir });
    assert.equal(result.ok, true);
  } finally {
    cleanup(root);
  }
});
