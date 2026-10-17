// Revival promo: older musicals and missing prior-production pages (BRO-4891).
//
// A read-only audit of the revival line-up (Dreamgirls, The Sound of Music,
// The Full Monty, A Few Good Men, Gloria, Paddington, John Proctor Is the
// Villain) found wrong creative teams, wrong dates, reviews of other
// productions filed under these pages, and genuine reviews dropped. The fixes
// went through data/pending-fixes/bro-4891*.json. This file pins:
//   1. the helpers those fixes rely on (add-show for a prior-production page,
//      the one-word-title gate that would have kept On Your Feet! out of
//      Gloria, the narrow self-syndication clear);
//   2. the corrected state, read from the data present in this checkout.
//      Review-text checks skip when the private texts are absent; checks for a
//      plan's edits skip until that plan's status is "applied".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { applyAddShow } = require(path.join(ROOT, 'scripts/lib/add-show-action.js'));
const { isGenericShowTitle, hasDisambiguator, canDisambiguateGenericTitle } = require(path.join(ROOT, 'scripts/lib/url-discovery.js'));
const { applyReviewFieldEdit, isSelfSyndicationPointer } = require(path.join(ROOT, 'scripts/lib/review-field-edit.js'));

const SHOWS_PATH = path.join(ROOT, 'data/shows.json');
const RT = path.join(ROOT, 'data/review-texts/');
const showsArr = () => {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
};
const hasShows = fs.existsSync(SHOWS_PATH);
const hasTexts = fs.existsSync(path.join(RT, 'paddington-the-musical-west-end-2025'));
const planStatus = (suffix) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pending-fixes', `bro-4891${suffix}.json`), 'utf8')).status;
  } catch { return null; }
};
const readText = (rel) => JSON.parse(fs.readFileSync(path.join(RT, rel), 'utf8'));
const NO_TEXTS = 'private review-texts not present in this checkout';

// ── 1. helpers ────────────────────────────────────────────────────────────

const existing = () => [
  { id: 'dreamgirls-1981', slug: 'dreamgirls-1981', title: 'Dreamgirls', venue: 'Imperial Theatre', openingDate: '1981-12-20', closingDate: '1985-08-11', category: 'broadway' },
  { id: 'dreamgirls-2026', slug: 'dreamgirls-2026', title: 'Dreamgirls', venue: 'TBA', openingDate: null, category: 'broadway' },
];
const savoy = {
  id: 'dreamgirls-west-end-2016', slug: 'dreamgirls-west-end-2016', title: 'Dreamgirls',
  venue: 'Savoy Theatre', status: 'closed', type: 'musical', category: 'west-end', market: 'west-end',
  openingDate: '2016-12-14', closingDate: '2019-01-12',
};

test('add-show accepts a prior-production page and links it from the revival (crossLinkFrom)', () => {
  const shows = existing();
  const res = applyAddShow(shows, { type: 'add-show', show: { ...savoy }, crossLinkFrom: 'dreamgirls-1981' });
  assert.equal(res.ok, true, res.reason);
  const added = shows.find((s) => s.id === savoy.id);
  assert.equal(added.discoverySource, 'manual-user-request', 'stamped provisional for validate-show-venue.js');
  const link = shows.find((s) => s.id === 'dreamgirls-1981').priorRuns.find((r) => r.id === savoy.id);
  assert.equal(link.openingDate, '2016-12-14');
});

test('add-show priorRunOf puts the link on the new entry', () => {
  const shows = existing();
  const res = applyAddShow(shows, { type: 'add-show', show: { ...savoy }, priorRunOf: 'dreamgirls-1981' });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(shows.find((s) => s.id === savoy.id).priorRuns.map((r) => r.id), ['dreamgirls-1981']);
  // A dateless earlier run cannot anchor a priorRuns window.
  const refused = applyAddShow(existing(), { type: 'add-show', show: { ...savoy }, priorRunOf: 'dreamgirls-2026' });
  assert.equal(refused.ok, false);
});

test('add-show refuses a placeholder venue', () => {
  const res = applyAddShow(existing(), { type: 'add-show', show: { ...savoy, venue: 'TBA' } });
  assert.equal(res.ok, false);
  assert.match(res.reason, /placeholder/);
});

test('a one-word title match needs a venue or people disambiguator (Gloria vs On Your Feet!)', () => {
  const gloria = { id: 'gloria-2026', title: 'Gloria', year: '2027', openingDate: '2027-04-05', venue: 'Hayes Theater', creativeNames: ['Branden Jacobs-Jenkins', 'Evan Cabnet'] };
  assert.equal(isGenericShowTitle('Gloria'), true);
  assert.equal(canDisambiguateGenericTitle(gloria), true);
  assert.equal(hasDisambiguator('review: on your feet! gloria estefan musical at the marquis theatre', gloria), false);
  // A year alone is not enough: a wrong show dated the same year passes it.
  assert.equal(hasDisambiguator('gloria review 2027', gloria), false);
  assert.equal(hasDisambiguator('gloria review hayes theater', gloria), true);
  assert.equal(hasDisambiguator('gloria review branden jacobs-jenkins', gloria), true);
});

test('isSyndicatedDuplicate may be cleared only when it points at the same file', () => {
  const stamp = { fixId: 'test', at: '2026-10-14T00:00:00Z' };
  const ctx = { folder: 'three-days-of-rain-2006', file: 'nytimes--ben-brantley.json' };
  const selfRec = { isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'three-days-of-rain-2006/nytimes--ben-brantley.json' };
  assert.equal(isSelfSyndicationPointer(selfRec, ctx), true);
  const ok = applyReviewFieldEdit(selfRec, { field: 'isSyndicatedDuplicate', oldValue: true, newValue: false }, stamp, ctx);
  assert.equal(ok.ok, true, ok.reason);
  const ptr = applyReviewFieldEdit(selfRec, { field: 'syndicatedPrimaryFile', oldValue: selfRec.syndicatedPrimaryFile, newValue: null }, stamp, ctx);
  assert.equal(ptr.ok, true, ptr.reason);

  const realCopy = { isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'three-days-of-rain-2006/variety--ben-brantley.json' };
  assert.equal(applyReviewFieldEdit(realCopy, { field: 'isSyndicatedDuplicate', oldValue: true, newValue: false }, stamp, ctx).ok, false);
  assert.equal(applyReviewFieldEdit(realCopy, { field: 'syndicatedPrimaryFile', oldValue: realCopy.syndicatedPrimaryFile, newValue: null }, stamp, ctx).ok, false);
  // Never sets the flag, and never without the on-disk path.
  assert.equal(applyReviewFieldEdit({}, { field: 'isSyndicatedDuplicate', oldValue: null, newValue: true }, stamp, ctx).ok, false);
  assert.equal(applyReviewFieldEdit(selfRec, { field: 'isSyndicatedDuplicate', oldValue: true, newValue: false }, stamp, {}).ok, false);
});

// ── 2. corrected state ────────────────────────────────────────────────────

test('revival creative teams name the new directors, not earlier productions\'', { skip: !hasShows && 'data/shows.json absent' }, () => {
  const byId = new Map(showsArr().map((s) => [s.id, s]));
  const names = (id) => (byId.get(id)?.creativeTeam || []).map((c) => c.name);
  assert.ok(names('a-few-good-men-2026').includes('Michael Arden'));
  assert.ok(!names('a-few-good-men-2026').includes('David Esbjornson'));
  assert.ok(names('the-sound-of-music-2027').includes('Lear deBessonet'));
  assert.ok(!names('the-sound-of-music-2027').includes('Susan H. Schulman'));
  assert.equal(byId.get('paddington-the-musical-west-end-2025').openingDate, '2025-11-30');
  assert.equal(byId.get('john-proctor-is-the-villain-west-end-2027').openingDate, '2027-02-11');
});

test('the Dreamgirls revival does not carry the 1981 cast', { skip: (!hasShows && 'data/shows.json absent') || (planStatus('-f') !== 'applied' && 'bro-4891-f not applied yet') }, () => {
  const byId = new Map(showsArr().map((s) => [s.id, s]));
  const orig = new Set((byId.get('dreamgirls-1981').cast || []).map((c) => c.name));
  const shared = (byId.get('dreamgirls-2026').cast || []).filter((c) => orig.has(c.name));
  assert.deepEqual(shared, []);
});

test('Gloria holds no On Your Feet! reviews', { skip: !hasTexts && NO_TEXTS }, () => {
  const dir = path.join(RT, 'gloria-2026');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    const t = readText(`gloria-2026/${f}`);
    assert.doesNotMatch(`${t.url || ''} ${(t.fullText || '').slice(0, 2000)}`, /on your feet|estefan/i, f);
  }
});

test('genuine reviews cleared by bro-4891-b/-d stay cleared', { skip: !hasTexts && NO_TEXTS }, () => {
  for (const rel of [
    'paddington-the-musical-west-end-2025/theatermania--alex-wood.json',
    'john-proctor-is-the-villain-west-end-2026/timeout-london--andrzej-lukowski.json',
    'john-proctor-is-the-villain-west-end-2026/indiependent--lucy-curtis.json',
    'john-proctor-is-the-villain-west-end-2026/new-statesman--emily-lawford.json',
    'john-proctor-is-the-villain-west-end-2026/theupcoming--unknown.json',
  ]) {
    assert.notEqual(readText(rel).wrongProduction, true, rel);
  }
  const ap = readText('dreamgirls-1981/nydailynews--douglas-watt.json');
  assert.equal(ap.criticName, 'Mary Campbell');
  assert.ok(ap.humanReviewScore >= 91, 'AP rave stays in the rave band');
});

test('bro-4891-f: no self-pointing syndication flag, no Benjamin Button under John Proctor', { skip: (!hasTexts && NO_TEXTS) || (planStatus('-f') !== 'applied' && 'bro-4891-f not applied yet') }, () => {
  for (const rel of [
    'paddington-the-musical-west-end-2025/daily-mail--patrick-marmion.json',
    'three-days-of-rain-2006/nytimes--ben-brantley.json',
    'gutenberg-2023/chicagotribune--chris-jones.json',
    'man-and-boy-2011/bloomberg--jeremy-gerard.json',
  ]) {
    const [folder, file] = rel.split('/');
    const t = readText(rel);
    assert.ok(!(t.isSyndicatedDuplicate === true && isSelfSyndicationPointer(t, { folder, file })), rel);
  }
  assert.equal(readText('paddington-the-musical-west-end-2025/daily-mail--robert-gore-langton.json').duplicateOf, 'daily-mail--patrick-marmion.json');
  const jp = path.join(RT, 'john-proctor-is-the-villain-west-end-2026');
  for (const f of fs.readdirSync(jp).filter((x) => x.endsWith('.json'))) {
    assert.doesNotMatch(readText(`john-proctor-is-the-villain-west-end-2026/${f}`).url || '', /benjamin-button/i, f);
  }
});
