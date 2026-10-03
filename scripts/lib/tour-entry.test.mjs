import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTourEntry } = require('./tour-entry.js');
const { openTourCandidates, tourCandidateFor } = require('./tour-roundup-candidate.js');

const NOW = new Date('2026-09-28T00:00:00Z');
const parent = { id: 'kimberly-akimbo-2022', title: 'Kimberly Akimbo', category: 'broadway', type: 'musical',
  images: { hero: '/images/shows/kimberly-akimbo-2022/hero.webp', thumbnail: '/images/shows/kimberly-akimbo-2022/thumbnail.webp', poster: '/images/shows/kimberly-akimbo-2022/poster.webp' }, synopsis: 'Story.' };
const ok = { write: { openingDate: '2024-09-14' }, notes: ['segment 2024-09-14..2026-05-24'] };

test('builds a provisional tour entry that inherits art, never the hero', () => {
  const { entry } = buildTourEntry({ parent, shows: [parent], decision: ok, roundupUrl: 'https://bww/x', scheduleUrl: 'https://t2y/x', now: NOW });
  assert.equal(entry.id, 'kimberly-akimbo-tour-2024');
  assert.equal(entry.category, 'tour');
  assert.equal(entry.tourOf, 'kimberly-akimbo-2022');
  assert.equal(entry.status, 'open');
  assert.equal(entry.provisional, true);
  assert.equal(entry.discoverySource, 'aggregator-roundup:bww-tour-roundup');
  assert.equal(entry.images.hero, null);
  assert.equal(entry.images.thumbnail, '/images/shows/kimberly-akimbo-2022/thumbnail.webp');
  assert.equal(entry.synopsis, 'Story.');
});

test('closed tour gets status closed and closing provenance', () => {
  const { entry } = buildTourEntry({ parent, shows: [parent], decision: { write: { openingDate: '2024-09-14', closingDate: '2026-05-24' }, notes: [] }, roundupUrl: 'u', now: NOW });
  assert.equal(entry.status, 'closed');
  assert.equal(entry.closingDateSource, 'tourstoyou+wikipedia');
});

test('a launch confirmed by the BWW roundup says so in its provenance (BRO-4563)', () => {
  const decision = { write: { openingDate: '2026-09-20' }, notes: ['segment 2026-09-20..2027-06-01'], launchSource: 'bww-roundup' };
  const { entry } = buildTourEntry({ parent, shows: [parent], decision, roundupUrl: 'https://bww/r-20260930', scheduleUrl: 'https://tourstoyou.org/shows/kimberly-akimbo/', now: NOW });
  assert.equal(entry.id, 'kimberly-akimbo-tour-2026');
  assert.equal(entry.openingDateSource, 'tourstoyou+bww-roundup');
  assert.equal(entry.discoverySource, 'aggregator-roundup:bww-tour-roundup');
  assert.match(entry.statusSource, /\+ BroadwayWorld roundup;/);
  assert.equal(entry.tourScheduleSlug, 'kimberly-akimbo');
  const closed = buildTourEntry({ parent, shows: [parent], decision: { ...decision, write: { openingDate: '2026-09-20', closingDate: '2026-09-27' } }, roundupUrl: 'u', now: NOW }).entry;
  assert.equal(closed.closingDateSource, 'tourstoyou');
  // Wikipedia-confirmed (or legacy decisions without launchSource) are unchanged.
  assert.equal(buildTourEntry({ parent, shows: [parent], decision: ok, roundupUrl: 'u', now: NOW }).entry.openingDateSource, 'tourstoyou+wikipedia');
});

test('stays a suggestion without a confirmed launch, with a problem, or while another tour is open', () => {
  assert.match(buildTourEntry({ parent, shows: [parent], decision: { write: {}, notes: [] }, roundupUrl: 'u', now: NOW }).skip, /no launch/);
  assert.match(buildTourEntry({ parent, shows: [parent], decision: { write: {}, notes: [], problem: 'zero engagements' }, roundupUrl: 'u', now: NOW }).skip, /zero engagements/);
  const running = { id: 'kimberly-akimbo-tour-2023', title: 'Kimberly Akimbo', category: 'tour', tourOf: parent.id, openingDate: '2023-01-01', closingDate: null };
  assert.match(buildTourEntry({ parent, shows: [parent, running], decision: ok, roundupUrl: 'u', now: NOW }).skip, /still open/);
  assert.match(buildTourEntry({ parent, shows: [parent, { id: 'kimberly-akimbo-tour-2024' }], decision: ok, roundupUrl: 'u', now: NOW }).skip, /already exists/);
  assert.match(buildTourEntry({ parent, shows: [parent], decision: { write: { openingDate: '2027-01-01' }, notes: [] }, roundupUrl: 'u', now: NOW }).skip, /future/);
});

test('a second tour is a candidate once the first has closed; created rows drop out', () => {
  const closed = { id: 'beetlejuice-tour-2022', title: 'Beetlejuice', category: 'tour', tourOf: 'beetlejuice-2019', status: 'closed', closingDate: '2025-09-14' };
  const bway = { id: 'beetlejuice-2019', title: 'Beetlejuice', category: 'broadway' };
  const slug = 'Review-Roundup-BEETLEJUICE-National-Tour-20260220';
  assert.ok(tourCandidateFor(slug, bway, [bway, closed]));
  assert.equal(tourCandidateFor(slug, bway, [bway, { ...closed, status: 'open', closingDate: null }]), null);
  const rows = [{ broadwayShowId: 'beetlejuice-2019', slug }, { broadwayShowId: 'beetlejuice-2019', slug, createdTourId: 'beetlejuice-tour-2026' }];
  assert.equal(openTourCandidates(rows, [bway, closed]).length, 1);
});

test('retired ids are never re-created', () => {
  const r = buildTourEntry({ parent, shows: [parent], decision: ok, roundupUrl: 'u', retiredIds: new Set(['kimberly-akimbo-tour-2024']), now: NOW });
  assert.match(r.skip, /retired/);
});

test('a new roundup for the same show starts a fresh candidate (later tour)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { recordTourCandidates } = require('./tour-roundup-candidate.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tourcand-')), 'c.json');
  fs.writeFileSync(file, JSON.stringify([{ broadwayShowId: 'b', slug: 'old-National-Tour', firstSeen: '2022-12-10', createdTourId: 'b-tour-2022', notifiedAt: 'x' }]));
  recordTourCandidates(file, [{ broadwayShowId: 'b', slug: 'old-National-Tour' }], '2026-02-20');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].createdTourId, 'b-tour-2022', 'same roundup keeps its state');
  recordTourCandidates(file, [{ broadwayShowId: 'b', slug: 'new-National-Tour' }], '2026-02-20');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  assert.equal(row.createdTourId, undefined);
  assert.equal(row.notifiedAt, undefined);
  assert.equal(row.firstSeen, '2026-02-20');
});
