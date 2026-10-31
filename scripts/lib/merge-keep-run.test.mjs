// BRO-5551: push-with-retry.sh's rebase / rebase --continue / merge /
// cherry-pick must keep this run's regenerated snapshot WHOLE instead of
// line-blending it with a concurrent regeneration, and must leave every other
// merge=ours path on the text merge it had. Runs real git in temp repos with
// the global and system config masked, the way a fresh GitHub runner sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DRIVER = path.join(HERE, 'merge-keep-run.sh');
const PWR = fs.readFileSync(path.join(HERE, 'push-with-retry.sh'), 'utf8');
const ATTRS = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
const BUILTIN = new Set(['text', 'binary', 'union']);

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_EDITOR: 'true',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// The string push-with-retry.sh's _keep_run_driver() prints.
const keepRun = side => `merge.ours.driver=bash '${DRIVER}' ${side} %O %A %B %P`;

const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\n';
const REMOTE = 'a\nB-remote\nc\nd\ne\nf\ng\nh\n';   // concurrent regeneration already on main
const RUN = 'a\nb\nc\nd\ne\nf\nG-run\nh\n';         // this run's regeneration
const BLEND = 'a\nB-remote\nc\nd\ne\nf\nG-run\nh\n';

const SNAP = 'data/audit/unknown-aggregator-outlets.json';
const ATTR = `data/audit/*.json merge=ours\n${SNAP} autostash=regenerated\nsrc/config/*.ts merge=ours\n`;
const write = (dir, f, s) => { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

// main = upstream with REMOTE; `run` = this run's commit(s) with RUN, both off BASE.
// conflictFirst: this run first commits a clashing edit to other.txt, so the
// rebase stops there and the snapshot commit replays in `rebase --continue`.
function race(file, op, { conflictFirst = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-run-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, '.gitattributes', ATTR);
    write(dir, file, BASE); write(dir, 'other.txt', 'x\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-qb', 'run');
    if (conflictFirst) { write(dir, 'other.txt', 'run\n'); git(dir, 'commit', '-qam', 'run other'); }
    write(dir, file, RUN); git(dir, 'commit', '-qam', 'run regen');
    const runHead = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', 'main');
    write(dir, file, REMOTE);
    if (conflictFirst) write(dir, 'other.txt', 'remote\n');
    git(dir, 'commit', '-qam', 'remote regen');
    git(dir, 'checkout', '-q', 'run');
    if (op === 'plain-rebase') git(dir, 'rebase', '-q', '-X', 'theirs', 'main');
    if (op === 'rebase') git(dir, '-c', keepRun('B'), 'rebase', '-q', '-X', 'theirs', 'main');
    if (op === 'rebase-continue') {
      // The real stop: a plain (no -X) rebase halts on other.txt; resolve it
      // the way resolve_conflicts does, then continue in a NEW process.
      try { git(dir, '-c', keepRun('B'), 'rebase', '-q', 'main'); assert.fail('expected the rebase to stop'); } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; }
      write(dir, 'other.txt', 'run\n'); git(dir, 'add', 'other.txt');
      git(dir, '-c', keepRun('B'), 'rebase', '--continue');
    }
    if (op === 'cherry-pick') { git(dir, 'checkout', '-q', 'main'); git(dir, '-c', keepRun('B'), 'cherry-pick', `${base}..${runHead}`, '--strategy-option=theirs'); }
    if (op === 'merge') git(dir, '-c', keepRun('A'), 'merge', 'main', '-X', 'ours', '--no-edit');
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('TRAP: plain rebase -X theirs blends two regenerations of a merge=ours file (no driver on CI)', () => {
  assert.equal(race(SNAP, 'plain-rebase'), BLEND);
});

test('rebase keeps this run\'s regenerated snapshot whole', () => {
  assert.equal(race(SNAP, 'rebase'), RUN);
});

test('a commit replayed by rebase --continue after a stop still gets the driver', () => {
  assert.equal(race(SNAP, 'rebase-continue', { conflictFirst: true }), RUN);
});

test('cherry-pick and merge -X ours fallbacks keep this run\'s regenerated snapshot whole', () => {
  assert.equal(race(SNAP, 'cherry-pick'), RUN);
  assert.equal(race(SNAP, 'merge'), RUN);
});

test('merge=ours paths that are NOT regenerated keep the old text merge (checkpoints, feature-flags.ts)', () => {
  assert.equal(race('data/audit/gap-audit-checkpoint.json', 'rebase'), BLEND);
  assert.equal(race('src/config/feature-flags.ts', 'rebase'), BLEND);
  assert.equal(race('src/config/feature-flags.ts', 'merge'), BLEND);
});

test('every rebase / merge / cherry-pick push-with-retry.sh runs (incl. --continue) carries the driver', () => {
  const calls = PWR.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !/^\s*(#|echo\b|printf\b)/.test(l))
    // `git [-c X]... <rebase|cherry-pick|merge>` as the git subcommand (not
    // `git check-attr merge`, not `git merge-base` / `merge-file`).
    .filter(({ l }) => /\bgit(?:\s+-c\s+(?:"[^"]*"|\S+))*\s+(?:rebase|cherry-pick|merge)(?![-\w])/.test(l))
    .filter(({ l }) => !/\s(rebase|cherry-pick|merge)\s+--(abort|quit)\b/.test(l));
  assert.ok(calls.length >= 4, `expected rebase, rebase --continue, merge and cherry-pick calls, found ${calls.length}`);
  for (const { l, n } of calls) assert.match(l, /git -c "\$\(_keep_run_driver [AB]\)" (rebase|cherry-pick|merge)\b/, `push-with-retry.sh:${n} runs without the keep-run driver: ${l.trim()}`);
  assert.match(PWR, /_keep_run_driver\(\) \{[^\n]*merge-keep-run\.sh/);
});

test('ours is the only custom merge driver .gitattributes names (a new one needs a keep-run override too)', () => {
  const names = new Set();
  for (const line of ATTRS.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/(?:^|\s)merge=([A-Za-z0-9_.-]+)/g)) if (!BUILTIN.has(m[1])) names.add(m[1]);
  }
  assert.deepEqual([...names], ['ours']);
});

test('the snapshot that blended is marked regenerated in the real .gitattributes', () => {
  assert.match(ATTRS, /^data\/audit\/unknown-aggregator-outlets\.json autostash=regenerated$/m);
});
