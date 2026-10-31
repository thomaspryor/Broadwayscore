// Regional→Broadway transfer auto-detection (2026-07-11). Tests the REAL
// exported function per CLAUDE.md §15.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectTransferPairs } = require('../../scripts/lib/transfer-detection.js');

const REGIONAL = { id: 'fakeshow-regional-2024', title: 'Fakeshow', category: 'regional', openingDate: '2024-06-01' };

test('exact-title Broadway show opening after the tryout is paired', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01' },
  ]);
  assert.deepEqual(pairs.map(p => [p.regionalId, p.broadwayId]), [['fakeshow-regional-2024', 'fakeshow-2025']]);
});

test('default-category (undefined) counts as Broadway', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'fakeshow-2025');
});

test('date direction: a regional revival of an OLD Broadway title is never linked backwards', () => {
  const pairs = detectTransferPairs([
    { id: 'rent-regional-2026', title: 'Rent', category: 'regional', openingDate: '2026-05-01' },
    { id: 'rent-1996', title: 'Rent', category: 'broadway', openingDate: '1996-04-29' },
  ]);
  assert.equal(pairs.length, 0, 'Broadway opening predates the regional run — not a transfer');
});

test('title variants pair via jaccard ("Fakeshow: The Musical")', () => {
  const pairs = detectTransferPairs([
    { ...REGIONAL, title: 'Fakeshow: The Musical' },
    { id: 'fakeshow-2025', title: 'Fakeshow The Musical', category: 'broadway', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'fakeshow-2025');
});

test('ambiguity (two post-dating Broadway matches) is reported, not applied', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01' },
    { id: 'fakeshow-2026', title: 'Fakeshow', category: 'broadway', openingDate: '2026-03-01' },
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].broadwayId, null);
  assert.match(pairs[0].reason, /ambiguous/);
});

test('already-linked shows are skipped on both sides', () => {
  const linked = detectTransferPairs([
    { ...REGIONAL, transferredTo: 'fakeshow-2025' },
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01', transferOf: 'fakeshow-regional-2024' },
  ]);
  assert.equal(linked.length, 0);
});

test('previews-only Broadway show (no openingDate yet) still pairs via previewsStartDate', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: null, previewsStartDate: '2025-09-15' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'fakeshow-2025');
});

test('non-Broadway categories (west-end, off-broadway) never pair', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-we-2025', title: 'Fakeshow', category: 'west-end', openingDate: '2025-10-01' },
    { id: 'fakeshow-ob-2025', title: 'Fakeshow', category: 'off-broadway', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs.length, 0);
});

test('regional show without any date anchor is skipped (direction check impossible)', () => {
  const pairs = detectTransferPairs([
    { id: 'x-regional-2024', title: 'Fakeshow', category: 'regional', openingDate: null, previewsStartDate: null },
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs.length, 0);
});

test('real-world regression: the LBRR pair would have been auto-detected', () => {
  const pairs = detectTransferPairs([
    { id: 'little-bear-ridge-road-regional-2024', title: 'Little Bear Ridge Road', category: 'regional', openingDate: '2024-06-24' },
    { id: 'little-bear-ridge-road-2025', title: 'Little Bear Ridge Road', category: 'broadway', openingDate: '2025-10-30' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'little-bear-ridge-road-2025');
});

// ── BRO-4204 S5-T5: London transfers / return engagements ─────────────────
// Same-title London rows at different venues within 120 days of the earlier
// row's close. Emits a priorRuns[].id-style suggestion for the LATER row —
// never transferOf/transferredTo, which validate-data reserves for regional
// tryouts. The Pride fixtures are the real rows (priorRuns left off so the
// detector has to find the pair itself).
const { detectLondonTransferPairs, LONDON_TRANSFER_WINDOW_DAYS } = require('../../scripts/lib/transfer-detection.js');

const prideDorfman = {
  id: 'pride-west-end-2026', title: 'Pride', category: 'west-end', venue: 'Dorfman Theatre', status: 'closed',
  previewsStartDate: '2026-06-11', openingDate: '2026-06-25', closingDate: '2026-09-12',
};
const prideBridge = {
  id: 'pride-bridge-theatre-off-west-end-2026', title: 'Pride - Bridge Theatre', category: 'off-west-end', venue: 'Bridge Theatre', status: 'upcoming',
  previewsStartDate: '2026-11-12', openingDate: null, closingDate: null,
};
const prideCelebration = {
  id: 'pride-a-creative-celebration-off-west-end-2026', title: 'Pride A Creative Celebration', category: 'off-west-end', venue: 'Southwark Playhouse', status: 'announced',
  previewsStartDate: null, openingDate: null, closingDate: null,
};

test('London: the Pride pair (Dorfman closed 2026-09-12 → Bridge upcoming 2026-11-12) is detected with a priorRuns[].id suggestion for the later row', () => {
  const pairs = detectLondonTransferPairs([prideDorfman, prideBridge, prideCelebration]);
  assert.equal(pairs.length, 1, JSON.stringify(pairs));
  const [pair] = pairs;
  assert.equal(pair.earlierId, 'pride-west-end-2026');
  assert.equal(pair.laterId, 'pride-bridge-theatre-off-west-end-2026');
  assert.deepEqual(pair.suggestedPriorRun, { id: 'pride-west-end-2026', venue: 'Dorfman Theatre', openingDate: '2026-06-25', closingDate: '2026-09-12' });
  assert.match(pair.reason, /starts 61d after pride-west-end-2026 closed/);
  assert.equal('transferOf' in pair, false, 'never a transferOf/transferredTo suggestion');
  assert.equal('regionalId' in pair, false, 'not the regional pair shape');
});

test('London: idempotent — a later row whose priorRuns already names the earlier id (or a declared transfer link) is skipped', () => {
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, priorRuns: [{ id: 'pride-west-end-2026', venue: 'Dorfman Theatre', openingDate: '2026-06-25', closingDate: '2026-09-12' }] }]), []);
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, priorRuns: ['pride-west-end-2026'] }]), []);
  assert.deepEqual(detectLondonTransferPairs([{ ...prideDorfman, transferredTo: prideBridge.id }, prideBridge]), []);
  // A dates-only priorRuns entry names no row, so the suggestion still fires.
  assert.equal(detectLondonTransferPairs([prideDorfman, { ...prideBridge, priorRuns: [{ venue: 'Dorfman Theatre', openingDate: '2026-06-25', closingDate: '2026-09-12' }] }]).length, 1);
});

test('London: a start more than 120 days after the close is a revival, not a transfer; a start before or on the close is never linked', () => {
  assert.equal(LONDON_TRANSFER_WINDOW_DAYS, 120);
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, previewsStartDate: '2027-01-11' }]), [], '121 days');
  assert.equal(detectLondonTransferPairs([prideDorfman, { ...prideBridge, previewsStartDate: '2027-01-10' }]).length, 1, '120 days is inside the window');
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, previewsStartDate: '2026-09-12' }]), [], 'same day as the close');
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, previewsStartDate: '2026-08-01' }]), [], 'overlapping run');
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, previewsStartDate: null }]), [], 'no start anchor');
});

test('London: same venue (aliases included) or a missing venue is not a transfer pair', () => {
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, venue: 'Dorfman Theatre' }]), []);
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, venue: 'The Dorfman Theatre' }]), [], 'leading article is the same house');
  assert.deepEqual(detectLondonTransferPairs([prideDorfman, { ...prideBridge, venue: null }]), []);
});

test('London: NYC rows are ignored — the off-Broadway Lost in Del Valle return is the S5-T1 dedup rule\'s job, not this detector\'s', () => {
  const spring = { id: 'lost-in-del-valle-off-broadway-2026', title: 'Lost in Del Valle', category: 'off-broadway', venue: 'SoHo Playhouse', status: 'closed', openingDate: '2026-04-09', closingDate: '2026-05-03' };
  const ret = { id: 'lost-in-del-valle-return-off-broadway-2026', title: 'Lost in Del Valle', category: 'off-broadway', venue: 'Rattlestick Theater', status: 'open', previewsStartDate: '2026-09-14' };
  assert.deepEqual(detectLondonTransferPairs([spring, ret]), []);
  assert.deepEqual(detectLondonTransferPairs([spring, { ...ret, category: 'broadway' }]), []);
});

test('London: two earlier rows closing inside the window before one later row is reported as ambiguous, never suggested', () => {
  const secondEarlier = { ...prideDorfman, id: 'pride-hampstead-off-west-end-2026', category: 'off-west-end', venue: 'Hampstead Theatre', closingDate: '2026-10-01' };
  const pairs = detectLondonTransferPairs([prideDorfman, secondEarlier, prideBridge]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].earlierId, null);
  assert.equal(pairs[0].laterId, prideBridge.id);
  assert.equal(pairs[0].suggestedPriorRun, null);
  assert.match(pairs[0].reason, /ambiguous: pride-west-end-2026, pride-hampstead-off-west-end-2026/);
});

test('London: the regional detector is untouched by London rows', () => {
  assert.deepEqual(detectTransferPairs([prideDorfman, prideBridge, prideCelebration]), []);
});

test('London: the Into the Woods (Bridge → Noël Coward, 115d) and Arcadia (Old Vic → Duke of York\'s, 91d) transfers are detected too', () => {
  const rows = [
    { id: 'into-the-woods-west-end-2025', title: 'Into the Woods', category: 'off-west-end', venue: 'Bridge Theatre', status: 'closed', openingDate: '2025-12-11', closingDate: '2026-05-30' },
    { id: 'into-the-woods-noel-coward-west-end-2026', title: 'Into the Woods', category: 'west-end', venue: 'Noël Coward Theatre', status: 'previews', previewsStartDate: '2026-09-22', openingDate: '2026-10-07' },
    { id: 'arcadia-west-end-2026', title: 'Arcadia', category: 'west-end', venue: 'The Old Vic', status: 'closed', openingDate: '2026-02-04', closingDate: '2026-03-21' },
    { id: 'arcadia-duke-of-yorks-west-end-2026', title: 'Arcadia', category: 'west-end', venue: "Duke of York's Theatre", status: 'closed', previewsStartDate: '2026-06-20', openingDate: '2026-07-01', closingDate: '2026-09-12' },
  ];
  const pairs = detectLondonTransferPairs(rows);
  assert.deepEqual(
    pairs.map(p => [p.earlierId, p.laterId, p.suggestedPriorRun.id]),
    [
      ['into-the-woods-west-end-2025', 'into-the-woods-noel-coward-west-end-2026', 'into-the-woods-west-end-2025'],
      ['arcadia-west-end-2026', 'arcadia-duke-of-yorks-west-end-2026', 'arcadia-west-end-2026'],
    ],
  );
});
