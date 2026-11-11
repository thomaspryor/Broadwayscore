// BRO-7370: rule-trial.mjs, trial sessions before big written-guidance changes land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isGuidance, countWords, guidanceDiff, ruleTrialWarning, trialSession, buildRecord, main, LEDGER, MIN_WORDS,
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

const sessionJson = (id, revision, bucket = 'SESSION_STATUS_BUCKET_COMPLETED') => ({ ccr: { id, status_bucket: bucket,
  session_context: { sources: [{ git_repository: { url: 'https://github.com/thomaspryor/Broadwayscore', revision } }] } } });

test('trialSession: needs a session id and a Broadwayscore revision', () => {
  assert.deepEqual(trialSession(sessionJson('session_abc', 'refs/heads/trial-x')), { id: 'session_abc', revision: 'refs/heads/trial-x', bucket: 'SESSION_STATUS_BUCKET_COMPLETED' });
  assert.throws(() => trialSession({ ccr: { id: 'x' } }), /no session id/);
  assert.throws(() => trialSession({ ccr: { id: 'session_a', session_context: { sources: [] } } }), /no Broadwayscore source revision/);
});

test('buildRecord: a trial counts only on this exact guidance text, after it finished', () => {
  const dir = repo();
  try {
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), `### 2. ${words(MIN_WORDS)}\n`);
    commit(dir, 'draft one');
    git(dir, 'branch', 'draft-one');
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), '### 3. another sentence added after the trial\n');
    commit(dir, 'draft two');
    fs.writeFileSync(path.join(dir, 'scripts', 'x.js'), '2;\n');
    commit(dir, 'code only, guidance unchanged');
    git(dir, 'branch', 'tip-before-code', 'HEAD~1');
    const note = 'trial followed the new rule and nothing else regressed';
    const ok = (rev, extra = {}) => buildRecord({ cwd: dir, base: 'main', sessions: [trialSession(sessionJson('session_t1', rev))], verdict: 'pass', note, ...extra });

    assert.match(ok('refs/heads/draft-one').error, /guidance text differs/, 'a trial of an older draft is refused');
    const r = ok('refs/heads/tip-before-code');
    assert.ok(r.row, JSON.stringify(r));
    assert.deepEqual(r.row.sessions, ['session_t1']);
    assert.equal(r.row.hash, guidanceDiff(dir, 'main', 'HEAD').hash, 'a later code-only commit keeps the same guidance text');
    assert.match(buildRecord({ cwd: dir, base: 'main', sessions: [trialSession(sessionJson('session_t2', 'refs/heads/tip-before-code', 'SESSION_STATUS_BUCKET_WORKING'))], verdict: 'pass', note }).error, /still working/);
    assert.match(ok('refs/heads/no-such-branch').error, /cannot resolve/);
    assert.match(ok('refs/heads/tip-before-code', { verdict: 'maybe' }).error, /pass or fail/);
    assert.match(ok('refs/heads/tip-before-code', { note: 'ok' }).error, /20\+ characters/);
    assert.match(buildRecord({ cwd: dir, base: 'main', sessions: [], verdict: 'pass', note }).error, /--from-json/);
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
