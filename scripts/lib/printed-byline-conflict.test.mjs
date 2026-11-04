/**
 * Tests for scripts/lib/printed-byline-conflict.js (BRO-6940).
 * Run: node --test scripts/lib/printed-byline-conflict.test.mjs
 *
 * Origin: Waiting for Lefty's NYSR review was credited to Frank Scheck while the article prints
 * "By Michael Sommers". Fixtures are invented text in the same layouts (no review copy in the repo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findPrintedBylineConflict,
  findPrintedKnownByline,
  findUnlistedPrintedByline,
  buildKnownCriticsIndex,
  knownCriticsForOutlet,
  sameCritic,
  isPlaceholderName,
  creditedCriticPrinted,
  NO_FILL_OUTLETS,
  decidePrintedByline,
} = require('./printed-byline-conflict.js');

const FILLER = ' The company plays the old protest piece straight and the room responds to it with real heat from the first scene to the last.'.repeat(3);
const NYSR = ['Michael Sommers', 'Frank Scheck', 'David Finkle', 'Rob Weinert-Kendt'];

test('NYSR one-line header: "<date> <title> By X" re-credits the queried colleague (the Lefty case)', () => {
  const text = `11/02/26 Clifford Odets' Waiting for Lefty at Classic Stage Company By Michael Sommers ★★★★${FILLER}`;
  const hit = findPrintedBylineConflict({ criticName: 'Frank Scheck', fullText: text, knownCritics: NYSR });
  assert.deepEqual(hit, { printedName: 'Michael Sommers', kind: 'known' });
});

test('no conflict when the credited critic is the one printed', () => {
  const text = `11/02/26 Waiting for Lefty at Classic Stage Company By Michael Sommers${FILLER}`;
  assert.equal(findPrintedBylineConflict({ criticName: 'Michael Sommers', fullText: text, knownCritics: NYSR }), null);
});

test('no conflict when both critics are printed (co-review or footer credit)', () => {
  const text = `By Frank Scheck and Michael Sommers. A double bill.${FILLER}`;
  assert.equal(findPrintedBylineConflict({ criticName: 'Frank Scheck', fullText: text, knownCritics: NYSR }), null);
});

test('"Written by X" (Time Out) and "by\\n\\nX" (THR) layouts are bylines', () => {
  const timeOut = `Review Written by Andrzej Lukowski${FILLER}`;
  assert.equal(
    findPrintedBylineConflict({ criticName: 'Time Out', fullText: timeOut, knownCritics: ['Andrzej Lukowski', 'Tim Bano'] })?.printedName,
    'Andrzej Lukowski',
  );
  const thr = `Waiting for Lefty\n\nby\n\nFrank Scheck\n\nNov 3, 2026${FILLER}`;
  assert.equal(
    findPrintedBylineConflict({ criticName: 'Ben Brantley', fullText: thr, knownCritics: ['Frank Scheck', 'David Rooney'] })?.printedName,
    'Frank Scheck',
  );
});

test('prose that merely names a critic is not a byline', () => {
  const cases = [
    `Reviewed for the Observer by Clare Brennan, the revival lands softly.${FILLER}`,
    `A thoughtful aside ( reviewed by Frank Scheck ) closes the notice.${FILLER}`,
    `The adaptation, written by Michael Sommers decades ago, still plays.${FILLER}`,
    `Photo By Michael Sommers shows the cast in rehearsal.${FILLER}`,
  ];
  for (const text of cases) {
    assert.equal(
      findPrintedBylineConflict({ criticName: 'Someone Else', fullText: text, knownCritics: [...NYSR, 'Clare Brennan'] }),
      null,
      text.slice(0, 40),
    );
  }
});

test('single-word and placeholder credits never conflict (their absence proves nothing)', () => {
  const text = `By Michael Sommers${FILLER}`;
  assert.equal(findPrintedBylineConflict({ criticName: 'Kathryn', fullText: text, knownCritics: NYSR }), null);
  assert.equal(findPrintedBylineConflict({ criticName: 'Unknown', fullText: text, knownCritics: NYSR }), null);
  assert.equal(findPrintedBylineConflict({ criticName: '', fullText: text, knownCritics: NYSR }), null);
});

test('spelling variants of one critic are not conflicts', () => {
  assert.ok(sameCritic('Kathleen Foley', 'F. Kathleen Foley'));
  assert.ok(sameCritic('Brian Scott Lipton', 'Brian Scott'));
  assert.ok(sameCritic('Daniel Fienberg', 'Daniel Feinberg'));
  assert.ok(!sameCritic('Frank Scheck', 'Michael Sommers'));
  assert.ok(!sameCritic('Mark Kennedy', 'Mark Lawson'));
  const text = `By F. Kathleen Foley${FILLER}`;
  assert.equal(findPrintedBylineConflict({ criticName: 'Kathleen Foley', fullText: text, knownCritics: ['F. Kathleen Foley'] }), null);
});

test('masthead labels are never a re-credit target', () => {
  const text = `By THR Staff${FILLER}`;
  assert.equal(findPrintedBylineConflict({ criticName: 'Frank Scheck', fullText: text, knownCritics: ['THR Staff', 'David Rooney'] }), null);
});

test('only the head is read: a byline deep in the body does not count', () => {
  const text = `${'The staging is spare and the pacing brisk. '.repeat(40)} By Michael Sommers`;
  assert.equal(findPrintedBylineConflict({ criticName: 'Frank Scheck', fullText: text, knownCritics: NYSR }), null);
});

test('unnamed files fill from a printed known byline, only for known critics', () => {
  const text = `Review by Ron Fassler . . . On January 6, 1935, a series of entertainments${FILLER}`;
  assert.deepEqual(findPrintedKnownByline({ fullText: text, knownCritics: ['Ron Fassler', 'Frank Scheck'] }), { printedName: 'Ron Fassler', kind: 'known' });
  assert.equal(findPrintedKnownByline({ fullText: text, knownCritics: ['Frank Scheck'] }), null);
  assert.equal(findPrintedKnownByline({ fullText: 'short', knownCritics: ['Ron Fassler'] }), null);
});

test('an unlisted printed name is reported as unlisted, never as known', () => {
  const text = `By Jane Newcomer${FILLER}`;
  const hit = findUnlistedPrintedByline({ criticName: 'Frank Scheck', fullText: text, knownCritics: NYSR });
  if (hit) assert.equal(hit.kind, 'unlisted');
});

test('registry index: outlet -> defaultCritics, and the lookup helper', () => {
  const idx = buildKnownCriticsIndex({
    outlets: { nysr: { defaultCritics: ['Michael Sommers', 'Frank Scheck'] }, nyt: { defaultCritic: 'Jesse Green' } },
  });
  assert.deepEqual(knownCriticsForOutlet(idx, 'nysr').sort(), ['Frank Scheck', 'Michael Sommers']);
  assert.deepEqual(knownCriticsForOutlet(idx, 'nyt'), ['Jesse Green']);
  assert.deepEqual(knownCriticsForOutlet(idx, 'absent'), []);
  assert.deepEqual(knownCriticsForOutlet(null, 'nysr'), []);
});

test('placeholder detection and the no-fill outlet set', () => {
  for (const n of ['Unknown', 'unknown', '', null, undefined, 'Staff']) assert.ok(isPlaceholderName(n), String(n));
  assert.ok(!isPlaceholderName('Michael Sommers'));
  assert.ok(NO_FILL_OUTLETS.has('playbill') && NO_FILL_OUTLETS.has('broadwayworld'));
  assert.ok(creditedCriticPrinted('Michael Sommers', 'By Michael Sommers'));
});

test('decidePrintedByline: the pipeline decision (conflict, fill, locked, no-fill outlet)', () => {
  const text = `11/02/26 Waiting for Lefty at Classic Stage Company By Michael Sommers${FILLER}`;
  const base = { outletId: 'nysr', fullText: text, knownCritics: NYSR };
  assert.deepEqual(decidePrintedByline({ ...base, criticName: 'Frank Scheck' }), { printedName: 'Michael Sommers', unnamed: false });
  assert.deepEqual(decidePrintedByline({ ...base, criticName: 'Unknown' }), { printedName: 'Michael Sommers', unnamed: true });
  assert.equal(decidePrintedByline({ ...base, criticName: 'Michael Sommers' }), null);
  assert.equal(decidePrintedByline({ ...base, criticName: 'Frank Scheck', locked: true }), null, 'a human-set credit is never overridden');
  assert.equal(decidePrintedByline({ ...base, criticName: 'Frank Scheck', knownCritics: [] }), null);
  assert.equal(decidePrintedByline({ ...base, criticName: 'Unknown', outletId: 'playbill' }), null, 'roundup outlets are never filled');
  assert.equal(decidePrintedByline({ ...base, criticName: 'Frank Scheck', fullText: '' }), null);
});
