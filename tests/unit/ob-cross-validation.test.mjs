import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCandidateConfirmed, preferCorroboratingTitle } = require('../../scripts/lib/ob-cross-validation.js');

const PLAYBILL = [
  { title: 'Indian Princesses', firstPreview: '2026-04-30', opening: '2026-05-19' },
  { title: 'The Reservoir', firstPreview: '2026-02-05', opening: null },
  { title: '||: GIRLS :||: CHANCE :||: MUSIC :||', firstPreview: '2026-05-12', opening: '2026-05-28' },
];

const LORTEL = [
  { title: 'Birthright', firstPreview: '2026-06-10', openingNight: '2026-06-24' },
];

test('isCandidateConfirmed: matches via Playbill', () => {
  const r = isCandidateConfirmed(
    { title: 'Indian Princesses', venue: 'Atlantic Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL }
  );
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'playbill');
});

test('isCandidateConfirmed: matches via Lortel when Playbill misses', () => {
  const r = isCandidateConfirmed(
    { title: 'Birthright', venue: 'MCC Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL }
  );
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'lortel');
});

test('isCandidateConfirmed: rejects gala/benefit phantom that neither source has', () => {
  const r = isCandidateConfirmed(
    { title: 'Spring Gala 2026', venue: 'Atlantic Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL }
  );
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /no Playbill\/Lortel match/);
});

test('isCandidateConfirmed: normalizes punctuation (||: GIRLS :|| variants)', () => {
  // Subagent extracted "Girls Chance Music" from Vineyard; Playbill stores
  // the full "||: GIRLS :||: CHANCE :||: MUSIC :||" — normalizeTitle should
  // collapse both to the same token bag.
  const r = isCandidateConfirmed(
    { title: 'Girls Chance Music', venue: 'Vineyard Theatre' },
    { playbillEntries: PLAYBILL, lortelEntries: [] }
  );
  assert.equal(r.confirmed, true, `expected confirmed; got: ${JSON.stringify(r)}`);
});

test('isCandidateConfirmed: empty sources returns not-confirmed', () => {
  const r = isCandidateConfirmed(
    { title: 'X' },
    { playbillEntries: [], lortelEntries: [] }
  );
  assert.equal(r.confirmed, false);
});

test('isCandidateConfirmed: missing title returns not-confirmed', () => {
  const r = isCandidateConfirmed({}, { playbillEntries: PLAYBILL });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /missing title/);
});

// BRO-3920 — matchedTitle lets a caller prefer the curated Playbill/Lortel
// casing over a venue page's, which can be shouted even in its own
// structured metadata (verified against signaturetheatre.org: JSON-LD,
// og:title, <title> and the WP REST API's title.rendered are ALL "MILES FOR
// MARY" — no client-side scraping fix recovers the true casing there, only
// a second corroborating source can).
test('isCandidateConfirmed: exact match surfaces the Playbill title as matchedTitle', () => {
  const r = isCandidateConfirmed(
    { title: 'INDIAN PRINCESSES', venue: 'Atlantic Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL },
  );
  assert.equal(r.confirmed, true);
  assert.equal(r.matchedTitle, 'Indian Princesses');
});

test('isCandidateConfirmed: exact match surfaces the Lortel title as matchedTitle', () => {
  const r = isCandidateConfirmed(
    { title: 'BIRTHRIGHT', venue: 'MCC Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL },
  );
  assert.equal(r.confirmed, true);
  assert.equal(r.matchedTitle, 'Birthright');
});

test('isCandidateConfirmed: a fuzzy jaccard match confirms but does NOT surface matchedTitle', () => {
  // 0.6 jaccard is similar-enough-to-corroborate-existence, not
  // similar-enough-to-safely-rename ("LOVE LOSS HOPE LAUGHTER" vs "Love
  // Loss Hope" both clear 0.6 but are different shows) — see
  // preferCorroboratingTitle's docstring.
  const r = isCandidateConfirmed(
    { title: 'Girls Chance Music', venue: 'Vineyard Theatre' },
    { playbillEntries: PLAYBILL, lortelEntries: [] },
  );
  assert.equal(r.confirmed, true);
  assert.equal(r.matchedTitle, undefined);
});

test('isCandidateConfirmed: no match means matchedTitle is absent', () => {
  const r = isCandidateConfirmed(
    { title: 'Spring Gala 2026', venue: 'Atlantic Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL },
  );
  assert.equal(r.confirmed, false);
  assert.equal(r.matchedTitle, undefined);
});

// preferCorroboratingTitle — the actual title-swap decision, extracted out
// of the promotion loop so it has coverage independent of that loop.
test('preferCorroboratingTitle: swaps a shouted venue title for a clean corroborating one', () => {
  const r = preferCorroboratingTitle('MILES FOR MARY', 'Miles for Mary');
  assert.equal(r.title, 'Miles for Mary');
  assert.equal(r.swapped, true);
});

test('preferCorroboratingTitle: leaves a clean venue title alone even if a corroborating title exists', () => {
  const r = preferCorroboratingTitle('Miles for Mary', 'Miles for Mary');
  assert.equal(r.title, 'Miles for Mary');
  assert.equal(r.swapped, false);
});

test('preferCorroboratingTitle: never swaps when BOTH sources are shouted — no evidence which is right', () => {
  const r = preferCorroboratingTitle('MILES FOR MARY', 'MILES FOR MARY');
  assert.equal(r.title, 'MILES FOR MARY');
  assert.equal(r.swapped, false);
});

test('preferCorroboratingTitle: no corroborating title means no swap', () => {
  const r = preferCorroboratingTitle('MILES FOR MARY', undefined);
  assert.equal(r.title, 'MILES FOR MARY');
  assert.equal(r.swapped, false);
});

test('preferCorroboratingTitle: never overrides a verified KEEP_SHOUTED exemption', () => {
  // "THIS IS NOT ABOUT ME." is a verified-correct exemption (Soho Theatre's
  // own <title> tag). A corroborating listing's own casing must not
  // silently override work that already checked the real source.
  const r = preferCorroboratingTitle('THIS IS NOT ABOUT ME.', 'This is not about me');
  assert.equal(r.title, 'THIS IS NOT ABOUT ME.');
  assert.equal(r.swapped, false);
});
