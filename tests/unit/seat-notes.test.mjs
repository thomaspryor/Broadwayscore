/**
 * Seat notes (BRO-8057): the publish rule and the validator, required from
 * the real modules (CLAUDE.md §15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publishableSeatNotes, noteLocationLabel, noteSources, latestVerified, seatNotePicks, pickText } = require('../../scripts/lib/seat-notes-publish.js');
const { validateSeatNotes } = require('../../scripts/lib/seat-notes-validators.js');

const ev = (host = 'seatplan.com') => [{ url: `https://${host}/x/`, quoteHash: 'a1b2c3d4e5f6a7b8', fetchedAt: '2026-11-22' }];
const watch = { type: 'watch-out', hazard: 'mezz-overhang', level: 'orchestra', rows: 'K-W', claim: 'The mezzanine overhang starts at row K and cuts off the top of the stage.', short: 'Overhang cuts off the top of the stage', evidence: ev(), verifiedAt: '2026-11-22' };
const value = { type: 'value', level: 'mezzanine', side: 'center', rows: 'E-J', claim: 'Cheaper than the front rows while still close, and in front of the overhang.', short: 'Cheaper, and still close to the stage', evidence: ev('tickpick.com'), verifiedAt: '2026-11-22' };
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

describe('closed-card headline picks', () => {
  test('picks the first watch-out and the first value note', () => {
    const v2 = { ...value, rows: 'K' };
    const out = seatNotePicks(publishableSeatNotes([note, v2, value, watch], { today: new Date('2026-11-23') }));
    assert.strictEqual(out.avoid, watch);
    assert.strictEqual(out.value, v2);
    assert.deepStrictEqual(seatNotePicks([watch, note]), { avoid: watch, value: null });
    assert.deepStrictEqual(seatNotePicks(undefined), { avoid: null, value: null });
  });
  test('headline text uses the short line, falls back to the claim, one period', () => {
    assert.deepStrictEqual(pickText(watch), { where: 'Orchestra, rows K to W', what: 'Overhang cuts off the top of the stage.' });
    assert.strictEqual(pickText({ ...watch, short: undefined }).what, 'The mezzanine overhang starts at row K and cuts off the top of the stage.');
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
  test('a claim naming more sources than it cites is refused', () => {
    const claim = 'Rows A to C are very close, and two seat guides say you can miss action at the sides.';
    const p = validateSeatNotes('T', [{ ...watch, claim }, value]);
    assert.ok(p.some((x) => /cites 1 source/.test(x)), p.join('\n'));
    const ok = validateSeatNotes('T', [{ ...watch, claim, evidence: [...ev(), ...ev('aviewfrommyseat.com')] }, value]);
    assert.deepStrictEqual(ok.filter((x) => /cites/.test(x)), []);
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
  test('watch-out and value notes need a clean short headline', () => {
    assert.ok(validateSeatNotes('T', [{ ...watch, short: undefined }, value]).some((x) => /need a short headline/.test(x)));
    assert.deepStrictEqual(validateSeatNotes('T', [watch, value, { ...note, short: undefined }]), []);
    assert.ok(validateSeatNotes('T', [{ ...watch, short: 'Overhang cuts off the top.' }, value]).some((x) => /ends with punctuation/.test(x)));
    assert.ok(validateSeatNotes('T', [{ ...watch, short: 'Too short' }, value]).some((x) => /short headline length/.test(x)));
    assert.ok(validateSeatNotes('T', [{ ...watch, short: 'You miss the elephant from these seats' }, value]).some((x) => /short headline names a production/.test(x)));
  });
  test('em dashes and quotation marks are refused', () => {
    const p = validateSeatNotes('T', [watch, { ...value, claim: 'Cheaper seats — still close to the stage for the price.' }]);
    assert.ok(p.some((x) => /em dash/.test(x)), p.join('\n'));
  });
});

const { quoteOnPage, quoteMatchesLocation, shrinkProblems, houseTitles, seedPages, seatplanLinks, rowMentions, seatplanSlug } = require('../../scripts/seat-notes.js');
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
  test('a sentence that starts with "Rows" still counts its row letters (ramp 2026-11-22)', () => {
    assert.strictEqual(quoteMatchesLocation('Rows AA and BB give a box-like feel', { level: 'mezzanine', rows: 'AA-BB' }), true);
    assert.strictEqual(quoteMatchesLocation('Row F faces the aisle', { level: 'balcony', rows: 'F' }), true);
  });
  test('a row letter does not tie a quote about another level to this one', () => {
    assert.strictEqual(quoteMatchesLocation('Orchestra row F has extra legroom', { level: 'balcony', rows: 'F' }), false);
    assert.strictEqual(quoteMatchesLocation('Mezzanine rows J and K are cramped', { level: 'orchestra', rows: 'J-K' }), false);
  });
  test('another level named elsewhere in the quote does not void a row match', () => {
    assert.strictEqual(quoteMatchesLocation('Mezzanine overhang cuts into view slightly in row P', { level: 'orchestra', rows: 'P' }), true);
    assert.strictEqual(quoteMatchesLocation('Front Mezzanine Row A overhangs row J', { level: 'orchestra', rows: 'J' }), true);
    assert.strictEqual(quoteMatchesLocation('Front Mezzanine Row A overhangs Orchestra Row O', { level: 'orchestra', rows: 'N-P' }), true);
  });
  test('row ranges and pairs count every row in them (ship-check 2026-11-22)', () => {
    assert.strictEqual(quoteMatchesLocation('Seats in rows E-L are a little cheaper', { level: 'mezzanine', rows: 'F-J' }), true);
    assert.strictEqual(quoteMatchesLocation('Stadium seating on the Orchestra level refers to rows Q to Z', { level: 'orchestra', rows: 'Y-Z' }), true);
    assert.strictEqual(quoteMatchesLocation('Rows AA and BB give a box-like feel', { level: 'mezzanine', rows: 'BB' }), true);
  });
  test('naming the level is not enough when the quote puts the rows elsewhere on it', () => {
    assert.strictEqual(quoteMatchesLocation('Orchestra row A is below the stage', { level: 'orchestra', rows: 'P-T' }), false);
    assert.strictEqual(quoteMatchesLocation('Orchestra rows E-L have the best view', { level: 'balcony', rows: 'F' }), false);
    assert.strictEqual(quoteMatchesLocation('Row F in the Orchestra has extra legroom', { level: 'balcony', rows: 'F' }), false);
    assert.strictEqual(quoteMatchesLocation('The rear mezzanine seats are among the cheapest', { level: 'mezzanine', rows: 'F-N' }), true);
  });
  test('front and rear mezzanine are told apart; box-like is not a box', () => {
    assert.strictEqual(quoteMatchesLocation('The Rear Mezzanine is steep', { level: 'front-mezzanine' }), false);
    assert.strictEqual(quoteMatchesLocation('The Rear Mezzanine is steep', { level: 'rear-mezzanine' }), true);
    assert.strictEqual(quoteMatchesLocation('These seats have a box-like feel', { level: 'box' }), false);
  });
  test('rowMentions tags each mention with the level beside it', () => {
    const m = rowMentions('Front Mezzanine Row A overhangs row J of the Orchestra');
    assert.deepStrictEqual(m.map((x) => x.levelWords), [['mezzanine'], ['orchestra']]);
  });
  test('seatplanSlug folds accents and reads www citations', () => {
    assert.strictEqual(seatplanSlug('Th\u00e9\u00e2tre \u00dcnique', []), 'theatre-unique');
    assert.strictEqual(seatplanSlug('X', ['https://www.seatplan.com/new-york/abc-theatre/orchestra/']), 'abc-theatre');
  });
  test('seed lists SeatPlan level pages under the cited slug plus cited seat guides', () => {
    const entry = { structuredTips: { seating: { sections: [{ evidence: [
      { url: 'https://seatplan.com/new-york/barrymore-theatre/orchestra/' },
      { url: 'https://www.tickpick.com/blog/barrymore-theatre-seating-chart/?x=1' },
      { url: 'https://www.nytimes.com/some-review' },
    ] }] } } };
    const pages = seedPages('Ethel Barrymore Theatre', entry);
    assert.ok(pages.includes('https://seatplan.com/new-york/barrymore-theatre/'));
    assert.ok(pages.includes('https://seatplan.com/new-york/barrymore-theatre/mezzanine/'));
    assert.ok(pages.includes('https://www.tickpick.com/blog/barrymore-theatre-seating-chart/'));
    assert.ok(!pages.some((u) => u.includes('nytimes')));
    assert.ok(seedPages("Eugene O'Neill Theatre", {}).includes('https://seatplan.com/new-york/eugene-oneill-theatre/'));
  });
  test('SeatPlan sub-page links are read from the main page HTML', () => {
    const html = '<a href="/new-york/gershwin-theatre/orchestra/">O</a><a href="https://seatplan.com/new-york/gershwin-theatre/mezzanine/">M</a><a href="/london/x/">L</a>';
    assert.deepStrictEqual(seatplanLinks(html), ['https://seatplan.com/new-york/gershwin-theatre/orchestra/', 'https://seatplan.com/new-york/gershwin-theatre/mezzanine/']);
    const loose = '<a href="https://www.seatplan.com/new-york/x-theatre/balcony?ref=1">B</a><a href=\'/new-york/x-theatre/orchestra\'>O</a>';
    assert.deepStrictEqual(seatplanLinks(loose), ['https://seatplan.com/new-york/x-theatre/balcony/', 'https://seatplan.com/new-york/x-theatre/orchestra/']);
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

describe('value note expiry warning (BRO-8057)', () => {
  const { valueNotesNearExpiry, buildToday, VALUE_MAX_AGE_DAYS } = require('../../scripts/lib/seat-notes-publish.js');
  const meta = { 'Test Theatre': { structuredTips: { seating: { seatNotes: [watch, value, note] } } } };
  test('quiet while the value note is fresh', () => {
    assert.deepStrictEqual(valueNotesNearExpiry(meta, { today: new Date('2026-12-01') }), []);
  });
  test('warns inside the window, before the note is hidden', () => {
    const day = new Date(Date.parse('2026-11-22') + (VALUE_MAX_AGE_DAYS - 30) * 86400000);
    const found = valueNotesNearExpiry(meta, { today: day });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].theater, 'Test Theatre');
    assert.ok(found[0].daysLeft > 0 && found[0].daysLeft <= 30);
    assert.strictEqual(publishableSeatNotes([watch, value], { today: day }).length, 2);
  });
  test('still reports a note that has already expired', () => {
    const day = new Date(Date.parse('2026-11-22') + (VALUE_MAX_AGE_DAYS + 5) * 86400000);
    assert.ok(valueNotesNearExpiry(meta, { today: day })[0].daysLeft < 0);
    assert.deepStrictEqual(publishableSeatNotes([watch, value], { today: day }), []);
  });
  test('audit and site agree on the exact hide day, around the 270-day boundary', () => {
    for (let n = 265; n <= 275; n++) {
      const day = new Date(Date.parse('2026-11-22') + n * 86400000 + 5 * 3600000); // any time that day
      const hidden = publishableSeatNotes([watch, value], { today: new Date(Date.parse('2026-11-22') + n * 86400000 + 12 * 3600000) }).length === 0;
      const f = valueNotesNearExpiry(meta, { today: day, warnDays: 0 });
      assert.strictEqual(f.length > 0, hidden, `day ${n}`);
    }
  });
  test('a missing or invalid verifiedAt is reported as invalid, not Infinity days', () => {
    const bad = { ...value, verifiedAt: 'not-a-date' };
    const f = valueNotesNearExpiry({ T: { structuredTips: { seating: { seatNotes: [watch, bad] } } } }, { today: new Date('2026-12-01') });
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].invalid, true);
    assert.strictEqual(f[0].daysLeft, 0);
  });
  test('value notes the site would never show are not audited', () => {
    const noClaim = { ...value, claim: '' };
    const f = valueNotesNearExpiry({ T: { structuredTips: { seating: { seatNotes: [watch, noClaim] } } } }, { today: new Date('2030-01-01') });
    assert.deepStrictEqual(f, []);
  });
  test('buildToday follows NEXT_PUBLIC_BUILD_DATE so server and client agree', () => {
    process.env.NEXT_PUBLIC_BUILD_DATE = '2027-01-05';
    try { assert.strictEqual(buildToday().toISOString().slice(0, 10), '2027-01-05'); }
    finally { delete process.env.NEXT_PUBLIC_BUILD_DATE; }
  });
});

describe('seat-note expiry alert decision (BRO-8057)', () => {
  const { decideSeatNoteExpiryAlert, CONDITION_KEY } = require('../../scripts/lib/seat-notes-expiry-alert.js');
  test('clean audit resolves the card', () => {
    assert.deepStrictEqual(decideSeatNoteExpiryAlert([]).action, 'resolve');
    assert.strictEqual(decideSeatNoteExpiryAlert([]).conditionKey, CONDITION_KEY);
  });
  test('findings route one warning card naming theater and days', () => {
    const d = decideSeatNoteExpiryAlert([{ theater: 'Test Theatre', where: 'Center Mezzanine', daysLeft: 12 }, { theater: 'Old Theatre', where: 'Center Mezzanine', daysLeft: -3 }]);
    assert.strictEqual(d.action, 'route');
    assert.strictEqual(d.alert.severity, 'warning');
    assert.match(d.alert.description, /Test Theatre \(Center Mezzanine\): hides in 12d/);
    assert.match(d.alert.description, /Old Theatre \(Center Mezzanine\): expired 3d ago/);
  });
  test('invalid dates read as such, and the hint demands a price check', () => {
    const d = decideSeatNoteExpiryAlert([{ theater: 'T', where: 'Rear', daysLeft: 0, invalid: true }]);
    assert.match(d.alert.description, /verification date missing or invalid/);
    assert.match(d.alert.hint, /price still holds/);
  });
});
