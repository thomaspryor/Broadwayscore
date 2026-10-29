import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outletFieldShapeErrors } = require('./outlet-registry-field-shape.js');
const { findRunTogetherSlugDisplayNames, isRunTogetherSlugDisplayName, resolveMastheadName } = require('./outlet-auto-register.js');
const { normalizeOutlet } = require('./review-normalization.js');

// BRO-5246: verified one-word mastheads must survive the homepage backfill.
// The first four are explicitly verified in the card. Operationlivetheatre's
// homepage also returns this exact spelling (2026-10-22).
// This is intentionally not an allowlist for unresolved compound names.
const VERIFIED_SINGLE_WORD_DISPLAY_NAMES = Object.freeze({
  washingtonian: 'Washingtonian',
  classicalite: 'Classicalite',
  berkeleyside: 'Berkeleyside',
  dramatically: 'Dramatically',
  operationlivetheatre: 'Operationlivetheatre',
  // tabinthecity.co.uk og:site_name and <title> are both "Tabinthecity" (BRO-6421, 2026-10-27).
  tabinthecity: 'Tabinthecity',
});

for (const [id, displayName] of Object.entries(VERIFIED_SINGLE_WORD_DISPLAY_NAMES)) {
  test(`verified single-word masthead ${displayName} is preserved and exempt from backfill`, () => {
    const { outlets } = require('../../data/outlet-registry.json');
    assert.equal(outlets[id]?.displayName, displayName);
    assert.deepEqual(findRunTogetherSlugDisplayNames({ [id]: outlets[id] }), [],
      `${id} needs displayNameReviewed:true so the homepage backfill preserves its verified spelling`);
  });
}

test('the whole registry has no unreviewed run-together display names', () => {
  const { outlets } = require('../../data/outlet-registry.json');
  assert.deepEqual(findRunTogetherSlugDisplayNames(outlets), []);
  // A reviewed stamp alone must not hide a compound name from this check.
  const singleWords = Object.keys(outlets).filter(id =>
    isRunTogetherSlugDisplayName(id, outlets[id]?.displayName));
  assert.deepEqual(singleWords.sort(), Object.keys(VERIFIED_SINGLE_WORD_DISPLAY_NAMES).sort());
});

// BRO-5246: homepage metadata retrieved from these Wayback captures on 2026-10-29.
// Keep only the masthead metadata, never the archived articles.
for (const { id, displayName, previousName, html, source } of [
  {
    id: 'realmericanmedia',
    displayName: 'RealMerican Media',
    previousName: 'RealMericanMedia.com',
    html: '<meta content="RealMerican Media" property="og:site_name"/><title>RealMerican Media | Keeping It American</title>',
    source: 'https://web.archive.org/web/20161022052133/http://realmericanmedia.com/',
  },
  {
    id: 'mydreamcametrue',
    displayName: 'My Dream Came True!',
    previousName: 'My Dream Came True',
    html: '<title>Home Page - My Dream Came True!</title>',
    source: 'https://web.archive.org/web/20161010123202/http://mydreamcametrue.com/',
  },
  {
    id: 'broadwayspotted',
    displayName: 'BroadwaySpotted',
    previousName: 'Broadway Spotted',
    html: '<title>BroadwaySpotted - Broadway gets Spotted</title>',
    source: 'https://web.archive.org/web/20150111081400/http://www.broadwayspotted.com/',
  },
]) {
  test(`${id} matches its archived homepage masthead`, async () => {
    const { outlets } = require('../../data/outlet-registry.json');
    const masthead = await resolveMastheadName({
      outletId: id,
      domain: outlets[id].domain,
      fetchPage: async () => ({ content: html }),
    });
    assert.equal(masthead.displayName, displayName, source);
    assert.equal(outlets[id].displayName, masthead.displayName, source);
    assert.equal(normalizeOutlet(displayName), id);
    assert.equal(normalizeOutlet(previousName), id, 'Existing review labels must still resolve to the same outlet');
  });
}

test('the remaining BRO-5246 names keep their individually checked spelling', () => {
  const { outlets } = require('../../data/outlet-registry.json');
  for (const [id, name] of Object.entries({
    // Homepage title / og:site_name, fetched via resolveMastheadName on 2026-10-25.
    // These three mastheads differ from their ids and needed manual review.
    thepegreview: 'THE PEG',
    ticketswitch: 'theatre.london',
    shinylife: 'A Shiny Life For Me!',
    donshewey: 'Don Shewey',
    travelbeginsat40: 'Travel Begins at 40',
  })) assert.equal(outlets[id]?.displayName, name);
});

test('the two defunct lottery pages are not registered as review outlets', () => {
  const { outlets } = require('../../data/outlet-registry.json');
  assert.equal(outlets.americanpsychothemusicalcomlottery, undefined);
  assert.equal(outlets.laughteronbroadwaycomlottery, undefined);
});

test('an omitted starScale is how "no star scale" is spelled — no error', () => {
  const entry = { displayName: 'The Arbuturian', tier: 3, domain: 'arbuturian.com' };
  assert.deepEqual(outletFieldShapeErrors('arbuturian', entry), []);
});

test('starScale: null is still rejected — present is present', () => {
  const errors = outletFieldShapeErrors('arbuturian', { starScale: null });
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
});

// The regression this module exists for. Test Suite run 34003135401 went red on
// a single `"starScale": null`, and the message told the author to pick one of
// 4/5/10/100 — the one thing they must NOT do for an outlet with no star scale.
// Assert the message names the actual remedy, not just that it fires.
test('the starScale: null message tells the author to OMIT the key', () => {
  const [message] = outletFieldShapeErrors('arbuturian', { starScale: null });
  assert.match(message, /OMIT the key/,
    `the null message must name the fix, got: ${message}`);
});

test('a non-null bad starScale does NOT get the omit advice — inventing 7 is a different mistake', () => {
  const [message] = outletFieldShapeErrors('somewhere', { starScale: 7 });
  assert.doesNotMatch(message, /OMIT the key/,
    `only null means "no star scale"; got: ${message}`);
  assert.match(message, /must be one of 4, 5, 10, 100/);
});

test('a string starScale is rejected even when it looks like a legal value', () => {
  const errors = outletFieldShapeErrors('somewhere', { starScale: '5' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /starScale="5"/);
});

test('every legal starScale passes', () => {
  for (const scale of [4, 5, 10, 100]) {
    assert.deepEqual(outletFieldShapeErrors('x', { starScale: scale }), [],
      `starScale ${scale} must be accepted`);
  }
});

test('multiAuthor must be boolean, and both booleans pass', () => {
  assert.deepEqual(outletFieldShapeErrors('x', { multiAuthor: true }), []);
  assert.deepEqual(outletFieldShapeErrors('x', { multiAuthor: false }), []);
  const errors = outletFieldShapeErrors('x', { multiAuthor: 'yes' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be a boolean/);
});

test('both fields wrong reports both, so one fix does not mask the other', () => {
  const errors = outletFieldShapeErrors('x', { starScale: null, multiAuthor: 'yes' });
  assert.equal(errors.length, 2, `expected both, got ${JSON.stringify(errors)}`);
});

test('a non-object entry is skipped rather than throwing', () => {
  assert.deepEqual(outletFieldShapeErrors('x', null), []);
  assert.deepEqual(outletFieldShapeErrors('x', 'not-an-object'), []);
});

// Wiring. Every test above passes just as happily if someone deletes the CALL
// in validate-data.js and leaves the require — v39's defect-11 shape, verified
// by doing exactly that. validate-data.js pins DATA_DIR to __dirname/../data
// with no override, so there is no seam to spawn it against a fixture registry
// without writing to the real one; this reads the source instead. Stated
// plainly so it is not mistaken for a behavioural test: it proves the call site
// exists and that no divergent copy of the rule has grown back beside it, and
// nothing more.
test('validate-data.js actually calls the extracted check (call site, not just the require)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await readFile(path.join(here, '..', 'validate-data.js'), 'utf8');

  assert.match(src, /require\('\.\/lib\/outlet-registry-field-shape'\)/,
    'validate-data.js must require the extracted module');
  assert.match(src, /outletFieldShapeErrors\(/,
    'validate-data.js must CALL outletFieldShapeErrors — a require alone validates nothing');
  assert.doesNotMatch(src, /ALLOWED_STAR_SCALES\s*=\s*new Set/,
    'the allowed-scale set must live only in the extracted module; a second copy here is how the two drift apart');
});
