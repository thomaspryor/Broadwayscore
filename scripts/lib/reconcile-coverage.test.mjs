// Unit tests for the PUSH_RECONCILE_MERGED_JSON coverage checker (task #574)
// + an end-to-end fixture proving the reconciliation machinery it enforces
// actually works, mirroring #420's fixture: two branches editing DIFFERENT
// slugs three lines apart in commercial-pending-review.json, rebase -X
// theirs (no reported conflict), then reconcile — both sides must survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  MANAGED_BASENAMES,
  stripCommentLines,
  splitIntoSteps,
  stepPushesWithRetry,
  stepManagedFiles,
  stepStagesEverything,
  stepHasFlag,
  stepHasWaiver,
  findCoverageGaps,
  auditWorkflows,
} = require('./reconcile-coverage.js');

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUSH_SH = path.join(REPO_ROOT, 'scripts', 'lib', 'push-with-retry.sh');

// ── stripCommentLines ────────────────────────────────────────────────────────

test('stripCommentLines blanks comment-only lines but preserves line count', () => {
  const src = 'line1\n  # a comment\nline3\n';
  const out = stripCommentLines(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.equal(out.split('\n')[1], '');
  assert.match(out, /line1/);
  assert.match(out, /line3/);
});

test('stripCommentLines leaves non-comment lines untouched', () => {
  const src = 'git add data/commercial.json # inline comment stays (not line-start)';
  assert.equal(stripCommentLines(src), src);
});

// ── splitIntoSteps ────────────────────────────────────────────────────────────

test('splitIntoSteps carves one chunk per `- name:` line', () => {
  const yaml = [
    'jobs:',
    '  x:',
    '    steps:',
    '      - name: First',
    '        run: echo 1',
    '      - name: Second',
    '        run: echo 2',
  ].join('\n');
  const steps = splitIntoSteps(yaml);
  const names = steps.map((s) => s.name);
  assert.deepEqual(names, ['<preamble>', 'First', 'Second']);
  assert.match(steps[1].text, /echo 1/);
  assert.match(steps[2].text, /echo 2/);
});

test('splitIntoSteps starts a new chunk on an UNNAMED step (`- run:`/`- uses:`/`- id:`), not just `- name:`', () => {
  // ship-check/Codex finding: the first cut only recognized `- name:`, so an
  // unnamed step landed in `<preamble>` — which findCoverageGaps skips
  // entirely — and could invisibly evade the gate.
  const yaml = [
    'jobs:',
    '  x:',
    '    steps:',
    '      - run: echo unnamed',
    '      - name: Named',
    '        run: echo named',
    '      - uses: actions/checkout@v5',
  ].join('\n');
  const steps = splitIntoSteps(yaml);
  assert.equal(steps.length, 4); // preamble + 3 steps
  assert.equal(steps[0].name, '<preamble>');
  assert.match(steps[1].name, /^<unnamed step @L\d+>$/);
  assert.match(steps[1].text, /echo unnamed/);
  assert.equal(steps[2].name, 'Named');
  assert.match(steps[3].name, /^<unnamed step @L\d+>$/);
});

test('splitIntoSteps does not split on continuation keys (run:/env:/if: with no leading dash) inside an already-named step', () => {
  const yaml = [
    '      - name: Commit',
    '        if: always()',
    "        env:",
    "          FOO: '1'",
    '        run: |',
    '          echo one',
    '          echo two',
  ].join('\n');
  const steps = splitIntoSteps(yaml);
  // No preamble emitted: NAME_RE matches on line 0, before any text has
  // accumulated in the empty starting chunk, so there's nothing to push.
  assert.equal(steps.length, 1);
  assert.equal(steps[0].name, 'Commit');
});

// ── stepStagesEverything ─────────────────────────────────────────────────────

test('stepStagesEverything catches bare stage-data-changes.sh, git add -A, git add ., git commit -a', () => {
  for (const cmd of [
    'bash scripts/lib/stage-data-changes.sh',
    'git add -A',
    'git add --all',
    'git add .',
    'git commit -m "msg" -a',
  ]) {
    assert.equal(stepStagesEverything(cmd), true, cmd);
  }
});

test('stepStagesEverything does NOT flag a pathspec-scoped add (real false positive fixed: bulk-reddit-sentiment.yml)', () => {
  // `git add -A <pathspec>` is scoped to that pathspec per git's own docs —
  // only a BARE `-A`/`--all` (no pathspec) is tree-wide.
  assert.equal(stepStagesEverything('git add -A data/reddit-shards/ 2>/dev/null || true'), false);
  assert.equal(stepStagesEverything('bash scripts/lib/stage-data-changes.sh data/commercial-pending-review.json'), false);
});

test('stepStagesEverything does NOT flag git add -A after cd-ing into a SEPARATE git clone (real false positive fixed: opening-night-poller.yml/ingest-urls.yml)', () => {
  // data/review-texts is a distinct `git clone` (broadway-review-texts) —
  // staging "everything" there can never touch this repo's managed files.
  const step = [
    'cd data/review-texts',
    'git add -A',
    'git commit -m "data: new reviews"',
    'bash ../../scripts/lib/push-with-retry.sh 5 main',
  ].join('\n');
  assert.equal(stepStagesEverything(step), false);
});

// ── stepPushesWithRetry / stepManagedFiles / stepHasFlag / stepHasWaiver ────

test('stepPushesWithRetry matches the bash caller', () => {
  assert.equal(stepPushesWithRetry('bash scripts/lib/push-with-retry.sh'), true);
  assert.equal(stepPushesWithRetry('git push origin main'), false);
});

test('stepPushesWithRetry matches the Node wrapper unless reconcileMergedJson is already set', () => {
  assert.equal(stepPushesWithRetry("pushWithRetry({ cwd, branch: 'HEAD:main' })"), true);
  assert.equal(stepPushesWithRetry("pushWithRetry({ cwd, reconcileMergedJson: true })"), false);
});

test('stepManagedFiles finds every managed basename literally present', () => {
  assert.deepEqual(
    stepManagedFiles('git add data/commercial-pending-review.json data/commercial-research-queue.json'),
    ['commercial-pending-review.json', 'commercial-research-queue.json'],
  );
  assert.deepEqual(stepManagedFiles('git add data/audit/alert-ledger.json'), []);
});

test('MANAGED_BASENAMES matches the reconcile-merged-json.js MANAGED list', () => {
  const { MANAGED } = require('./reconcile-merged-json.js');
  const basenames = MANAGED.map((m) => m.file.replace(/^data\//, ''));
  assert.deepEqual([...MANAGED_BASENAMES].sort(), [...basenames].sort());
});

test('stepHasFlag accepts YAML env, shell export, and the JS wrapper option', () => {
  assert.equal(stepHasFlag("env:\n  PUSH_RECONCILE_MERGED_JSON: '1'"), true);
  assert.equal(stepHasFlag('PUSH_RECONCILE_MERGED_JSON=1 bash scripts/lib/push-with-retry.sh'), true);
  assert.equal(stepHasFlag('pushWithRetry({ reconcileMergedJson: true })'), true);
  assert.equal(stepHasFlag('bash scripts/lib/push-with-retry.sh'), false);
});

test('stepHasWaiver requires a reason after the colon', () => {
  assert.equal(stepHasWaiver('# push-reconcile-ok: pushed via push-core-data, not this helper'), true);
  assert.equal(stepHasWaiver('# push-reconcile-ok:'), false);
  assert.equal(stepHasWaiver('no waiver here'), false);
});

// ── findCoverageGaps: the real false positives/negatives this check had to get right ──

test('flags a step that pushes a managed file with no flag or waiver', () => {
  const yaml = [
    '      - name: Commit pending results',
    '        run: |',
    '          git add data/commercial-pending-review.json',
    '          git commit -m "data: pending"',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  const gaps = findCoverageGaps('fixture.yml', yaml);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].step, 'Commit pending results');
  assert.deepEqual(gaps[0].managedFiles, ['commercial-pending-review.json']);
});

test('does not flag a step once PUSH_RECONCILE_MERGED_JSON is set', () => {
  const yaml = [
    '      - name: Commit pending results',
    "        env:",
    "          PUSH_RECONCILE_MERGED_JSON: '1'",
    '        run: |',
    '          git add data/commercial-pending-review.json',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  assert.deepEqual(findCoverageGaps('fixture.yml', yaml), []);
});

test('does not flag a step with an inline waiver comment', () => {
  const yaml = [
    '      - name: Commit pending results',
    '        run: |',
    '          # push-reconcile-ok: fixture, reviewed',
    '          git add data/commercial-pending-review.json',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  assert.deepEqual(findCoverageGaps('fixture.yml', yaml), []);
});

test('REGRESSION (check-cron-health.yml/test.yml shape): a managed filename mentioned only in an unrelated cron-name string does not false-positive', () => {
  const yaml = [
    '      - name: Record test success',
    '        run: |',
    '          # "commercial-pending-review-notify.yml|36|Commercial Pending Review Notify"',
    '          git diff --staged --quiet || git commit -m "health: Record test success"',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  // The filename literal is inside a comment (the cron-name row), not an
  // actual git-add argument for this step — must NOT flag.
  assert.deepEqual(findCoverageGaps('fixture.yml', yaml), []);
});

test('REGRESSION (update-mezzanine.yml shape): an explanatory comment about a DIFFERENT step\'s push does not false-positive', () => {
  const yaml = [
    '      - name: Commit and push watermark',
    '        # Gated on the PRIVATE diary-shows.json push actually succeeding,',
    '        # not always() -- the watermark tells next week what is already',
    '        # in the catalog (diary-shows.json is pushed by push-core-data,',
    '        # a separate action, not this step).',
    '        run: |',
    '          bash scripts/lib/stage-data-changes.sh data/audit/mezzanine-catalog-watermark.json',
    '          git commit -m "data: advance watermark"',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  // diary-shows.json only appears in COMMENT lines describing a different
  // push (push-core-data) — this step itself commits only the watermark file.
  assert.deepEqual(findCoverageGaps('fixture.yml', yaml), []);
});

test('REGRESSION (update-show-status.yml shape): a shell-variable indirection still resolves within the same step', () => {
  const yaml = [
    '      - name: Queue new Broadway shows for commercial research',
    '        run: |',
    '          node scripts/queue-commercial-research.js --new-slugs="$NEW_SLUGS"',
    '          QUEUE_FILE="data/commercial-research-queue.json"',
    '          git add "$QUEUE_FILE" 2>/dev/null || true',
    '          git commit -m "data: Queue new Broadway shows"',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  const gaps = findCoverageGaps('fixture.yml', yaml);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].managedFiles, ['commercial-research-queue.json']);
});

test('does not flag a step that pushes but touches no managed file', () => {
  const yaml = [
    '      - name: Commit alert ledger',
    '        run: |',
    '          git add data/audit/alert-ledger.json',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  assert.deepEqual(findCoverageGaps('fixture.yml', yaml), []);
});

test('flags a step that stages everything with NO literal managed filename (ship-check/Codex finding class)', () => {
  const yaml = [
    '      - name: Commit and push changes',
    '        run: |',
    '          git config user.name "github-actions[bot]"',
    '          bash scripts/lib/stage-data-changes.sh',
    '          git diff --staged --quiet || git commit -m "chore: update"',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  const gaps = findCoverageGaps('fixture.yml', yaml);
  assert.equal(gaps.length, 1);
  // Every managed file is a possible victim — can't narrow it down further
  // than "this step stages everything".
  assert.deepEqual([...gaps[0].managedFiles].sort(), [...MANAGED_BASENAMES].sort());
});

test('does not flag an unnamed step in the SAME way a preamble-only scanner would miss it', () => {
  const yaml = [
    'jobs:',
    '  x:',
    '    steps:',
    '      - run: |',
    '          bash scripts/lib/stage-data-changes.sh',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  const gaps = findCoverageGaps('fixture.yml', yaml);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].step, /^<unnamed step @L\d+>$/);
});

test('auditWorkflows aggregates gaps across multiple files', () => {
  const withGap = [
    '      - name: Commit pending results',
    '        run: |',
    '          git add data/commercial-pending-review.json',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  const clean = [
    '      - name: Commit ledger',
    '        run: |',
    '          git add data/audit/alert-ledger.json',
    '          bash scripts/lib/push-with-retry.sh',
  ].join('\n');
  const gaps = auditWorkflows([['a.yml', withGap], ['b.yml', clean]]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].file, 'a.yml');
});

// ── Live-repo regression: the 10-workflow rollout this card shipped stays clean ──

test('every real .github/workflows/*.yml is clean under the coverage checker', () => {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const fileMap = files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const gaps = auditWorkflows(fileMap);
  assert.deepEqual(gaps, [], `unflagged coverage gap(s): ${JSON.stringify(gaps)}`);
});

// ── End-to-end fixture: mirrors #420's proof that reconciliation actually works ──

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function pendingReview(shows) {
  return JSON.stringify({ shows, lastUpdated: '2026-07-01T00:00:00Z' }, null, 2) + '\n';
}

test('PUSH_RECONCILE_MERGED_JSON=1 survives a nearby-slug remote edit through the REAL push-with-retry.sh rebase path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-coverage-'));
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const runnerDir = path.join(tmp, 'runner');

  try {
    sh(`git init -q --bare "${originDir}"`, tmp);
    sh(`git init -q "${seedDir}"`, tmp);
    sh('git config user.email t@t.t', seedDir);
    sh('git config user.name t', seedDir);

    // Base state: two slugs already present (three lines apart in the
    // formatted JSON — the exact shape #420 measured as a silent-drop).
    fs.mkdirSync(path.join(seedDir, 'data'));
    fs.writeFileSync(
      path.join(seedDir, 'data', 'commercial-pending-review.json'),
      pendingReview({
        'show-a': { slug: 'show-a', claim: 'original-a', researchedAt: '2026-07-01T00:00:00Z' },
        'show-b': { slug: 'show-b', claim: 'original-b', researchedAt: '2026-07-01T00:00:00Z' },
      }),
    );
    sh('git add -A', seedDir);
    sh('git commit -q -m base', seedDir);
    sh('git branch -M main', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);
    // Pin the bare origin's HEAD to `main` explicitly. `git init --bare`
    // sets HEAD from `init.defaultBranch`, which is NOT the same everywhere
    // (this Mac's global config defaults to "main"; the GitHub Actions
    // ubuntu runner's git defaults to "master"). If HEAD still points at a
    // ref that was never pushed, `git clone` checks out an EMPTY working
    // tree — refs and objects are all present, but no files land on disk —
    // so every `fs.writeFileSync` below into a fresh clone's `data/`
    // silently ENOENTs. Reproduced exactly this way in CI (run 30234641991)
    // after passing locally many times.
    sh(`git --git-dir="${originDir}" symbolic-ref HEAD refs/heads/main`, tmp);

    // Runner clone: this is "our" branch, about to edit show-a and push
    // through push-with-retry.sh with PUSH_RECONCILE_MERGED_JSON=1.
    sh(`git clone -q "${originDir}" "${runnerDir}"`, tmp);
    sh('git config user.email t@t.t', runnerDir);
    sh('git config user.name t', runnerDir);

    // Concurrent writer: pushes a remote commit editing show-b's claim
    // BEFORE our push attempt — same fixture shape as #420 (different
    // slugs, few lines apart, both sides touch the same file).
    sh(`git clone -q "${originDir}" "${seedDir}-writer"`, tmp);
    const writerDir = `${seedDir}-writer`;
    sh('git config user.email t@t.t', writerDir);
    sh('git config user.name t', writerDir);
    fs.writeFileSync(
      path.join(writerDir, 'data', 'commercial-pending-review.json'),
      pendingReview({
        'show-a': { slug: 'show-a', claim: 'original-a', researchedAt: '2026-07-01T00:00:00Z' },
        'show-b': { slug: 'show-b', claim: 'REMOTE-EDIT-b', researchedAt: '2026-07-02T00:00:00Z' },
      }),
    );
    sh('git add -A', writerDir);
    sh('git commit -q -m "remote: edit show-b"', writerDir);
    sh('git push -q origin main', writerDir);

    // Our local edit to show-a, committed on top of the (now stale) base —
    // this is the commit push-with-retry.sh will need to rebase.
    fs.writeFileSync(
      path.join(runnerDir, 'data', 'commercial-pending-review.json'),
      pendingReview({
        'show-a': { slug: 'show-a', claim: 'LOCAL-EDIT-a', researchedAt: '2026-07-02T00:00:00Z' },
        'show-b': { slug: 'show-b', claim: 'original-b', researchedAt: '2026-07-01T00:00:00Z' },
      }),
    );
    sh('git add -A', runnerDir);
    sh('git commit -q -m "local: edit show-a"', runnerDir);

    // Sanity check on the bug this whole card fixes: a PLAIN `git rebase -X
    // theirs` here reports success with no conflict, and the remote's
    // show-b edit is gone from the result (this is #420's measured bug,
    // reproduced fresh so a future refactor of push-with-retry.sh can't
    // silently stop needing the flag without this test noticing).
    const bugCheckDir = `${runnerDir}-bugcheck`;
    sh(`git clone -q "${runnerDir}" "${bugCheckDir}"`, tmp);
    sh('git config user.email t@t.t', bugCheckDir);
    sh('git config user.name t', bugCheckDir);
    sh('git fetch -q origin main', bugCheckDir);
    const rebaseOut = sh('git rebase -X theirs origin/main', bugCheckDir);
    assert.match(rebaseOut, /Successfully rebased|up to date/i);
    const bugCheckJson = JSON.parse(
      fs.readFileSync(path.join(bugCheckDir, 'data', 'commercial-pending-review.json'), 'utf8'),
    );
    assert.equal(bugCheckJson.shows['show-b'].claim, 'original-b', 'sanity check: plain -X theirs silently drops the remote edit');

    // Now the REAL fix: push through push-with-retry.sh with the flag on.
    // PUSH_FAILURE_LOG is redirected into the tmp fixture: push-with-retry.sh
    // resolves its default from $SCRIPT_DIR (this repo's real scripts/lib/),
    // not from `cwd`, so on a failure path it would otherwise write into the
    // REAL working tree's data/audit/ (ship-check finding) — this push is
    // expected to succeed, but the redirect is cheap defense-in-depth.
    execFileSync('bash', [PUSH_SH, '3', 'main'], {
      cwd: runnerDir,
      env: {
        ...process.env, ...GIT_ENV,
        PUSH_RECONCILE_MERGED_JSON: '1',
        PUSH_FAILURE_LOG: path.join(tmp, 'push-retry-failures.jsonl'),
      },
      stdio: 'pipe',
    });

    sh('git fetch -q origin main', runnerDir);
    const finalJson = JSON.parse(sh('git show origin/main:data/commercial-pending-review.json', runnerDir));
    assert.equal(finalJson.shows['show-a'].claim, 'LOCAL-EDIT-a', 'our edit must survive');
    assert.equal(finalJson.shows['show-b'].claim, 'REMOTE-EDIT-b', 'the concurrent writer\'s nearby-slug edit must survive too');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
