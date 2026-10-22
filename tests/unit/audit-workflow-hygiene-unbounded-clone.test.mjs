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
const { findUnboundedGitClones } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
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
