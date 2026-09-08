import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isNodeTestCommand,
  extractTestFilePaths,
  auditCardTestPaths,
  findCardsWithMissingTestFiles,
} = require('../../scripts/lib/card-premises-auditor.js');

test('isNodeTestCommand: recognizes node --test and npx tsx --test, rejects everything else', () => {
  assert.equal(isNodeTestCommand('node --test tests/unit/foo.test.mjs'), true);
  assert.equal(isNodeTestCommand('npx tsx --test tests/unit/foo.test.ts'), true);
  assert.equal(isNodeTestCommand('npx tsc --noEmit'), false);
  assert.equal(isNodeTestCommand('test -f docs/foo.md'), false);
  assert.equal(isNodeTestCommand(''), false);
  assert.equal(isNodeTestCommand(null), false);
});

test('extractTestFilePaths: pulls the file paths out of a node --test command', () => {
  assert.deepEqual(
    extractTestFilePaths('node --test tests/unit/foo.test.mjs'),
    ['tests/unit/foo.test.mjs'],
  );
  assert.deepEqual(
    extractTestFilePaths('node --test tests/unit/a.test.mjs tests/unit/b.test.mjs'),
    ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs'],
  );
});

test('extractTestFilePaths: non-test-shaped commands yield no paths', () => {
  assert.deepEqual(extractTestFilePaths('npx tsc --noEmit'), []);
  assert.deepEqual(extractTestFilePaths('test -f tests/unit/foo.test.mjs'), []);
});

test('auditCardTestPaths: flags a card whose test file is confirmed missing', () => {
  const cards = [
    { id: 'BRO-1', name: 'Real test exists', url: 'u1', cmd: 'node --test tests/unit/real.test.mjs' },
    { id: 'BRO-2', name: 'Phantom test', url: 'u2', cmd: 'node --test tests/unit/phantom.test.mjs' },
  ];
  const existsFn = (p) => p === 'tests/unit/real.test.mjs';
  const flagged = auditCardTestPaths(cards, existsFn);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, 'BRO-2');
  assert.deepEqual(flagged[0].missingPaths, ['tests/unit/phantom.test.mjs']);
});

test('auditCardTestPaths: a card with no node --test command is never flagged', () => {
  const cards = [{ id: 'BRO-3', name: 'tsc card', url: 'u3', cmd: 'npx tsc --noEmit' }];
  const flagged = auditCardTestPaths(cards, () => false);
  assert.deepEqual(flagged, []);
});

test('auditCardTestPaths: null (unresolved) is never treated as missing', () => {
  const cards = [{ id: 'BRO-4', name: 'Unresolvable', url: 'u4', cmd: 'node --test tests/unit/unclear.test.mjs' }];
  const flagged = auditCardTestPaths(cards, () => null);
  assert.deepEqual(flagged, []);
});

test('auditCardTestPaths: only the missing path is reported when a command names several files', () => {
  const cards = [{
    id: 'BRO-5', name: 'Mixed', url: 'u5',
    cmd: 'node --test tests/unit/real.test.mjs tests/unit/phantom.test.mjs',
  }];
  const existsFn = (p) => p === 'tests/unit/real.test.mjs';
  const flagged = auditCardTestPaths(cards, existsFn);
  assert.equal(flagged.length, 1);
  assert.deepEqual(flagged[0].missingPaths, ['tests/unit/phantom.test.mjs']);
});

// ── findCardsWithMissingTestFiles (I/O wrapper) ─────────────────────────────

test('findCardsWithMissingTestFiles: skips the origin/main fetch entirely when nothing is node --test shaped', () => {
  const cards = [
    { id: 'BRO-6', name: 'tsc card', url: 'u6', cmd: 'npx tsc --noEmit', armed: true },
    { id: 'BRO-7', name: 'unarmed card', url: 'u7', cmd: null, armed: false },
  ];
  // No mock injected — if this reached fetchOriginMain it would shell out to
  // real git. The empty result with no throw proves the fetch was skipped.
  assert.deepEqual(findCardsWithMissingTestFiles(cards), []);
});

test('findCardsWithMissingTestFiles: a failed origin/main fetch bails to [] rather than trusting a stale local ref', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  // A real (non-git) directory makes fetchOriginMain's `git fetch` fail
  // deterministically, no network mocking needed — proving the CONFIRMED
  // failure path never falls through to pathExistsOnOriginMain (which would
  // read whatever origin/main happens to be cached, possibly stale).
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'card-premises-not-a-repo-'));
  const cards = [{ id: 'BRO-8', name: 'x', url: 'u8', cmd: 'node --test tests/unit/whatever.test.mjs', armed: true }];
  assert.deepEqual(findCardsWithMissingTestFiles(cards, { repo: notARepo, log: () => {} }), []);
});
