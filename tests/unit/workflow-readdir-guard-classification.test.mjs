import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { readWorkflowFilesOrFailClosed, MIN_EXPECTED_WORKFLOWS } = require('../../scripts/lib/workflow-glob-guard.js');
const report = fs.readFileSync(path.join(ROOT, 'docs/audits/bro-3689-workflow-readdir-classification.md'), 'utf8');
const entries = [...report.matchAll(/^\| `(scripts\/[^`]+)` \| (verdict-risk|informational) \| (.+) \|$/gm)]
  .map(([, file, classification, reason]) => ({ file, classification, reason }));

test('the written audit classifies all 32 card entries with a reason', () => {
  assert.equal(entries.length, 32);
  assert.equal(new Set(entries.map(e => e.file)).size, 32);
  assert.equal(entries.filter(e => e.classification === 'verdict-risk').length, 14);
  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.file)), entry.file);
    assert.ok(entry.reason.length > 40, entry.file);
  }
});

// Execute production callers in separate processes. Redirect only their
// workflow enumeration to a real fixture directory. The production helper
// decides whether it is large enough; no scanner logic is copied here.
// Network and snapshot writes are forbidden so missing guards fail safely.
function makeFixture(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-classification-'));
  const inventory = path.join(root, 'workflows');
  if (count !== null) {
    fs.mkdirSync(inventory);
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(inventory, `fixture-${i}.yml`), 'jobs: {}\n');
    // Non-workflow files must not contribute to the floor.
    for (let i = 0; i < MIN_EXPECTED_WORKFLOWS; i++) fs.writeFileSync(path.join(inventory, `note-${i}.txt`), '');
  }
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const cp = require('node:child_process');
    const workflows = ${JSON.stringify(path.join(ROOT, '.github/workflows'))};
    const readdir = fs.readdirSync;
    fs.readdirSync = (dir, ...args) => readdir(
      path.resolve(String(dir)) === workflows ? ${JSON.stringify(inventory)} : dir, ...args);
    fs.writeFileSync = () => { throw new Error('UNEXPECTED_WRITE'); };
    cp.spawnSync = (cmd) => {
      if (cmd === 'command' || cmd === 'git') return { status: 0, stdout: '' };
      throw new Error('UNEXPECTED_SUBPROCESS: ' + cmd);
    };
    cp.execSync = cp.execFileSync = () => { throw new Error('UNEXPECTED_SUBPROCESS'); };
    const deny = () => { throw new Error('UNEXPECTED_NETWORK'); };
    for (const protocol of ['node:http', 'node:https']) {
      const mod = require(protocol); mod.get = deny; mod.request = deny;
    }
    global.fetch = deny;
  `);
  return { root, inventory, preload };
}

function runCaller(file, fixture, healthFunction) {
  const target = path.join(ROOT, file);
  let args = ['--require', fixture.preload, target];
  if (file.endsWith('/audit-push-retry-budgets.js')) args.push('--fail-on-job-timeout');
  if (file.endsWith('/audit-notion-schedule-coupling.js')) {
    args = ['--require', fixture.preload, '-e', `
      const audit = require(${JSON.stringify(target)});
      console.log(JSON.stringify(audit.scanWorkflowsForCoupling()));
    `];
  } else if (healthFunction) {
    args = ['--require', fixture.preload, '-e', `
      process.env.GITHUB_ACTIONS = 'true';
      process.env.GH_TOKEN = 'offline-fixture';
      const cache = require(${JSON.stringify(path.join(ROOT, 'scripts/lib/gh-api-cache.js'))});
      cache.hasLowHeadroom = () => false;
      const health = require(${JSON.stringify(target)});
      Promise.resolve(health[${JSON.stringify(healthFunction)}]()).then(rows => console.log(JSON.stringify(rows)));
    `];
  }
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
}

for (const { file } of entries.filter(e => e.classification === 'verdict-risk')) {
  const functions = file.endsWith('/health-check.js')
    ? ['checkExemptCronLiveness', 'checkScheduledFailureStreak', 'checkNeverRunWorkflowHealth'] : [null];
  for (const healthFunction of functions) {
    for (const count of [null, 0, 3, MIN_EXPECTED_WORKFLOWS - 1]) {
      test(`${file}${healthFunction ? ':' + healthFunction : ''} refuses a ${count === null ? 'missing' : count + '-workflow'} inventory`, () => {
        const fixture = makeFixture(count);
        try {
          const result = runCaller(file, fixture, healthFunction);
          assert.ifError(result.error);
          const output = result.stdout + result.stderr;
          assert.doesNotMatch(output, /UNEXPECTED_(NETWORK|SUBPROCESS|WRITE)/, output);
          assert.match(output, count === null ? /ENOENT/ : new RegExp(`__TOO_FEW_WORKFLOWS__:${count}(?!\\d)`), output);
          if (healthFunction) {
            const rows = JSON.parse(result.stdout.trim().split('\n').at(-1));
            assert.equal(rows.length, 1);
            assert.equal(rows[0].status, 'error');
            assert.equal(result.status, 0, output);
          } else if (file.endsWith('/audit-notion-schedule-coupling.js')) {
            assert.equal(JSON.parse(result.stdout).ok, false);
            assert.equal(result.status, 0, output);
          } else if (file.endsWith('/audit-alert-reachability.js')) {
            assert.equal(result.status, 0, output);
            assert.match(output, /::warning::.*scan incomplete/);
            assert.doesNotMatch(output, /no unreachable.*found/);
          } else {
            assert.notEqual(result.status, 0, output);
          }
        } finally {
          fs.rmSync(fixture.root, { recursive: true, force: true });
        }
      });
    }
  }
}

test('the real workflow inventory is unchanged by the guard', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const expected = fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  assert.ok(expected.length >= MIN_EXPECTED_WORKFLOWS);
  assert.deepEqual(readWorkflowFilesOrFailClosed(dir, { includeYaml: true }).sort(), expected);
});

test('both-extension callers count .yaml at the exact floor; .yml-only callers preserve their scope', () => {
  const fixture = makeFixture(MIN_EXPECTED_WORKFLOWS - 1);
  try {
    fs.writeFileSync(path.join(fixture.inventory, 'last.yaml'), 'jobs: {}\n');
    assert.equal(readWorkflowFilesOrFailClosed(fixture.inventory, { includeYaml: true }).length, MIN_EXPECTED_WORKFLOWS);
    assert.throws(() => readWorkflowFilesOrFailClosed(fixture.inventory), /__TOO_FEW_WORKFLOWS__:49/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
