// Tests the real content-request router (scripts/lib/content-request-routing.js).
//
// Guards the 2026-08-01 "3 Summers of Lincoln" regression (GH #505 + its
// resubmitted twin): a content-addition request reached a needs-review issue
// that no workflow consumed and no notification surfaced, so the owner's ask
// sat untouched. Task #461 had made these requests *visible*; nothing made
// them *actionable*.
//
// The fixture is the owner's ACTUAL submission text, verbatim from the
// Formspree API, including the two-asks-in-one-message shape that the old
// one-issue-per-submission path could not represent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planContentRequestActions,
  cleanRequestedTitle,
  parseRequestedTitles,
  extractVenueHint,
  extractVenueHintFor,
  WORKFLOW_REVIEWS,
  REVIEW_COUNT_AUTOGATHER_CEILING,
} = require('../../scripts/lib/content-request-routing.js');

// Verbatim from GET /api/0/forms/mojdjwqo/submissions (2026-08-01T02:41:04Z).
const REAL_MESSAGE =
  "Please add 3 Summers of Lincoln in the recent tryouts section of the Pre-Broadway section from its run at La Jolla. " +
  "PS: there's no picture for Elephant Shoes for it's scorecard page.";
const REAL_SHOW_FIELD = '3 Summers of Lincoln (Regional)';

// Minimal catalog: Elephant Shoes exists, 3 Summers of Lincoln does not.
const SHOWS = [
  { id: 'elephant-shoes-regional-2026', title: 'Elephant Shoes', slug: 'elephant-shoes', category: 'regional', status: 'closed' },
  { id: 'hamilton', title: 'Hamilton', slug: 'hamilton', category: 'broadway', status: 'open' },
  { id: 'lincoln-in-the-bardo-off-broadway-2026', title: 'Lincoln in the Bardo', slug: 'lincoln-in-the-bardo', category: 'off-broadway', status: 'open' },
];

test('the real submission yields BOTH asks, not just one', () => {
  const actions = planContentRequestActions({
    message: REAL_MESSAGE,
    show: REAL_SHOW_FIELD,
    shows: SHOWS,
    showIdsMissingImages: new Set(['elephant-shoes-regional-2026']),
  });
  const kinds = actions.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['missing-image', 'missing-show'],
    'one submission carried two asks; both must route');
});

test('missing-image resolves to the right existing show and a real workflow', () => {
  const actions = planContentRequestActions({
    message: REAL_MESSAGE,
    show: REAL_SHOW_FIELD,
    shows: SHOWS,
    showIdsMissingImages: new Set(['elephant-shoes-regional-2026']),
  });
  const img = actions.find((a) => a.kind === 'missing-image');
  assert.equal(img.showId, 'elephant-shoes-regional-2026');
  assert.equal(img.workflow, 'fetch-all-image-formats.yml');
  assert.equal(img.inputs.show_id, 'elephant-shoes-regional-2026');
  // only_missing must be off: the user asserts the art is absent, and a stale
  // or broken file on disk must not cause the workflow to skip the show.
  assert.equal(img.inputs.only_missing, 'false');
  assert.equal(img.imageAbsenceVerified, true);
});

test('missing-show strips the market parenthetical and captures the venue hint', () => {
  const actions = planContentRequestActions({
    message: REAL_MESSAGE,
    show: REAL_SHOW_FIELD,
    shows: SHOWS,
  });
  const add = actions.find((a) => a.kind === 'missing-show');
  assert.equal(add.title, '3 Summers of Lincoln', 'form appends "(Regional)"; the lookup needs the bare title');
  assert.equal(add.workflow, 'add-requested-show.yml');
  assert.equal(add.venueHint, 'La Jolla',
    'hint must stop at the sentence terminator — allowing "." captured "La Jolla. PS"');
  assert.equal(add.inputs.title, '3 Summers of Lincoln');
});

test('venue hint never bleeds across a sentence boundary', () => {
  assert.equal(
    extractVenueHint('It ran at La Jolla. PS: there is no picture for it.'),
    'La Jolla'
  );
  assert.equal(
    extractVenueHint('Seen at Two River Theater last spring.'),
    'Two River Theater'
  );
});

test('a show already in the catalog never routes as missing-show', () => {
  const actions = planContentRequestActions({
    message: 'Please add Hamilton, I cannot find it',
    show: 'Hamilton',
    shows: SHOWS,
  });
  assert.equal(actions.some((a) => a.kind === 'missing-show'), false);
  const un = actions.find((a) => a.kind === 'unroutable');
  assert.ok(un, 'must park rather than invent a workflow');
  assert.equal(un.showId, 'hamilton', 'parking still carries the resolved show');
});

test('image absence is sentence-scoped — praise for A + missing art on B does not cross-wire', () => {
  const actions = planContentRequestActions({
    message: 'Hamilton is great and the page looks perfect. Separately there is no artwork for Elephant Shoes.',
    show: '',
    shows: SHOWS,
    showIdsMissingImages: new Set(['elephant-shoes-regional-2026']),
  });
  const imgIds = actions.filter((a) => a.kind === 'missing-image').map((a) => a.showId);
  assert.deepEqual(imgIds, ['elephant-shoes-regional-2026'],
    'only the show named in the absence sentence may route');
});

test('nothing recognisable still returns an unroutable action — never an empty plan', () => {
  const actions = planContentRequestActions({
    message: 'I love this site, keep it up!',
    show: '',
    shows: SHOWS,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'unroutable');
  assert.match(actions[0].reason, /no recognised content-request pattern/);
});

test('a title mentioned without absence phrasing does not trigger an image fetch', () => {
  const actions = planContentRequestActions({
    message: 'The Elephant Shoes page is lovely.',
    show: '',
    shows: SHOWS,
  });
  assert.equal(actions.some((a) => a.kind === 'missing-image'), false);
});

test('imageAbsenceVerified is null when the caller supplies no disk evidence', () => {
  const actions = planContentRequestActions({
    message: REAL_MESSAGE,
    show: REAL_SHOW_FIELD,
    shows: SHOWS,
  });
  const img = actions.find((a) => a.kind === 'missing-image');
  assert.equal(img.imageAbsenceVerified, null,
    'unknown must be distinguishable from confirmed-present');
});

// --- missing-reviews route (2026-08-05, GH #543) ---------------------------
// The second time this dead end swallowed a real request. #505 was "the show
// isn't here at all"; this is "the show is here but you never finished its
// reviews" — resolved to a catalogued show, matched no image phrasing, and so
// fell straight through to unroutable/needs-review, which nothing consumes.
// Verbatim from GET /api/0/forms/mojdjwqo/submissions (2026-08-05T14:10Z).
const REVIEW_MESSAGE = 'Please finish the reviews for 3 Summers of Lincoln.';
const REVIEW_SHOW_FIELD = '3 Summers of Lincoln (Regional)';

// Catalog as it actually stood when #543 landed: the show WAS present (added
// 2026-08-01 off request #505) carrying a single San Diego Union-Tribune review.
const SHOWS_WITH_LINCOLN = [
  ...SHOWS,
  { id: '3-summers-of-lincoln-regional-2025', title: '3 Summers of Lincoln', slug: '3-summers-of-lincoln-regional-2025', category: 'regional', status: 'closed' },
];

test('the real #543 submission routes to a review gather, not a parked issue', () => {
  const actions = planContentRequestActions({
    message: REVIEW_MESSAGE,
    show: REVIEW_SHOW_FIELD,
    shows: SHOWS_WITH_LINCOLN,
    reviewCountsByShowId: { '3-summers-of-lincoln-regional-2025': 1 },
  });
  assert.deepEqual(actions.map((a) => a.kind), ['missing-reviews']);
  assert.equal(actions[0].workflow, WORKFLOW_REVIEWS);
  // gather-reviews.js matches on show.id, not slug — they diverge for shows
  // whose slug drops the year/market suffix, so a slug here would silently
  // gather nothing.
  assert.deepEqual(actions[0].inputs, { shows: '3-summers-of-lincoln-regional-2025' });
  assert.equal(actions[0].reviewCountAtRequest, 1);
});

test('a well-covered show parks instead of auto-spending scrape credits', () => {
  const actions = planContentRequestActions({
    message: 'Please finish the reviews for Hamilton.',
    show: 'Hamilton',
    shows: SHOWS_WITH_LINCOLN,
    reviewCountsByShowId: { hamilton: REVIEW_COUNT_AUTOGATHER_CEILING },
  });
  assert.deepEqual(actions.map((a) => a.kind), ['unroutable']);
  assert.match(actions[0].reason, /already has 5 review\(s\)/);
  assert.equal(actions[0].showId, 'hamilton');
  assert.equal(actions.some((a) => a.workflow), false, 'nothing dispatchable may escape the ceiling');
});

test('unknown review counts still route — absent evidence must not silently park', () => {
  const actions = planContentRequestActions({
    message: 'Reviews are incomplete for 3 Summers of Lincoln.',
    show: REVIEW_SHOW_FIELD,
    shows: SHOWS_WITH_LINCOLN,
  });
  const gather = actions.find((a) => a.kind === 'missing-reviews');
  assert.ok(gather, 'no counts supplied means unknown, not "too many"');
  assert.equal(gather.reviewCountAtRequest, null,
    'unknown must be distinguishable from a real count');
});

test('praise mentioning reviews does not trigger a gather', () => {
  const actions = planContentRequestActions({
    message: 'I love the reviews on this site, great work!',
    show: 'Hamilton',
    shows: SHOWS_WITH_LINCOLN,
    reviewCountsByShowId: { hamilton: 40 },
  });
  assert.equal(actions.some((a) => a.kind === 'missing-reviews'), false);
});

test('review absence is sentence-scoped like image absence', () => {
  const actions = planContentRequestActions({
    message: 'Hamilton looks perfect. Separately the reviews are missing for 3 Summers of Lincoln.',
    show: '',
    shows: SHOWS_WITH_LINCOLN,
    reviewCountsByShowId: { hamilton: 40, '3-summers-of-lincoln-regional-2025': 1 },
  });
  const ids = actions.filter((a) => a.kind === 'missing-reviews').map((a) => a.showId);
  assert.deepEqual(ids, ['3-summers-of-lincoln-regional-2025']);
});

test('one show never yields both a review gather and a duplicate unroutable row', () => {
  const actions = planContentRequestActions({
    message: REVIEW_MESSAGE,
    show: REVIEW_SHOW_FIELD,
    shows: SHOWS_WITH_LINCOLN,
    reviewCountsByShowId: new Map([['3-summers-of-lincoln-regional-2025', 1]]),
  });
  assert.equal(actions.length, 1, 'the form-field fallback must not re-add what the sentence pass claimed');
});

test('adding the review route did not break the two-asks-in-one-message case', () => {
  const actions = planContentRequestActions({
    message: REAL_MESSAGE,
    show: REAL_SHOW_FIELD,
    shows: SHOWS,
    showIdsMissingImages: new Set(['elephant-shoes-regional-2026']),
  });
  assert.deepEqual(actions.map((a) => a.kind).sort(), ['missing-image', 'missing-show']);
});

// --- multi-title + market scoping (2026-08-05, GH #542) --------------------
// The show field is ONE free-text box and users put two shows in it. Treating
// it as a single title fuzzy-matched the whole string to the Broadway entry for
// Two Strangers, declared "already in catalog", and dropped The Outsiders
// entirely — a real request refused on two independent counts.
const MULTI_SHOW_FIELD = 'The Outsiders (Regional) and Two Strangers (Carry a Cake Across New York) Regional';
const MULTI_MESSAGE =
  'Please add both The Outsiders out of town at The Weiss at La Jolla and Two Strangers ' +
  'out of town from A.R.T in Cambridge in subsection Transferred to Broadway in the Regional section, please';

// Both titles exist on BROADWAY in the real catalog; neither regional tryout does.
// That is precisely the trap: a Broadway hit must not satisfy a regional ask.
const SHOWS_BWAY_ONLY = [
  { id: 'the-outsiders-2024', title: 'The Outsiders', slug: 'the-outsiders', category: 'broadway', status: 'open', openingDate: '2024-04-11' },
  { id: 'two-strangers-bway-2025', title: 'Two Strangers (Carry a Cake Across New York)', slug: 'two-strangers', category: 'broadway', status: 'open', openingDate: '2025-11-20' },
];

test('parseRequestedTitles splits the field on market words, not on "and"', () => {
  assert.deepEqual(parseRequestedTitles(MULTI_SHOW_FIELD), [
    { title: 'The Outsiders', market: 'regional' },
    { title: 'Two Strangers (Carry a Cake Across New York)', market: 'regional' },
  ]);
  // The reason " and " is not the delimiter: it appears inside real titles.
  assert.deepEqual(parseRequestedTitles('Sense and Sensibility (Off-Broadway)'), [
    { title: 'Sense and Sensibility', market: 'off-broadway' },
  ]);
  assert.deepEqual(parseRequestedTitles('Kyoto (Broadway)'), [{ title: 'Kyoto', market: 'broadway' }]);
  // No market word at all: unchanged pre-existing behaviour.
  assert.deepEqual(parseRequestedTitles('Just A Title'), [{ title: 'Just A Title', market: null }]);
  assert.deepEqual(parseRequestedTitles(''), []);
  assert.deepEqual(parseRequestedTitles(undefined), []);
});

test('the real #542 submission routes BOTH shows, not one', () => {
  const actions = planContentRequestActions({
    message: MULTI_MESSAGE,
    show: MULTI_SHOW_FIELD,
    shows: SHOWS_BWAY_ONLY,
  });
  assert.deepEqual(actions.map((a) => a.kind), ['missing-show', 'missing-show']);
  assert.deepEqual(actions.map((a) => a.title), [
    'The Outsiders',
    'Two Strangers (Carry a Cake Across New York)',
  ]);
  assert.equal(actions.every((a) => a.workflow === 'add-requested-show.yml'), true);
});

test('a Broadway entry does not satisfy a request for the regional tryout', () => {
  const actions = planContentRequestActions({
    message: 'Please add The Outsiders from its La Jolla run.',
    show: 'The Outsiders (Regional)',
    shows: SHOWS_BWAY_ONLY,
  });
  assert.deepEqual(actions.map((a) => a.kind), ['missing-show'],
    'the Broadway production existing says nothing about the tryout');
  assert.equal(actions[0].market, 'regional');
});

test('a request that IS satisfied in its own market still parks, not adds', () => {
  const actions = planContentRequestActions({
    message: 'Please add The Outsiders.',
    show: 'The Outsiders (Broadway)',
    shows: SHOWS_BWAY_ONLY,
  });
  assert.deepEqual(actions.map((a) => a.kind), ['unroutable']);
  assert.match(actions[0].reason, /already in catalog as the-outsiders-2024/);
});

test('venue hints do not cross-wire between two shows in one message', () => {
  const actions = planContentRequestActions({
    message: MULTI_MESSAGE,
    show: MULTI_SHOW_FIELD,
    shows: SHOWS_BWAY_ONLY,
  });
  const [outsiders, twoStrangers] = actions;
  assert.equal(outsiders.venueHint, 'The Weiss', 'hint must come from its own clause');
  // Null, NOT "The Weiss". An unfounded hint is worse than none here because
  // add-requested-show searches on it.
  assert.equal(twoStrangers.venueHint, null,
    'the first show\'s venue must never leak onto the second');
});

test('extractVenueHintFor stops at the next requested title', () => {
  const hint = extractVenueHintFor(
    'The Outsiders',
    'Add The Outsiders at La Jolla and Two Strangers at Cambridge',
    ['The Outsiders', 'Two Strangers']
  );
  assert.equal(hint, 'La Jolla');
  assert.equal(
    extractVenueHintFor('Nowhere Show', 'Add The Outsiders at La Jolla', ['Nowhere Show']),
    null,
    'a title absent from the message yields no hint rather than a borrowed one'
  );
});

test('helpers behave on edge input', () => {
  assert.equal(cleanRequestedTitle('Kyoto (Broadway)'), 'Kyoto');
  assert.equal(cleanRequestedTitle('Kyoto (Off-Broadway)'), 'Kyoto');
  assert.equal(cleanRequestedTitle(''), '');
  assert.equal(cleanRequestedTitle(undefined), '');
  assert.equal(extractVenueHint('no venue mentioned here'), null);
});
