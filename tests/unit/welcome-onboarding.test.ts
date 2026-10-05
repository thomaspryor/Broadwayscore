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
  welcomeFinishDestination,
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

test('pickWelcomeShows: long-runners oldest first, then recent hits, then recent closings', () => {
  const picked = pickWelcomeShows([
    show({ id: 'small-recent', reviewCount: 21 }),
    show({ id: 'big-recent', reviewCount: 60 }),
    show({ id: 'thin-recent', reviewCount: 5 }),
    show({ id: 'wicked', openingDate: '2003-10-30', reviewCount: 25 }),
    show({ id: 'chicago', openingDate: '1996-11-14', reviewCount: 9 }),
    show({ id: 'stub-runner', openingDate: '2010-01-01', reviewCount: 2 }),
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

test('pickWelcomeShows: one poster per title and respects the counts', () => {
  const picked = pickWelcomeShows([
    show({ id: 'gypsy-2024', title: 'Gypsy', status: 'closed', closingDate: '2025-08-17', reviewCount: 41 }),
    show({ id: 'gypsy-2026', title: 'Gypsy', reviewCount: 99 }),
    ...Array.from({ length: 20 }, (_, i) => show({ id: `o${i}`, reviewCount: 25 + i })),
  ], '2026-10-05', { longRunnerCount: 2, recentCount: 3, closedCount: 2 });
  assert.equal(picked.filter(s => s.title === 'Gypsy').length, 1);
  assert.equal(picked.length, 3, 'no long-runners, 3 recent (Gypsy first), the only closing is a duplicate title');
  assert.equal(picked[0].id, 'gypsy-2026');
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

test('importSourceNames: one list names every import source', () => {
  assert.equal(importSourceNames([{ name: 'Show Score' }, { name: 'Mezzanine' }]), 'Show Score or Mezzanine');
  assert.equal(importSourceNames([{ name: 'Show Score' }, { name: 'Mezzanine' }, { name: 'Theatr' }]), 'Show Score, Mezzanine or Theatr');
  assert.equal(importSourceNames([{ name: 'Show Score' }]), 'Show Score');
  assert.equal(importSourceNames(), IMPORT_SOURCES.map(s => s.name).join(' or ').replace(/ or (?=.* or )/g, ', '));
  assert.ok(IMPORT_SOURCES.every(s => s.id && s.name && s.hint), 'every source has a card hint for the welcome sheet');
});
