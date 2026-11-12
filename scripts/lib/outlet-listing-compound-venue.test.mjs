// BRO-7372: Exeunt's review of "the ripple, the wave that carried me home" (Nov 10 2026) was
// dropped by the page check. The show had no cast or director on file, so its venue was the
// only credit, and shows.json spells that venue "Playwrights Horizons/Judith O. Rubin Theater"
// while the page says "at Playwrights Horizons". The whole-string match could never be true,
// for any credit-less show whose venue carries a stage ("House/Stage", "House - Main Theatre").
// require()s the real matcher (CLAUDE.md §15). Titles and venues copied from shows.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('./outlet-listing-helpers.js');
const NOW = Date.parse('2026-11-10T12:00:00Z');

const ripple = {
  id: 'the-ripple-the-wave-that-carried-me-home-off-broadway-2026',
  title: 'the ripple, the wave that carried me home',
  venue: 'Playwrights Horizons/Judith O. Rubin Theater',
  status: 'previews', previewsStartDate: '2026-10-21', openingDate: '2026-11-18',
  cast: [], creativeTeam: [],
};
// Another Playwrights Horizons show on the other stage.
const sibling = {
  id: 'other-play-off-broadway-2026', title: 'Other Play',
  venue: 'Playwrights Horizons/Peter Jay Sharp Theater',
  status: 'open', cast: [], creativeTeam: [],
};
// An article body: title, then the house, with nothing else of the show's on file to match.
const page = (body) => ` Review: the ripple, the wave that carried me home at Playwrights Horizons. ${body} `;

test('a credit-less show with a House/Stage venue is confirmed by the house name on the page', () => {
  const text = page('Christina Anderson’s play, at Playwrights Horizons through Nov. 29, hums.');
  assert.equal(helpers.pageConfirmsShow(text, ripple, { nowMs: NOW, otherShows: [ripple] }), true);
});

test('the stage name alone confirms too', () => {
  const text = 'the ripple, the wave that carried me home plays the Judith O. Rubin Theater.';
  assert.equal(helpers.pageConfirmsShow(text, ripple, { nowMs: NOW, otherShows: [ripple, sibling] }), true);
});

test('when another running show shares the house, the house name no longer confirms', () => {
  const text = page('A fine night at Playwrights Horizons.');
  assert.equal(helpers.pageConfirmsShow(text, ripple, { nowMs: NOW, otherShows: [ripple, sibling] }), false);
});

test('a page that names the title but neither the house nor a credit stays unconfirmed', () => {
  const text = 'the ripple, the wave that carried me home was staged at the Goodman in 2023.';
  assert.equal(helpers.pageConfirmsShow(text, ripple, { nowMs: NOW, otherShows: [ripple] }), false);
});

test('a show with usable credits still needs a credit, not the venue', () => {
  const withCast = { ...ripple, cast: [{ name: 'Crystal Lucas-Perry', role: 'Helen' }] };
  assert.equal(helpers.pageConfirmsShow(page('A night at Playwrights Horizons.'), withCast, { nowMs: NOW, otherShows: [withCast] }), false);
  assert.equal(helpers.pageConfirmsShow(page('Crystal Lucas-Perry anchors it.'), withCast, { nowMs: NOW, otherShows: [withCast] }), true);
});

test('venueForms: house and stage forms are added, generic suffixes and one-word names are not', () => {
  assert.deepEqual(helpers.venueForms(ripple), ['playwrights horizons judith o rubin theater', 'playwrights horizons', 'judith o rubin theater']);
  assert.deepEqual(helpers.venueForms({ venue: 'The Other Palace - Main Theatre' }), ['other palace main theatre', 'other palace']);
  assert.deepEqual(helpers.venueForms({ venue: 'Soho Playhouse Main Stage' }), ['soho playhouse main stage']);
  assert.deepEqual(helpers.venueForms({ venue: 'Public/Main Stage' }), ['public main stage']);
  assert.deepEqual(helpers.venueForms({ venue: 'JACK' }), ['jack']);
  assert.deepEqual(helpers.venueForms({ venue: 'TBD' }), []);
  assert.deepEqual(helpers.venueForms({ venue: '' }), []);
});

test('feed-item path: a short-title show at a House/Stage venue matches on the house, once', () => {
  const soon = { id: 'soon-off-broadway-2026', title: 'Soon', venue: 'Foo Playhouse/Black Box Theater', status: 'open', cast: [], creativeTeam: [] };
  const rival = { id: 'hamlet-off-broadway-2026', title: 'Hamlet', venue: 'Foo Playhouse/Main Stage Theater', status: 'open', cast: [], creativeTeam: [] };
  const find = (h, u, shows) => helpers.findMatchingShows(h, u, shows, '', { nowMs: NOW });
  assert.deepEqual(find('Review: Soon at Foo Playhouse', 'review-soon-foo-playhouse', [soon]).map((s) => s.id), [soon.id]);
  // Hamlet matched on its own title at the same house: the house credit on Soon is void.
  assert.deepEqual(find('Review: Hamlet at Foo Playhouse, soon', 'review-hamlet-foo-playhouse-soon', [soon, rival]).map((s) => s.id), [rival.id]);
});

// Reviewer blockers (BRO-7372): a comma venue keeps its city, and the rival check is by whole words.
test('a comma venue keeps its city: another city\'s house of the same name does not confirm', () => {
  const mdq = { id: 'mdq-regional-2026', title: 'Million Dollar Quartet', venue: 'Paramount Theatre, Aurora, IL', status: 'open', cast: [], creativeTeam: [] };
  assert.deepEqual(helpers.venueForms(mdq), ['paramount theatre aurora il']);
  const seattle = 'Million Dollar Quartet review: the musical rocks the Paramount Theatre in Seattle.';
  assert.equal(helpers.pageConfirmsShow(seattle, mdq, { nowMs: NOW, otherShows: [mdq] }), false);
  const aurora = 'Million Dollar Quartet review: the musical rocks the Paramount Theatre, Aurora, IL.';
  assert.equal(helpers.pageConfirmsShow(aurora, mdq, { nowMs: NOW, otherShows: [mdq] }), true);
});

test('a rival whose house name contains ours as whole words voids the shorter form', () => {
  const sigArl = { id: 'sig-arlington-2026', title: 'All the world\'s a stage', venue: 'Signature Theatre/Max Theatre', status: 'open', cast: [], creativeTeam: [] };
  const sigNyc = { id: 'sig-nyc-2026', title: 'Other Play', venue: 'Signature Theatre Company/Pershing Square', status: 'open', cast: [], creativeTeam: [] };
  const page2 = 'All the world\'s a stage, a note on Signature Theatre Company this season.';
  assert.equal(helpers.pageConfirmsShow(page2, sigArl, { nowMs: NOW, otherShows: [sigArl, sigNyc] }), false);
  // The feed path's sibling check agrees: Other Play matched by its title voids the house credit on the other show.
  const find = (h, u, shows) => helpers.findMatchingShows(h, u, shows, '', { nowMs: NOW });
  const soonArl = { ...sigArl, id: 'soon-arl-2026', title: 'Soon' };
  const other = { ...sigNyc, title: 'Zebra Garden' };
  assert.deepEqual(find('Review: Soon at Signature Theatre', 'review-soon-signature-theatre', [soonArl]).map((x) => x.id), [soonArl.id]);
  assert.deepEqual(find('Review: Zebra Garden, Soon at Signature Theatre', 'review-zebra-garden-soon', [soonArl, other]).map((x) => x.id), [other.id]);
});

// Ship-check blockers (BRO-7372): a comma venue never gets house forms, even with a bracket or
// dash before the comma, and a slash inside a name must not yield a place-only form.
test('comma venues with a bracket or dash keep the city: no extra forms, no Manhattan false positive', () => {
  const arl = { id: 'arl-2026', title: 'Million Dollar Quartet', venue: 'Signature Theatre (The MAX), Arlington, VA', status: 'open', cast: [], creativeTeam: [] };
  assert.equal(helpers.venueForms(arl).length, 1);
  assert.equal(helpers.pageConfirmsShow('Million Dollar Quartet at Signature Theatre in Manhattan', arl, { nowMs: NOW, otherShows: [arl] }), false);
  for (const venue of ['Victory Gardens Theater - Biograph, Chicago, IL', 'The Old Globe (Donald and Darlene Shiley Stage), San Diego, CA']) {
    assert.equal(helpers.venueForms({ venue }).length, 1, venue);
  }
});

test('a slash inside a house name does not make a place-only form ("new york theatres")', () => {
  const morbs = { id: 'the-morbs-2026', title: 'The Morbs', venue: 'Jeffrey and Paula Gural Theatre at A.R.T./New York Theatres', status: 'open', cast: [], creativeTeam: [] };
  assert.ok(!helpers.venueForms(morbs).includes('new york theatres'));
  assert.ok(!helpers.venueForms(morbs).includes('a r t'));
  assert.equal(helpers.pageConfirmsShow('Review: The Morbs heads to New York theatres after its London run.', morbs, { nowMs: NOW, otherShows: [morbs] }), false);
  assert.ok(helpers.venueForms({ venue: 'Jeffrey and Paula Gural Theatre (A.R.T./New York Theatres)' }).every((f) => !f.includes(')')));
});

// Class guard: no venue in shows.json yields an extra form that is only generic or place words, and a
// comma venue yields none. Fails if the filters in venueForms regress.
test('class: no show venue in shows.json yields a generic or city-less extra form', (t) => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'shows.json');
  if (!fs.existsSync(file)) return t.skip('data/shows.json not present (private data)');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shows = Array.isArray(j) ? j : j.shows;
  const bad = [];
  for (const v of new Set(shows.map((x) => String(x.venue || '')).filter(Boolean))) {
    const forms = helpers.venueForms({ venue: v });
    if (v.includes(',') && forms.length > 1) bad.push(`comma venue with extra forms: ${v}`);
    for (const f of forms.slice(1)) {
      const words = f.split(/\s+/);
      if (words.length < 2 || /[()]/.test(f) || words.every((w) => w.length < 2 || ['new', 'york', 'london', 'theatres', 'theaters', 'theatre', 'theater', 'stage', 'main'].includes(w))) bad.push(`${v} -> ${f}`);
    }
  }
  assert.deepEqual(bad, []);
});

// Class guard: every show the poller must be able to confirm from a page with no credits on
// file has a venue form a page can carry. Fails if venueForms regresses to the whole string.
test('class: every credit-less show with a House/Stage venue in shows.json yields a house form', (t) => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'shows.json');
  if (!fs.existsSync(file)) return t.skip('data/shows.json not present (private data)');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shows = Array.isArray(j) ? j : j.shows;
  const compound = shows.filter((s) => /\//.test(String(s.venue || '')) && !(s.cast && s.cast.length) && s.status !== 'closed');
  const bad = compound.filter((s) => helpers.venueForms(s).length < 2 && String(s.venue).split('/')[0].trim().split(/\s+/).length >= 2);
  assert.deepEqual(bad.map((s) => `${s.id} | ${s.venue}`), []);
});

// The 7-day "did not confirm" cache must not outlive the rules that produced it: the ripple
// page stayed cached as unconfirmed after the fix, hiding it until the TTL ran out.
test('the unconfirmed cache is dropped when the confirmation rules change, or carry no stamp', async () => {
  const os = await import('node:os');
  const poller = require('../outlet-listing-poller.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unconfirmed-'));
  const file = path.join(dir, 'cache.json');
  const key = 'https://exeuntnyc.com/reviews/x|show-a';
  const at = new Date(NOW - 3600e3).toISOString();
  const write = (j) => fs.writeFileSync(file, JSON.stringify(j));
  const logic = helpers.confirmLogicFingerprint();
  assert.match(logic, /^[0-9a-f]{12}$/);
  write({ logic, entries: { [key]: at } });
  assert.deepEqual(Object.keys(poller.loadUnconfirmedCache(file, NOW)), [key]);
  write({ logic: 'old-rules', entries: { [key]: at } });
  assert.deepEqual(poller.loadUnconfirmedCache(file, NOW), {});
  write({ entries: { [key]: at } }); // legacy file, written before the stamp existed
  assert.deepEqual(poller.loadUnconfirmedCache(file, NOW), {});
  fs.rmSync(dir, { recursive: true });
});
