/**
 * Welcome step after first sign-in (BRO-4619): who sees it, which posters,
 * what a pick writes, where Done goes. Requires the real module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WELCOME_ACCOUNT_MAX_AGE_MS,
  nextWelcomeStep,
  pickWelcomeShows,
  shouldOfferWelcome,
  welcomeCanOpenOn,
  welcomeDoneMessage,
  welcomeFinishDestination,
  welcomeMarketFor,
  welcomeSaveStep,
  welcomeSeenKey,
  welcomeWriteFor,
  type WelcomeShowSource,
} from '../../src/lib/welcome-onboarding';
import { IMPORT_SOURCES, importSourceNames } from '../../src/lib/import-sources';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

test('shouldOfferWelcome: a fresh account with an unclaimed welcome', () => {
  assert.equal(shouldOfferWelcome({ profile: { onboarding_seen_at: null, created_at: minsAgo(1) }, now: NOW, locallySeen: false }), true);
});

test('shouldOfferWelcome: never twice, never for existing accounts', () => {
  const fresh = { onboarding_seen_at: null, created_at: minsAgo(1) };
  assert.equal(shouldOfferWelcome({ profile: { ...fresh, onboarding_seen_at: minsAgo(0) }, now: NOW, locallySeen: false }), false, 'server says already shown');
  assert.equal(shouldOfferWelcome({ profile: fresh, now: NOW, locallySeen: true }), false, 'this browser already showed it');
  assert.equal(shouldOfferWelcome({ profile: { onboarding_seen_at: null, created_at: new Date(NOW - WELCOME_ACCOUNT_MAX_AGE_MS - 1).toISOString() }, now: NOW, locallySeen: false }), false, 'account older than a day');
  assert.equal(shouldOfferWelcome({ profile: { created_at: minsAgo(1) }, now: NOW, locallySeen: false }), false, 'column missing (migration not applied) means do not show');
  assert.equal(shouldOfferWelcome({ profile: { onboarding_seen_at: null, created_at: null }, now: NOW, locallySeen: false }), false, 'unknown age');
  assert.equal(shouldOfferWelcome({ profile: null, now: NOW, locallySeen: false }), false, 'profile not loaded yet');
  assert.equal(shouldOfferWelcome({ profile: { onboarding_seen_at: null, created_at: minsAgo(-5) }, now: NOW, locallySeen: false }), false, 'created far in the future');
  assert.equal(shouldOfferWelcome({ profile: { onboarding_seen_at: null, created_at: minsAgo(-0.5) }, now: NOW, locallySeen: false }), true, 'device clock 30s behind the server');
});

test('welcomeSeenKey is per account', () => {
  assert.notEqual(welcomeSeenKey('a'), welcomeSeenKey('b'));
});

test('steps run shows -> import -> done and stop at done', () => {
  assert.equal(nextWelcomeStep('shows'), 'import');
  assert.equal(nextWelcomeStep('import'), 'done');
  assert.equal(nextWelcomeStep('done'), 'done');
});

const show = (o: Partial<WelcomeShowSource> & { id: string }): WelcomeShowSource => ({
  title: o.id, slug: o.id, status: 'open', category: 'broadway', openingDate: '2025-06-01',
  images: { poster: `/images/shows/${o.id}/poster.webp` }, reviewCount: 40, closingDate: null, ...o,
});

test('pickWelcomeShows: open shows oldest first, then recent closings', () => {
  const picked = pickWelcomeShows([
    show({ id: 'small-recent', openingDate: '2025-03-01', reviewCount: 21 }),
    show({ id: 'big-recent', openingDate: '2025-01-01', reviewCount: 60 }),
    show({ id: 'thin-recent', reviewCount: 5 }),
    show({ id: 'wicked', openingDate: '2003-10-30', reviewCount: 25 }),
    show({ id: 'chicago', openingDate: '1996-11-14', reviewCount: 9 }),
    show({ id: 'stub-runner', openingDate: '2010-01-01', reviewCount: 2 }),
    show({ id: 'just-opened', openingDate: '2026-08-01', reviewCount: 80 }),
    show({ id: 'big-closed', status: 'closed', closingDate: '2026-01-01', reviewCount: 45 }),
    show({ id: 'old-closed', status: 'closed', closingDate: '2019-01-01', reviewCount: 90 }),
    show({ id: 'ob', category: 'off-broadway', reviewCount: 99 }),
    show({ id: 'no-art', images: {}, reviewCount: 99 }),
    show({ id: 'previews', status: 'previews', reviewCount: 99 }),
    show({ id: 'not-open-yet', openingDate: '2026-12-01', reviewCount: 99 }),
  ], '2026-10-05');
  assert.deepEqual(picked.map(s => s.id), ['chicago', 'wicked', 'big-recent', 'small-recent', 'big-closed']);
  assert.equal(picked[4].closingDate, '2026-01-01');
  assert.equal(picked[0].closingDate, null);
});

test('pickWelcomeShows: a show needs 180 days on the boards, so a weeks-old opening waits', () => {
  const ids = (openingDate: string) => pickWelcomeShows([show({ id: 'x', openingDate, reviewCount: 50 })], '2026-10-05').map(s => s.id);
  assert.deepEqual(ids('2026-04-08'), ['x'], '180 days ago');
  assert.deepEqual(ids('2026-04-09'), [], '179 days ago');
});

test('pickWelcomeShows: one poster per title and respects the counts', () => {
  const picked = pickWelcomeShows([
    show({ id: 'gypsy-2024', title: 'Gypsy', status: 'closed', closingDate: '2025-08-17', reviewCount: 41 }),
    show({ id: 'gypsy-2026', title: 'Gypsy', openingDate: '2024-12-01', reviewCount: 99 }),
    ...Array.from({ length: 20 }, (_, i) => show({ id: `o${i}`, reviewCount: 25 + i })),
  ], '2026-10-05', { openCount: 3, closedCount: 2 });
  assert.equal(picked.filter(s => s.title === 'Gypsy').length, 1);
  assert.equal(picked.length, 3, '3 open (Gypsy oldest), the only closing is a duplicate title');
  assert.equal(picked[0].id, 'gypsy-2026');
});

test('pickWelcomeShows: West End grid only takes West End shows', () => {
  const picked = pickWelcomeShows([
    show({ id: 'mousetrap', category: 'west-end', openingDate: '1952-11-25', reviewCount: 6 }),
    show({ id: 'wicked', openingDate: '2003-10-30', reviewCount: 25 }),
  ], '2026-10-05', { category: 'west-end' });
  assert.deepEqual(picked.map(s => s.id), ['mousetrap']);
});

test('welcomeMarketFor: London pages get the West End grid, everything else Broadway', () => {
  assert.equal(welcomeMarketFor('west-end'), 'west-end');
  assert.equal(welcomeMarketFor('off-west-end'), 'west-end');
  assert.equal(welcomeMarketFor('nyc'), 'broadway');
  assert.equal(welcomeMarketFor('off-broadway'), 'broadway');
});

test('welcomeCanOpenOn: hub pages right away, other pages only after moving on', () => {
  assert.equal(welcomeCanOpenOn({ pathname: '/', landingPath: '/' }), true);
  assert.equal(welcomeCanOpenOn({ pathname: '/my-shows/', landingPath: '/my-shows' }), true);
  assert.equal(welcomeCanOpenOn({ pathname: '/west-end', landingPath: null }), true);
  assert.equal(welcomeCanOpenOn({ pathname: '/show/six-2021', landingPath: '/show/six-2021/' }), false, 'reading the page they came for');
  assert.equal(welcomeCanOpenOn({ pathname: '/show/hamilton-2015', landingPath: '/show/six-2021' }), true, 'moved on to another page');
  assert.equal(welcomeCanOpenOn({ pathname: '/show/six-2021', landingPath: null }), false, 'landing not known yet');
});

test('pickWelcomeShows on the real catalog: a full grid of Broadway posters with the classics in it', () => {
  const path = join(__dirname, '../../public/data/mobile-shows.json');
  const raw: { shows: Array<Record<string, unknown>> } = JSON.parse(readFileSync(path, 'utf-8'));
  // mobile-shows.json leaves `cat` off Broadway rows.
  const sources: WelcomeShowSource[] = raw.shows.map(s => ({
    id: s.id as string, title: s.t as string, slug: s.s as string, status: s.st as string,
    category: (s.cat as string | undefined) ?? 'broadway',
    openingDate: (s.od as string | undefined) ?? null, closingDate: (s.cd as string | undefined) ?? null,
    images: { poster: (s.img as { po?: string } | undefined)?.po, thumbnail: (s.img as { th?: string } | undefined)?.th },
    reviewCount: ((s.cr as { rc?: number } | undefined)?.rc) ?? 0,
  }));
  const picked = pickWelcomeShows(sources, '2026-10-05');
  assert.ok(picked.length >= 15, `expected a full grid, got ${picked.length}`);
  assert.ok(picked.every(s => s.image.startsWith('/images/') || s.image.startsWith('http')));
  assert.equal(new Set(picked.map(s => s.id)).size, picked.length);
  assert.ok(picked.some(s => /wicked/.test(s.id)), 'Wicked is in the grid');
});

test('welcomeWriteFor: stars make a dateless diary entry', () => {
  assert.deepEqual(welcomeWriteFor({ showId: 'six-2021', rating: 4.5 }),
    { table: 'reviews', row: { show_id: 'six-2021', rating: 4.5, date_seen: null } });
});

test('welcomeWriteFor: no stars is "seen, date not set", never a made-up date', () => {
  assert.deepEqual(welcomeWriteFor({ showId: 'gypsy-2024', rating: null }),
    { table: 'seen_unrated', row: { show_id: 'gypsy-2024' } });
  assert.equal(welcomeWriteFor({ showId: 'x', rating: 0 }).table, 'seen_unrated', 'zero stars is no rating');
  assert.equal(welcomeWriteFor({ showId: 'x', rating: 6 }).table, 'seen_unrated', 'out-of-range stars are not saved as a review');
});

test('welcomeFinishDestination: My Shows only when there is something to see', () => {
  assert.equal(welcomeFinishDestination({ showsAdded: 0, imported: 0 }), 'stay');
  assert.equal(welcomeFinishDestination({ showsAdded: 2, imported: 0 }), 'my-shows');
  assert.equal(welcomeFinishDestination({ showsAdded: 0, imported: 5 }), 'my-shows');
});

test('welcomeDoneMessage: To Be Rated only when picks went in without stars', () => {
  assert.equal(welcomeDoneMessage({ showsAdded: 0, imported: 0, unratedAdded: 0 }), 'Rate a show from its page any time, and it lands in your diary.');
  assert.equal(welcomeDoneMessage({ showsAdded: 3, imported: 0, unratedAdded: 0 }), '3 shows added to your diary.');
  assert.equal(welcomeDoneMessage({ showsAdded: 1, imported: 0, unratedAdded: 0 }), '1 show added to your diary.');
  // Imports can be watchlist rows, so they are never said to be in the diary.
  assert.equal(welcomeDoneMessage({ showsAdded: 0, imported: 12, unratedAdded: 0 }), '12 imported to My Shows.');
  assert.equal(welcomeDoneMessage({ showsAdded: 2, imported: 12, unratedAdded: 0 }), '2 shows added, 12 imported to My Shows.');
  assert.match(welcomeDoneMessage({ showsAdded: 1, imported: 0, unratedAdded: 1 }), /^1 show added\. It waits for you under To Be Rated/);
  assert.match(welcomeDoneMessage({ showsAdded: 3, imported: 0, unratedAdded: 3 }), /^3 shows added\. They wait for you under To Be Rated/);
  assert.match(welcomeDoneMessage({ showsAdded: 3, imported: 0, unratedAdded: 1 }), /^3 shows added\. The one without stars waits for you under To Be Rated/);
  assert.match(welcomeDoneMessage({ showsAdded: 3, imported: 0, unratedAdded: 2 }), /^3 shows added\. The 2 without stars wait/);
  // With imports, "They" would take them in too: the unrated picks are named.
  assert.match(welcomeDoneMessage({ showsAdded: 2, imported: 5, unratedAdded: 2 }), /^2 shows added, 5 imported\. The 2 without stars wait/);
  // A bad count never claims more unrated shows than were added.
  assert.match(welcomeDoneMessage({ showsAdded: 2, imported: 0, unratedAdded: 5 }), /^2 shows added\. They wait/);
  assert.equal(welcomeDoneMessage({ showsAdded: 0, imported: 4, unratedAdded: 3 }), '4 imported to My Shows.');
});

test('welcomeSaveStep: a bookmark never drops the pick; seen shows are not written twice', () => {
  const rated = { showId: 'wicked', rating: 4 };
  const unrated = { showId: 'wicked', rating: null };
  // Bookmarked during sign-in: written with its stars, and off the watchlist.
  assert.deepEqual(welcomeSaveStep(rated, { seen: false, watchlisted: true }),
    { write: { table: 'reviews', row: { show_id: 'wicked', rating: 4, date_seen: null } }, clearWatchlist: true });
  assert.deepEqual(welcomeSaveStep(unrated, { seen: false, watchlisted: true }),
    { write: { table: 'seen_unrated', row: { show_id: 'wicked' } }, clearWatchlist: true });
  // Nowhere yet: written, nothing to clear.
  assert.equal(welcomeSaveStep(rated, { seen: false, watchlisted: false }).clearWatchlist, false);
  // Already seen (reviewed or picked before): no second write, watchlist left alone.
  assert.deepEqual(welcomeSaveStep(rated, { seen: true, watchlisted: true }), { write: null, clearWatchlist: false });
  assert.deepEqual(welcomeSaveStep(unrated, { seen: true, watchlisted: false }), { write: null, clearWatchlist: false });
});

test('importSourceNames: one list names every import source', () => {
  assert.equal(importSourceNames([{ name: 'Show Score' }, { name: 'Mezzanine' }]), 'Show Score or Mezzanine');
  assert.equal(importSourceNames([{ name: 'Show Score' }, { name: 'Mezzanine' }, { name: 'Theatr' }]), 'Show Score, Mezzanine or Theatr');
  assert.equal(importSourceNames([{ name: 'Show Score' }]), 'Show Score');
  assert.equal(importSourceNames(), IMPORT_SOURCES.map(s => s.name).join(' or ').replace(/ or (?=.* or )/g, ', '));
  assert.ok(IMPORT_SOURCES.every(s => s.id && s.name && s.hint), 'every source has a card hint for the welcome sheet');
});
