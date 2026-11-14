import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const digest = require('./overnight-digest.js');
const { rowAbsentCheckCmd, rowRequiresLive } = require('./health-row-check-cmd.js');
const { isIssueMissingOnRead } = require('./linear-client.js');
const { isSkipPlaceholder } = require('./health-row-probe.js');

test('BRO-7276: every stuck-row filer uses a safe live command', () => {
  const { planAutofix, buildCardNotes, localRollupIssues } = require('./digest-autofix.js');
  const { isSafeCheckCommand } = require('./verify-gate.js');
  const command = rowAbsentCheckCmd('Stuck pipeline items');
  assert.match(command, / --live$/);
  assert.equal(rowRequiresLive(' Stuck pipeline items '), true);
  assert.equal(isSafeCheckCommand(command), true);
  for (const input of [
    { health: {}, extraIssues: localRollupIssues({ stuckCount: 1, stuckSignals: ['Unmerged work'] }) },
    { health: { warns: [{ name: 'Stuck pipeline items', message: 'Unmerged work' }] } },
  ]) {
    assert.ok(buildCardNotes(planAutofix({ ...input, tasks: [] })[0]).includes(command));
  }
  for (const name of ['Data freshness gaps', 'Dispatch health']) {
    assert.equal(rowRequiresLive(name), false);
    assert.doesNotMatch(rowAbsentCheckCmd(name), /--live/);
  }
});

test('BRO-7276: unavailable Mac sources cannot produce a clean live verdict', () => {
  const off = digest.stuckPipelineRow({ macSourcesPresent: false });
  assert.equal(isSkipPlaceholder(off), true);
  assert.equal(isSkipPlaceholder(digest.stuckPipelineRow({ macSourcesPresent: true })), false);
  assert.equal(digest.stuckPipelineRow({ macSourcesPresent: false, signals: ['Review regression'] }).status, 'warn');
  assert.equal(digest.stuckPipelineRow({ macSourcesPresent: true, errors: ['git timed out'] }).status, 'warn');
});

test('BRO-7276: a cloud worktree directory is not proof of Mac source availability', () => {
  assert.equal(digest.hasMacStuckSources({ repo: process.cwd(), platform: 'linux', exists: () => true }), false);
  assert.equal(digest.hasMacStuckSources({ repo: process.cwd(), platform: 'darwin', exists: () => false }), false);
  assert.equal(digest.hasMacStuckSources({ repo: process.cwd(), platform: 'darwin', exists: () => true }), true);
});

test('BRO-7276: missing issue reads are distinct from transient and permission errors', () => {
  assert.equal(isIssueMissingOnRead(new Error('Linear GraphQL error: Entity not found: Issue')), true);
  assert.equal(isIssueMissingOnRead({ linearErrors: [{ message: 'Entity not found: Issue' }] }), true);
  for (const message of ['fetch failed', 'HTTP 429', 'Unauthorized', 'Entity not found: IssueLabel']) {
    assert.equal(isIssueMissingOnRead(new Error(message)), false, message);
  }
});

test('BRO-7276: digest recognizes rebased patches while retaining real unlanded work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-pipeline-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, 'base'), 'base\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    const wtRoot = path.join(root, '.claude', 'worktrees');
    const add = (name, contents) => {
      const wt = path.join(wtRoot, name);
      git(root, 'worktree', 'add', '-qb', name, wt, base);
      fs.writeFileSync(path.join(wt, name), contents);
      git(wt, 'add', name); git(wt, 'commit', '-qm', 'fix(BRO-7276): same subject');
      return wt;
    };
    const landed = add('landed', 'landed patch\n');
    add('stranded', 'different patch, identical subject\n');
    add('job-unlanded', 'headless work still needs landing\n');
    fs.writeFileSync(path.join(root, 'other'), 'main moved\n');
    git(root, 'add', 'other'); git(root, 'commit', '-qm', 'main moved');
    git(root, 'cherry-pick', git(landed, 'rev-parse', 'HEAD'));
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = digest.gatherDigest({ repo: root, skipFetch: true });
    assert.deepEqual(result.stuck.worktrees.map(x => x.split(':')[0]).sort(), ['job-unlanded', 'stranded']);
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
