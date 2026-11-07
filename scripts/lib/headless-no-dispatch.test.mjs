// BRO-4868: every dispatcher that calls classifyHeadlessDispatchability must
// honour the NO-DISPATCH marker; the marker regex is line-anchored; the
// owner-decision gate catches "needs the owner's answer".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyHeadlessDispatchability, BLOCKERS } = require('./headless-dispatchability.js');
const { hasNoDispatchMarker } = require('./no-dispatch-marker.js');

const VERIFY = { verifyCmd: 'node --test x.test.mjs' };
const codes = (notes, subject = 'Fix thing') =>
  classifyHeadlessDispatchability({ subject, notes }, VERIFY).blockers.map((b) => b.code);

test('NO-DISPATCH at line start blocks (also after mirrored header lines)', () => {
  assert.ok(codes('NO-DISPATCH: owner must answer first\n\nbody').includes(BLOCKERS.NO_DISPATCH_MARKER));
  assert.ok(codes('[notion:abc] title\nhttps://x.y\nNO-DISPATCH: reason\nbody').includes(BLOCKERS.NO_DISPATCH_MARKER));
});

test('a card that merely quotes the marker mid-sentence is not blocked', () => {
  assert.equal(hasNoDispatchMarker('the notion-brain writes NO-DISPATCH: onto --no-spawn cards'), false);
  assert.ok(!codes('Meta card: the NO-DISPATCH: marker is written by notion-brain.').includes(BLOCKERS.NO_DISPATCH_MARKER));
});

test('subject line alone never carries the marker', () => {
  assert.ok(!codes('plain body', 'NO-DISPATCH: subject').includes(BLOCKERS.NO_DISPATCH_MARKER));
});

test('unmarked card stays dispatchable', () => {
  assert.deepEqual(codes('Do a small fix.'), []);
});

test("owner-decision gate catches \"needs the owner's answer\" phrasings", () => {
  for (const t of ["This needs the owner's answer before any code.", "requires the owner’s input", 'waiting on owner\'s call']) {
    assert.ok(codes(t).includes(BLOCKERS.OWNER_DECISION_GATE), t);
  }
  assert.ok(!codes('The owner approved this plan; implement it.').includes(BLOCKERS.OWNER_DECISION_GATE));
});

test('hand-typed decorations of the marker still match', () => {
  for (const t of ['**NO-DISPATCH:** x', '- NO-DISPATCH: x', '> NO-DISPATCH: x']) assert.equal(hasNoDispatchMarker(t), true, t);
});

test('detail text does not promise a --force waiver the shared filter does not give', () => {
  const d = classifyHeadlessDispatchability({ subject: 's', notes: 'NO-DISPATCH: r' }, VERIFY).blockers[0].detail;
  assert.ok(!/--force/.test(d));
});
