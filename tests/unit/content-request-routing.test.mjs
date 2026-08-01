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
  extractVenueHint,
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

test('helpers behave on edge input', () => {
  assert.equal(cleanRequestedTitle('Kyoto (Broadway)'), 'Kyoto');
  assert.equal(cleanRequestedTitle('Kyoto (Off-Broadway)'), 'Kyoto');
  assert.equal(cleanRequestedTitle(''), '');
  assert.equal(cleanRequestedTitle(undefined), '');
  assert.equal(extractVenueHint('no venue mentioned here'), null);
});
