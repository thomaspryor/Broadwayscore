// BRO-4238 phase 2: the pre-implementation review gate (CLAUDE.md §18) now
// runs in cloud sessions. Drives the REPO copies of infra-plan-review-gate.sh
// and infra-post-write-audit.sh (scripts/tests/infra-review-gate.test.mjs only
// covers the scope lib, never a hook script). Each case runs inside a
// throwaway git repo carrying scripts/lib, so the real review ledger is never
// read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4238-infra-'));
const fakeHome = path.join(scratch, 'home');   // no ~/.claude/hooks: the repo copies must not self-skip
fs.mkdirSync(fakeHome);
// Copied, not symlinked: a symlinked lib breaks transcript-scan.mjs's isMain check.
const repo = path.join(scratch, 'repo');
fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(repo, 'scripts', 'lib'), { recursive: true });
spawnSync('git', ['init', '-q', repo]);
// Committed, so the post-write audit (which asks git what changed) starts clean.
const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
git('add', '-A');
git('commit', '-q', '-m', 'fixture');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

let n = 0;
function runGate(name, toolName, toolInput, { sessionId = `sid-${++n}`, home = fakeHome, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(scratch, 'tmp-'));   // fresh repeat-block counter per case
  const r = spawnSync('bash', [path.join(HOOKS, name)], {
    cwd: repo,
    input: JSON.stringify({ session_id: sessionId, tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: home, TMPDIR: tmp, INFRA_REVIEW_GATE_DISABLE: '', INFRA_POST_AUDIT_DISABLE: '', ...env },
  });
  return { status: r.status, stderr: r.stderr || '' };
}
const edit = (rel) => ({ file_path: path.join(repo, rel), old_string: 'a', new_string: 'b' });

test('infra gate (cloud): an unreviewed edit to a critical file is blocked, with the review route', () => {
  for (const rel of ['scripts/lib/review-gate.mjs', '.claude/hooks/verify-edits.sh', '.claude/settings.json']) {
    const r = runGate('infra-plan-review-gate.sh', 'Edit', edit(rel));
    assert.equal(r.status, 2, `${rel}: ${r.stderr}`);
    assert.match(r.stderr, /second-opinion/);
    assert.match(r.stderr, /record-plan/);
  }
});

test('infra gate (cloud): a Bash write to a critical file is blocked too', () => {
  const r = runGate('infra-plan-review-gate.sh', 'Bash', { command: `sed -i 's/a/b/' ${path.join(repo, 'scripts/lib/review-gate.mjs')}` });
  assert.equal(r.status, 2, r.stderr);
});

test('infra gate (cloud): a recorded plan review for this session lets the edit through', () => {
  const sid = 'sid-reviewed';
  const rec = spawnSync('node', ['scripts/lib/review-gate.mjs', '--query=record-plan', '--reviewer=second-opinion',
    '--result=pass', `--session-id=${sid}`], { cwd: repo, encoding: 'utf8' });
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(runGate('infra-plan-review-gate.sh', 'Edit', edit('scripts/lib/review-gate.mjs'), { sessionId: sid }).status, 0);
  // ...and only for that session.
  assert.equal(runGate('infra-plan-review-gate.sh', 'Edit', edit('scripts/lib/review-gate.mjs'), { sessionId: 'sid-other' }).status, 2);
});

test('infra gate (cloud): ordinary files, NO-PLAN-REVIEW and the kill switch pass', () => {
  assert.equal(runGate('infra-plan-review-gate.sh', 'Edit', edit('src/app/page.tsx')).status, 0);
  assert.equal(runGate('infra-plan-review-gate.sh', 'Bash', { command: 'ls scripts/lib' }).status, 0);
  assert.equal(runGate('infra-plan-review-gate.sh', 'Bash',
    { command: `sed -i 's/a/b/' scripts/lib/review-gate.mjs # NO-PLAN-REVIEW: one-character typo fix in a comment` }).status, 0);
  assert.equal(runGate('infra-plan-review-gate.sh', 'Edit', edit('scripts/lib/review-gate.mjs'),
    { env: { INFRA_REVIEW_GATE_DISABLE: '1' } }).status, 0);
});

test('infra gate: fails open after two blocks on the same edit, so a session with no human cannot spin', () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'tmp-'));
  const call = () => spawnSync('bash', [path.join(HOOKS, 'infra-plan-review-gate.sh')], {
    cwd: repo, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ session_id: 'sid-spin', tool_name: 'Edit', tool_input: edit('scripts/lib/review-gate.mjs') }),
    env: { ...process.env, HOME: fakeHome, TMPDIR: tmp },
  }).status;
  assert.deepEqual([call(), call(), call()], [2, 2, 0]);
});

test('infra hooks: both self-skip on the Mac, where the ~/.claude/hooks masters run instead', () => {
  const macHome = path.join(scratch, 'mac-home');
  fs.mkdirSync(path.join(macHome, '.claude', 'hooks'), { recursive: true });
  for (const name of ['infra-plan-review-gate.sh', 'infra-post-write-audit.sh']) {
    fs.writeFileSync(path.join(macHome, '.claude', 'hooks', name), '#!/bin/bash\nexit 0\n');
  }
  assert.equal(runGate('infra-plan-review-gate.sh', 'Edit', edit('scripts/lib/review-gate.mjs'), { home: macHome }).status, 0);
  assert.equal(runGate('infra-post-write-audit.sh', 'Bash', { command: 'true' }, { home: macHome }).status, 0);
});

test('post-write audit (cloud): clean tree passes; an unreviewed Bash-side change to a critical file is flagged', () => {
  const r = runGate('infra-post-write-audit.sh', 'Bash', { command: 'ls' });
  assert.equal(r.status, 0, r.stderr);
  // `python3 x.py` writing a gated file is invisible to the pre-hoc gate's
  // command parser; the audit catches it from git's view of the tree.
  const target = path.join(repo, 'scripts', 'lib', 'review-gate.mjs');
  const before = fs.readFileSync(target, 'utf8');
  fs.appendFileSync(target, '\n// touched\n');
  try {
    const r2 = runGate('infra-post-write-audit.sh', 'Bash', { command: 'python3 tools/rewrite.py' });
    assert.notEqual(r2.status, 0, 'an unreviewed change to a critical file must be reported');
    assert.match(r2.stderr, /review-gate\.mjs/);
  } finally {
    fs.writeFileSync(target, before);
  }
});

test('settings.json: both infra hooks registered on the right events', () => {
  const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const find = (ev, script) => (d.hooks[ev] || []).find((g) => g.hooks.some((h) => h.command.includes(script)));
  const pre = find('PreToolUse', 'infra-plan-review-gate.sh');
  assert.ok(pre, 'infra-plan-review-gate.sh not registered');
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    assert.ok(new RegExp(`^(?:${pre.matcher})$`).test(t), `matcher must cover ${t}`);
  }
  const post = find('PostToolUse', 'infra-post-write-audit.sh');
  assert.ok(post && new RegExp(`^(?:${post.matcher})$`).test('Bash'), 'infra-post-write-audit.sh must run after Bash');
});

// BRO-4134 (rollout watch 2026-09-29): an unescaped ~ in a case pattern
// (`~/*)`) or prefix strip (`${x#~/}`) is tilde-EXPANDED by bash, so it never
// matches the literal "~/..." a command carries. Every copy of the push/merge
// review gates misread `cd ~/...` and `git -C ~/...` this way and judged the
// command against the wrong repo (a ~/.claude push was refused as a direct
// push to Broadwayscore main). Guard every repo hook script against it.
test('no hook script uses an unescaped ~ in a case pattern or prefix strip', () => {
  const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
  const dirs = [path.join(repo, '.claude', 'hooks'), path.join(repo, 'scripts', 'hooks')];
  const bad = [];
  let scanned = 0;
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (!fs.statSync(p).isFile()) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!/^#!.*\b(ba)?sh\b/.test(text) && !name.endsWith('.sh')) continue;
      scanned++;
      text.split('\n').forEach((line, i) => {
        if (/(^|\s)~\/?\*?\)|\$\{[A-Za-z_]+#~/.test(line)) bad.push(`${path.relative(repo, p)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.ok(scanned > 5, `expected to scan hook scripts, scanned ${scanned}`);
  assert.deepEqual(bad, [], 'write \\~ (escaped) in case patterns and ${x#\\~/}');
});
