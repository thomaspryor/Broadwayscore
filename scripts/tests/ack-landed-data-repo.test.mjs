/**
 * ack-landed-data-repo.test.mjs — BRO-5219: --data-repo points every git check
 * at a private data repo clone. These pin the CLI half: the flag parses, an
 * unknown name or a non-clone refuses (never a silent fallback to
 * Broadwayscore), and a real throwaway clone resolves. The decision half lives
 * in scripts/lib/ack-landed-core.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseArgs, resolveDataRepo } = require('../ack-landed.js');

const base = ['--id', 'BRO-5416', '--sha', 'abc1234', '--verify', 'node -e 1', '--reason', 'reasonreasonreason'];

test('parseArgs: --data-repo is carried through', () => {
  const a = parseArgs([...base, '--data-repo', 'review-texts']);
  assert.equal(a.error, undefined);
  assert.equal(a.dataRepo, 'review-texts');
});

test('resolveDataRepo: unknown name refuses', () => {
  assert.match(resolveDataRepo('broadwayscore', {}).error, /must be one of: review-texts, core-data/);
  assert.match(resolveDataRepo('__proto__', {}).error, /must be one of/);
});

test('resolveDataRepo: a directory that is not its own clone refuses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-dr-'));
  try {
    assert.match(resolveDataRepo('review-texts', { REVIEW_TEXTS_DIR: dir }).error, /not a git work tree/);
    const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    g(dir, 'init', '-q', '-b', 'main');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    assert.match(resolveDataRepo('review-texts', { REVIEW_TEXTS_DIR: sub }).error, /not its own clone/);
    assert.match(resolveDataRepo('review-texts', { REVIEW_TEXTS_DIR: dir }).error, /no origin\/main/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveDataRepo: a clone with origin/main resolves to its path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-dr-'));
  try {
    const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    g(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const clone = path.join(root, 'clone');
    g(root, 'clone', '-q', origin, clone);
    const r = resolveDataRepo('review-texts', { REVIEW_TEXTS_DIR: clone });
    assert.equal(r.error, undefined);
    assert.equal(r.path, clone);
    assert.equal(r.name, 'review-texts');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
