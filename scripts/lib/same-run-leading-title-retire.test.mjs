// BRO-7156: one run listed twice, the second title being the first plus a tail
// (comma subtitle, byline, venue name, "_<year>" listing counter). The retire-show
// and retitle-show plan actions must accept these; real rows from shows.json
// 2026-11-13. Real modules are require()d (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isSameRunLeadingTitle } = require('./show-duplicate-detection.js');
const { applyRetireShow } = require('./retire-show-action.js');
const { applyRetitleShow } = require('./retitle-show-action.js');

const honor = { id: 'honor-off-broadway-2027', title: 'Honor', venue: 'Polonsky Shakespeare Center', market: 'broadway', category: 'off-broadway', status: 'upcoming', previewsStartDate: '2027-01-13', closingDate: '2027-01-31', provisional: true };
const honorLong = { ...honor, id: 'honor-an-artist-lecture-off-broadway-2027', title: 'Honor, An Artist Lecture' };
const lumin = { id: 'lumin-regional-2027', title: 'Lumin', venue: 'Moxie Theatre, San Diego, CA', market: 'broadway', category: 'regional', status: 'upcoming', openingDate: '2027-02-14', closingDate: '2027-03-14' };
const luminBy = { ...lumin, id: 'lumin-by-emma-gibson-regional-2027', title: 'Lumin By Emma Gibson' };
const ohio = { id: 'ohio-off-broadway-2027', title: 'Ohio', venue: 'Greenwich House Theater', market: 'broadway', category: 'off-broadway', status: 'upcoming', previewsStartDate: '2027-01-17', closingDate: '2027-03-27' };
const ohioVenue = { id: 'ohio-greenwich-house-theater-off-broadway-2027', title: 'Ohio / Greenwich House Theater', venue: 'Greenwich House Theater', market: 'broadway', category: 'off-broadway', status: 'upcoming', openingDate: '2027-01-17', closingDate: null };
const berlinKept = { id: 'berlin2027-off-west-end-2026', title: 'Berlin_2027', venue: 'Kiln Theatre', market: 'west-end', category: 'off-west-end', status: 'upcoming', previewsStartDate: '2027-03-10', closingDate: '2027-04-17', todaytixId: 47136 };
const berlinStub = { ...berlinKept, id: 'berlin-off-west-end-2027', title: 'Berlin', todaytixId: undefined };

test('isSameRunLeadingTitle: the four real pairs match, both directions', () => {
  for (const [a, b] of [[honor, honorLong], [lumin, luminBy], [ohio, ohioVenue], [berlinStub, berlinKept]]) {
    assert.equal(isSameRunLeadingTitle(a, b), true, `${a.title} / ${b.title}`);
    assert.equal(isSameRunLeadingTitle(b, a), true, `${b.title} / ${a.title}`);
  }
});

test('isSameRunLeadingTitle: a different start, closing, house, or a non-prefix title does not match', () => {
  assert.equal(isSameRunLeadingTitle(honor, { ...honorLong, previewsStartDate: '2027-01-14' }), false, 'start date');
  assert.equal(isSameRunLeadingTitle(honor, { ...honorLong, closingDate: '2027-02-28' }), false, 'closing date');
  assert.equal(isSameRunLeadingTitle(honor, { ...honorLong, venue: 'Signature Theatre' }), false, 'house');
  assert.equal(isSameRunLeadingTitle(honor, { ...honorLong, title: 'An Artist Lecture: Honor' }), false, 'not leading');
  assert.equal(isSameRunLeadingTitle(honor, { ...honor, id: 'x', title: 'Honour' }), false, 'different word');
  assert.equal(isSameRunLeadingTitle(honor, { ...honor, id: 'x' }), false, 'identical title is not this rule');
  assert.equal(isSameRunLeadingTitle({ ...honor, title: 'The' }, { ...honorLong, title: 'The Honor' }), false, 'a bare article is not a title');
  assert.equal(isSameRunLeadingTitle({ ...honor, title: 'Henry VI' }, { ...honorLong, title: 'Henry VI, Part 2' }), false, 'cycle part');
  assert.equal(isSameRunLeadingTitle({ ...honor, title: 'Henry VI' }, { ...honorLong, title: 'Henry VI 2' }), false, 'cycle number');
  assert.equal(isSameRunLeadingTitle({ ...honor, title: 'Angels in America' }, { ...honorLong, title: 'Angels in America: Perestroika' }), false, 'colon part');
  assert.equal(isSameRunLeadingTitle({ ...honor, previewsStartDate: null }, { ...honorLong, previewsStartDate: null }), false, 'undated');
});

test('retire-show accepts a same-run leading-title duplicate (was refused: title does not match)', () => {
  for (const [kept, dup] of [[honor, honorLong], [lumin, luminBy], [ohio, ohioVenue], [berlinKept, berlinStub]]) {
    const shows = [structuredClone(kept), structuredClone(dup)];
    const r = applyRetireShow(shows, { id: dup.id, expectTitle: dup.title, duplicateOf: kept.id, reason: 'BRO-7156 test', evidenceUrl: 'https://example.org/listing' }, { reviewCount: () => 0, retire: () => true });
    assert.equal(r.ok, true, `${dup.id}: ${r.reason}`);
    assert.deepEqual(shows.map(s => s.id), [kept.id]);
  }
});

test('retire-show still refuses the pair when the dates differ (a return run is not a duplicate)', () => {
  const shows = [structuredClone(honor), { ...structuredClone(honorLong), previewsStartDate: '2028-01-13', closingDate: '2028-01-31' }];
  const r = applyRetireShow(shows, { id: honorLong.id, expectTitle: honorLong.title, duplicateOf: honor.id, reason: 'BRO-7156 test' }, { reviewCount: () => 0, retire: () => true });
  assert.equal(r.ok, false);
  assert.equal(shows.length, 2);
});

test('retitle-show drops a "_<year>" listing tail, and nothing else new', () => {
  const shows = [structuredClone(berlinKept)];
  const r = applyRetitleShow(shows, { id: berlinKept.id, expectTitle: 'Berlin_2027', newTitle: 'Berlin', reason: 'Kiln and TodayTix title it Berlin' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(shows[0].title, 'Berlin');
  const other = [{ ...structuredClone(berlinKept), title: 'Berlin_2027' }];
  assert.equal(applyRetitleShow(other, { id: berlinKept.id, expectTitle: 'Berlin_2027', newTitle: 'Berlin 2', reason: 'x' }).ok, false);
  const taken = [{ ...structuredClone(berlinKept) }, { ...structuredClone(berlinKept), id: 'berlin-off-west-end-2027', title: 'Berlin' }];
  assert.equal(applyRetitleShow(taken, { id: berlinKept.id, expectTitle: 'Berlin_2027', newTitle: 'Berlin', reason: 'x' }).ok, false, 'another row holds Berlin');
  const notYear = [{ ...structuredClone(berlinKept), title: 'Berlin_27' }];
  assert.equal(applyRetitleShow(notYear, { id: berlinKept.id, expectTitle: 'Berlin_27', newTitle: 'Berlin', reason: 'x' }).ok, false);
});
