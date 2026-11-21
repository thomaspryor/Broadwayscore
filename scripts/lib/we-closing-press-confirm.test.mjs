// BRO-7993: West End new-closing candidates are written only when credible press
// names an explicit final performance within 7 days of the booking-page date.
// Fixtures = the 12 candidates hand-checked on 2026-11-21.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideWeNewClosing } = require('./we-closing-press-confirm.js');
const { parseExtraction, clusterDates, isCredibleUrl, getFieldConfig, WEST_END_CREDIBLE_HOSTS } = require('./closing-date-discovery.js');

const TODAY = '2026-11-21';
const press = (date, quote, url = 'https://www.whatsonstage.com/x') => ({ date, sources: [{ url, title: 't', quote }] });

const REAL = [
  { id: 'white-rabbit-red-rabbit-west-end-2026', booking: '2026-12-14', final: '2026-12-14', quote: 'The final performance will be on 14 December.' },
  { id: 'titanique-west-end-2024', booking: '2027-01-03', final: '2027-01-03', quote: 'Titanique will play its final performance on 3 January 2027.' },
];
const HORIZONS = [
  ['hadestown', '2027-03-06'], ['devil-wears-prada', '2027-05-29'], ['paddington', '2027-02-28'], ['oliver', '2027-04-03'],
  ['moulin-rouge', '2027-06-12'], ['paranormal-activity', '2027-01-30'], ['austentatious', '2027-02-14'],
  ['murder-she-didnt-write', '2027-03-20'], ['cabaret', '2027-08-28'], ['operation-mincemeat', '2027-05-01'],
];

for (const r of REAL) {
  test(`real closing applies: ${r.id}`, () => {
    const d = decideWeNewClosing({ stored: null, bookingDate: r.booking, discovery: press(r.final, r.quote), todayStr: TODAY });
    assert.equal(d.apply, true);
    assert.equal(d.date, r.final);
  });
}

for (const [id, booking] of HORIZONS) {
  test(`booking horizon stays blank: ${id} (no press closing)`, () => {
    assert.equal(decideWeNewClosing({ stored: null, bookingDate: booking, discovery: null, todayStr: TODAY }).apply, false);
  });
  test(`booking horizon stays blank: ${id} (press only says booking until)`, () => {
    const d = decideWeNewClosing({ stored: null, bookingDate: booking, discovery: press(booking, 'Tickets are on sale until the end of the booking period'), todayStr: TODAY });
    assert.equal(d.apply, false);
    assert.equal(d.reason, 'no_explicit_final_performance_quote');
  });
  test(`booking horizon stays blank: ${id} (press final date >7d away)`, () => {
    const d = decideWeNewClosing({ stored: null, bookingDate: booking, discovery: press('2026-12-20', 'final performance on 20 December'), todayStr: TODAY });
    assert.equal(d.apply, false);
    assert.match(d.reason, /^press_disagrees/);
  });
}

test('7 day tolerance is inclusive, 8 is rejected', () => {
  const q = 'final performance on 3 January';
  assert.equal(decideWeNewClosing({ stored: null, bookingDate: '2027-01-10', discovery: press('2027-01-03', q), todayStr: TODAY }).apply, true);
  assert.equal(decideWeNewClosing({ stored: null, bookingDate: '2027-01-11', discovery: press('2027-01-03', q), todayStr: TODAY }).apply, false);
});

test('never overwrites a stored closingDate, never applies a past date', () => {
  const q = 'final performance on 3 January 2027 and 15 November';
  assert.equal(decideWeNewClosing({ stored: '2027-01-03', bookingDate: '2027-01-03', discovery: press('2027-01-03', q), todayStr: TODAY }).apply, false);
  assert.equal(decideWeNewClosing({ stored: null, bookingDate: '2026-11-15', discovery: press('2026-11-15', q), todayStr: TODAY }).apply, false);
});

test('a booking-window quote does not count even if it contains a closing verb', () => {
  const d = decideWeNewClosing({ stored: null, bookingDate: '2027-01-03', discovery: press('2027-01-03', 'Booking until 3 January, closing on tickets released later'), todayStr: TODAY });
  assert.equal(d.apply, false);
});

test("'closing-we' config: West End hosts only, WET excluded, prompt targets London", () => {
  const cfg = getFieldConfig('closing-we');
  assert.equal(cfg.hosts, WEST_END_CREDIBLE_HOSTS);
  assert.equal(isCredibleUrl('https://www.whatsonstage.com/a', cfg.hosts), true);
  assert.equal(isCredibleUrl('https://www.westendtheatre.com/a', cfg.hosts), false);
  assert.equal(isCredibleUrl('https://www.playbill.com/a', cfg.hosts), false);
  assert.match(cfg.serpQuery('Cabaret'), /West End/);
});

test('extraction plumbing: parse + cluster accept an explicit final date, reject low confidence', () => {
  const now = new Date('2026-11-21T00:00:00Z');
  const ok = parseExtraction('{"date":"2027-01-03","confidence":"high","quote":"final performance on 3 January"}', { fieldType: 'closing-we', now });
  assert.equal(ok.date, '2027-01-03');
  const low = parseExtraction('{"date":null,"confidence":"low","quote":null}', { fieldType: 'closing-we', now });
  assert.equal(clusterDates([{ ...low, sourceUrl: 'https://www.whatsonstage.com/a' }], { fieldType: 'closing-we' }), null);
  const c = clusterDates([{ ...ok, sourceUrl: 'https://www.whatsonstage.com/a' }], { fieldType: 'closing-we' });
  assert.equal(c.centerDate, '2027-01-03');
});

test('cast departure quote does not count', () => {
  const d = decideWeNewClosing({ stored: null, bookingDate: '2027-01-03', discovery: press('2027-01-03', 'The star plays her final performance on 3 January.'), todayStr: TODAY });
  assert.equal(d.apply, false);
});

test('quote must name the date day, and the written date is the evidence source date', () => {
  assert.equal(decideWeNewClosing({ stored: null, bookingDate: '2027-01-03', discovery: press('2027-01-03', 'The final performance will be in January.'), todayStr: TODAY }).apply, false);
  const d = decideWeNewClosing({ stored: null, bookingDate: '2027-01-03', discovery: { date: '2027-01-02', sources: [
    { url: 'https://a.com/1', quote: 'a vague mention', date: '2027-01-02' },
    { url: 'https://www.whatsonstage.com/2', quote: 'final performance on 3 January', date: '2027-01-03' },
  ] }, todayStr: TODAY });
  assert.equal(d.apply, true);
  assert.equal(d.date, '2027-01-03');
});

test('host check is domain-bounded', () => {
  const cfg = getFieldConfig('closing-we');
  assert.equal(isCredibleUrl('https://whatsonstage.com.evil.org/a', cfg.hosts), false);
  assert.equal(isCredibleUrl('https://evil.org/whatsonstage.com/a', cfg.hosts), false);
  assert.equal(isCredibleUrl('https://www.playbill.com/a'), true);
});
