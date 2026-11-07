import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeStrandedTie } = require('../../scripts/lib/ack-landed-stranded-tie.js');
const { decideAck, decideLandedElsewhere } = require('../../scripts/lib/ack-landed-core.js');
const noTie = { tiedToStranded: false, tiedToStrandedByPatch: false };
const directTie = { tiedToStranded: true, tiedToStrandedByPatch: false };
const patchTie = { tiedToStranded: false, tiedToStrandedByPatch: true };

function fixture(t, { large = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-stranded-tip-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T11:00:00Z',
    },
  }).trim();
  const commit = (name, content = name + '\n') => {
    fs.writeFileSync(path.join(cwd, name), content);
    git('add', name);
    git('commit', '-qm', `BRO-4080: ${name}`);
    return git('rev-parse', 'HEAD');
  };
  const publish = () => git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('init', '-qb', 'main');
  const base = commit('base');
  git('checkout', '-qb', 'job');
  const first = commit('first');
  const tip = commit('tip', large ? 'large patch line\n'.repeat(100000) : 'tip\n');
  git('checkout', '-q', 'main');
  const unrelated = commit('unrelated');
  publish();
  const tie = (sha, strandedSha = tip, opts = {}) => computeStrandedTie(sha, strandedSha, { cwd, ...opts });
  const land = (sha) => { git('cherry-pick', sha); publish(); return git('rev-parse', 'HEAD'); };
  return { cwd, git, commit, publish, base, first, tip, unrelated, tie, land };
}

function facts(sha, tip, tie) {
  return {
    ref: 'BRO-4080',
    rows: [
      { event: 'job-spawned', taskId: 'linear:BRO-4080', jobId: 'job', ts: '2026-01-01T09:00:00Z' },
      { event: 'job-stranded', taskId: 'linear:BRO-4080', jobId: 'job', ts: '2026-01-01T10:30:00Z', sha: tip },
    ],
    landing: { verdict: 'LANDED', sha, authorTs: '2026-01-01T12:00:00Z',
      message: 'BRO-4080: landed work', changedPaths: ['scripts/example.js'], ...tie },
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node --test tests/unit/ack-landed-stranded-tip.test.mjs', safe: true, exitCode: 0 },
    reason: 'Verified the stranded tip against actual git history',
  };
}

test('partial landing: an earlier patch twin cannot acknowledge the stranded job', t => {
  const f = fixture(t);
  const landedFirst = f.land(f.first);
  assert.notEqual(landedFirst, f.first);
  const decision = decideAck(facts(landedFirst, f.tip, f.tie(landedFirst)));
  assert.equal(decision.ok, false, 'the unlanded tip must prevent a job-level ack');
  assert.equal(decision.row, null);
  assert.deepEqual(f.tie(landedFirst), noTie);
});

test('full rebase: only the rebased tip can acknowledge the job', t => {
  const f = fixture(t);
  f.git('checkout', '-q', 'job');
  f.git('rebase', '-q', 'origin/main');
  const rebasedFirst = f.git('rev-parse', 'HEAD^');
  const rebasedTip = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-q', 'main');
  f.git('merge', '-q', '--ff-only', 'job');
  f.publish();
  assert.notEqual(rebasedTip, f.tip);
  assert.deepEqual(f.tie(rebasedFirst), noTie);
  assert.deepEqual(f.tie(rebasedTip), patchTie);
  const decision = decideAck(facts(rebasedTip, f.tip, f.tie(rebasedTip)));
  assert.equal(decision.ok, true, decision.refusals.join('\n'));
  assert.equal(decision.row.strandedSha, f.tip);
});

test('direct partial landing: neither an earlier commit nor the branch base is the tip', t => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/origin/main', f.first);
  for (const sha of [f.first, f.base]) {
    assert.deepEqual(f.tie(sha), noTie);
    assert.equal(decideAck(facts(sha, f.tip, f.tie(sha))).ok, false);
  }
});

test('direct tip and valid abbreviations retain their tie', t => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/origin/main', f.tip);
  assert.deepEqual(f.tie(f.tip), directTie);
  assert.deepEqual(f.tie(f.tip.slice(0, 12)), directTie);
  assert.deepEqual(f.tie(f.tip, f.tip.slice(0, 12)), directTie);
});

test('missing, invalid and non-commit IDs fail closed, including identical missing IDs', t => {
  const f = fixture(t);
  const blob = f.git('rev-parse', `${f.tip}:tip`);
  for (const bad of [null, '', 'deadbeefdeadbeef', '--help', blob]) {
    assert.deepEqual(f.tie(bad), noTie);
    assert.deepEqual(f.tie(f.tip, bad), noTie);
    assert.deepEqual(f.tie(bad, bad), noTie);
  }
});

test('empty diffs and unrelated patches never match; non-landed twins skip patch matching', t => {
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-qm', 'empty one');
  const empty1 = f.git('rev-parse', 'HEAD');
  f.git('commit', '--allow-empty', '-qm', 'empty two');
  const empty2 = f.git('rev-parse', 'HEAD');
  f.publish();
  assert.deepEqual(f.tie(empty1, empty2), noTie);
  assert.deepEqual(f.tie(f.unrelated), noTie);
  f.land(f.first);
  const landedTip = f.land(f.tip);
  assert.deepEqual(f.tie(landedTip, f.tip, { landed: false }), noTie);
});

test('landed-elsewhere still recognizes earlier stranded work as owned by a dispatch', t => {
  const f = fixture(t);
  const landedFirst = f.land(f.first);
  const ownership = f.tie(landedFirst, f.tip, { includeEarlierCommits: true });
  assert.deepEqual(ownership, patchTie);
  assert.deepEqual(f.tie(f.first, f.tip, { includeEarlierCommits: true }), directTie);
  for (const historical of [false, true]) {
    const input = facts(landedFirst, f.tip, ownership);
    if (historical) input.rows.push(
      { event: 'job-spawned', taskId: 'linear:BRO-4080', jobId: 'later', ts: '2026-01-01T10:40:00Z' },
      { event: 'job-stopped-short', taskId: 'linear:BRO-4080', jobId: 'later', ts: '2026-01-01T10:45:00Z' },
    );
    const decision = decideLandedElsewhere(input);
    assert.equal(decision.ok, false);
    assert.match(decision.refusals.join('\n'), /stranded/i);
  }
});

test('tip patch matching retains buffers for diffs exceeding 1 MiB', t => {
  const f = fixture(t, { large: true });
  f.land(f.first);
  assert.deepEqual(f.tie(f.land(f.tip)), patchTie);
});
