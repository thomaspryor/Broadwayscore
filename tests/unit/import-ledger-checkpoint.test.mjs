// tests/unit/import-ledger-checkpoint.test.mjs — S3-T7c incident, 2026-08-20.
//
// The ledger is the only record of which Notion pageId became which Linear
// issue. It is a git-tracked file, and a full import spends ~30 minutes
// appending to it. On 2026-08-20 a parallel session merged three branches into
// main in the same shared checkout mid-import; the working-tree copy was reset
// and ~776 uncommitted rows were destroyed. No Linear issues were lost — the
// deterministic issue id makes a replayed create a classified no-op — but the
// MAPPING was, so the anti-join reported live issues as unaccounted and the
// only recovery was a full re-run.
//
// checkpointLedger() bounds that loss to a single batch. These tests use a real
// throwaway git repo and a real reset, not mocks: the whole point is what git
// actually does to an uncommitted file, which a mock cannot tell us.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkpointLedger } = require('../../scripts/lib/import-ledger.js');

function newRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-ckpt-'));
  const git = (...a) =>
    execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const ledger = path.join(dir, 'data', 'ledger.jsonl');
  mkdirSync(path.dirname(ledger), { recursive: true });
  return { dir, git, ledger };
}

const row = (id) => JSON.stringify({ pageId: id.toLowerCase(), identifier: `BRO-${id}` }) + '\n';

test('a missing ledger is a no-op, not a throw', () => {
  const { dir } = newRepo();
  assert.equal(checkpointLedger(path.join(dir, 'data', 'absent.jsonl'), 'b0'), false);
  rmSync(dir, { recursive: true, force: true });
});

test('checkpoint commits the rows written so far', () => {
  const { dir, git, ledger } = newRepo();
  appendFileSync(ledger, row('1'));
  assert.equal(checkpointLedger(ledger, 'batch 1'), true);
  assert.match(git('log', '--oneline'), /batch 1/);
  assert.match(git('show', 'HEAD:data/ledger.jsonl'), /BRO-1/);
  rmSync(dir, { recursive: true, force: true });
});

test('no new rows produces no empty commit', () => {
  const { dir, git, ledger } = newRepo();
  appendFileSync(ledger, row('1'));
  checkpointLedger(ledger, 'batch 1');
  const head = git('rev-parse', 'HEAD');
  assert.equal(checkpointLedger(ledger, 'batch 2'), false);
  assert.equal(git('rev-parse', 'HEAD'), head);
  rmSync(dir, { recursive: true, force: true });
});

test('THE INCIDENT: checkpointed rows survive a working-tree reset, loss is bounded to one batch', () => {
  const { dir, git, ledger } = newRepo();
  appendFileSync(ledger, row('1'));
  checkpointLedger(ledger, 'batch 1');
  appendFileSync(ledger, row('2'));
  checkpointLedger(ledger, 'batch 2');
  appendFileSync(ledger, row('3')); // written after the last checkpoint — in the loss window

  // What a parallel session's merge effectively did to the working tree.
  git('checkout', '--', 'data/ledger.jsonl');

  const after = readFileSync(ledger, 'utf8');
  assert.match(after, /BRO-1/, 'checkpointed row survived');
  assert.match(after, /BRO-2/, 'checkpointed row survived');
  assert.doesNotMatch(after, /BRO-3/, 'only post-checkpoint rows are lost');
  rmSync(dir, { recursive: true, force: true });
});

test('only the ledger is staged — never another session\'s work in progress', () => {
  const { dir, git, ledger } = newRepo();
  writeFileSync(path.join(dir, 'other.txt'), 'a parallel session is mid-edit here');
  appendFileSync(ledger, row('1'));
  checkpointLedger(ledger, 'batch 1');
  assert.match(git('status', '--short'), /other\.txt/, 'unrelated file must remain uncommitted');
  rmSync(dir, { recursive: true, force: true });
});

test('outside a git repo it reports false rather than aborting the import', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-nogit-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  writeFileSync(ledger, '{}\n');
  assert.equal(checkpointLedger(ledger, 'batch 1'), false);
  rmSync(dir, { recursive: true, force: true });
});
