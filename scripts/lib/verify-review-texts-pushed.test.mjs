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

test('ok:true — whitespace/indentation differences alone do not count as unpushed', () => {
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

test('ok:true — real key REORDER (not just whitespace) does not count as unpushed', () => {
  // Codex ship-check finding: JSON.stringify(JSON.parse(x)) alone preserves key
  // insertion order, so the original normalizeJson did NOT actually tolerate
  // reordered keys despite claiming to — this is the test that would have
  // caught it (the old test used a single-key object, which can't exercise
  // ordering at all).
  const { root, cloneDir, filePath } = makeFixture();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ wrongShow: false, url: 'https://example.com/x', outlet: 'variety' }));
    sh('git', ['add', '-A'], cloneDir);
    sh('git', ['commit', '-m', 'multi-key seed'], cloneDir);
    sh('git', ['push', 'origin', 'main'], cloneDir);

    // Same values, DIFFERENT key order, never committed.
    fs.writeFileSync(filePath, JSON.stringify({ outlet: 'variety', wrongShow: false, url: 'https://example.com/x' }));
    const result = verifyReviewTextsPushed([filePath], { reviewTextsDir: cloneDir });
    assert.equal(result.ok, true);
  } finally {
    cleanup(root);
  }
});

test('opts.predicate: ok:true when origin/main satisfies the postcondition, even if local disk has been reverted', () => {
  // Reproduces the Codex-found "lost edit passes verification" false success:
  // a rebase (or anything else) can revert local disk back to the pre-fix
  // content AFTER a real push already landed the fix on origin/main. A plain
  // local-vs-remote diff would then compare two matching-but-WRONG copies and
  // report ok:true for the wrong reason; the predicate checks origin/main's
  // actual content against the real postcondition instead of trusting local
  // disk as a proxy for it.
  const { root, cloneDir, filePath } = makeFixture();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ wrongShow: true }, null, 2) + '\n');
    sh('git', ['add', '-A'], cloneDir);
    sh('git', ['commit', '-m', 'promote wrongShow'], cloneDir);
    sh('git', ['push', 'origin', 'main'], cloneDir);

    // Local disk reverted back to the pre-fix state after the push landed.
    fs.writeFileSync(filePath, JSON.stringify({ wrongShow: false }, null, 2) + '\n');

    const result = verifyReviewTextsPushed([filePath], {
      reviewTextsDir: cloneDir,
      predicate: (data) => data.wrongShow === true,
    });
    assert.equal(result.ok, true);
  } finally {
    cleanup(root);
  }
});

test('opts.predicate: ok:false — reproduces the exact false-success case a bare diff would miss', () => {
  // Local disk and origin/main AGREE (both lack the fix) — a bare diff sees no
  // difference and would report ok:true. The predicate catches it because it
  // checks the real postcondition against origin/main, not "does local match
  // remote".
  const { root, cloneDir, filePath } = makeFixture();
  try {
    // origin/main still has the seeded {"wrongShow": false} — never promoted.
    // Local disk also reads {"wrongShow": false} (e.g. a rebase silently
    // dropped an earlier local write) — a bare diff would find them equal.
    const result = verifyReviewTextsPushed([filePath], {
      reviewTextsDir: cloneDir,
      predicate: (data) => data.wrongShow === true,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.notPushed, ['some-show/outlet--critic.json']);
  } finally {
    cleanup(root);
  }
});

test('opts.predicate: ok:false — file missing on origin/main at all', () => {
  const { root, cloneDir, filePath } = makeFixture();
  try {
    const result = verifyReviewTextsPushed([path.join(cloneDir, 'some-show', 'nope.json')], {
      reviewTextsDir: cloneDir,
      predicate: () => true,
    });
    assert.equal(result.ok, false);
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
