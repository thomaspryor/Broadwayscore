// Parser test for newyorktheater.me's monthly "New York Theater Openings"
// post (scripts/lib/reverse-discovery.js extractOpeningsFromNytheaterPost).
// Per feedback_test_extraction_pattern.md: require the real lib, don't
// reimplement the parser in the test. Card #997 (OB discovery S1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractOpeningsFromNytheaterPost, nytheaterOpeningsTagSignature } = require('../../scripts/lib/reverse-discovery.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'ob-discovery');

// Captured live 2026-08-04 via the WP REST API:
// newyorktheater.me/wp-json/wp/v2/posts?slug=august-2026-new-york-theater-openings
const REAL_HTML = readFileSync(join(FIXTURE_DIR, 'nytheater-openings-aug2026.html'), 'utf8');
const REAL_POST = { date: '2026-08-02T15:32:09', content: { rendered: REAL_HTML } };

// Hand-mutated: one entry's venue parenthetical moves from plain text right
// after the title link into a nested <em> tag (a realistic Gutenberg
// inline-formatting change), and another entry's whole paragraph is
// restructured into a <ul><li> list block instead of <p class="wp-block-paragraph">.
const DRIFT_HTML = readFileSync(join(FIXTURE_DIR, 'nytheater-openings-drift.html'), 'utf8');

test('extractOpeningsFromNytheaterPost: real Aug 2026 fixture yields >=14 entries, all with venue', () => {
  const entries = extractOpeningsFromNytheaterPost(REAL_POST);
  assert.ok(entries.length >= 14, `expected >=14 entries, got ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.title && e.title.length >= 2, `entry has title: ${JSON.stringify(e)}`);
    assert.ok(e.venue && e.venue.length >= 2, `entry has non-empty venue: ${JSON.stringify(e)}`);
    assert.ok(e.url, `entry has url: ${JSON.stringify(e)}`);
    assert.match(e.date, /^2026-08-\d{2}$/, `entry date resolves into August 2026: ${JSON.stringify(e)}`);
  }
  // Spot-check a couple of real entries survive verbatim.
  assert.ok(entries.some(e => e.title === 'The Vessel' && e.venue === 'Tollbooth Co at 59e59'));
  assert.ok(entries.some(e => e.title === 'The Real Ivanov' && e.venue === 'at CSC Theater'));
});

test('extractOpeningsFromNytheaterPost: Gutenberg drift fixture (nested-tag venue) throws', () => {
  assert.throws(
    () => extractOpeningsFromNytheaterPost({ date: '2026-08-02', content: { rendered: DRIFT_HTML } }),
    /venue likely moved into a nested tag/
  );
});

test('extractOpeningsFromNytheaterPost: no date headers -> empty, no throw', () => {
  assert.deepEqual(extractOpeningsFromNytheaterPost({ date: '2026-08-02', content: { rendered: '<p>no headers here</p>' } }), []);
  assert.deepEqual(extractOpeningsFromNytheaterPost({}), []);
  assert.deepEqual(extractOpeningsFromNytheaterPost(null), []);
});

test('extractOpeningsFromNytheaterPost: date headers with zero parseable entries throws', () => {
  const html = '<h2>August 2</h2><p class="wp-block-paragraph">No link here, just prose about the month ahead.</p>';
  assert.throws(
    () => extractOpeningsFromNytheaterPost({ date: '2026-08-02', content: { rendered: html } }),
    /0 show entries parsed/
  );
});

test('nytheaterOpeningsTagSignature: pinned against real fixture, drift fixture differs', () => {
  const realSig = nytheaterOpeningsTagSignature(REAL_HTML);
  assert.equal(realSig, 'h2:15|p:27|a:20|li:0');
  const driftSig = nytheaterOpeningsTagSignature(DRIFT_HTML);
  assert.notEqual(driftSig, realSig);
  assert.match(driftSig, /li:[1-9]/, 'drift fixture introduces a <li> the real post never has');
});
