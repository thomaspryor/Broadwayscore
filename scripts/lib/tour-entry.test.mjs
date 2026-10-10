import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTourEntry, baseSlug, titleSlug } = require('./tour-entry.js');
const { tourImageProblems } = require('./tour-family.js');
const { openTourCandidates, tourCandidateFor } = require('./tour-roundup-candidate.js');

const NOW = new Date('2026-09-28T00:00:00Z');
const parent = { id: 'kimberly-akimbo-2022', title: 'Kimberly Akimbo', category: 'broadway', type: 'musical',
  images: { hero: '/images/shows/kimberly-akimbo-2022/hero.webp', thumbnail: '/images/shows/kimberly-akimbo-2022/thumbnail.webp', poster: '/images/shows/kimberly-akimbo-2022/poster.webp' }, synopsis: 'Story.' };
const ok = { write: { openingDate: '2024-09-14' }, notes: ['segment 2024-09-14..2026-05-24'], launchSource: 'wikipedia' };

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
  const { entry } = buildTourEntry({ parent, shows: [parent], decision: { write: { openingDate: '2024-09-14', closingDate: '2026-05-24' }, notes: [], launchSource: 'wikipedia' }, roundupUrl: 'u', now: NOW });
  assert.equal(entry.status, 'closed');
  assert.equal(entry.closingDateSource, 'tourstoyou+wikipedia');
});

test('a launch confirmed by the BWW roundup says so in its provenance (BRO-4563)', () => {
  const decision = { write: { openingDate: '2026-09-20' }, notes: ['segment 2026-09-20..2027-06-01'], launchSource: 'bww-roundup' };
  const { entry } = buildTourEntry({ parent, shows: [parent], decision, roundupUrl: 'https://bww/r-20260930', scheduleUrl: 'https://tourstoyou.org/shows/kimberly-akimbo/', now: NOW });
  assert.equal(entry.id, 'kimberly-akimbo-tour-2026');
  assert.equal(entry.openingDateSource, 'tourstoyou+bww-roundup');
  assert.equal(entry.discoverySource, 'aggregator-roundup:bww-tour-roundup');
  assert.match(entry.statusSource, /launch confirmed by BroadwayWorld roundup;/);
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
  assert.match(buildTourEntry({ parent, shows: [parent], decision: { write: { openingDate: '2024-09-14' }, notes: [] }, roundupUrl: 'u', now: NOW }).skip, /unknown launch source/);
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

// BRO-4601: a fresh Tours To You launch has one source and says so; it never
// borrows the Wikipedia label (the validate-show-venue two-source exemption).
test('a fresh Tours To You launch is labelled as the first listed engagement', () => {
  const decision = { write: { openingDate: '2026-09-20' }, notes: ['segment 2026-09-20..2027-06-01'], launchSource: 'tourstoyou-fresh' };
  const { entry } = buildTourEntry({ parent, shows: [parent], decision, scheduleUrl: 'https://tourstoyou.org/shows/kimberly-akimbo/', now: NOW });
  assert.equal(entry.openingDateSource, 'tourstoyou-first-engagement');
  assert.equal(entry.discoverySource, 'tour-schedule:tourstoyou');
  assert.match(entry.tourLaunchEvidence, /first listed engagement of a tour launching now/);
  assert.doesNotMatch(entry.tourLaunchEvidence + entry.statusSource, /Wikipedia/);
});

test('a launch still ahead creates an upcoming tour that opens on its date', () => {
  const booked = buildTourEntry({ parent, shows: [parent], decision: { write: { openingDate: '2027-01-19' }, notes: [], launchSource: 'tourstoyou-upcoming' }, scheduleUrl: 'https://tourstoyou.org/shows/kimberly-akimbo/', now: NOW }).entry;
  assert.equal(booked.status, 'upcoming');
  assert.equal(booked.id, 'kimberly-akimbo-tour-2027');
  assert.equal(booked.openingDateSource, 'tourstoyou-first-engagement');
  assert.match(booked.tourLaunchEvidence, /booked ahead/);
  // Wikipedia naming a future launch is as good.
  assert.equal(buildTourEntry({ parent, shows: [parent], decision: { write: { openingDate: '2027-01-01' }, notes: [], launchSource: 'wikipedia' }, roundupUrl: 'u', now: NOW }).entry.status, 'upcoming');
});

// ---- BRO-4931: tours of any market, and standalone tours --------------------

const art = id => ({ hero: `/images/shows/${id}/hero.webp`, thumbnail: `/images/shows/${id}/thumbnail.webp`, poster: `/images/shows/${id}/poster.webp` });
const mexodus = { id: 'mexodus-off-broadway-2026', title: 'Mexodus', category: 'off-broadway', type: 'musical', status: 'open', openingDate: '2026-03-01', images: art('mexodus-off-broadway-2026'), synopsis: 'A road story.', runtime: '2h' };
const pizza = { id: 'mystic-pizza-regional-2025', title: 'Mystic Pizza', category: 'regional', type: 'musical', status: 'closed', closingDate: '2025-10-01', openingDate: '2025-08-01', images: art('mystic-pizza-regional-2025'), synopsis: 'Three waitresses.' };
const t2yUrl = slug => `https://tourstoyou.org/shows/${slug}/`;
const fresh = (openingDate, launchSource = 'tourstoyou-fresh') => ({ write: { openingDate }, notes: [], launchSource });

test('baseSlug drops the year and the market token before it', () => {
  assert.equal(baseSlug('beetlejuice-2019'), 'beetlejuice');
  assert.equal(baseSlug('mexodus-off-broadway-2026'), 'mexodus');
  assert.equal(baseSlug('mystic-pizza-regional-2025'), 'mystic-pizza');
  assert.equal(baseSlug('heathers-the-musical-off-west-end-2026'), 'heathers-the-musical');
  assert.equal(baseSlug('evita-west-end-2019'), 'evita');
  assert.equal(baseSlug('six-on-broadway-2021'), 'six');
  assert.equal(baseSlug('west-end-2020'), 'west-end', 'a market word that is the whole base stays');
  assert.equal(baseSlug('regional'), 'regional');
});

test('titleSlug kebab-cases a title for a standalone tour', () => {
  assert.equal(titleSlug("Dr. Seuss' How the Grinch Stole Christmas!"), 'dr-seuss-how-the-grinch-stole-christmas');
  assert.equal(titleSlug('Moulin Rouge! & Co'), 'moulin-rouge-and-co');
  assert.equal(titleSlug('Les Misérables'), 'les-miserables');
});

test('a tour of an Off-Broadway show: id without the market, parent art and synopsis inherited, never the hero', () => {
  const { entry, skip } = buildTourEntry({ parent: mexodus, shows: [mexodus], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('mexodus'), now: NOW });
  assert.equal(skip, undefined);
  assert.equal(entry.id, 'mexodus-tour-2026');
  assert.equal(entry.slug, 'mexodus-tour-2026');
  assert.equal(entry.tourOf, 'mexodus-off-broadway-2026');
  assert.equal(entry.category, 'tour');
  assert.equal(entry.venue, 'North American Tour');
  assert.equal(entry.title, 'Mexodus');
  assert.equal(entry.synopsis, 'A road story.');
  assert.equal(entry.runtime, '2h');
  assert.equal(entry.images.thumbnail, '/images/shows/mexodus-off-broadway-2026/thumbnail.webp');
  assert.equal(entry.images.poster, '/images/shows/mexodus-off-broadway-2026/poster.webp');
  assert.equal(entry.images.hero, null);
  assert.equal(entry.cast, undefined);
  assert.deepEqual(tourImageProblems(entry, [mexodus, entry]), []);
});

test('a tour of a regional show takes the plain <base>-tour-<year> id from the launch year', () => {
  const { entry } = buildTourEntry({ parent: pizza, shows: [pizza], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('mystic-pizza'), now: NOW });
  assert.equal(entry.id, 'mystic-pizza-tour-2026');
  assert.equal(entry.tourOf, 'mystic-pizza-regional-2025');
  assert.equal(entry.type, 'musical');
});

test('a parent that closed long before the tour lends its synopsis but not its art', () => {
  const old = { ...pizza, closingDate: '2018-10-01', openingDate: '2018-08-01' };
  const { entry } = buildTourEntry({ parent: old, shows: [old], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('mystic-pizza'), now: NOW });
  assert.equal(entry.synopsis, 'Three waitresses.');
  assert.equal(entry.images.thumbnail, null);
  assert.equal(entry.images.poster, null);
});

test('a tour is refused a parent that is itself a tour', () => {
  const tour = { id: 'x-tour-2024', title: 'X', category: 'tour' };
  assert.match(buildTourEntry({ parent: tour, shows: [tour], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('x'), now: NOW }).skip, /not a production a tour can descend from/);
});

test('a standalone tour has no tourOf key, its own title-based id, the schedule slug and inherits nothing', () => {
  const r = buildTourEntry({ parent: null, title: "Dr. Seuss' How the Grinch Stole Christmas!", type: 'musical', shows: [], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('dr-seuss-how-the-grinch-stole-christmas'), now: NOW });
  assert.equal(r.skip, undefined);
  const e = r.entry;
  assert.equal(e.id, 'dr-seuss-how-the-grinch-stole-christmas-tour-2026');
  assert.equal('tourOf' in e, false, 'the field is omitted, never null');
  assert.equal(e.tourScheduleSlug, 'dr-seuss-how-the-grinch-stole-christmas');
  assert.equal(e.title, "Dr. Seuss' How the Grinch Stole Christmas!");
  assert.equal(e.type, 'musical');
  assert.equal(e.category, 'tour');
  assert.equal(e.synopsis, undefined);
  assert.equal(e.runtime, undefined);
  assert.deepEqual(e.images, { hero: null, thumbnail: null, poster: null });
});

test('a standalone tour needs a title, a known type and a Tours To You schedule page', () => {
  const ok = { parent: null, title: 'Elf', type: 'musical', shows: [], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('elf'), now: NOW };
  assert.ok(buildTourEntry(ok).entry);
  assert.match(buildTourEntry({ ...ok, title: '  ' }).skip, /needs a title/);
  assert.match(buildTourEntry({ ...ok, type: undefined }).skip, /known type/);
  assert.match(buildTourEntry({ ...ok, type: 'ballet' }).skip, /known type/);
  assert.match(buildTourEntry({ ...ok, scheduleUrl: undefined, roundupUrl: 'https://bww/x' }).skip, /schedule URL/);
  assert.match(buildTourEntry({ ...ok, scheduleUrl: 'https://example.com/elf' }).skip, /schedule URL/);
});

test('a standalone tour is refused when a same-title production exists, unless a person allows it', () => {
  const elf = { id: 'elf-2010', title: 'Elf', category: 'broadway' };
  const args = { parent: null, title: 'ELF!', type: 'musical', shows: [elf], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('elf'), now: NOW };
  assert.match(buildTourEntry(args).skip, /already has non-tour production/);
  const allowed = buildTourEntry({ ...args, allowStandaloneOverExisting: true });
  assert.equal(allowed.entry.id, 'elf-tour-2026');
  assert.equal('tourOf' in allowed.entry, false);
  // Another tour of the title is not a production: it only collides on dates.
  const sibling = { id: 'elf-tour-2025', title: 'Elf', category: 'tour', openingDate: '2025-01-01', closingDate: '2025-03-01' };
  assert.ok(buildTourEntry({ ...args, shows: [sibling] }).entry);
  assert.match(buildTourEntry({ ...args, shows: [{ ...sibling, closingDate: null }] }).skip, /still open/);
});

test('a title naming two different works still blocks a tour of an Off-Broadway parent', () => {
  const w = (id, name) => ({ id, title: 'Carol', category: 'off-broadway', type: 'play', creativeTeam: [{ role: 'Playwright', name }] });
  const a = w('carol-off-broadway-2019', 'Ann Author');
  const b = w('carol-off-broadway-2022', 'Bo Writer');
  assert.match(buildTourEntry({ parent: b, shows: [a, b], decision: fresh('2026-09-20'), scheduleUrl: t2yUrl('carol'), now: NOW }).skip, /different Broadway works/);
});
