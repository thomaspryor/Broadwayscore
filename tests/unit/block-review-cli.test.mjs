/**
 * scripts/block-review.js — operator CLI for per-show _blocklist.json.
 *
 * Exercises the real subprocess entry point so exit codes, argv parsing,
 * and file writes are covered end-to-end against a tmp data dir. No real
 * review-texts fixtures are touched.
 *
 * Run: node --test tests/unit/block-review-cli.test.mjs
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', 'scripts', 'block-review.js');
const SHOW_ID = 'the-rocky-horror-show-2026';

let tmpRoot;
let showDir;
let blocklistPath;

function run(...args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf-8' });
}

function runInShow(...args) {
  return run(`--show=${SHOW_ID}`, `--data-dir=${tmpRoot}`, ...args);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'block-review-cli-'));
});

beforeEach(() => {
  showDir = path.join(tmpRoot, SHOW_ID);
  blocklistPath = path.join(showDir, '_blocklist.json');
  fs.rmSync(showDir, { recursive: true, force: true });
  fs.mkdirSync(showDir, { recursive: true });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('--help prints usage and exits 0 without --show', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /block-review\.js/);
  assert.match(r.stdout, /--remove=URL/);
});

test('no args prints help (exit 0)', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage|Examples/i);
});

test('missing --show exits 1', () => {
  const r = run('--list');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--show=ID is required/);
});

test('add writes canonical object form with blockedAt timestamp', () => {
  const url = 'https://davidcote1.substack.com/p/the-rocky-horror-show?triedRedirect=true';
  const r = runInShow(`--url=${url}`, '--reason=duplicate of cote-notices--david-cote');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Blocked/);
  assert.match(r.stdout, /normalized: https:\/\/davidcote1\.substack\.com\/p\/the-rocky-horror-show$/m);

  const saved = JSON.parse(fs.readFileSync(blocklistPath, 'utf-8'));
  assert.equal(saved.urls.length, 1);
  assert.equal(saved.urls[0].url, url);
  assert.equal(saved.urls[0].reason, 'duplicate of cote-notices--david-cote');
  assert.ok(saved.urls[0].blockedAt, 'blockedAt populated');
  assert.doesNotThrow(() => new Date(saved.urls[0].blockedAt).toISOString());
});

test('add without --reason still writes default reason', () => {
  const r = runInShow('--url=https://example.com/bad');
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(blocklistPath, 'utf-8'));
  assert.equal(saved.urls[0].reason, 'no reason given');
});

test('add rejects URL already blocked (normalized match across tracking params)', () => {
  const first = runInShow(
    '--url=https://example.com/review',
    '--reason=original block',
  );
  assert.equal(first.status, 0, first.stderr);

  const dup = runInShow('--url=https://example.com/review?utm_source=twitter');
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /Already blocked/);
  assert.match(dup.stderr, /original block/);

  const saved = JSON.parse(fs.readFileSync(blocklistPath, 'utf-8'));
  assert.equal(saved.urls.length, 1, 'no second entry written');
});

test('list prints (empty) when no file exists', () => {
  const r = runInShow('--list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(empty\)/);
});

test('list prints entries with reason, blockedAt, normalized form', () => {
  runInShow('--url=https://example.com/a', '--reason=reason-a');
  runInShow('--url=https://example.com/b', '--reason=reason-b');
  const r = runInShow('--list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 entries/);
  assert.match(r.stdout, /https:\/\/example\.com\/a/);
  assert.match(r.stdout, /https:\/\/example\.com\/b/);
  assert.match(r.stdout, /reason-a/);
  assert.match(r.stdout, /reason-b/);
  assert.match(r.stdout, /normalized:/);
});

test('remove succeeds when URL matches in normalized form (trailing slash + param)', () => {
  const stored = 'https://example.com/review?triedRedirect=true';
  const given = 'https://example.com/review/';
  runInShow(`--url=${stored}`, '--reason=x');
  const r = runInShow(`--remove=${given}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed 1 entry — 0 remaining/);
  const saved = JSON.parse(fs.readFileSync(blocklistPath, 'utf-8'));
  assert.equal(saved.urls.length, 0);
});

test('remove exits 1 when URL not present', () => {
  runInShow('--url=https://example.com/a');
  const r = runInShow('--remove=https://example.com/does-not-exist');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in blocklist/);
  const saved = JSON.parse(fs.readFileSync(blocklistPath, 'utf-8'));
  assert.equal(saved.urls.length, 1);
});

test('missing show dir exits 1 with a helpful message', () => {
  const r = run(
    '--show=does-not-exist',
    `--data-dir=${tmpRoot}`,
    '--url=https://example.com/x',
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Show dir not found/);
});

test('conflicting modes rejected (--list + --url)', () => {
  const r = runInShow('--list', '--url=https://example.com/x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Conflicting modes/);
});

test('existing legacy bare-string blocklist gets canonicalized on next write', () => {
  fs.writeFileSync(
    blocklistPath,
    JSON.stringify({ urls: ['https://legacy.example/review'] }),
  );
  const r = runInShow('--url=https://new.example/review', '--reason=new');
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(blocklistPath, 'utf-8'));
  assert.equal(saved.urls.length, 2);
  const legacy = saved.urls.find((e) => e.url === 'https://legacy.example/review');
  assert.ok(legacy, 'legacy entry preserved');
  assert.equal(legacy.reason, undefined, 'no synthesized reason written for bare-string legacy entry');
  const fresh = saved.urls.find((e) => e.url === 'https://new.example/review');
  assert.equal(fresh.reason, 'new');
  assert.ok(fresh.blockedAt);
});
