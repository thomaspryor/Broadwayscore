import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { testIdentity, testIdFromPlaywright, testIdForSignature, testIdMarker, MAX_ID_LEN } = require('./test-identity.js');
const { parseTapOutput } = require('./tap-failure-parser.js');
const { firstFailingTestNameInJobLog, firstFailingTestFileInJobLog } = require('./main-red-streak.js');
const { planLiveDataRouting } = require('./live-data-routing.js');
const { findOpenIssueForTerm } = require('./linear-dispatch.js');

test('one test, one identity: live-data TAP and a main test.yml job log agree', () => {
  const root = '/home/runner/work/Broadwayscore/Broadwayscore';
  const tap = [
    'TAP version 13',
    '# Subtest: every show has a venue',
    'not ok 1 - every show has a venue',
    '  ---',
    `  location: '${root}/scripts/lib/corpus.test.mjs:12:1'`,
    '  failureType: testCodeFailure',
    '  ...',
    '1..1',
    '# tests 1',
    '# fail 1',
  ].join('\n');
  const parsed = parseTapOutput(tap, root);
  const [f] = [...parsed.failures.values()];
  const live = planLiveDataRouting(parsed.failures, [], parsed, 1).route[0].testId;
  // The same failure as test.yml's job log prints it (timestamps on every line).
  const log = tap.split('\n').map((l) => `2026-11-08T04:00:00.0000000Z ${l}`).join('\n');
  const fromMain = testIdForSignature({ testName: firstFailingTestNameInJobLog(log), testFile: firstFailingTestFileInJobLog(log) });
  assert.equal(live, 'scripts/lib/corpus.test.mjs::every show has a venue');
  assert.equal(fromMain, live);
  assert.equal(testIdentity(f.file, f.name), live);
});

test('a title with no file is not an identity (titles repeat across files)', () => {
  assert.equal(testIdentity(null, 'works'), null);
  assert.equal(testIdentity('?', 'works'), null);
  assert.equal(testIdentity('a.test.mjs', '  '), null);
  assert.equal(testIdForSignature({ testName: 'works', testFile: undefined }), null);
  assert.equal(testIdForSignature({ testName: null, testFile: 'a.test.mjs' }), null);
});

test('normalization: ./ prefix, backslashes, :L:C, whitespace, retry and duration tails', () => {
  const want = 'e2e/show.spec.ts::Show page › renders score';
  assert.equal(testIdentity('./e2e/show.spec.ts:14:5', 'Show page ›  renders score (retry #2)'), want);
  assert.equal(testIdentity('e2e\\show.spec.ts', 'Show page › renders score (5.2s)'), want);
  assert.equal(testIdFromPlaywright('e2e/show.spec.ts › Show page › renders score'), want);
  assert.equal(testIdFromPlaywright('[chromium] › e2e/show.spec.ts:14:5 › Show page › renders score'), want);
  assert.equal(testIdForSignature({ testName: 'e2e/show.spec.ts › Show page › renders score' }), want);
  assert.equal(testIdFromPlaywright('no separator'), null);
});

test('long ids are capped with a stable hash tail', () => {
  const a = testIdentity('scripts/x.test.mjs', 'n'.repeat(400));
  const b = testIdentity('scripts/x.test.mjs', `${'n'.repeat(399)}m`);
  assert.equal(a.length, MAX_ID_LEN);
  assert.notEqual(a, b);
  assert.equal(a, testIdentity('scripts/x.test.mjs', 'n'.repeat(400)));
});

test('the marker is found by the router search, through markdown escaping, without prefix false matches', () => {
  const id = testIdentity('scripts/lib/a_b.test.mjs', 'foo');
  const marker = testIdMarker(id);
  const escaped = marker.replace(/([_[\]])/g, '\\$1');
  const card = { identifier: 'BRO-1', title: 'Live-data test failing: foo', description: `body\n${escaped}` };
  assert.equal(findOpenIssueForTerm([card], marker), card);
  // "foo" must not match a card for "foo bar" (the closing bracket ends the id).
  const other = { identifier: 'BRO-2', title: 't', description: testIdMarker(testIdentity('scripts/lib/a_b.test.mjs', 'foo bar')) };
  assert.equal(findOpenIssueForTerm([other], marker), null);
  assert.equal(testIdMarker(null), '');
});

test('router: the card notes carry the marker and the dedupe finds another filer\'s card by it', async () => {
  const { buildCardNotes, findLinearDuplicate } = require('./owner-alert-router.js');
  const id = 'scripts/lib/corpus.test.mjs::every show has a venue';
  const notes = buildCardNotes({ description: 'red', hint: '', fields: [], conditionKey: 'live-data-test:x', testId: id });
  assert.ok(notes.includes(testIdMarker(id)));
  assert.ok(!buildCardNotes({ description: 'red', hint: '', fields: [], conditionKey: 'k' }).includes('[testId:'));
  const liveCard = { identifier: 'BRO-9', title: 'Live-data test failing', description: notes };
  const searchIssuesFn = async (term) => findOpenIssueForTerm([liveCard], term);
  // main test.yml red on the same test: its own conditionKey misses, the test identity hits.
  assert.deepEqual(await findLinearDuplicate('test-yml:red:Unit Tests:abcd1234', { searchIssuesFn, testId: id }),
    { matched: true, identifier: 'BRO-9', byTestId: true });
  assert.equal((await findLinearDuplicate('test-yml:red:Unit Tests:abcd1234', { searchIssuesFn })).matched, false);
  assert.equal((await findLinearDuplicate('test-yml:red:Unit Tests:abcd1234', { searchIssuesFn, testId: 'other.test.mjs::x' })).matched, false);
});

test('digest-autofix: an unfolded row with a testId reattaches to the router card by marker before the title lookup', () => {
  const { fileCard, buildCardNotes } = require('./digest-autofix.js');
  const id = 'scripts/lib/corpus.test.mjs::every show has a venue';
  assert.ok(buildCardNotes({ name: 'n', message: 'm', title: 'BSC Daily: n', testId: id }).includes(testIdMarker(id)));
  assert.ok(!buildCardNotes({ name: 'n', message: 'm', title: 'BSC Daily: n' }).includes('[testId:'));
  const calls = [];
  const execFn = (cmd, args) => {
    calls.push(args.slice(1));
    return args[2] === testIdMarker(id) ? '{"identifier": "BRO-9"}' : 'null';
  };
  const r = fileCard('BSC Daily: n', 'notes', { testId: id, execFn });
  assert.equal(r.identifier, 'BRO-9');
  assert.equal(r.existing, true);
  assert.equal(calls.length, 1);
  // No testId: straight to the exact-title lookup, as before.
  calls.length = 0;
  const execTitle = (cmd, args) => { calls.push(args.slice(1)); return args[1] === 'find' ? '{"identifier": "BRO-5"}' : ''; };
  assert.equal(fileCard('BSC Daily: n', 'notes', { execFn: execTitle }).identifier, 'BRO-5');
  assert.deepEqual(calls[0].slice(0, 3), ['find', 'BSC Daily: n', '--exact-title']);
});

test('digest-autofix: a folded row (even one item) never advertises a test marker it does not search', () => {
  const { buildCardNotes } = require('./digest-autofix.js');
  const id = 'scripts/lib/venue.test.mjs::venue on Hamilton is set';
  const notes = buildCardNotes({ name: 'n', message: 'm', title: 'BSC Daily: Live-data test failing: venue', testId: id,
    affected: [{ name: 'venue on Hamilton is set', conditionKey: 'live-data-test:x' }] });
  assert.ok(!notes.includes('[testId:'));
});

test('router: a dispatch-at-filing alert (main test.yml red) never dedupes by test id, so it still files and dispatches', () => {
  const { testIdForDedupe } = require('./owner-alert-router.js');
  const id = 'scripts/lib/corpus.test.mjs::every show has a venue';
  assert.equal(testIdForDedupe(id, { runId: '1' }), null);
  assert.equal(testIdForDedupe(id, undefined), id);
  assert.equal(testIdForDedupe(null, undefined), null);
});

test('digest-autofix: a failed marker lookup still runs the exact-title lookup', () => {
  const { fileCard } = require('./digest-autofix.js');
  const execFn = (cmd, args) => {
    if (args[1] === 'find' && args[2].startsWith('[testId:')) throw new Error('linear timeout');
    return args[1] === 'find' ? '{"identifier": "BRO-5"}' : '';
  };
  const r = fileCard('BSC Daily: n', 'notes', { testId: 'a.test.mjs::n', execFn });
  assert.equal(r.identifier, 'BRO-5');
  assert.equal(r.existing, true);
});
