import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveEntryShowId, describeAmbiguity, buildStuckAlert } = require('./verify-feedback-requests-live.js');

// Mirrors the real #905 shape: a title with multiple same-titled productions.
const BOOK_OF_MORMON_SHOWS = [
  { id: 'book-of-mormon-2011', slug: 'book-of-mormon', title: 'The Book of Mormon', status: 'open', openingDate: '2011-03-24', category: 'broadway' },
  { id: 'book-of-mormon-we-2024', slug: 'the-book-of-mormon-west-end', title: 'The Book of Mormon', status: 'open', openingDate: '2013-03-21', category: 'west-end' },
  { id: 'book-of-mormon-tour-2022', slug: 'book-of-mormon-tour-2022', title: 'The Book of Mormon', status: 'open', openingDate: '2022-09-23', category: 'tour' },
];

// A same-market revival: two Broadway productions sharing a title.
const REVIVAL_SHOWS = [
  { id: 'dolly-1964', slug: 'hello-dolly', title: 'Hello, Dolly!', status: 'closed', openingDate: '1964-01-16', category: 'broadway' },
  { id: 'dolly-2017', slug: 'hello-dolly-2017', title: 'Hello Dolly', status: 'closed', openingDate: '2017-04-20', category: 'broadway' },
];

test('manual entry.showId always wins, skipping resolution entirely', () => {
  const entry = { key: 'k', showId: 'manually-set-id', title: 'anything', market: null };
  assert.equal(resolveEntryShowId(entry, BOOK_OF_MORMON_SHOWS), 'manually-set-id');
});

test('no title or no shows array resolves to null', () => {
  assert.equal(resolveEntryShowId({ key: 'k' }, BOOK_OF_MORMON_SHOWS), null);
  assert.equal(resolveEntryShowId({ key: 'k', title: 'X' }, null), null);
});

test('no match at all resolves to null', () => {
  const entry = { key: 'k', title: 'Some Show Nobody Has Heard Of', market: null };
  assert.equal(resolveEntryShowId(entry, BOOK_OF_MORMON_SHOWS), null);
});

test('unambiguous single match resolves to that show', () => {
  const entry = { key: 'k', title: 'The Book of Mormon', market: 'tour' };
  assert.equal(resolveEntryShowId(entry, BOOK_OF_MORMON_SHOWS), 'book-of-mormon-tour-2022');
});

// The #905 regression: an unscoped (market: null) title matching 3 productions
// across markets must NOT silently pick the newest opening — it must skip and
// stay open for manual review, not get auto-closed against the wrong show.
test('#905 shape: cross-market ambiguity with no market set returns null, does not guess', () => {
  const entry = { key: 'k', title: 'The Book of Mormon', market: null };
  assert.equal(resolveEntryShowId(entry, BOOK_OF_MORMON_SHOWS), null);
});

// Same-market revival (the cousin bug this commit targets): title scoped to
// one market still ties between two productions — must also skip, not guess.
test('same-market revival ambiguity returns null, does not guess', () => {
  const entry = { key: 'k', title: 'Hello Dolly', market: 'broadway' };
  assert.equal(resolveEntryShowId(entry, REVIVAL_SHOWS), null);
});

test('market scoping narrows to the single in-market match', () => {
  const entry = { key: 'k', title: 'The Book of Mormon', market: 'west-end' };
  assert.equal(resolveEntryShowId(entry, BOOK_OF_MORMON_SHOWS), 'book-of-mormon-we-2024');
});

// Codex /second-opinion review of ac007966312: the stuck-request alert only
// said "still not on the site" for an ambiguous entry — the owner's alert
// needs to say WHY, and a cousin of the content-request-routing.js finding
// means that WHY must name shows by title, not raw ID (the text lands
// verbatim in the owner's plain-English email).
test('describeAmbiguity names candidates by title, not raw ID', () => {
  const entry = { key: 'k', title: 'The Book of Mormon', market: null };
  const note = describeAmbiguity(entry, BOOK_OF_MORMON_SHOWS);
  assert.match(note, /matched 3 shows/);
  assert.match(note, /The Book of Mormon \(broadway\)/);
  assert.match(note, /The Book of Mormon \(west-end\)/);
  assert.doesNotMatch(note, /book-of-mormon-2011/);
});

test('describeAmbiguity returns null for an unambiguous or already-resolved entry', () => {
  assert.equal(describeAmbiguity({ key: 'k', showId: 'x', title: 'The Book of Mormon' }, BOOK_OF_MORMON_SHOWS), null);
  assert.equal(
    describeAmbiguity({ key: 'k', title: 'The Book of Mormon', market: 'tour' }, BOOK_OF_MORMON_SHOWS),
    null
  );
});

test('buildStuckAlert renders the ambiguity note instead of the generic "could not establish" line', () => {
  const stale = [{ key: 'k', title: 'The Book of Mormon', requestedAt: new Date(Date.now() - 10 * 86400000).toISOString() }];
  const ambiguityNotes = new Map([['k', 'ambiguous — "The Book of Mormon" matched 3 shows (A, B, C); needs a human to set entry.showId in the ledger']]);
  const alert = buildStuckAlert(stale, new Map(), ambiguityNotes);
  assert.match(alert.description, /ambiguous — "The Book of Mormon" matched 3 shows/);
  assert.doesNotMatch(alert.description, /could not establish/);
});
