import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isNodeTestCommand,
  isTestFCommand,
  isCheckPathCommand,
  extractCheckFilePaths,
  auditCardCheckPaths,
  findCardsWithMissingCheckPaths,
} = require('../../scripts/lib/card-premises-auditor.js');

test('isNodeTestCommand: recognizes node --test and npx tsx --test, rejects everything else', () => {
  assert.equal(isNodeTestCommand('node --test tests/unit/foo.test.mjs'), true);
  assert.equal(isNodeTestCommand('npx tsx --test tests/unit/foo.test.ts'), true);
  assert.equal(isNodeTestCommand('npx tsc --noEmit'), false);
  assert.equal(isNodeTestCommand('test -f docs/foo.md'), false);
  assert.equal(isNodeTestCommand(''), false);
  assert.equal(isNodeTestCommand(null), false);
});

test('isTestFCommand: recognizes test -f, rejects everything else', () => {
  assert.equal(isTestFCommand('test -f docs/foo.md'), true);
  assert.equal(isTestFCommand('test -f memory/foo.md tests/unit/bar.test.mjs'), true);
  assert.equal(isTestFCommand('node --test tests/unit/foo.test.mjs'), false);
  assert.equal(isTestFCommand('npx tsc --noEmit'), false);
  assert.equal(isTestFCommand(''), false);
  assert.equal(isTestFCommand(null), false);
});

test('isCheckPathCommand: true for either file-naming form, false for shapes with no hallucinable path', () => {
  assert.equal(isCheckPathCommand('node --test tests/unit/foo.test.mjs'), true);
  assert.equal(isCheckPathCommand('npx tsx --test tests/unit/foo.test.ts'), true);
  assert.equal(isCheckPathCommand('test -f docs/foo.md'), true);
  assert.equal(isCheckPathCommand('npx tsc --noEmit'), false);
  assert.equal(isCheckPathCommand('node scripts/audit-review-contamination.js'), false);
});

test('extractCheckFilePaths: pulls the file paths out of a node --test command', () => {
  assert.deepEqual(
    extractCheckFilePaths('node --test tests/unit/foo.test.mjs'),
    ['tests/unit/foo.test.mjs'],
  );
  assert.deepEqual(
    extractCheckFilePaths('node --test tests/unit/a.test.mjs tests/unit/b.test.mjs'),
    ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs'],
  );
});

test('extractCheckFilePaths: pulls the file paths out of a test -f command (BRO-3076)', () => {
  assert.deepEqual(
    extractCheckFilePaths('test -f docs/foo.md'),
    ['docs/foo.md'],
  );
  assert.deepEqual(
    extractCheckFilePaths('test -f memory/a.md tests/unit/b.test.mjs'),
    ['memory/a.md', 'tests/unit/b.test.mjs'],
  );
});

test('extractCheckFilePaths: non-file-naming commands yield no paths', () => {
  assert.deepEqual(extractCheckFilePaths('npx tsc --noEmit'), []);
  assert.deepEqual(extractCheckFilePaths('node scripts/audit-review-contamination.js'), []);
});

test('auditCardCheckPaths: flags a card whose test file is confirmed missing', () => {
  const cards = [
    { id: 'BRO-1', name: 'Real test exists', url: 'u1', cmd: 'node --test tests/unit/real.test.mjs' },
    { id: 'BRO-2', name: 'Phantom test', url: 'u2', cmd: 'node --test tests/unit/phantom.test.mjs' },
  ];
  const existsFn = (p) => p === 'tests/unit/real.test.mjs';
  const flagged = auditCardCheckPaths(cards, existsFn);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, 'BRO-2');
  assert.deepEqual(flagged[0].missingPaths, ['tests/unit/phantom.test.mjs']);
});

test('auditCardCheckPaths: flags a card whose test -f path is confirmed missing (BRO-3076)', () => {
  const cards = [
    { id: 'BRO-9', name: 'Real doc exists', url: 'u9', cmd: 'test -f docs/real.md' },
    { id: 'BRO-10', name: 'Phantom doc', url: 'u10', cmd: 'test -f docs/hallucinated.md' },
  ];
  const existsFn = (p) => p === 'docs/real.md';
  const flagged = auditCardCheckPaths(cards, existsFn);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, 'BRO-10');
  assert.deepEqual(flagged[0].missingPaths, ['docs/hallucinated.md']);
});

test('auditCardCheckPaths: a card with no file-naming command is never flagged', () => {
  const cards = [{ id: 'BRO-3', name: 'tsc card', url: 'u3', cmd: 'npx tsc --noEmit' }];
  const flagged = auditCardCheckPaths(cards, () => false);
  assert.deepEqual(flagged, []);
});

test('auditCardCheckPaths: null (unresolved) is never treated as missing', () => {
  const cards = [{ id: 'BRO-4', name: 'Unresolvable', url: 'u4', cmd: 'node --test tests/unit/unclear.test.mjs' }];
  const flagged = auditCardCheckPaths(cards, () => null);
  assert.deepEqual(flagged, []);
});

test('auditCardCheckPaths: only the missing path is reported when a command names several files', () => {
  const cards = [{
    id: 'BRO-5', name: 'Mixed', url: 'u5',
    cmd: 'node --test tests/unit/real.test.mjs tests/unit/phantom.test.mjs',
  }];
  const existsFn = (p) => p === 'tests/unit/real.test.mjs';
  const flagged = auditCardCheckPaths(cards, existsFn);
  assert.equal(flagged.length, 1);
  assert.deepEqual(flagged[0].missingPaths, ['tests/unit/phantom.test.mjs']);
});

// ── findCardsWithMissingCheckPaths (I/O wrapper) ────────────────────────────

test('findCardsWithMissingCheckPaths: skips the origin/main fetch entirely when nothing is file-naming-shaped', () => {
  const cards = [
    { id: 'BRO-6', name: 'tsc card', url: 'u6', cmd: 'npx tsc --noEmit', armed: true },
    { id: 'BRO-7', name: 'unarmed card', url: 'u7', cmd: null, armed: false },
  ];
  // No mock injected — if this reached fetchOriginMain it would shell out to
  // real git. The empty result with no throw proves the fetch was skipped.
  assert.deepEqual(findCardsWithMissingCheckPaths(cards), []);
});

test('findCardsWithMissingCheckPaths: a failed origin/main fetch bails to [] rather than trusting a stale local ref', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  // A real (non-git) directory makes fetchOriginMain's `git fetch` fail
  // deterministically, no network mocking needed — proving the CONFIRMED
  // failure path never falls through to pathExistsOnOriginMain (which would
  // read whatever origin/main happens to be cached, possibly stale).
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'card-premises-not-a-repo-'));
  const cards = [{ id: 'BRO-8', name: 'x', url: 'u8', cmd: 'node --test tests/unit/whatever.test.mjs', armed: true }];
  assert.deepEqual(findCardsWithMissingCheckPaths(cards, { repo: notARepo, log: () => {} }), []);
});

test('findCardsWithMissingCheckPaths: an armed test -f candidate also fails closed to [] on a fetch failure (BRO-3076)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'card-premises-not-a-repo-'));
  const cards = [{ id: 'BRO-11', name: 'x', url: 'u11', cmd: 'test -f docs/whatever.md', armed: true }];
  // The candidate filter now admits this card (isCheckPathCommand, not just
  // isNodeTestCommand — asserted directly above); this only proves the
  // fail-open-never-a-false-positive fetch contract still holds once a
  // test -f card reaches it, mirroring the node --test coverage above.
  assert.deepEqual(findCardsWithMissingCheckPaths(cards, { repo: notARepo, log: () => {} }), []);
});
