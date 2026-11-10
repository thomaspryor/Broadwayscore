// browser-recovery-helpers.js checkpoint() against a real temp review-texts
// repo (BRO-7171). Before the fix it ran `git add -A` (sweeping another
// writer's half-written file into our commit) and swallowed a failed push
// with a WARNING while the run kept counting "recovered" reviews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brh-checkpoint-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.com',
  PUSH_SKIP_LEDGER: '1', PUSH_SKIP_FAILURE_LEDGER: '1', PUSH_SKIP_UNSHALLOW: '1',
  PUSH_API_FALLBACK_DISABLE: '1', PUSH_RESCUE_DISABLE: '1', PUSH_SKIP_STALL_DIAGNOSTICS: '1',
  PUSH_FAILURE_LOG: path.join(ROOT, 'push-failures.jsonl'),
  PUSH_DEADLINE_SEC: '30',
  REVIEW_TEXTS_LOCK_PATH: path.join(ROOT, 'review-texts.lock'),
  REVIEW_TEXTS_PENDING_PATH: path.join(ROOT, 'pending.json'),
});

const origin = path.join(ROOT, 'broadway-review-texts.git');
git(ROOT, 'init', '-q', '--bare', '-b', 'main', origin);
const local = path.join(ROOT, 'local');
git(ROOT, 'clone', '-q', origin, local);
fs.mkdirSync(path.join(local, 'show-2026'));
const ours = path.join(local, 'show-2026', 'nytimes--a.json');
const theirs = path.join(local, 'show-2026', 'variety--b.json');
fs.writeFileSync(ours, JSON.stringify({ fullText: 'stub' }) + '\n');
fs.writeFileSync(theirs, JSON.stringify({ fullText: 'other' }) + '\n');
git(local, 'add', '-A');
git(local, 'commit', '-q', '-m', 'init');
git(local, 'push', '-q', 'origin', 'HEAD:main');

// REVIEW_TEXTS_DIR is read at module load.
process.env.REVIEW_TEXTS_DIR = local;
const helpers = require('./browser-recovery-helpers.js');

const track = (p) => { if (helpers.RUN_WRITES) helpers.RUN_WRITES.add(p); };
const originText = (rel) => JSON.parse(git(origin, 'show', `main:${rel}`)).fullText;

test('checkpoint commits only the files this run wrote', () => {
  fs.writeFileSync(ours, JSON.stringify({ fullText: 'recovered' }) + '\n');
  track(ours);
  fs.writeFileSync(theirs, JSON.stringify({ fullText: 'half-written by another writer' }) + '\n');
  helpers.checkpoint({ recovered: 1, dryRun: false }, 'Test browser recovery');
  assert.equal(originText('show-2026/nytimes--a.json'), 'recovered');
  assert.equal(originText('show-2026/variety--b.json'), 'other', "another writer's uncommitted edit must not ride along");
  git(local, 'checkout', '--', 'show-2026/variety--b.json');
});

test('checkpoint throws when the push fails instead of warning and carrying on', () => {
  const hook = path.join(origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/bash\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  try {
    fs.writeFileSync(ours, JSON.stringify({ fullText: 'recovered again, longer' }) + '\n');
    track(ours);
    assert.throws(() => helpers.checkpoint({ recovered: 2, dryRun: false }, 'Test browser recovery', { retries: 1 }), /push failed/);
    assert.equal(originText('show-2026/nytimes--a.json'), 'recovered');
  } finally {
    fs.unlinkSync(hook);
  }
});

// Class guard: the local review-texts recovery writers share one checkout
// with other local automation, so none may stage with a bare `git add -A` or
// push on its own; they go through review-texts-checkpoint.js (BRO-7171).
// (CI-only writers run in fresh checkouts and are out of this class.)
test('local review-texts recovery scripts never `git add -A` or push directly', () => {
  const scriptsDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const files = [
    'lib/browser-recovery-helpers.js',
    'recover-serp-text.js',
    ...fs.readdirSync(scriptsDir).filter((f) => /^recover-.*-browser\.js$/.test(f)),
  ];
  assert.ok(files.length >= 8, `expected the 6 browser scripts + 2, got ${files.join(', ')}`);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (/git add -A|['"]add['"],\s*['"]-A['"]/.test(src)) offenders.push(`${f}: git add -A`);
    if (/git push|push-with-retry\.sh/.test(src)) offenders.push(`${f}: pushes directly`);
  }
  assert.deepEqual(offenders, []);
});

// BRO-7171 class guard, every writer: no whole-tree add anywhere in scripts/
// or .github/ (workflows, composite actions). A whole-tree add commits
// whatever sits in the checkout (screenshots, *.mergetmp, another local
// writer's half-written file). Review-texts writers stage through
// stage-review-texts.js (CI, whole checkout) or review-texts-checkpoint.js
// (the paths a run wrote). Pathspec-scoped adds (`git add -A lane-recordings`,
// `git add -A -- <paths>`) are fine. Allowlist = other repos, with the reason.
const WHOLE_TREE_ADD = /\bgit(?:\s+-C\s+\S+)?\s+add\s+(?:-A|--all|\.)(?=\s*(?:$|&&|\|\||;|\)|'|"|`|2>|>))|['"]add['"]\s*,\s*['"](?:-A|--all|\.)['"]\s*\]/;
const WHOLE_TREE_ALLOW = {
  '.github/actions/push-core-data/action.yml': 'core-data repo checkout (/tmp/core-data-checkout), not review-texts',
  'scripts/migrate-add-core-data-push.js': 'string match on workflow text, does not run git',
  'scripts/autonomous-run.js': 'commits inside its own main-repo task worktree (retired autonomous loop), never review-texts',
};
function walkFiles(dir, re) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '.git'].includes(e.name) ? [] : walkFiles(p, re);
    return re.test(e.name) && !/\.test\.(m?js|sh)$/.test(e.name) ? [p] : []; // tests build their own scratch repos
  });
}
/** Offending `file:line` for whole-tree adds (comment lines ignored). Exported shape for the red check below. */
export function wholeTreeAdds(repoRoot) {
  const files = [
    ...walkFiles(path.join(repoRoot, 'scripts'), /\.(c?js|mjs|sh)$/),
    ...walkFiles(path.join(repoRoot, '.github'), /\.ya?ml$/),
  ];
  const hits = [];
  for (const f of files) {
    const rel = path.relative(repoRoot, f);
    if (WHOLE_TREE_ALLOW[rel]) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (/^\s*(#|\/\/|\*)/.test(l)) return;
      if (WHOLE_TREE_ADD.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 90)}`);
    });
  }
  return hits;
}

test('no review-texts writer (local or CI) stages with a whole-tree add', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  assert.deepEqual(wholeTreeAdds(repoRoot), [], 'stage with scripts/lib/stage-review-texts.js or review-texts-checkpoint.js');
});

test('the whole-tree-add matcher catches the shapes the writers used and passes scoped adds', () => {
  for (const bad of [
    "execSync('git add -A', { cwd: rtDir, stdio: 'pipe' });",
    "          git add -A",
    "execSync('cd data/review-texts && git add -A && git commit -m x', {});",
    "execFileSync('git', ['-C', opts.dir, 'add', '-A'], { stdio: 'ignore' });",
    "      git add -A 2>/dev/null || true",
    "  git add .",
  ]) assert.ok(WHOLE_TREE_ADD.test(bad), bad);
  for (const ok of [
    "git add -A lane-recordings",
    "git add -A -- \"data/pending-fixes/$PLAN.json\"",
    "git(repo, ['add', '-A', '--', ...rels]);",
    "git add -u",
    "git add data/audit/",
  ]) assert.ok(!WHOLE_TREE_ADD.test(ok), ok);
});

// Local committing writers of the shared ~/broadway-review-texts checkout go
// through review-texts-checkpoint.js (lock, scoped staging, a failed push
// throws) and land an earlier run's pending push first.
test('local committing review-texts writers use the checkpoint, never push directly', () => {
  const scriptsDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const offenders = [];
  for (const f of ['recover-wayback-reviews.js', 'recover-talkinbroadway-forum-links.js', 'batch-correct-reviews.js', 'clean-orphan-pending.js', 'backfill-first-seen.js', 'manual-review-direct.js']) {
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (!/review-texts-checkpoint/.test(src)) offenders.push(`${f}: not routed through review-texts-checkpoint.js`);
    // Pushes of the review-texts checkout must come from the checkpoint. (manual-review-direct
    // also pushes the core-data repo with `cd ${coreDataDir} && ... git push`.)
    const rtPush = src.split('\n').filter((l) => /git push|push-with-retry|pushWithRetry\(/.test(l) && !/require\(|coreDataDir|cwd: path\.join\(__dirname, '\.\.'\)/.test(l));
    if (rtPush.length) offenders.push(`${f}: pushes directly (${rtPush[0].trim().slice(0, 80)})`);
  }
  // Shell tools that rebase/commit review-texts hold the lock via `review-texts-lock.js run`.
  for (const f of ['sync-review-texts.sh', 'fix-review-file.sh', 'lib/safe-sync-review-texts.sh']) {
    if (!/review-texts-lock\.js" run --/.test(fs.readFileSync(path.join(scriptsDir, f), 'utf8'))) offenders.push(`${f}: not under the review-texts lock`);
  }
  assert.deepEqual(offenders, []);
});
