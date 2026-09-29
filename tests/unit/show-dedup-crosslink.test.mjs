// Sprint-plan S0-T2b: cross-linked ids are never duplicates (stopgap until
// the S5-T1 temporal rule). Per CLAUDE.md §15 the real functions are
// require()d — nothing is reimplemented here.
//
// The shapes mirror the Sprint 2 stubs the rule exists for: an OPEN/previews
// return or transfer that shares a title with an existing row in the same
// market. checkForDuplicate's Check 1 (exact title) fires before any
// venue/date reasoning, and isMultiProduction only exempts closed-vs-
// announced pairs, so without an explicit link these pairs ARE duplicates
// today — the first assertion in each test pins that current behaviour, the
// second shows the cross-link exempting exactly that row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForDuplicate, isCrossLinked } = require('../../scripts/lib/deduplication.js');
const { isDeclaredTransferPair } = require('../../scripts/lib/show-duplicate-detection.js');

// Transfer shape: the existing run is still open, the freshly-discovered
// transfer stub is in previews and does not carry a venue yet (discovery
// stubs never do before enrichment), so no venue-diff shortcut can fire.
const existingOpenRun = {
  id: 'into-the-woods-off-broadway-2025',
  title: 'Into the Woods',
  status: 'open',
  category: 'off-broadway',
  venue: 'Laura Pels Theatre',
  openingDate: '2025-11-02',
};
const transferStub = {
  id: 'into-the-woods-2026',
  title: 'Into the Woods',
  status: 'previews',
  category: 'broadway',
  venue: null,
  openingDate: null,
  previewsStartDate: '2026-09-22',
};

test('open same-title pair WITHOUT links is still a duplicate (current behaviour)', () => {
  const result = checkForDuplicate(transferStub, [existingOpenRun]);
  assert.equal(result.isDuplicate, true, 'un-linked open pair must still be flagged');
  assert.equal(result.existingShow.id, existingOpenRun.id);
});

test('candidate.transferOf naming the existing id exempts that row', () => {
  const linked = { ...transferStub, transferOf: existingOpenRun.id };
  const result = checkForDuplicate(linked, [existingOpenRun]);
  assert.equal(result.isDuplicate, false, `transferOf-linked pair must not be a duplicate: ${result.reason}`);
});

test('existing.transferredTo naming the candidate id exempts that row (reverse direction)', () => {
  const existingLinked = { ...existingOpenRun, transferredTo: transferStub.id };
  const result = checkForDuplicate(transferStub, [existingLinked]);
  assert.equal(result.isDuplicate, false, `transferredTo-linked pair must not be a duplicate: ${result.reason}`);
});

// Return-engagement shape: same title, SAME venue, prior run closed last
// year, the return is open now. One year apart falls inside the >2yr
// window and the venues match, so before S5-T1 isMultiProduction said "same
// production"; the start-after-close rule now resolves it on dates alone.
const priorRun = {
  id: 'lost-in-del-valle-off-broadway-2025',
  title: 'Lost in Del Valle',
  status: 'closed',
  category: 'off-broadway',
  venue: 'Rattlestick Theater',
  openingDate: '2025-06-01',
  closingDate: '2025-07-15',
};
const returnRun = {
  id: 'lost-in-del-valle-off-broadway-2026',
  title: 'Lost in Del Valle',
  status: 'open',
  category: 'off-broadway',
  venue: 'Rattlestick Theater',
  openingDate: '2026-09-15',
};

test('return engagement WITHOUT an id-bearing priorRuns entry: S5-T1 resolves it on dates, and a dates-only priorRuns is still not a cross-link', () => {
  // Pinned as "still a duplicate" while S0-T2b was the only rule; the S5-T1
  // start-after-close rule (tests/unit/show-dedup-temporal.test.mjs) now
  // reads a return that opens after the prior run closed as a new production
  // with or without a link.
  const noLink = checkForDuplicate(returnRun, [priorRun]);
  assert.equal(noLink.isDuplicate, false, `un-linked same-venue return opening after the prior run closed is a new production (S5-T1): ${noLink.reason}`);

  // Today's shows.json priorRuns shape carries dates + venue but no id —
  // that is NOT a cross-link and must not blanket-exempt every priorRuns show.
  const datesOnly = { ...returnRun, priorRuns: [{ openingDate: '2025-06-01', closingDate: '2025-07-15', venue: 'Rattlestick Theater' }] };
  assert.equal(isCrossLinked(datesOnly, priorRun), false, 'priorRuns without an id names no row and is not a cross-link');

  // Without temporal separation (the "return" overlaps the prior run) the
  // un-linked same-venue pair is still flagged — the S0-T2b exemption is
  // what a real link buys, not a blanket pass for priorRuns-bearing rows.
  const overlapping = { ...returnRun, openingDate: '2025-07-01' };
  assert.equal(checkForDuplicate(overlapping, [priorRun]).isDuplicate, true, 'an overlapping un-linked same-venue pair is still a duplicate');
  assert.equal(checkForDuplicate({ ...overlapping, priorRuns: datesOnly.priorRuns }, [priorRun]).isDuplicate, true, 'dates-only priorRuns exempts nothing');
});

test('candidate.priorRuns entry naming the existing id exempts that row (object and string forms)', () => {
  const objectForm = { ...returnRun, priorRuns: [{ id: priorRun.id, openingDate: '2025-06-01', closingDate: '2025-07-15', venue: 'Rattlestick Theater' }] };
  const a = checkForDuplicate(objectForm, [priorRun]);
  assert.equal(a.isDuplicate, false, `priorRuns[{id}] must exempt the named row: ${a.reason}`);

  const stringForm = { ...returnRun, priorRuns: [priorRun.id] };
  const b = checkForDuplicate(stringForm, [priorRun]);
  assert.equal(b.isDuplicate, false, `priorRuns['id'] must exempt the named row: ${b.reason}`);
});

test('the exemption is per-row: an un-linked same-title row can still match', () => {
  const unrelatedSameTitle = {
    id: 'into-the-woods-2026-dup',
    title: 'Into the Woods',
    status: 'previews',
    category: 'broadway',
    venue: null,
    openingDate: null,
  };
  const linked = { ...transferStub, transferOf: existingOpenRun.id };
  const result = checkForDuplicate(linked, [existingOpenRun, unrelatedSameTitle]);
  assert.equal(result.isDuplicate, true, 'the un-linked row must still be flagged');
  assert.equal(result.existingShow.id, unrelatedSameTitle.id, 'and it is the un-linked row that matched');
});

test('isCrossLinked is symmetric, id-exact, and never matches missing ids', () => {
  const a = { id: 'a-2026', transferOf: 'b-2025' };
  const b = { id: 'b-2025' };
  assert.equal(isCrossLinked(a, b), true);
  assert.equal(isCrossLinked(b, a), true, 'symmetric');
  assert.equal(isCrossLinked({ id: 'a-2026', transferOf: 'c-2024' }, b), false, 'must name THIS row');
  assert.equal(isCrossLinked({ id: 'a-2026', transferredTo: 'b-2025' }, b), true);
  assert.equal(isCrossLinked({ id: 'a-2026', priorRuns: [{ showId: 'b-2025' }] }, b), true);
  assert.equal(isCrossLinked({ id: 'a-2026', priorRuns: [{ productionId: 'b-2025' }] }, b), true);
  // undefined === undefined must not read as a link.
  assert.equal(isCrossLinked({ title: 'X' }, { title: 'X' }), false, 'no ids, no link');
  assert.equal(isCrossLinked({ id: 'a-2026', transferOf: undefined }, { title: 'X' }), false);
  assert.equal(isCrossLinked({ id: '', transferOf: '' }, { id: '' }), false, 'empty ids never link');
  assert.equal(isCrossLinked(null, b), false);
  assert.equal(isCrossLinked(a, undefined), false);
});

test('the transferOf/transferredTo half IS show-duplicate-detection\'s isDeclaredTransferPair (one rule for the dedup check and the ticket-identity audit)', () => {
  const t = { id: 'kimberly-regional-2024' };
  const b = { id: 'kimberly-bway-2025' };
  for (const [x, y] of [[{ ...t, transferredTo: b.id }, b], [t, { ...b, transferOf: t.id }], [{ ...t, transferOf: b.id }, b], [t, { ...b, transferredTo: t.id }]]) {
    assert.equal(isDeclaredTransferPair(x, y), true);
    assert.equal(isCrossLinked(x, y), true);
    assert.equal(isCrossLinked(y, x), true, 'symmetric through the shared helper');
  }
  // The shared helper carries the same id-exact guard the dedup check relies
  // on: undefined === undefined and empty ids are not a pair.
  assert.equal(isDeclaredTransferPair({ id: 'a-2026', transferOf: undefined }, { title: 'X' }), false);
  assert.equal(isDeclaredTransferPair({ id: '' }, { id: '', transferredTo: '' }), false);
  assert.equal(isDeclaredTransferPair({ id: ' a-2026 ' }, { id: 'b-2025', transferOf: 'a-2026' }), true, 'ids are trimmed before comparing');
  assert.equal(isDeclaredTransferPair(null, b), false);
  assert.equal(isDeclaredTransferPair(t, undefined), false);
});

test('distinctFrom: concurrent sibling productions at one venue (family panto vs adults-only twin) are exempt only when one row names the other', () => {
  // Audit S8-T3: the King's Head runs "Dick Whittington and His Cat" and
  // "Dick Whittington: Adults Only" side by side (Nov 2026 – Jan 2027). Neither
  // is a transfer or a prior run of the other, so transferOf/priorRuns cannot
  // describe the pair; without a link the same-venue similar-title rule flags it.
  const family = {
    id: 'dick-whittington-and-his-cat-off-west-end-2026', slug: 'dick-whittington-and-his-cat-off-west-end-2026',
    title: 'Dick Whittington and His Cat', venue: "King's Head Theatre", category: 'off-west-end', type: 'musical',
    previewsStartDate: '2026-11-22', openingDate: '2026-11-29', closingDate: '2027-01-03', status: 'upcoming',
  };
  const adults = {
    id: 'dick-whittington-adults-only-off-west-end-2026', slug: 'dick-whittington-adults-only-off-west-end-2026',
    title: 'Dick Whittington: Adults Only', venue: "King's Head Theatre", category: 'off-west-end', type: 'musical',
    previewsStartDate: '2026-11-26', openingDate: '2026-11-27', closingDate: '2027-01-02', status: 'upcoming',
  };
  const unlinked = checkForDuplicate(adults, [family]);
  assert.equal(unlinked.isDuplicate, true, 'without a link the same-venue rule flags the pair');
  assert.match(unlinked.reason, /Same venue/);

  assert.equal(checkForDuplicate({ ...adults, distinctFrom: [family.id] }, [family]).isDuplicate, false, 'the candidate may name the existing row');
  assert.equal(checkForDuplicate(adults, [{ ...family, distinctFrom: [adults.id] }]).isDuplicate, false, 'or the existing row may name the candidate');
  assert.equal(checkForDuplicate({ ...adults, distinctFrom: [{ id: family.id }] }, [family]).isDuplicate, false, '{ id } objects work too');
  assert.equal(checkForDuplicate({ ...adults, distinctFrom: ['some-other-2026'] }, [family]).isDuplicate, true, 'a dangling distinctFrom exempts nothing');
  assert.equal(isCrossLinked({ id: 'a-2026', distinctFrom: [] }, { id: 'b-2026' }), false, 'empty list, no link');
  assert.equal(isCrossLinked({ id: 'a-2026', distinctFrom: [undefined] }, { title: 'X' }), false, 'undefined never links a row without an id');
});
