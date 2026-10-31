import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { scanSource, scanTree } = require('../../scripts/lib/git-maxbuffer-scan.js');

test('flags git show without maxBuffer', () => {
  const hits = scanSource("const t = execFileSync('git', ['show', `${ref}:f`], { encoding: 'utf8' });");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sub, 'show');
});

test('accepts git show with maxBuffer, multi-line and nested parens', () => {
  const src = "execFileSync('git', ['show', `${a(b)}:f`], {\n  cwd: x,\n  maxBuffer: 1 << 29,\n});";
  assert.equal(scanSource(src).length, 0);
});

test('accepts options passed as an identifier defined with maxBuffer', () => {
  const src = "const opts = { encoding: 'utf8', maxBuffer: 1e9 };\nexecFileSync('git', ['show', 'x'], opts);";
  assert.equal(scanSource(src).length, 0);
});

test('flags options identifier that carries no maxBuffer', () => {
  const src = "const opts = { encoding: 'utf8' };\nexecFileSync('git', ['show', 'x'], opts);";
  assert.equal(scanSource(src).length, 1);
});

test('bounded-output probes are exempt', () => {
  for (const s of [
    "execFileSync('git', ['cat-file', '-e', 'x'], {})",
    "execFileSync('git', ['diff', '--name-only', a, b], {})",
    "execFileSync('git', ['log', '-1', '--format=%ct'], {})",
    "execFileSync('git', ['show', 'x'], { stdio: 'ignore' })",
  ]) assert.equal(scanSource(s).length, 0, s);
});

test('flags cat-file -p, ls-tree, unbounded diff and log', () => {
  for (const s of [
    "execFileSync('git', ['cat-file', '-p', 'x'], {})",
    "execFileSync('git', ['ls-tree', '-r', 'HEAD'], {})",
    "execFileSync('git', ['diff', a, b], {})",
    "execFileSync('git', ['log', '--format=%H'], {})",
  ]) assert.equal(scanSource(s).length, 1, s);
});

test('ignores mentions in comments', () => {
  assert.equal(scanSource(" * execFileSync('git', ['show', x])").length, 0);
});

test('scanTree is clean on a good tree, flags a planted offender', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/ok.js'), "execFileSync('git', ['show', 'a'], { maxBuffer: 9e8 });\n");
  assert.equal(scanTree(root).length, 0);
  fs.writeFileSync(path.join(root, 'scripts/bad.js'), "execFileSync('git', ['show', 'a'], {});\n");
  const hits = scanTree(root);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, path.join('scripts', 'bad.js'));
});

test('real repo has no unbuffered git show/cat-file/ls-tree/diff/log calls', () => {
  const hits = scanTree(REPO);
  assert.deepEqual(hits, []);
});

test('real repo scan actually reads files (guards against a silent no-op walk)', () => {
  assert.ok(fs.existsSync(path.join(REPO, 'scripts/lib/git-maxbuffer-scan.js')));
});

test('flags -C <identifier> before the subcommand', () => {
  assert.equal(scanSource("execFileSync('git', ['-C', REPO, 'log', '--format=%B'], {})").length, 1);
});

test('log -n N (N large) is not exempt, log -n 1 is', () => {
  assert.equal(scanSource("execFileSync('git', ['log', '-n', '100000'], {})").length, 1);
  assert.equal(scanSource("execFileSync('git', ['log', '-n', '1'], {})").length, 0);
});

test('maxBuffer only inside a comment does not count', () => {
  assert.equal(scanSource("execFileSync('git', ['show', 'x'], { /* maxBuffer later */ })").length, 1);
});
