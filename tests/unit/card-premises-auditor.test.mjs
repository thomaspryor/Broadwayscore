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

// ── classifyVacuousCheck / auditVacuousChecks (BRO-3378) ────────────────────
// The opposite-polarity question: not "can this command ever pass" but "can it
// ever FAIL". A check already green on the pre-work tree proves nothing when
// re-run at Done time — the mechanism behind BRO-423 and 40 live armed cards.

const {
  classifyVacuousCheck,
  auditVacuousChecks,
  findCardCheckPathDefects,
  pathExistsOnOriginMain,
  VACUOUS_TEST_F_SATISFIED,
  VACUOUS_TEST_F_ARITY,
  VACUOUS_TEST_F_UNRESOLVED,
} = require('../../scripts/lib/card-premises-auditor.js');

test('pathExistsOnOriginMain: a DIRECTORY is not "present" — test -f on a dir always exits 1', () => {
  // `git cat-file -e` answers "is there an object here", which is true for a
  // tree. Counting a directory as present would report an unpassable check as
  // satisfied, and call a check that can only ever FAIL one that can never fail.
  // Uses this repo's own origin/main, so it exercises the real git probe.
  assert.equal(pathExistsOnOriginMain('scripts/lib', { log: () => {} }), false);
  assert.equal(pathExistsOnOriginMain('scripts/health-check.js', { log: () => {} }), true);
});

const EXISTS = () => true;
const ABSENT = () => false;
const UNRESOLVED = () => null;

test('classifyVacuousCheck: test -f naming a file that already exists is vacuous', () => {
  const v = classifyVacuousCheck('test -f scripts/opening-night-poller.js', EXISTS);
  assert.equal(v.kind, VACUOUS_TEST_F_SATISFIED);
  assert.equal(v.polarity, 'never-fails');
  assert.deepEqual(v.paths, ['scripts/opening-night-poller.js']);
  assert.match(v.reason, /already passes on origin\/main/);
});

test('classifyVacuousCheck: test -f naming a to-be-created file is NOT vacuous (NEW-ARTIFACT ALLOWANCE)', () => {
  // The single most important negative case. Vetoing this is what killed 3
  // in-scope cards in the 2026-07-26 live run; naming the file the work will
  // create is the documented, correct use of the `test -f` form.
  assert.equal(classifyVacuousCheck('test -f docs/new-runbook.md', ABSENT), null);
});

test('classifyVacuousCheck: an unresolvable path is reported as unresolved, NOT as healthy', () => {
  // "I could not check" and "I checked and it is fine" must be distinguishable,
  // because the two consumers make opposite calls on them: the audit drops the
  // unresolved verdict (never accuse), the enricher defers on it (never write
  // an unvalidated command).
  const v = classifyVacuousCheck('test -f scripts/whatever.js', UNRESOLVED);
  assert.equal(v.kind, VACUOUS_TEST_F_UNRESOLVED);
  assert.equal(v.polarity, 'unknown');
});

test('auditVacuousChecks: an unresolved probe is never reported as a defect', () => {
  const cards = [{ id: 'BRO-U', name: 'unknowable', url: 'u', cmd: 'test -f scripts/whatever.js' }];
  assert.deepEqual(auditVacuousChecks(cards, UNRESOLVED), []);
});

test('classifyVacuousCheck: node --test is never vacuous, even when the file exists', () => {
  // The file's CONTENTS change with the work, so its verdict can change too —
  // that is the whole point of naming a colocated test, and the reason this
  // rule is scoped to `test -f` alone.
  assert.equal(classifyVacuousCheck('node --test tests/unit/foo.test.mjs', EXISTS), null);
  assert.equal(classifyVacuousCheck('npx tsx --test tests/unit/foo.test.ts', EXISTS), null);
});

test('classifyVacuousCheck: generic and audit-script forms are out of scope, not flagged', () => {
  assert.equal(classifyVacuousCheck('npx tsc --noEmit', EXISTS), null);
  assert.equal(classifyVacuousCheck('npx next lint', EXISTS), null);
  assert.equal(classifyVacuousCheck('node scripts/audit-review-contamination.js', EXISTS), null);
  assert.equal(classifyVacuousCheck('', EXISTS), null);
  assert.equal(classifyVacuousCheck(null, EXISTS), null);
});

test('classifyVacuousCheck: multi-operand test -f is a shell arity error that can never pass', () => {
  // SAFE_CHECK_FORMS' regex accepts `((?: [\w@./-]+)+)`, but `test -f a b`
  // exits 2 ("too many arguments") — nothing else in the pipeline catches it.
  const v = classifyVacuousCheck('test -f docs/a.md docs/b.md', ABSENT);
  assert.equal(v.kind, VACUOUS_TEST_F_ARITY);
  assert.equal(v.polarity, 'never-passes');
  assert.deepEqual(v.paths, ['docs/a.md', 'docs/b.md']);
});

test('classifyVacuousCheck: arity is decided without consulting existsFn at all', () => {
  const v = classifyVacuousCheck('test -f docs/a.md docs/b.md', () => {
    throw new Error('existsFn must not be consulted for an arity error');
  });
  assert.equal(v.kind, VACUOUS_TEST_F_ARITY);
});

test('auditVacuousChecks: flags only the vacuous cards and carries the card identity through', () => {
  const cards = [
    { id: 'BRO-1', name: 'behaviour bug', url: 'u1', cmd: 'test -f scripts/exists.js' },
    { id: 'BRO-2', name: 'creates a file', url: 'u2', cmd: 'test -f docs/tobe.md' },
    { id: 'BRO-3', name: 'real test', url: 'u3', cmd: 'node --test tests/unit/x.test.mjs' },
  ];
  const existsFn = (p) => p === 'scripts/exists.js';
  const flagged = auditVacuousChecks(cards, existsFn);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, 'BRO-1');
  assert.equal(flagged[0].name, 'behaviour bug');
  assert.equal(flagged[0].url, 'u1');
  assert.equal(flagged[0].kind, VACUOUS_TEST_F_SATISFIED);
});

test('auditVacuousChecks: the two buckets are complementary, never contradictory, on one corpus', () => {
  // A reader seeing both reports must be able to tell the cases apart: the
  // SAME card can never appear in both, because "every path present" and
  // "some path absent" are mutually exclusive for a single-operand test -f.
  const cards = [
    { id: 'BRO-A', name: 'vacuous', url: 'a', cmd: 'test -f scripts/exists.js' },
    { id: 'BRO-B', name: 'unpassable', url: 'b', cmd: 'test -f docs/gone.md' },
  ];
  const existsFn = (p) => p === 'scripts/exists.js';
  const vacuous = auditVacuousChecks(cards, existsFn).map((c) => c.id);
  const missing = auditCardCheckPaths(cards, existsFn).map((c) => c.id);
  assert.deepEqual(vacuous, ['BRO-A']);
  assert.deepEqual(missing, ['BRO-B']);
  assert.equal(vacuous.filter((id) => missing.includes(id)).length, 0);
});

test('a multi-operand test -f lands in the arity bucket ONLY, never in both', () => {
  // The case that broke the disjointness claim: the arity branch returns before
  // consulting existsFn, so a command naming one absent and one present path
  // was reported as BOTH a missing path and an arity error — two contradictory
  // rows for one card, and a duplicate re-fetch in reconciliation.
  const cards = [{ id: 'BRO-C', name: 'arity', url: 'c', cmd: 'test -f docs/absent.md docs/present.md' }];
  const existsFn = (p) => p === 'docs/present.md';
  const vacuous = auditVacuousChecks(cards, existsFn);
  const missing = auditCardCheckPaths(cards, existsFn);
  assert.equal(vacuous.length, 1);
  assert.equal(vacuous[0].kind, VACUOUS_TEST_F_ARITY);
  assert.deepEqual(missing, [], 'a syntax error must not also be diagnosed as a missing path');
});

test('a multi-operand node --test is still a normal missing-path check', () => {
  // The arity rule is about `test -f` semantics alone — `node --test a b` is a
  // perfectly valid two-file invocation and must keep its existing treatment.
  const cards = [{ id: 'BRO-D', name: 'two tests', url: 'd', cmd: 'node --test tests/unit/a.test.mjs tests/unit/b.test.mjs' }];
  const missing = auditCardCheckPaths(cards, (p) => p === 'tests/unit/a.test.mjs');
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0].missingPaths, ['tests/unit/b.test.mjs']);
});

test('findCardCheckPathDefects: returns both buckets and skips the fetch when nothing is file-naming-shaped', () => {
  const cards = [
    { id: 'BRO-6', name: 'tsc card', url: 'u6', cmd: 'npx tsc --noEmit', armed: true },
    { id: 'BRO-7', name: 'unarmed', url: 'u7', cmd: null, armed: false },
  ];
  // No mock injected — reaching fetchOriginMain would shell out for real.
  assert.deepEqual(findCardCheckPathDefects(cards), { missing: [], vacuous: [] });
});

test('findCardCheckPathDefects: a failed fetch bails BOTH buckets to [] rather than trusting a stale ref', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'card-premises-not-a-repo-'));
  const cards = [{ id: 'BRO-9', name: 'x', url: 'u9', cmd: 'test -f scripts/whatever.js', armed: true }];
  assert.deepEqual(
    findCardCheckPathDefects(cards, { repo: notARepo, log: () => {} }),
    { missing: [], vacuous: [] },
  );
});

test('findCardsWithMissingCheckPaths: back-compat wrapper still returns the bare missing array', () => {
  const cards = [{ id: 'BRO-10', name: 'tsc', url: 'u10', cmd: 'npx tsc --noEmit', armed: true }];
  const result = findCardsWithMissingCheckPaths(cards);
  assert.ok(Array.isArray(result), 'must stay an array, not the new {missing,vacuous} object');
  assert.deepEqual(result, []);
});
