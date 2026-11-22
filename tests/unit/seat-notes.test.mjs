/**
 * Seat notes (BRO-8057): the publish rule and the validator, required from
 * the real modules (CLAUDE.md §15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publishableSeatNotes, noteLocationLabel, noteSources, latestVerified } = require('../../scripts/lib/seat-notes-publish.js');
const { validateSeatNotes } = require('../../scripts/lib/seat-notes-validators.js');

const ev = (host = 'seatplan.com') => [{ url: `https://${host}/x/`, quoteHash: 'a1b2c3d4e5f6a7b8', fetchedAt: '2026-11-22' }];
const watch = { type: 'watch-out', hazard: 'mezz-overhang', level: 'orchestra', rows: 'K-W', claim: 'The mezzanine overhang starts at row K and cuts off the top of the stage.', evidence: ev(), verifiedAt: '2026-11-22' };
const value = { type: 'value', level: 'mezzanine', side: 'center', rows: 'E-J', claim: 'Cheaper than the front rows while still close, and in front of the overhang.', evidence: ev('tickpick.com'), verifiedAt: '2026-11-22' };
const note = { type: 'note', level: 'mezzanine', side: 'left', rows: 'G', claim: 'Row G has an aisle in front of it, so there is extra legroom.', evidence: ev(), verifiedAt: '2026-11-22' };

describe('publishableSeatNotes', () => {
  test('orders watch-out, value, note and keeps them', () => {
    const out = publishableSeatNotes([note, value, watch], { today: new Date('2026-11-23') });
    assert.deepStrictEqual(out.map((n) => n.type), ['watch-out', 'value', 'note']);
  });
  test('a single note is not enough', () => {
    assert.deepStrictEqual(publishableSeatNotes([watch], { today: new Date('2026-11-23') }), []);
  });
  test('two good-to-know notes alone do not show the card', () => {
    assert.deepStrictEqual(publishableSeatNotes([note, { ...note, rows: 'H' }], { today: new Date('2026-11-23') }), []);
  });
  test('value notes older than 9 months are hidden', () => {
    const out = publishableSeatNotes([watch, value, note], { today: new Date('2027-09-30') });
    assert.deepStrictEqual(out.map((n) => n.type), ['watch-out', 'note']);
  });
  test('notes without evidence never render', () => {
    assert.deepStrictEqual(publishableSeatNotes([watch, { ...value, evidence: [] }], { today: new Date('2026-11-23') }), []);
  });
  test('location labels', () => {
    assert.strictEqual(noteLocationLabel(value), 'Center Mezzanine, rows E to J');
    assert.strictEqual(noteLocationLabel(note), 'Left Mezzanine, row G');
    assert.strictEqual(noteLocationLabel({ level: 'orchestra', side: 'sides' }), 'Orchestra, far sides');
    assert.strictEqual(noteLocationLabel({ level: 'orchestra', rows: 'K-W' }), 'Orchestra, rows K to W');
  });
  test('sources are distinct hosts', () => {
    assert.deepStrictEqual(noteSources({ evidence: [...ev(), ...ev(), ...ev('aviewfrommyseat.com')] }), ['seatplan.com', 'aviewfrommyseat.com']);
    assert.strictEqual(latestVerified([watch, { ...note, verifiedAt: '2026-12-01' }]), '2026-12-01');
  });
});

describe('validateSeatNotes', () => {
  test('a good set passes', () => {
    assert.deepStrictEqual(validateSeatNotes('T', [watch, value, note], { showTitles: ['Hadestown'] }), []);
  });
  test('production and set-piece claims are refused (house notes only)', () => {
    const p = validateSeatNotes('T', [watch, { ...value, claim: 'You miss the elephant on the left side of the stage from here.' }]);
    assert.ok(p.some((x) => /production or set piece/.test(x)), p.join('\n'));
  });
  test('show titles are refused', () => {
    const p = validateSeatNotes('T', [watch, { ...value, claim: 'During Hadestown these seats are the best value in the house.' }], { showTitles: ['Hadestown'] });
    assert.ok(p.some((x) => /names show/.test(x)), p.join('\n'));
  });
  test('unverified accessibility claims are refused', () => {
    const p = validateSeatNotes('T', [watch, { ...note, claim: 'Row G is wheelchair accessible with a ramp from the lobby.' }]);
    assert.ok(p.some((x) => /accessibility|wheelchair/i.test(x)), p.join('\n'));
  });
  test('evidence must be https on an allowed host with a hash and fetch date', () => {
    const bad = { ...watch, evidence: [{ url: 'http://evil.example/x', quoteHash: '', fetchedAt: '' }] };
    const p = validateSeatNotes('T', [bad, value]);
    assert.ok(p.some((x) => /https/.test(x)) && p.some((x) => /quoteHash/.test(x)) && p.some((x) => /fetchedAt/.test(x)), p.join('\n'));
    const p2 = validateSeatNotes('T', [{ ...watch, evidence: [{ url: 'https://evil.example/x', quoteHash: 'abcdef12', fetchedAt: '2026-11-22' }] }, value]);
    assert.ok(p2.some((x) => /host not allowed/.test(x)), p2.join('\n'));
  });
  test('a watch-out and a value note on the same rows contradict', () => {
    const p = validateSeatNotes('T', [watch, { ...value, level: 'orchestra', side: 'left', rows: 'J-L' }]);
    assert.ok(p.some((x) => /overlap/.test(x)), p.join('\n'));
  });
  test('row text must be a plain row or range', () => {
    const p = validateSeatNotes('T', [{ ...watch, rows: 'K and back' }, value]);
    assert.ok(p.some((x) => /plain row/.test(x)), p.join('\n'));
  });
  test('a set that cannot render is refused (store none instead)', () => {
    const p = validateSeatNotes('T', [watch]);
    assert.ok(p.some((x) => /clear the bar/.test(x)), p.join('\n'));
  });
  test('a good-value note on the Center Orchestra is refused (top price tier)', () => {
    const v = { ...value, level: 'orchestra', side: 'center' };
    assert.ok(validateSeatNotes('T', [watch, v]).some((x) => /Center Orchestra/.test(x)));
    assert.ok(validateSeatNotes('T', [watch, { ...v, side: undefined, rows: 'A-C' }]).some((x) => /Center Orchestra/.test(x)));
    assert.deepStrictEqual(validateSeatNotes('T', [watch, { ...v, side: 'sides', rows: 'A-C' }]).filter((x) => /Center Orchestra/.test(x)), []);
  });
  test('em dashes and quotation marks are refused', () => {
    const p = validateSeatNotes('T', [watch, { ...value, claim: 'Cheaper seats — still close to the stage for the price.' }]);
    assert.ok(p.some((x) => /em dash/.test(x)), p.join('\n'));
  });
});

const { quoteOnPage, quoteMatchesLocation, shrinkProblems, houseTitles } = require('../../scripts/seat-notes.js');
const { pageNamesTheater } = require('../../scripts/lib/seat-adjudication.js');

describe('seat-notes grounding helpers', () => {
  const page = 'The Mezzanine overhang starts at Orchestra row K; seats beyond this may experience cut-off.';
  test('a quote must appear on the page on word boundaries', () => {
    assert.strictEqual(quoteOnPage('overhang starts at Orchestra row K', page), true);
    assert.strictEqual(quoteOnPage('verhang starts at Orchestra row K', page), false);
    assert.strictEqual(quoteOnPage('short', page), false);
  });
  test('the quote has to name the level or one of the rows', () => {
    assert.strictEqual(quoteMatchesLocation('starts at Orchestra row K', { level: 'orchestra' }), true);
    assert.strictEqual(quoteMatchesLocation('Seats in rows E-L are a little cheaper', { level: 'mezzanine', rows: 'E-J' }), true);
    assert.strictEqual(quoteMatchesLocation('Seats in rows E-L are a little cheaper', { level: 'mezzanine', rows: 'M-P' }), false);
    assert.strictEqual(quoteMatchesLocation('a little cheaper overall', { level: 'balcony' }), false);
  });
  test('the writer refuses a large drop in notes or watch-outs', () => {
    const n = (type) => ({ type });
    assert.deepStrictEqual(shrinkProblems('T', [n('watch-out'), n('value')], [n('watch-out'), n('value')]), []);
    assert.ok(shrinkProblems('T', [n('watch-out'), n('watch-out'), n('value')], [n('value')]).some((x) => /watch-outs would drop/.test(x)));
    assert.deepStrictEqual(shrinkProblems('T', undefined, [n('value')]), []);
  });
  test('only titles of shows at this house count as show names', () => {
    const shows = [
      { title: 'Still', venue: 'DR2 Theatre' },
      { title: 'Moulin Rouge! The Musical', venue: 'Al Hirschfeld Theatre' },
      { title: 'Kinky Boots', venue: 'Hirschfeld Theatre' },
    ];
    assert.deepStrictEqual(houseTitles(shows, 'Al Hirschfeld Theatre'), ['Moulin Rouge! The Musical', 'Kinky Boots']);
  });
  test('seat guides that use the short theater name still count as naming it', () => {
    assert.strictEqual(pageNamesTheater('Photos at Barrymore Theatre', 'Ethel Barrymore Theatre'), true);
    assert.strictEqual(pageNamesTheater('the Kerr Theater seating chart', 'Walter Kerr Theatre'), true);
    assert.strictEqual(pageNamesTheater('the Lyric Theatre', 'Ethel Barrymore Theatre'), false);
  });
});
