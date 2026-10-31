import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessThroughputRow } = require('../../scripts/lib/autofix-canary.js');
const root = new URL('../../', import.meta.url);
const source = (file) => readFileSync(new URL(file, root), 'utf8');

test('the digest autofix ledger is tracked in a normal checkout', () => {
  assert.equal(execFileSync('git', ['ls-files', '--error-unmatch',
    'data/audit/digest-autofix-ledger.jsonl'], { cwd: root, encoding: 'utf8' }).trim(),
  'data/audit/digest-autofix-ledger.jsonl');
});

test('effectiveness ENOENT warns about a missing tracked ledger, not an untracked CI input', () => {
  const block = source('scripts/health-check.js').split('function checkAutofixEffectiveness(isCI) {')[1]
    .split('const rows = [];')[0];
  assert.match(block, /git-tracked/);
  assert.match(block, /snapshot.*lag|lag.*snapshot/s);
  assert.match(block, /status: 'warn'/);
  assert.match(block, /unmeasurable: true/);
  assert.match(block, /is absent/);
  assert.doesNotMatch(block, /untracked|CI never sees|Track the ledger|always absent/);
});

test('digest comments distinguish committed snapshots from live host readings', () => {
  const block = source('scripts/send-morning-digest.js')
    .split('// Task #1220/BRO-230')[1].split('let backlogRows = null;')[0];
  assert.match(block, /git-tracked/);
  assert.match(block, /snapshot/);
  assert.match(block, /lag|stale/);
  assert.doesNotMatch(block, /doesn't exist in the checkout|BOTH.*per-machine|NEVER carry|only ever say 'warn'/);
});

test('health throughput comments distinguish tracked digest and local ledgers', () => {
  const block = source('scripts/health-check.js')
    .split('// --- Digest-autofix S6:')[1].split('function readJsonlLedgerOrNull')[0];
  assert.match(block, /git-tracked/);
  assert.doesNotMatch(block, /Both\s*\/\/ ledgers are gitignored|same as digest-autofix-ledger/);
});

test('unreadable throughput inputs remain a warning without claiming the digest ledger is gitignored', () => {
  const row = assessThroughputRow({ digestLedgerEntries: null, backlogLedgerEntries: null,
    linearIssues: null });
  assert.equal(row.status, 'warn');
  assert.equal(row.unmeasurable, true);
  assert.match(row.message, /absent|unreadable/);
  assert.match(row.message, /Linear/);
  assert.doesNotMatch(row.message, /gitignored|per-machine/);
});
