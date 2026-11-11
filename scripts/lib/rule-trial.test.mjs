// BRO-7370: rule-trial.mjs, trial sessions before big written-guidance changes land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isGuidance, countWords, wordChanges, guidanceDiff, ruleTrialWarning, trialSession, buildRecord, main, LEDGER, MIN_WORDS,
} from './rule-trial.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const words = (n, w = 'rule') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-trial-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  for (const d of ['.claude/commands', '.agents/skills/ship-check', 'cloud-memory', 'scripts']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules\n### 1. One long rule line with several words in it.\n');
  fs.writeFileSync(path.join(dir, '.claude', 'commands', 'wrap-up.md'), 'Wrap up.\nParagraph one is here and wraps\nacross two lines.\n');
  fs.writeFileSync(path.join(dir, 'cloud-memory', 'topic.md'), 'a topic\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'x.js'), '1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'work');
  return dir;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg); };
const HOUR = 3600 * 1000;
const at = (h) => new Date(Date.now() + h * HOUR).toISOString();
function commitAt(dir, msg, h) {
  git(dir, 'add', '-A');
  const r = spawnSync('git', ['commit', '-qm', msg], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: at(h), GIT_AUTHOR_DATE: at(h) } });
  if (r.status !== 0) throw new Error(r.stderr);
}

test('isGuidance: rule files, skills (both copies), agents; not memory topics or code', () => {
  for (const f of ['CLAUDE.md', 'scripts/CLAUDE.md', 'AGENTS.md', '.claude/CLOUD.md', '.claude/commands/ship-check.md',
    '.claude/skills/visual-qa/SKILL.md', '.agents/skills/ship-check/SKILL.md', '.claude/agents/review-panelist.md',
    'cloud-memory/MEMORY.md', 'docs/cloud-worker-session-runbook.md']) assert.ok(isGuidance(f), f);
  for (const f of ['cloud-memory/feedback_x.md', 'memory/MEMORY.md', 'README.md', 'scripts/lib/a.mjs', '.claude/hooks/verify-edits.sh',
    '.claude/commands/sub/x.md', 'docs/other.md']) assert.ok(!isGuidance(f), f);
});

test('countWords: added and removed runs count, file headers do not', () => {
  const p = ['diff --git a/CLAUDE.md b/CLAUDE.md', '--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -1 +1 @@', ' kept words', '-old two', '+new three words', '~'].join('\n');
  assert.equal(countWords(p), 5);
});

test('wordChanges: header lines are parsed only in the header, paths come from +++', () => {
  // A removed line whose text starts "-- a/" is a change, not a file header.
  const p = ['diff --git a/x b/y/CLAUDE.md b/x b/y/CLAUDE.md', '--- a/x b/y/CLAUDE.md', '+++ b/x b/y/CLAUDE.md', '@@ -1 +1 @@', ' keep', '--- a/b rule', '+new', '~',
    'diff --git "a/q\\"x.md" "b/q\\"x.md"', '--- "a/q\\"x.md"', '+++ "b/q\\"x.md"', '@@ -1 +1 @@', '+word'].join('\n');
  const { words, changes } = wordChanges(p);
  assert.equal(words, 5);
  assert.deepEqual([...changes.keys()], ['x b/y/CLAUDE.md', 'q"x.md']);
  assert.deepEqual(changes.get('x b/y/CLAUDE.md'), ['keep|--- a/b rule', 'keep|+new']);
});

test('guidanceDiff: the same words added in a different place are a different text', () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules\nAlways land changes\nNever email owners\n');
    commit(dir, 'base2');
    git(dir, 'branch', '-f', 'main');
    const add = (txt) => { git(dir, 'checkout', '-q', '-B', 'x', 'main'); fs.writeFileSync(path.join(dir, 'CLAUDE.md'), txt); commit(dir, 'edit'); return guidanceDiff(dir, 'main', 'HEAD').hash; };
    const a = add('# Rules\nAlways land changes without asking\nNever email owners\n');
    const b = add('# Rules\nAlways land changes\nNever email owners without asking\n');
    assert.ok(a && b);
    assert.notEqual(a, b);
  } finally { rm(dir); }
});

test('guidanceDiff + ruleTrialWarning: a one-line CLAUDE.md rule is big, a reflow and memory topics are not', () => {
  const dir = repo();
  try {
    assert.equal(guidanceDiff(dir, 'main', 'HEAD').hash, null);
    fs.writeFileSync(path.join(dir, '.claude', 'commands', 'wrap-up.md'), 'Wrap up.\nParagraph one is here\nand wraps across two lines.\n');
    fs.writeFileSync(path.join(dir, 'cloud-memory', 'topic.md'), `${words(80)}\n`);
    fs.writeFileSync(path.join(dir, 'scripts', 'x.js'), `${words(80)}\n`);
    commit(dir, 'reflow, memory topic, code');
    assert.equal(guidanceDiff(dir, 'main', 'HEAD').hash, null, 'a whitespace reflow is not a guidance change');
    assert.equal(ruleTrialWarning({ root: dir, base: 'main' }), null);

    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), '### 2. typo fix\n');
    commit(dir, 'small');
    const small = guidanceDiff(dir, 'main', 'HEAD');
    assert.ok(small.hash && small.words < MIN_WORDS, JSON.stringify(small));
    assert.equal(ruleTrialWarning({ root: dir, base: 'main' }), null, 'a small edit needs no trial');

    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), `### 3. ${words(MIN_WORDS)}\n`);
    commit(dir, 'new rule on one line');
    const d = guidanceDiff(dir, 'main', 'HEAD');
    assert.deepEqual(d.files, ['CLAUDE.md']);
    assert.ok(d.words >= MIN_WORDS);
    const w = ruleTrialWarning({ root: dir, base: 'main' });
    assert.match(w, /CLAUDE\.md/);
    assert.match(w, /rule-trial\.mjs status/);
    assert.equal(ruleTrialWarning({ root: dir, base: 'main', env: { RULE_TRIAL_MIN_WORDS: '500' } }), null, 'threshold override');

    fs.writeFileSync(path.join(dir, LEDGER), JSON.stringify({ hash: d.hash, verdict: 'fail' }) + '\n');
    assert.match(ruleTrialWarning({ root: dir, base: 'main' }), /recorded as failed/, 'a failed trial does not clear it');
    fs.appendFileSync(path.join(dir, LEDGER), JSON.stringify({ hash: d.hash, verdict: 'pass' }) + '\n');
    assert.equal(ruleTrialWarning({ root: dir, base: 'main' }), null, 'a passing trial of this exact text clears it');

    fs.mkdirSync(path.join(dir, '.agents', 'skills', 'ship-check'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'skills', 'ship-check', 'SKILL.md'), `${words(10, 'codex')}\n`);
    commit(dir, 'codex skill copy');
    assert.notEqual(guidanceDiff(dir, 'main', 'HEAD').hash, d.hash, 'a further guidance edit needs a new trial');
    assert.match(ruleTrialWarning({ root: dir, base: 'main' }), /\.agents\/skills\/ship-check\/SKILL\.md/);
  } finally { rm(dir); }
});

test('ruleTrialWarning never throws (a broken repo is silent)', () => {
  assert.equal(ruleTrialWarning({ root: '/nonexistent-dir', base: 'main' }), null);
});

const sessionJson = (id, revision, bucket = 'SESSION_STATUS_BUCKET_COMPLETED', created = at(100)) => ({ ccr: { id, status_bucket: bucket, created_at: created,
  session_context: { sources: [{ git_repository: { url: 'https://github.com/thomaspryor/Broadwayscore', revision } }] } } });

test('trialSession: needs a session id and a Broadwayscore revision', () => {
  assert.deepEqual(trialSession(sessionJson('session_abc', 'refs/heads/trial-x', undefined, '2026-11-11T13:00:00Z')),
    { id: 'session_abc', revision: 'refs/heads/trial-x', bucket: 'SESSION_STATUS_BUCKET_COMPLETED', createdAt: '2026-11-11T13:00:00Z', initError: null });
  assert.throws(() => trialSession({ ccr: { id: 'x' } }), /no session id/);
  assert.throws(() => trialSession({ ccr: { id: 'session_a', session_context: { sources: [] } } }), /no Broadwayscore source revision/);
});

test('buildRecord: a trial counts only on the guidance text it ran on, after it finished', () => {
  const dir = repo();
  try {
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), `### 2. ${words(MIN_WORDS)}\n`);
    commitAt(dir, 'draft one', 1);
    const draftOne = git(dir, 'rev-parse', 'HEAD').trim();
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), '### 3. another sentence added after the trial\n');
    commitAt(dir, 'draft two', 2);
    fs.writeFileSync(path.join(dir, 'scripts', 'x.js'), '2;\n');
    commitAt(dir, 'code only, guidance unchanged', 3);
    const note = 'trial followed the new rule and nothing else regressed';
    const rec = (rev, created, extra = {}) => buildRecord({ cwd: dir, base: 'main', sessions: [trialSession(sessionJson('session_t1', rev, undefined, created))], verdict: 'pass', note, ...extra });

    // The branch moved on after the trial started: the trial ran draft one, not today's tip.
    assert.match(rec('refs/heads/work', at(1.5)).error, /guidance text differs/, 'a trial of an older draft on the same branch is refused');
    assert.match(rec(draftOne, at(1.5)).error, /guidance text differs/, 'a sha of an older draft is refused');
    const r = rec('refs/heads/work', at(2.5));
    assert.ok(r.row, JSON.stringify(r));
    assert.deepEqual(r.row.sessions, ['session_t1']);
    assert.equal(r.row.hash, guidanceDiff(dir, 'main', 'HEAD').hash, 'a later code-only commit keeps the same guidance text');
    assert.match(rec('refs/heads/work', at(-5)).error, /cannot resolve/, 'a session older than every commit has nothing to resolve');
    assert.match(rec('refs/heads/work', null).error, /cannot resolve/, 'a branch name needs the start time');
    assert.match(buildRecord({ cwd: dir, base: 'main', sessions: [trialSession(sessionJson('session_t2', 'refs/heads/work', 'SESSION_STATUS_BUCKET_WORKING'))], verdict: 'pass', note }).error, /still working/);
    assert.match(buildRecord({ cwd: dir, base: 'main', sessions: [trialSession(sessionJson('session_t3', 'refs/heads/work', ''))], verdict: 'pass', note }).error, /status is unknown/);
    assert.match(rec('refs/heads/no-such-branch', at(2.5)).error, /cannot resolve/);
    const dead = sessionJson('session_t4', 'refs/heads/work', 'SESSION_STATUS_BUCKET_COMPLETED', at(2.5));
    dead.ccr.external_metadata = { last_init_error: { message: 'Setup script failed' } };
    assert.match(buildRecord({ cwd: dir, base: 'main', sessions: [trialSession(dead)], verdict: 'pass', note }).error, /never started/, 'an archived session that died in setup is not a trial');
    assert.match(rec('refs/heads/work', at(2.5), { verdict: 'maybe' }).error, /pass or fail/);
    assert.match(rec('refs/heads/work', at(2.5), { note: 'ok' }).error, /20\+ characters/);
    assert.match(buildRecord({ cwd: dir, base: 'main', sessions: [], verdict: 'pass', note }).error, /--from-json/);
    assert.match(buildRecord({ cwd: dir, base: 'no-such-base', sessions: [trialSession(sessionJson('session_t1', 'refs/heads/work'))], verdict: 'pass', note }).error, /failed/);
  } finally { rm(dir); }
});

test('main record + status: writes the ledger row that clears the warning', () => {
  const dir = repo();
  try {
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), `### 2. ${words(MIN_WORDS)}\n`);
    commit(dir, 'rule');
    const outs = []; const errs = [];
    const io = { cwd: dir, out: (s) => outs.push(s), err: (s) => errs.push(s) };
    assert.equal(main(['status', '--base', 'main'], io), 0);
    assert.match(outs.join('\n'), /Trial needed[\s\S]*create_session[\s\S]*TRIAL SESSION/);
    const f = path.join(dir, 'gs.json');
    fs.writeFileSync(f, JSON.stringify(sessionJson('session_t1', 'refs/heads/work')));
    assert.equal(main(['record', '--base', 'main', '--from-json', f, '--verdict', 'pass', '--note', 'followed the new rule in a real trial'], io), 0, errs.join('\n'));
    assert.equal(ruleTrialWarning({ root: dir, base: 'main' }), null);
    outs.length = 0;
    assert.equal(main(['status', '--base', 'main'], io), 0);
    assert.match(outs.join('\n'), /passing trial is recorded/);
    assert.equal(main(['record', '--base', 'main', '--verdict', 'pass', '--note', 'no sessions given here at all'], io), 1);
    assert.equal(main(['bogus'], io), 1);
  } finally { rm(dir); }
});
