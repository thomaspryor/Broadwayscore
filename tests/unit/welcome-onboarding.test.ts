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
  pickWantShows,
  pickWelcomeShows,
  shouldOfferWelcome,
  welcomeCanOpenOn,
  welcomeClosesLabel,
  welcomeMarketFor,
  welcomeSaveStep,
  welcomeSeenKey,
  welcomeSummary,
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

test('steps run shows -> want and stop at want', () => {
  assert.equal(nextWelcomeStep('shows'), 'want');
  assert.equal(nextWelcomeStep('want'), 'want');
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

test('welcomeSummary: one plain line about what was saved, none when nothing was', () => {
  assert.equal(welcomeSummary({ seenAdded: 0, wantAdded: 0, unratedAdded: 0 }), null);
  assert.equal(welcomeSummary({ seenAdded: 3, wantAdded: 0, unratedAdded: 0 }), 'Saved to your account: 3 seen.');
  assert.equal(welcomeSummary({ seenAdded: 0, wantAdded: 2, unratedAdded: 0 }), 'Saved to your account: 2 to see.');
  assert.equal(welcomeSummary({ seenAdded: 3, wantAdded: 2, unratedAdded: 0 }), 'Saved to your account: 3 seen, 2 to see.');
  // Unrated picks wait under To Be Rated; never more unrated than seen.
  assert.match(welcomeSummary({ seenAdded: 3, wantAdded: 0, unratedAdded: 2 }) as string, /Add stars any time under To Be Rated\.$/);
  assert.equal(welcomeSummary({ seenAdded: 0, wantAdded: 4, unratedAdded: 2 }), 'Saved to your account: 4 to see.');
  assert.equal(welcomeSummary({ seenAdded: -1, wantAdded: 0, unratedAdded: 0 }), null);
});

test('welcomeClosesLabel: a short date for a real closing date, nothing otherwise', () => {
  assert.equal(welcomeClosesLabel('2026-12-14'), 'Closes Dec 14');
  assert.equal(welcomeClosesLabel('2027-01-03'), 'Closes Jan 3');
  assert.equal(welcomeClosesLabel(null), null);
  assert.equal(welcomeClosesLabel(undefined), null);
  assert.equal(welcomeClosesLabel(''), null);
  assert.equal(welcomeClosesLabel('soon'), null);
  assert.equal(welcomeClosesLabel('2026-13-45'), null);
});

const scored = (id: string, score: number, o: Partial<WelcomeShowSource> = {}) => show({ id, score, ...o });

test('pickWantShows: best Critic Score first, open or previews only, one poster per title', () => {
  const picked = pickWantShows([
    scored('b-open', 80),
    scored('a-top', 92, { status: 'previews' }),
    scored('c-closed', 99, { status: 'closed' }),
    scored('d-dupe-old', 70, { title: 'Dupe' }),
    scored('d-dupe-new', 75, { title: 'Dupe' }),
    scored('e-unscored', 0),
    scored('f-few-reviews', 95, { reviewCount: 3 }),
    scored('g-no-poster', 90, { images: {} }),
  ], '2026-10-05');
  assert.deepEqual(picked.map(s => s.id), ['a-top', 'b-open', 'd-dupe-new']);
  assert.deepEqual(picked.map(s => s.score), [92, 80, 75]);
});

test('pickWantShows: ties fall back to title; scores are rounded; the count caps the list', () => {
  const picked = pickWantShows([scored('z', 80.4), scored('m', 80.4), scored('x', 80.6)], '2026-10-05', { count: 2 });
  assert.deepEqual(picked.map(s => s.id), ['x', 'm']);
  assert.deepEqual(picked.map(s => s.score), [81, 80]);
});

test('pickWantShows: only a closing date within 60 days is called out; a stale one drops the show', () => {
  const picked = pickWantShows([
    scored('soon', 90, { closingDate: '2026-11-20' }),
    scored('later', 89, { closingDate: '2027-06-01' }),
    scored('stale', 95, { closingDate: '2026-09-01' }),
    scored('open-ended', 88, { closingDate: null }),
  ], '2026-10-05');
  assert.deepEqual(picked.map(s => s.id), ['soon', 'later', 'open-ended']);
  assert.deepEqual(picked.map(s => s.closingDate), ['2026-11-20', null, null]);
});

test('pickWantShows: West End list only takes West End shows', () => {
  const sources = [scored('bway', 90), scored('london', 85, { category: 'west-end' })];
  assert.deepEqual(pickWantShows(sources, '2026-10-05').map(s => s.id), ['bway']);
  assert.deepEqual(pickWantShows(sources, '2026-10-05', { category: 'west-end' }).map(s => s.id), ['london']);
});

test('pickWantShows on the real catalog: scored Broadway shows, best first, no duplicates', () => {
  const path = join(__dirname, '../../public/data/mobile-shows.json');
  const raw: { shows: Array<Record<string, unknown>> } = JSON.parse(readFileSync(path, 'utf-8'));
  const sources: WelcomeShowSource[] = raw.shows.map(s => ({
    id: s.id as string, title: s.t as string, slug: s.s as string, status: s.st as string,
    category: (s.cat as string | undefined) ?? 'broadway',
    openingDate: (s.od as string | undefined) ?? null, closingDate: (s.cd as string | undefined) ?? null,
    images: { poster: (s.img as { po?: string } | undefined)?.po, thumbnail: (s.img as { th?: string } | undefined)?.th },
    reviewCount: ((s.cr as { rc?: number } | undefined)?.rc) ?? 0,
    score: ((s.cr as { s?: number } | undefined)?.s) ?? null,
  }));
  const picked = pickWantShows(sources, '2026-10-05');
  // The catalog may hold no scored show for a market; when it does the shape must hold.
  assert.ok(picked.length > 0, 'expected at least one scored open Broadway show');
  assert.ok(picked.length <= 12);
  assert.equal(new Set(picked.map(s => s.id)).size, picked.length);
  assert.ok(picked.every((s, i) => i === 0 || picked[i - 1].score >= s.score), 'sorted by score, best first');
  assert.ok(picked.every(s => s.score > 0 && s.score <= 100));
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

test('importSourceNames: one list names every import source (My Shows import link)', () => {
  assert.equal(importSourceNames([{ name: 'Show Score' }, { name: 'Mezzanine' }]), 'Show Score or Mezzanine');
  assert.equal(importSourceNames([{ name: 'Show Score' }, { name: 'Mezzanine' }, { name: 'Theatr' }]), 'Show Score, Mezzanine or Theatr');
  assert.equal(importSourceNames([{ name: 'Show Score' }]), 'Show Score');
  assert.equal(importSourceNames(), IMPORT_SOURCES.map(s => s.name).join(' or ').replace(/ or (?=.* or )/g, ', '));
});
