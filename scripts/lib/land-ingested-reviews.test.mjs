// BRO-4908: a single-URL ingest left reviews unscored because nothing pushed
// the file or dispatched scoring. Locks push-before-dispatch and that a failed
// push never dispatches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { landIngestedReviews } = require('./land-ingested-reviews.js');
const { isReviewTextsClone } = require('./review-texts-dir.js');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isCheckout is injected: /rt is not a real clone, and the refusal below is the
// point of the last two tests, so the other four say explicitly that it is one.
const base = {
  showId: 'rent-west-end-2026', reviewTextsDir: '/rt',
  touchedPaths: ['/rt/rent-west-end-2026/a.json'], newReviews: 1, message: 'm',
  log: () => {}, isCheckout: () => true,
};

test('pushes before dispatching scoring, scoped to the show', () => {
  const calls = [];
  const exec = (cmd) => { calls.push(cmd); return cmd.includes('status --porcelain') ? 'A  x' : ''; };
  const r = landIngestedReviews({ ...base, exec, only: ['llm-ensemble-score.yml'] });
  const pushIdx = calls.findIndex((c) => c.includes(' push origin main'));
  const dispIdx = calls.findIndex((c) => c.startsWith('gh workflow run llm-ensemble-score.yml -f show_id=rent-west-end-2026'));
  assert.ok(pushIdx >= 0 && dispIdx > pushIdx);
  assert.equal(calls.filter((c) => c.startsWith('gh workflow run')).length, 1);
  assert.deepEqual(r.dispatched.map((d) => d.ok), [true]);
});

test('failed push never dispatches', () => {
  const exec = (cmd) => { if (cmd.includes(' push origin main')) throw new Error('rejected'); return 'A  x'; };
  const calls = [];
  const r = landIngestedReviews({ ...base, exec: (c, o) => { calls.push(c); return exec(c, o); } });
  assert.equal(r.push.pushed, false);
  assert.equal(r.dispatched.length, 0);
  assert.ok(!calls.some((c) => c.startsWith('gh workflow run')));
});

test('clean tree with an earlier unpushed local commit still pushes', () => {
  const calls = [];
  const exec = (cmd) => { calls.push(cmd); if (cmd.includes('status --porcelain')) return ''; if (cmd.includes('rev-list')) return '1\n'; return ''; };
  const r = landIngestedReviews({ ...base, exec, only: ['llm-ensemble-score.yml'] });
  assert.ok(calls.some((c) => c.includes(' push origin main')));
  assert.equal(r.dispatched.length, 1);
});

test('multi-show fan-out dispatches scoring per child show', () => {
  const calls = [];
  const exec = (cmd) => { calls.push(cmd); return cmd.includes('status --porcelain') ? 'A  x' : ''; };
  const r = landIngestedReviews({ ...base, exec, extraShowIds: ['other-show'], only: ['llm-ensemble-score.yml'] });
  assert.equal(r.dispatched.length, 2);
  assert.ok(calls.some((c) => c.includes('show_id=other-show')));
});

// BRO-5936: the static source guard (review-texts-push-dir.test.mjs) only catches
// the shapes it knows, and in CI both review-texts roots are the same path, so
// nothing there can tell a wrong root from a right one. These two checks run
// against the dir and the paths themselves, which is what fails on the Mac.
test('refuses to push a review-texts dir that is not a checkout', () => {
  const calls = [];
  const r = landIngestedReviews({
    ...base, isCheckout: () => false,
    exec: (c) => { calls.push(c); return 'A  x'; },
  });
  assert.equal(r.push.pushed, false);
  assert.match(r.push.error, /not the review-texts clone/);
  assert.deepEqual(calls, [], 'git must not run at all — git -C <copy> walks up to the enclosing repo');
  assert.equal(r.dispatched.length, 0);
});

test('refuses to push paths written outside the dir being pushed', () => {
  const calls = [];
  const r = landIngestedReviews({
    ...base,
    touchedPaths: ['/Users/x/Broadwayscore/data/review-texts/rent-west-end-2026/a.json'],
    exec: (c) => { calls.push(c); return 'A  x'; },
  });
  assert.equal(r.push.pushed, false);
  assert.match(r.push.error, /outside \/rt/);
  assert.deepEqual(calls, []);
  assert.equal(r.dispatched.length, 0);
});

// Codex's second pass pointed reviewTextsDir at the Broadwayscore checkout
// itself: a `.git`-entry test passes, and `git add` would then run in the PUBLIC
// repo taking review paths as its own. The refusal needs the clone's identity,
// not just the presence of a repo.
test('a checkout that is not the review-texts clone is refused on its origin remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ident-'));
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere\n'); // worktree-style .git FILE
  fs.mkdirSync(path.join(dir, 'rent-west-end-2026'));
  try {
    assert.equal(isReviewTextsClone(dir, () => 'https://github.com/thomaspryor/Broadwayscore.git'), false);
    assert.equal(isReviewTextsClone(dir, () => ''), false, 'no origin at all is not the clone');
    // The same dir IS acceptable once origin names the review-texts repo, so the
    // check cannot be satisfied by the dir layout alone — and a worktree-style
    // .git file is accepted, which is what CI and the owner's Mac both have.
    assert.equal(
      isReviewTextsClone(dir, () => 'https://x-access-token:TOKEN@github.com/thomaspryor/broadway-review-texts.git'),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legitimate ..name path is not mistaken for an escape', () => {
  const calls = [];
  const r = landIngestedReviews({
    ...base, touchedPaths: ['/rt/..shadow-show/a.json'],
    exec: (c) => { calls.push(c); return c.includes('status --porcelain') ? 'A  x' : ''; },
    only: ['llm-ensemble-score.yml'],
  });
  assert.equal(r.push.pushed, true);
  assert.ok(calls.some((c) => c.includes(' push origin main')));
});
