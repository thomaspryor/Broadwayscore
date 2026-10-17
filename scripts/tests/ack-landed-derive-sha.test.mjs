import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { candidatesFor, parseArgs } = require('../ack-landed.js');

// BRO-4071. ack-landed made the operator guess --sha even though it could
// search origin/main for the commits naming the card inside the window the
// decision judges by — the BRO-4066 handoff guessed wrong and passed the one
// commit of three that named no card. With --sha omitted, main() now takes
// candidatesFor(ref, hintCtx)[0]. These pin the helper both the derivation and
// the refusal hint share, so the two can never drift apart.
//
// Throwaway repo, not this repo's history: CI checks out at depth 1.

const CARD = 'BRO-777';
let repo;

function git(args, date = '2026-01-01T12:00:00Z') {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date,
    },
  });
}

function commit(message, date) {
  fs.writeFileSync(path.join(repo, 'f.txt'), String(Math.random()));
  git(['add', 'f.txt'], date);
  git(['commit', '-q', '-m', message], date);
  return git(['rev-parse', '--short', 'HEAD']).trim();
}

const LAUNCH = '2026-01-01T12:00:00Z';
const TERMINAL = '2026-01-01T13:00:00Z';
const JOB = { launchTs: LAUNCH, terminalTs: TERMINAL };
const OPTS = () => ({ cwd: repo, base: 'main' });
let before, older, unnamed, newer;

test.before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-landed-derive-'));
  git(['init', '-q', '-b', 'main']);
  // Shaped like the real BRO-4066 landing: two commits name the card, one
  // between them names nothing — plus one from before the dispatch launched.
  before = commit(`chore(${CARD}): groundwork that predates the dispatch`, '2026-01-01T11:00:00Z');
  older = commit(`fix(${CARD}): first half`, '2026-01-01T12:20:00Z');
  unnamed = commit('fix: follow-up that names no card', '2026-01-01T12:30:00Z');
  newer = commit(`fix: second half\n\nRefs ${CARD}.`, '2026-01-01T12:40:00Z');
});

test.after(() => { try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ } });

test('--sha is optional: parseArgs no longer requires it', () => {
  const a = parseArgs(['--id', CARD, '--verify', 'true', '--reason', 'derivation test reason']);
  assert.equal(a.error, undefined);
  assert.equal(a.sha, undefined);
});

test('job window: derives the NEWEST naming commit, never the unnamed one between', () => {
  const c = candidatesFor(CARD, JOB, [], OPTS());
  assert.deepEqual(c.map(x => x.sha), [newer, older],
    'newest first, so [0] is the landing tip; the unnamed commit is exactly the BRO-4066 wrong guess');
  assert.ok(!c.some(x => x.sha === unnamed));
  assert.ok(!c.some(x => x.sha === before), 'a commit from before launch is outside the job window');
});

test('--already-landed window: only commits authored BEFORE the earliest launch', () => {
  const c = candidatesFor(CARD, { alreadyLanded: true, beforeTs: LAUNCH }, [], OPTS());
  assert.deepEqual(c.map(x => x.sha), [before]);
});

test('unreadable earliest-launch ts under --already-landed: undefined (nothing can pass timing)', () => {
  assert.equal(candidatesFor(CARD, { alreadyLanded: true, beforeTs: null }, [], OPTS()), undefined);
  assert.equal(candidatesFor(CARD, { alreadyLanded: true, beforeTs: 'garbage' }, [], OPTS()), undefined);
});

test('window with no naming commit: [] (searched, none) — main() refuses rather than guessing', () => {
  const c = candidatesFor(CARD, { launchTs: '2026-01-02T00:00:00Z', terminalTs: '2026-01-02T01:00:00Z' }, [], OPTS());
  assert.deepEqual(c, []);
});

test('failed search: null, never [] — "could not look" must not read as "nothing landed"', () => {
  const c = candidatesFor(CARD, JOB, [], { cwd: path.join(repo, 'does-not-exist'), base: 'main' });
  assert.equal(c, null);
});
