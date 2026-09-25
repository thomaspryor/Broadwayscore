/**
 * bash-integration-test-list.test.mjs (BRO-4150) — drives the REAL
 * listInvokedBashIntegrationTests()/isInvokedIn() via require() (rule 15),
 * never a copy. This is the module land-gauntlet.sh's bash-integration gate
 * and colocated-test-ci-coverage.test.mjs both read, so a regression here
 * would silently desync the two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listInvokedBashIntegrationTests, isInvokedIn, stripShellComments } = require('./bash-integration-test-list.js');

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'bash-integration-test-list.js');

test('lists only scripts/lib/*.test.sh files actually invoked in runText, sorted', () => {
  const runText = [
    'timeout 180 bash scripts/lib/b.test.sh',
    'bash scripts/lib/a.test.sh',
    'echo "see scripts/lib/c.test.sh"', // named, not invoked
  ].join('\n');
  assert.deepEqual(listInvokedBashIntegrationTests({ runText }), ['scripts/lib/a.test.sh', 'scripts/lib/b.test.sh']);
});

test('a file invoked in a run: step but missing from disk is STILL derived (Codex adversarial review, BRO-4150): mirrors test.yml, which fails loudly ("No such file or directory") on a deleted-but-still-invoked file rather than silently skipping it', () => {
  const runText = 'timeout 180 bash scripts/lib/deleted-test.test.sh';
  assert.deepEqual(listInvokedBashIntegrationTests({ runText }), ['scripts/lib/deleted-test.test.sh']);
});

test('empty runText → empty list, not a crash', () => {
  assert.deepEqual(listInvokedBashIntegrationTests({ runText: '' }), []);
});

test('a bare mention (not invoked) contributes no candidate', () => {
  assert.deepEqual(listInvokedBashIntegrationTests({ runText: 'echo "see scripts/lib/helper.test.sh"' }), []);
});

test('CLI --list against the REAL repo: every printed path exists, ends .test.sh, and is actually invoked', () => {
  const out = execFileSync('node', [CLI, '--list'], { encoding: 'utf8' });
  const lines = out.trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'derived zero files from the real test.yml — the gate would run nothing');
  const ROOT = path.join(path.dirname(CLI), '..', '..');
  for (const relPath of lines) {
    assert.match(relPath, /^scripts\/lib\/.+\.test\.sh$/);
    assert.ok(fs.existsSync(path.join(ROOT, relPath)), `${relPath} does not exist on disk`);
  }
  assert.deepEqual(lines, [...lines].sort(), 'CLI output must be sorted');
});

test('isInvokedIn re-exported here matches the shell-anchoring rule (spot check; full battery lives in colocated-test-ci-coverage.test.mjs)', () => {
  const P = 'scripts/lib/example.test.sh';
  assert.ok(isInvokedIn(`timeout 180 bash ${P}`, P, 'sh'));
  assert.ok(!isInvokedIn(`echo "see ${P}"`, P, 'sh'));
});

test('stripShellComments drops a bare # line but keeps a quoted #', () => {
  assert.equal(stripShellComments('echo hi # comment'), 'echo hi ');
  assert.equal(stripShellComments('echo "a # b"'), 'echo "a # b"');
});
