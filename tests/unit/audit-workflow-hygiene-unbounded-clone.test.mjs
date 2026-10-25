// Rule (z): a `git clone` with no wall-clock cap (BRO-5972).
//
// A stalled clone transfer never returns, so the step waits for the job
// timeout (or GitHub's 6h default) instead of failing in minutes. BRO-4966
// added git_net (scripts/lib/git-net-timeout.sh) for this; the inline
// fallback re-clones in rebuild-reviews, rebuild-fast, opening-night-poller,
// fetch-guardian-reviews and scrape-dtli-show-score, plus the finance and
// claude-config clones, stayed bare until BRO-5972.
//
// Per CLAUDE.md §15 this requires the REAL rule function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findUnboundedGitClones, findUnboundedGitNetworkCommands } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const wf = (body) => `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n${body.split('\n').map((l) => `          ${l}`).join('\n')}\n`;

test('flags bare clones, including git -c ... clone and inline run', () => {
  assert.equal(findUnboundedGitClones(wf('git clone --depth 1 https://x/y.git d')).length, 1);
  assert.equal(findUnboundedGitClones(wf('if git -c "http.x.extraheader=$h" clone -q https://x/y d; then :; fi')).length, 1);
  assert.equal(findUnboundedGitClones('jobs:\n  a:\n    steps:\n      - run: git clone https://x/y.git d\n').length, 1);
  assert.equal(findUnboundedGitClones(wf('echo cloning && git clone https://x/y.git d')).length, 1);
  assert.equal(findUnboundedGitClones(wf('git clone https://x/y.git d  # see timeout docs')).length, 1);
});

test('bounded, archival, message and exempt lines pass', () => {
  for (const body of [
    'git_net 300 clone --depth 1 https://x/y.git d',
    'git_net 120 -c "http.x.extraheader=$h" clone -q https://x/y d',
    'timeout 300 git clone https://x/y.git d',
    'FOO=1 timeout 90 git clone https://x/y.git d',
    'while ! timeout 60 git clone https://x/y.git d; do sleep 1; done',
    'git clone --mirror https://x/y.git repo.git',
    'git clone --bare https://x/y.git /tmp/r',
    'echo "re-running git clone after a stale checkout"',
    '# git clone https://x/y.git d',
    'git clone https://x/y.git d  # hygiene-unbounded-clone-ok: test',
    '# hygiene-unbounded-clone-ok: test\ngit clone https://x/y.git d',
  ]) {
    assert.deepEqual(findUnboundedGitClones(wf(body)), [], body);
  }
});

test('every workflow clone is bounded', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const offenders = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const h of findUnboundedGitClones(readFileSync(path.join(dir, f), 'utf8'))) {
      offenders.push(`${f}:${h.lineNum}: ${h.text.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `unbounded git clone(s):\n${offenders.join('\n')}`);
});

test('network rule flags unbounded fetch, pull and push, including global options', () => {
  for (const body of [
    'git fetch origin main',
    'git pull --rebase origin main',
    'if git push origin HEAD:main; then exit 0; fi',
    'git -C "repo dir" fetch origin main',
    'git -c "http.extraheader=AUTHORIZATION: basic token" push origin main',
    'OUT=$(git push --force-with-lease="$ref:$sha" origin "$ref" 2>&1)',
    'git push --mirror origin',
    'git --bare fetch origin main',
    'git fetch origin main # timeout is only documentation',
    'echo "$(git fetch origin main)"',
  ]) {
    assert.equal(findUnboundedGitNetworkCommands(wf(body)).length, 1, body);
  }
  assert.equal(findUnboundedGitNetworkCommands('steps:\n  - run: git pull origin main\n').length, 1);
});

test('network rule skips bounded commands, comments, messages and clone-only archives', () => {
  for (const body of [
    'git_net 120 fetch origin main',
    'git_net 180 pull --rebase origin main',
    'git_net 90 push origin HEAD:main',
    'timeout -k 10 "$CAP" git fetch --progress origin main',
    'if timeout 90 git push; then break; fi',
    'OUT=$(timeout 90 git push origin main)',
    'gtimeout 180 git pull --rebase',
    'bash scripts/push-with-retry.sh',
    '# git fetch origin main',
    'echo "git pull origin main"',
    'printf "git push origin main"',
    'echo "git fetch origin && git reset --hard origin/main" >> "$GITHUB_STEP_SUMMARY"',
    'git status # git fetch origin main',
    '1. Pull latest: \\`git pull\\`',
    'git clone --mirror https://x/y.git repo.git',
    'git clone --bare https://x/y.git repo.git',
    'git fetch origin main # hygiene-unbounded-clone-ok: temporary exception',
    '# hygiene-unbounded-clone-ok: temporary exception\ngit push origin main',
  ]) {
    assert.deepEqual(findUnboundedGitNetworkCommands(wf(body)), [], body);
  }
});

test('network rule checks sudo, until and env commands with and without a timeout', () => {
  for (const [bounded, unbounded] of [
    ['sudo timeout 90 git fetch origin main', 'sudo git fetch origin main'],
    ['until timeout 60 git push origin HEAD; do sleep 1; done', 'until git push origin HEAD; do sleep 1; done'],
    ['env X=1 timeout 60 git pull origin main', 'env X=1 git pull origin main'],
  ]) {
    assert.deepEqual(findUnboundedGitNetworkCommands(wf(bounded)), [], bounded);
    assert.equal(findUnboundedGitNetworkCommands(wf(unbounded)).length, 1, unbounded);
  }
});

test('quoted values cannot supply a timeout for a git network command', () => {
  for (const body of [
    'env NOTE="timeout 60" git fetch origin main',
    "env NOTE='timeout 60' git push origin main",
    'env NOTE="gtimeout 60" git pull origin main',
    'env NOTE="escaped \\"quote\\" timeout 60" git clone https://x/y.git d',
  ]) {
    assert.equal(findUnboundedGitNetworkCommands(wf(body)).length, 1, body);
  }
  for (const body of [
    'env NOTE="timeout 60" timeout "$CAP" git fetch origin main',
    "env NOTE='timeout 60' timeout 90 git push origin main",
    'env NOTE="gtimeout 60" gtimeout 90 git pull origin main',
    'timeout "$CAP" git -c "http.extraheader=$h" clone https://x/y.git d',
  ]) {
    assert.deepEqual(findUnboundedGitNetworkCommands(wf(body)), [], body);
  }
});

test('a bounded command does not hide a separate unbounded command on the same line', () => {
  for (const body of [
    'git_net 120 fetch origin main && git push origin main',
    'timeout 120 git fetch origin main; git pull --rebase',
    'echo timeout && git fetch origin main',
    'git clone --mirror https://x/y.git repo.git && git push --mirror origin',
  ]) {
    assert.equal(findUnboundedGitNetworkCommands(wf(body)).length, 1, body);
  }
});

test('network rule includes clones and keeps the clone-only API compatible', () => {
  const raw = wf('git clone https://x/y.git d\ngit fetch origin main\ngit pull\ngit push');
  assert.equal(findUnboundedGitNetworkCommands(raw).length, 4);
  assert.equal(findUnboundedGitClones(raw).length, 1);
});
