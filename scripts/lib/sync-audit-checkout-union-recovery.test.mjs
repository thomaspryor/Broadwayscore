// scripts/lib/sync-audit-checkout-union-recovery.test.mjs — BRO-2498.
//
// sync-audit-checkout.sh's union-recovery stage used to reconcile every
// merge=union ledger with a dumb line union, so census-recall-trend.jsonl and
// coverage-adversarial-probe-trend.jsonl (same-date-replace writers) had to be
// EXEMPT_LEDGERS: a line union leaves two rows for one date. The stage now calls
// the merge function registered in core-data-merge-registry.js.
//
// Run: node --test scripts/lib/sync-audit-checkout-union-recovery.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'sync-audit-checkout.sh');
const REPO = path.join(HERE, '..', '..');
const { classifyBlock } = require(path.join(HERE, 'sync-audit-decision.js'));
const {
  smartMergeEntryFor, smartMergeLines, GIT_MERGE_UNSAFE_LEDGERS, gitMergeUnsafe,
} = require(path.join(HERE, 'smart-ledger-merge.js'));
const { EXEMPT_LEDGERS } = require(path.join(HERE, 'audit-ledger-merge-attrs.js'));

const TREND = 'data/audit/census-recall-trend.jsonl';
const PROBE = 'data/audit/coverage-adversarial-probe-trend.jsonl';
const row = (date, truthUrls, extra = {}) => JSON.stringify({ date, truthUrls, ...extra });

// ── pure layer ───────────────────────────────────────────────────────────────

test('smartMergeLines resolves a same-date collision with the registered function, not a line union', () => {
  const origin = [row('2026-10-01', 400), row('2026-10-02', 400)];
  const local = [row('2026-10-01', 10), row('2026-10-03', 400)];
  const { merged } = smartMergeLines(TREND, origin, local);
  const dates = merged.map((l) => JSON.parse(l).date);
  assert.deepEqual(dates, ['2026-10-01', '2026-10-02', '2026-10-03'], 'one row per date');
  assert.equal(JSON.parse(merged[0]).truthUrls, 400, 'the better-evidenced measurement wins');
});

test('smartMergeLines returns null for other ledgers, and skips (never throws on) an unparseable row', () => {
  assert.equal(smartMergeLines('data/audit/landings.jsonl', ['{}'], ['{}']), null);
  assert.equal(smartMergeEntryFor('data/audit/owner-email-log.jsonl'), null, 'keyed ledgers keep the line union');
  const r = smartMergeLines(TREND, [row('2026-10-01', 400)], ['{"date":', row('2026-10-02', 400)]);
  assert.equal(r.merged.length, 2);
  assert.equal(r.stats.skipped, 1);
});

test('every git-merge-unsafe ledger has a registered merge function, is declared merge=union, and is no longer exempt', () => {
  const attrs = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8').split('\n');
  assert.deepEqual([...GIT_MERGE_UNSAFE_LEDGERS].sort(), [PROBE, TREND].sort());
  for (const f of GIT_MERGE_UNSAFE_LEDGERS) {
    assert.ok(smartMergeEntryFor(f), `${f} must have a registered merge function`);
    assert.ok(attrs.includes(`${f} merge=union`), `${f} must be declared merge=union`);
    assert.equal(EXEMPT_LEDGERS.some((e) => e.file === f), false, `${f} must not stay in EXEMPT_LEDGERS`);
    assert.equal(gitMergeUnsafe(f), true);
  }
});

test('classifyBlock: a diverged checkout blocked by a git-merge-unsafe ledger refuses; a plain union ledger still rebases', () => {
  const common = { aheadCount: 1, behindCount: 1 };
  const L = 'data/audit/landings.jsonl';
  assert.equal(classifyBlock({ ...common, blockingPaths: [L], unionMergePaths: [L], gitMergeUnsafePaths: [TREND] }).action, 'refuse', 'rebase path');
  assert.equal(classifyBlock({ ...common, blockingPaths: [], gitMergeUnsafePaths: [TREND] }).action, 'refuse', 'merge-origin path');
  assert.equal(classifyBlock({ ...common, blockingPaths: [L], unionMergePaths: [L] }).action, 'commit-and-rebase');
  const ffOnly = classifyBlock({ aheadCount: 0, behindCount: 1, blockingPaths: [TREND], unionMergePaths: [TREND] });
  assert.equal(ffOnly.action, 'union-recover', 'the ff-only stage is where the smart merge runs');
});

// ── the real shell script ────────────────────────────────────────────────────

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);

function pair(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const origin = path.join(base, 'origin');
  const clone = path.join(base, 'clone');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, 'config', 'user.email', 't@t.t');
  git(clone, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(clone, 'data', 'audit'), { recursive: true });
  fs.copyFileSync(path.join(REPO, '.gitattributes'), path.join(clone, '.gitattributes'));
  fs.writeFileSync(path.join(clone, TREND), row('2026-10-01', 400) + '\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'remote', 'add', 'origin', origin);
  git(clone, 'push', '-q', 'origin', 'main');
  return { base, origin, clone };
}

function originCommit(base, origin, name, mutate) {
  const via = path.join(base, name);
  execFileSync('git', ['init', '-q', via]);
  git(via, 'config', 'user.email', 'ci@ci.ci');
  git(via, 'config', 'user.name', 'ci');
  git(via, 'remote', 'add', 'origin', origin);
  git(via, 'fetch', '-q', 'origin', 'main');
  git(via, 'checkout', '-q', 'main');
  mutate(via);
  git(via, 'add', '-A');
  git(via, 'commit', '-q', '-m', 'ci: advance');
  git(via, 'push', '-q', 'origin', 'main');
}

function sync(clone, tag) {
  try {
    return { code: 0, out: execFileSync('bash', [LIB, clone], { encoding: 'utf8', env: { ...process.env, SYNC_TAG: tag } }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('ACCEPTANCE: union-recovery of census-recall-trend.jsonl keeps ONE row per date, via the registered merge', () => {
  const { base, origin, clone } = pair('bro2498-a-');
  try {
    // origin re-measured 2026-10-01 with more ground truth and added 10-02;
    // the local job appended a weaker 10-01 re-run and a new 10-03, uncommitted.
    originCommit(base, origin, 'via-a', (via) => {
      fs.writeFileSync(path.join(via, TREND), [row('2026-10-01', 450), row('2026-10-02', 400)].join('\n') + '\n');
    });
    fs.writeFileSync(path.join(clone, TREND), [row('2026-10-01', 400), row('2026-10-01', 10), row('2026-10-03', 400)].join('\n') + '\n');

    const { code, out } = sync(clone, 'a');
    assert.equal(code, 0, `expected recovery, got ${code}:\n${out}`);
    assert.match(out, /smart merge/);
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), git(clone, 'rev-parse', 'origin/main').trim());
    const rows = lines(path.join(clone, TREND)).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.date), ['2026-10-01', '2026-10-02', '2026-10-03'], 'no duplicate date');
    assert.equal(rows[0].truthUrls, 450, "origin's stronger measurement kept");
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('an unparseable row in the saved copy is dropped; origin rows still reach the worktree', () => {
  const { base, origin, clone } = pair('bro2498-b-');
  try {
    originCommit(base, origin, 'via-b', (via) => {
      fs.writeFileSync(path.join(via, TREND), [row('2026-10-01', 400), row('2026-10-02', 400)].join('\n') + '\n');
    });
    fs.writeFileSync(path.join(clone, TREND), row('2026-10-01', 400) + '\nnot-json-in-the-middle\n' + row('2026-10-03', 400) + '\n');
    const { code, out } = sync(clone, 'b');
    assert.equal(code, 0, out);
    const dates = lines(path.join(clone, TREND)).map((l) => JSON.parse(l).date);
    assert.deepEqual(dates, ['2026-10-01', '2026-10-02', '2026-10-03'], "origin's 10-02 is present");
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('commit-and-rebase with an ahead commit on a trend file origin also changed refuses and never pushes a duplicate date', () => {
  const { base, origin, clone } = pair('bro2498-d-');
  try {
    const OTHER = 'data/audit/fixture-other-ledger.jsonl';
    fs.appendFileSync(path.join(clone, '.gitattributes'), `${OTHER} merge=union\n`);
    fs.writeFileSync(path.join(clone, OTHER), 'x\n');
    git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'other'); git(clone, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(clone, TREND), [row('2026-10-01', 400), row('2026-10-05', 10)].join('\n') + '\n');
    git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'local trend');
    originCommit(base, origin, 'via-d', (via) => {
      fs.writeFileSync(path.join(via, TREND), [row('2026-10-01', 400), row('2026-10-05', 400)].join('\n') + '\n');
      fs.writeFileSync(path.join(via, OTHER), 'x\ny\n');
    });
    fs.appendFileSync(path.join(clone, OTHER), 'z\n');
    const before = git(origin, 'rev-parse', 'main').trim();
    const { code, out } = sync(clone, 'd');
    assert.notEqual(code, 0, out);
    assert.equal(git(origin, 'rev-parse', 'main').trim(), before, 'nothing pushed');
    const dates = lines(path.join(clone, TREND)).map((l) => JSON.parse(l).date);
    assert.equal(new Set(dates).size, dates.length);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('identical changes on both sides are not a refusal (git merges them with no driver)', () => {
  const { base, origin, clone } = pair('bro2498-e-');
  try {
    const content = [row('2026-10-01', 400), row('2026-10-05', 400)].join('\n') + '\n';
    fs.writeFileSync(path.join(clone, TREND), content);
    git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'local trend');
    originCommit(base, origin, 'via-e', (via) => { fs.writeFileSync(path.join(via, TREND), content); });
    const { code, out } = sync(clone, 'e');
    assert.equal(code, 0, out);
    assert.equal(lines(path.join(clone, TREND)).length, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a diverged checkout where both sides changed a git-merge-unsafe ledger refuses instead of git-merging it', () => {
  const { base, origin, clone } = pair('bro2498-c-');
  try {
    fs.writeFileSync(path.join(clone, TREND), [row('2026-10-01', 400), row('2026-10-05', 10)].join('\n') + '\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'local: trend row');
    originCommit(base, origin, 'via-c', (via) => {
      fs.writeFileSync(path.join(via, TREND), [row('2026-10-01', 400), row('2026-10-05', 400)].join('\n') + '\n');
    });
    const { code, out } = sync(clone, 'c');
    assert.notEqual(code, 0, out);
    assert.match(out, /line union and double a same-date row|refus/i);
    const dates = lines(path.join(clone, TREND)).map((l) => JSON.parse(l).date);
    assert.equal(new Set(dates).size, dates.length, 'never left a duplicate date');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
