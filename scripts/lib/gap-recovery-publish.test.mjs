// BRO-7171 Stage 3: ledger publish by plumbing (no working tree), against a
// real bare remote. Run: node --test scripts/lib/gap-recovery-publish.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const P = require('./gap-recovery-publish.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const REL = 'data/audit/gap-recovery-attempts.jsonl';
const row = (n) => JSON.stringify({ ts: `2026-11-0${n}T00:00:00Z`, reviewKey: `s/${n}.json`, outcome: 'no_evidence' });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-pub-'));
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(root, 'seed');
  git(root, 'clone', '-q', bare, seed);
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  git(seed, 'config', 'core.hooksPath', '/dev/null');
  fs.mkdirSync(path.join(seed, 'data/audit'), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), row(1) + '\n');
  fs.writeFileSync(path.join(seed, 'other.txt'), 'untouched\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init'); git(seed, 'push', '-q', 'origin', 'main');
  const work = path.join(root, 'work');
  git(root, 'clone', '-q', bare, work);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  git(work, 'config', 'core.hooksPath', '/dev/null');
  return { root, bare, seed, work };
}

test('unionLines: origin order kept, only new valid lines appended, torn tail dropped', () => {
  const u = P.unionLines(`${row(1)}\n${row(2)}\n`, `${row(2)}\n${row(3)}\nnot json\n{"torn":`);
  assert.equal(u.text, `${row(1)}\n${row(2)}\n${row(3)}\n`);
  assert.equal(u.added, 1);
  assert.equal(P.unionLines(`${row(1)}\n`, `${row(1)}\n`).added, 0);
});

test('publish: one commit on origin/main, working tree and HEAD untouched, rerun is a no-op', () => {
  const { root, bare, work } = setup();
  const local = path.join(root, 'state.jsonl');
  fs.writeFileSync(local, `${row(1)}\n${row(2)}\n`);
  fs.writeFileSync(path.join(work, 'dirty.txt'), 'a session edit\n');
  const headBefore = git(work, 'rev-parse', 'HEAD').trim();
  const r = P.publishLedgers({ repoDir: work, files: [{ rel: REL, localPath: local }], message: 'data: ledger [skip ci]' });
  assert.equal(r.pushed, true);
  assert.equal(git(work, 'rev-parse', 'HEAD').trim(), headBefore, 'HEAD did not move');
  assert.equal(fs.readFileSync(path.join(work, 'dirty.txt'), 'utf8'), 'a session edit\n');
  assert.equal(git(work, 'status', '--porcelain', '--', REL).trim(), '', 'tracked ledger in the working tree untouched');
  assert.equal(git(bare, 'show', `main:${REL}`), `${row(1)}\n${row(2)}\n`);
  assert.equal(git(bare, 'show', 'main:other.txt'), 'untouched\n');
  assert.equal(git(bare, 'rev-list', '--count', 'main').trim(), '2');
  const again = P.publishLedgers({ repoDir: work, files: [{ rel: REL, localPath: local }], message: 'x' });
  assert.equal(again.upToDate, true);
  assert.equal(git(bare, 'rev-list', '--count', 'main').trim(), '2', 'no empty commit');
});

test('publish: origin moved (another writer appended) -> union keeps both sides, no merge commit', () => {
  const { root, bare, seed, work } = setup();
  // Another writer lands a row after our clone.
  fs.appendFileSync(path.join(seed, REL), row(5) + '\n');
  git(seed, 'commit', '-qam', 'ci row'); git(seed, 'push', '-q', 'origin', 'main');
  const local = path.join(root, 'state.jsonl');
  fs.writeFileSync(local, `${row(1)}\n${row(3)}\n`);
  P.publishLedgers({ repoDir: work, files: [{ rel: REL, localPath: local }, { rel: 'data/audit/new.jsonl', localPath: local }], message: 'm' });
  assert.equal(git(bare, 'show', `main:${REL}`), `${row(1)}\n${row(5)}\n${row(3)}\n`);
  assert.equal(git(bare, 'show', 'main:data/audit/new.jsonl'), `${row(1)}\n${row(3)}\n`, 'a file new to origin is created');
  assert.equal(git(bare, 'rev-list', '--merges', '--count', 'main').trim(), '0');
});

test('publish: push failure throws after retries (never reported as published)', () => {
  const { root, work } = setup();
  const local = path.join(root, 'state.jsonl');
  fs.writeFileSync(local, `${row(2)}\n`);
  git(work, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  assert.throws(() => P.publishLedgers({ repoDir: work, files: [{ rel: REL, localPath: local }], message: 'm', attempts: 1 }), /not published after 1 attempts/);
});

test('seedStateFile: unions origin, the shared working copy and the existing state file', () => {
  const { root, work } = setup();
  git(work, 'fetch', '-q', 'origin');
  fs.appendFileSync(path.join(work, REL), row(4) + '\n'); // manual run in the shared checkout
  const local = path.join(root, 'st', 'state.jsonl');
  fs.mkdirSync(path.dirname(local));
  fs.writeFileSync(local, row(7) + '\n');
  assert.equal(P.seedStateFile({ repoDir: work, rel: REL, localPath: local }), 3);
  assert.deepEqual(fs.readFileSync(local, 'utf8').trim().split('\n').sort(), [row(1), row(4), row(7)].sort());
});
