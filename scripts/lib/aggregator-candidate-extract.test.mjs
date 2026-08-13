// Fixture-driven tests for aggregator-candidate extraction. No network —
// fixtures live in tests/fixtures/aggregator-candidates/ (regenerate with
// node tests/fixtures/aggregator-candidates/_generate.js).
//
// Covers the 6 plan-review acceptance cases plus the bot-shell guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '../../tests/fixtures/aggregator-candidates');

const {
  isInfrastructureSlug,
  isBotShell,
  parseBwwSlugTitle,
  extractArticleFields,
  classifyTitleDelta,
  cleanCandidateTitle,
  classifyCandidate,
  slugCollidesWith,
  collisionSlugSet,
  obRegionalShows,
  venuesMatch,
  findKnownObShow,
  pruneUnmatchedAudit,
  pruneStagedCandidates,
  referenceTitle,
} = require('./aggregator-candidate-extract.js');

const html = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const NO_SLUGS = new Set();
const NO_SHOWS = [];

test('infrastructure slugs are rejected', () => {
  assert.ok(isInfrastructureSlug('site-map'));
  assert.ok(isInfrastructureSlug('privacy-policy'));
  assert.ok(isInfrastructureSlug('upcoming-cast-recordings-com-171219'));
  assert.ok(isInfrastructureSlug('playbill-rss-feeds'));
  assert.ok(!isInfrastructureSlug('Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515'));
});

test('bot-shell detection: 3 independent signals', () => {
  assert.equal(isBotShell(html('bot-shell-cloudflare.html')), true, 'tiny interstitial');
  assert.equal(isBotShell(html('bot-shell-no-date.html')), true, 'no date signal');
  assert.equal(isBotShell(html('bww-dad-dont-read-this.html')), false, 'real article');
  assert.equal(isBotShell(''), true);
  assert.equal(isBotShell(null), true);
});

test('BWW slug parsing: placeholder vs venue tails', () => {
  const dad = parseBwwSlugTitle('Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515');
  assert.equal(dad.title, "Dad Dont Read This");
  assert.equal(dad.placeholder, false);

  const celeb = parseBwwSlugTitle('Review-Roundup-CELEBRITY-AUTOPBIOGRAPHY-On-Broadway');
  assert.equal(celeb.title, 'Celebrity Autopbiography');
  assert.equal(celeb.placeholder, true);

  const heated = parseBwwSlugTitle('Review-Roundup-HEATED-RIVALRY-THE-UNAUTHORIZED-MUSICAL-PARODY-Opens-Off-Broadway-20260526');
  assert.equal(heated.placeholder, true);
  assert.match(heated.title, /^Heated Rivalry The Unauthorized Musical Parody$/);

  // ship-check High: a title containing "at" must keep its internal "at" —
  // the venue tail is the LAST "at <theater>", not the first.
  const dinner = parseBwwSlugTitle('Review-Roundup-DINNER-AT-EIGHT-At-St-Lukes-Theatre-20260101');
  assert.equal(dinner.title, 'Dinner At Eight');

  // task #722: colon-less "Critics Sound Off On CITY's SHOW" slug must parse
  // to the same title extractArticleFields derives from the body, or the
  // slug-vs-body typo guard false-rejects a correctly-scraped regional show.
  const lincoln = parseBwwSlugTitle('Review-Roundup-Critics-Sound-Off-On-La-Jollas-3-SUMMERS-OF-LINCOLN-20250304');
  assert.equal(lincoln.title, '3 Summers Of Lincoln');
});

test('classifyTitleDelta: match / typo / mismatch', () => {
  assert.equal(classifyTitleDelta("Dad Dont Read This", "Dad Don't Read This"), 'match');
  assert.equal(classifyTitleDelta('Celebrity Autopbiography', 'Celebrity Autobiography'), 'typo');
  assert.equal(classifyTitleDelta('Broken Snow', 'A Completely Different Show'), 'mismatch');
});

test('acceptance #1: Dad Dont Read This → accept w/ St. Luke\'s Theatre', () => {
  const r = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515', slug: 'Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515', firstSeen: '2026-05-16T00:00:00Z' },
    html: html('bww-dad-dont-read-this.html'),
    shows: NO_SHOWS,
  });
  assert.equal(r.status, 'accept');
  assert.equal(r.candidate.title, "Dad Don't Read This");
  assert.equal(r.candidate.venue, "St. Luke's Theatre");
  assert.equal(r.candidate.source, 'bww-roundup');
  assert.ok(r.candidate.articlePublishedAt, 'date populated');
  assert.equal(r.candidate.category, 'off-broadway');
});

test('acceptance #2: CELEBRITY AUTOPBIOGRAPHY → typo bucket (not silent drop)', () => {
  const r = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-CELEBRITY-AUTOPBIOGRAPHY-On-Broadway', slug: 'Review-Roundup-CELEBRITY-AUTOPBIOGRAPHY-On-Broadway' },
    html: html('bww-celebrity-autopbiography.html'),
    shows: NO_SHOWS,
  });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'typo-detected');
});

test('acceptance #6: historical backtest — Broken Snow / Bedlam / Heated Rivalry', () => {
  const brokenSnow = classifyCandidate({
    source: 'playbill-verdict',
    record: { url: 'https://playbill.com/article/broken-snow', slug: 'broken-snow', title: 'Broken Snow' },
    html: html('pv-broken-snow.html'),
    shows: NO_SHOWS,
  });
  assert.equal(brokenSnow.status, 'accept');
  assert.equal(brokenSnow.candidate.venue, 'Theatre 71');

  const bedlam = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-BEDLAMS-OTHELLO-At-The-West-End-Theatre-20260520', slug: 'Review-Roundup-BEDLAMS-OTHELLO-At-The-West-End-Theatre-20260520' },
    html: html('bww-bedlam-othello.html'),
    shows: NO_SHOWS,
  });
  assert.equal(bedlam.status, 'accept');
  assert.equal(bedlam.candidate.title, "Bedlam's Othello");
  assert.equal(bedlam.candidate.venue, 'West End Theatre');

  const heated = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-HEATED-RIVALRY-THE-UNAUTHORIZED-MUSICAL-PARODY-Opens-Off-Broadway-20260526', slug: 'Review-Roundup-HEATED-RIVALRY-THE-UNAUTHORIZED-MUSICAL-PARODY-Opens-Off-Broadway-20260526' },
    html: html('bww-heated-rivalry.html'),
    shows: NO_SHOWS,
  });
  assert.equal(heated.status, 'accept', 'venue from body prose');
  assert.equal(heated.candidate.venue, '6th Floor Theater');
});

test('bot-shell article is rejected even with a venue-shaped headline', () => {
  const r = classifyCandidate({
    source: 'playbill-verdict',
    record: { url: 'https://playbill.com/article/some-show', slug: 'some-show', title: 'Some Show' },
    html: html('bot-shell-no-date.html'),
    shows: NO_SHOWS,
  });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'bot-shell');
});

test('slug-collision guard rejects a title already in shows.json at the SAME venue', () => {
  const r = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515', slug: 'Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515' },
    html: html('bww-dad-dont-read-this.html'),
    shows: [
      { id: 'dad-dont-read-this-off-broadway-2026', category: 'off-broadway', title: "Dad Don't Read This", venue: "St. Luke's Theatre" },
    ],
  });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'slug-collision');
});

// P1 task #1246, 2026-08-11: the 4th slugCollidesWith call site follow-up to
// the P0 fixed in pruneStagedCandidates (task #101) — classifyCandidate is
// the ONE call site with venue in hand (fetched HTML), so it must be fully
// venue-scoped, not just title-scoped like the two pre-fetch gates.
test('slug-collision guard does NOT reject a same-titled show at a DIFFERENT venue', () => {
  const r = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515', slug: 'Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515' },
    html: html('bww-dad-dont-read-this.html'),
    // An unrelated closed OB show happens to share the title, at a different venue.
    shows: [
      { id: 'dad-dont-read-this-off-broadway-2019', category: 'off-broadway', title: "Dad Don't Read This", venue: 'Some Other Theatre' },
    ],
  });
  assert.equal(r.status, 'accept');
  assert.equal(r.candidate.venue, "St. Luke's Theatre");
});

test('slug-collision guard does NOT reject a same-titled BROADWAY/West-End show — only off-broadway/regional namesakes count', () => {
  const r = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515', slug: 'Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515' },
    html: html('bww-dad-dont-read-this.html'),
    shows: [
      { id: 'dad-dont-read-this-broadway-2010', category: 'broadway', title: "Dad Don't Read This", venue: "St. Luke's Theatre" },
    ],
  });
  assert.equal(r.status, 'accept');
});

test('title containing " at " is not truncated (ship-check P1)', () => {
  const f = extractArticleFields(
    '<html><head><title>x</title></head><body><h1>Review Roundup: DINNER AT EIGHT Opens at the Todd Haimes Theatre</h1></body></html>'
  );
  assert.match(f.title, /^Dinner At Eight$/i);
  assert.equal(f.venue, 'Todd Haimes Theatre');
});

test('leading-type venue "Stage 42" is extracted (ship-check P2)', () => {
  const f = extractArticleFields(
    '<html><head><title>x</title></head><body><h1>Little Shop of Horrors Opens at Stage 42</h1></body></html>'
  );
  assert.equal(f.venue, 'Stage 42');
  assert.match(f.title, /^Little Shop Of Horrors$/i);
});

test('venue falls back to meta description when no <article>/<p> carries it (task #722, "3 Summers of Lincoln")', () => {
  // Reproduces the real BWW regional-roundup template: the headline has no
  // "at VENUE" clause and the first <p> in DOM order is nav chrome, not
  // review content — only the meta description states the venue.
  const f = extractArticleFields(
    '<html><head><title>x</title>' +
    '<meta name="description" content="3 Summers of Lincoln is now playing at La Jolla Playhouse through March 23, 2025.">' +
    '</head><body><p>Broadway + NYC</p><h1>Critics Sound Off On 3 SUMMERS OF LINCOLN</h1></body></html>'
  );
  assert.equal(f.venue, 'La Jolla Playhouse');
});

test('"Critics Sound Off On CITY\'s SHOW" headline strips the editorial lead-in and city possessive (task #722)', () => {
  const f = extractArticleFields(
    '<html><head><title>x</title>' +
    '<meta name="description" content="3 Summers of Lincoln is now playing at La Jolla Playhouse through March 23, 2025.">' +
    '</head><body><p>Broadway + NYC</p>' +
    "<h1>Review Roundup: Critics Sound Off On La Jolla's 3 SUMMERS OF LINCOLN</h1></body></html>"
  );
  assert.equal(f.title, '3 Summers Of Lincoln');
  assert.equal(f.venue, 'La Jolla Playhouse');
});

test('meta-description venue fallback bails on ambiguity — two distinct venues named (ship-check P1, task #722)', () => {
  // e.g. an actor bio aside ("fresh off her run at the Booth Theatre") next
  // to the real venue clause — picking the FIRST match would silently trust
  // the wrong one. A null venue here is safe (candidate falls through to
  // rejection); a wrong venue is not.
  const f = extractArticleFields(
    '<html><head><title>x</title>' +
    '<meta name="description" content="Fresh off her run at the Booth Theatre, the star headlines this new play now playing at La Jolla Playhouse.">' +
    '</head><body><p>Broadway + NYC</p><h1>Critics Sound Off On 3 SUMMERS OF LINCOLN</h1></body></html>'
  );
  assert.equal(f.venue, null);
});

test('referenceTitle + slugCollidesWith pre-fetch guard (ship-check P0)', () => {
  // PV ships a title; BWW derives from slug.
  assert.equal(referenceTitle('playbill-verdict', { title: 'Broken Snow' }), 'Broken Snow');
  assert.equal(referenceTitle('bww-roundup', { slug: 'Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515' }), 'Dad Dont Read This');
  // A title already in shows.json → driver skips the fetch.
  assert.equal(slugCollidesWith('Dad Dont Read This', new Set(['dad-dont-read-this'])), true);
  assert.equal(slugCollidesWith('Brand New Show', new Set(['dad-dont-read-this'])), false);
});

test('pruneUnmatchedAudit (PV) drops infrastructure + exact-slug-in-shows, keeps new', () => {
  const entries = [
    { url: 'https://playbill.com/article/site-map', slug: 'site-map', title: 'Site Map' },
    { url: 'https://playbill.com/article/playbill-rss-feeds', slug: 'playbill-rss-feeds' },
    { url: 'https://x/article/promoted-show', slug: 'promoted-show', title: 'Promoted Show' },
    { url: 'https://x/article/hamlet-at-bam', slug: 'hamlet-at-bam', title: 'Hamlet at BAM' },
    { url: 'https://x/article/brand-new', slug: 'brand-new', title: 'Brand New Show' },
  ];
  // shows.json contains the promoted show AND an old token-sharing namesake.
  const existingSlugs = new Set(['promoted-show', 'hamlet-2009']);
  const { kept, pruned } = pruneUnmatchedAudit(entries, { source: 'playbill-verdict', existingSlugs });
  assert.equal(pruned, 3, 'site-map + rss-feeds + promoted-show (exact slug)');
  // INVARIANT: "Hamlet at BAM" shares tokens with hamlet-2009 but its slug is
  // not in shows.json, so it MUST survive — the loose-matcher regression both
  // ship-check reviewers flagged would have wrongly pruned it.
  assert.deepEqual(kept.map(e => e.slug), ['hamlet-at-bam', 'brand-new']);
});

test('pruneUnmatchedAudit (BWW) derives the gate title from the slug', () => {
  const entries = [
    { url: 'a', slug: 'Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515' },
    { url: 'b', slug: 'Review-Roundup-CELEBRITY-AUTOPBIOGRAPHY-On-Broadway-20260518' },
  ];
  // "Dad Don't Read This" was promoted → shows.json slug 'dad-dont-read-this'.
  const existingSlugs = new Set(['dad-dont-read-this']);
  const { kept, pruned } = pruneUnmatchedAudit(entries, { source: 'bww-roundup', existingSlugs });
  assert.equal(pruned, 1);
  assert.deepEqual(kept.map(e => e.slug), ['Review-Roundup-CELEBRITY-AUTOPBIOGRAPHY-On-Broadway-20260518']);
});

test('pruneUnmatchedAudit tolerates junk input + empty slug set', () => {
  assert.deepEqual(pruneUnmatchedAudit(null, { source: 'playbill-verdict', existingSlugs: new Set() }), { kept: [], pruned: 0 });
  assert.deepEqual(pruneUnmatchedAudit([null, 'x', 42], {}), { kept: [], pruned: 0 });
  // No existingSlugs → only infrastructure is pruned.
  const r = pruneUnmatchedAudit([{ slug: 'site-map' }, { slug: 'real-show', title: 'Real Show' }], { source: 'playbill-verdict' });
  assert.equal(r.pruned, 1);
  assert.deepEqual(r.kept.map(e => e.slug), ['real-show']);
});

test('obRegionalShows keeps only off-broadway/regional shows, tolerates junk', () => {
  const shows = [
    { id: 'a', category: 'broadway', title: 'A' },
    { id: 'b', category: 'off-broadway', title: 'B' },
    { id: 'c', category: 'regional', title: 'C' },
    { id: 'd', category: 'west-end', title: 'D' },
    null,
    'junk',
  ];
  assert.deepEqual(obRegionalShows(shows).map(s => s.id), ['b', 'c']);
  assert.deepEqual(obRegionalShows(null), []);
  assert.deepEqual(obRegionalShows(undefined), []);
});

test('venuesMatch does NOT collapse two unrelated venues that merely share a leading word (ship-check finding, task #1246, 2026-08-11)', () => {
  // title-match.js's canonicalVenue() falls back to the lowercased FIRST
  // WORD for any venue outside VENUE_ALIASES — "The Duke on 42nd Street" and
  // "The Public Theater" both reduce to "the". venuesMatch must not inherit
  // that: it's the one thing standing between a title collision and a
  // silent reject/prune, so a false MATCH here reintroduces the exact P0
  // findKnownObShow exists to prevent.
  assert.equal(venuesMatch('The Duke on 42nd Street', 'The Public Theater'), false);
  assert.equal(venuesMatch('The Tank', 'The Connelly'), false);
  assert.equal(venuesMatch('Studio Theatre', 'Studio 54'), false);
  // Trivial formatting differences must still match (whitespace, Theatre vs
  // Theater) — this is what normalizeVenueName's exact-string comparison
  // (not first-word) buys over a naive strict === would.
  assert.equal(venuesMatch("St. Luke's Theatre", "St. Luke's Theater"), true);
  assert.equal(venuesMatch('  The Duke on 42nd Street  ', 'The Duke on 42nd Street'), true);
  // Identical strings and null/empty inputs.
  assert.equal(venuesMatch('Signature Center', 'Signature Center'), true);
  assert.equal(venuesMatch('', 'Signature Center'), false);
  assert.equal(venuesMatch(null, null), false);
});

test('findKnownObShow requires BOTH title and venue to match, and only off-broadway/regional', () => {
  const shows = [
    { id: 'match', category: 'off-broadway', title: 'Hamlet', venue: "St. Luke's Theatre" },
    { id: 'diff-venue', category: 'regional', title: 'Hamlet', venue: 'Some Other Theatre' },
    { id: 'broadway-namesake', category: 'broadway', title: 'Hamlet', venue: "St. Luke's Theatre" },
  ];
  assert.equal(findKnownObShow('Hamlet', "St. Luke's Theatre", shows).id, 'match');
  assert.equal(findKnownObShow('Hamlet', 'A Totally Unrelated Venue', shows), null);
  assert.equal(findKnownObShow('', "St. Luke's Theatre", shows), null, 'no title → no match');
  assert.equal(findKnownObShow('Hamlet', '', shows), null, 'no venue → no match');
  assert.equal(findKnownObShow('Hamlet', "St. Luke's Theatre", null), null, 'junk shows tolerated');
});

// The actual composition the 3 pre-fetch/prune call sites use (P1 task
// #1246, 2026-08-11): market-scope the shows list BEFORE building the slug
// set, so a Broadway/West-End namesake can never gate a title-only decision.
test('collisionSlugSet(obRegionalShows(shows)) excludes a broadway namesake but keeps the OB show', () => {
  const shows = [
    { id: 'chess-broadway-2003', category: 'broadway', slug: 'chess-broadway-2003', title: 'Chess' },
    { id: 'chess-off-broadway-2026', category: 'off-broadway', slug: 'chess-off-broadway-2026', title: 'Chess' },
  ];
  const scoped = collisionSlugSet(obRegionalShows(shows));
  // Both index the same title-derived slug "chess" (collisionSlugSet indexes
  // by title as well as by the show's own slug), so the OB show alone is
  // enough for the collision to still register — the point is that removing
  // the Broadway entry does not defeat the still-legitimate OB collision.
  assert.equal(slugCollidesWith('Chess', scoped), true);
  // With NO off-broadway/regional namesake at all, a Broadway-only catalog
  // must never gate the pre-fetch/prune decision.
  const broadwayOnly = [{ id: 'chess-broadway-2003', category: 'broadway', slug: 'chess-broadway-2003', title: 'Chess' }];
  assert.equal(slugCollidesWith('Chess', collisionSlugSet(obRegionalShows(broadwayOnly))), false);
});

test('pruneStagedCandidates drops staged candidates already in shows.json at the SAME venue (2026-08-11 regression: Dad Dont Read This)', () => {
  const staged = [
    { title: "Dad Don't Read This", venue: "St. Luke's Theatre", source: 'bww-roundup' },
    { title: 'Brand New Unstaged Show', venue: 'Some Theatre', source: 'playbill-verdict' },
  ];
  const shows = [
    { id: 'dad-dont-read-this-off-broadway-2026', category: 'off-broadway', title: "Dad Don't Read This", venue: "St. Luke's Theatre" },
  ];
  const { kept, pruned } = pruneStagedCandidates(staged, shows);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].title, "Dad Don't Read This");
  assert.equal(pruned[0].matchedShowId, 'dad-dont-read-this-off-broadway-2026');
  assert.deepEqual(kept.map(c => c.title), ['Brand New Unstaged Show']);
});

test('pruneStagedCandidates does NOT prune a same-title candidate at a DIFFERENT venue (ship-check P0 2026-08-11: title-only match would erase a real new production)', () => {
  const staged = [
    { title: 'Hamlet', venue: 'A New Off-Broadway Space', source: 'bww-roundup' },
  ];
  // shows.json has an unrelated, long-closed "Hamlet" at a different venue —
  // same title slug, but a title-only prune would wrongly delete the NEW
  // Hamlet's discovery signal. Venue must also match.
  const shows = [
    { id: 'hamlet-2009', category: 'off-broadway', title: 'Hamlet', venue: 'Some Other Theatre' },
  ];
  const { kept, pruned } = pruneStagedCandidates(staged, shows);
  assert.equal(pruned.length, 0);
  assert.deepEqual(kept.map(c => c.title), ['Hamlet']);
});

test('pruneStagedCandidates only matches off-broadway/regional shows, never a broadway/west-end namesake', () => {
  const staged = [
    { title: 'Chess', venue: 'A New Off-Broadway Space', source: 'bww-roundup' },
  ];
  const shows = [
    { id: 'chess-2003', category: 'broadway', title: 'Chess', venue: 'A New Off-Broadway Space' },
  ];
  const { kept, pruned } = pruneStagedCandidates(staged, shows);
  assert.equal(pruned.length, 0);
  assert.deepEqual(kept.map(c => c.title), ['Chess']);
});

test('pruneStagedCandidates tolerates junk input + missing shows', () => {
  assert.deepEqual(pruneStagedCandidates(null, []), { kept: [], pruned: [] });
  assert.deepEqual(pruneStagedCandidates([null, 'x', 42], []), { kept: [], pruned: [] });
  const r = pruneStagedCandidates([{ title: 'Real Show', venue: 'X' }], undefined);
  assert.equal(r.pruned.length, 0);
  assert.deepEqual(r.kept.map(c => c.title), ['Real Show']);
});

test('low-confidence PV entries are not new candidates', () => {
  const r = classifyCandidate({
    source: 'playbill-verdict',
    record: { url: 'https://playbill.com/article/x', slug: 'x', title: 'X', reason: 'low-confidence' },
    html: html('pv-broken-snow.html'),
    shows: NO_SHOWS,
  });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'low-confidence-existing-match');
});

test('regional feeder venues classify as category regional (2026-07-08)', () => {
  const { classifyVenueMarket } = require('./aggregator-candidate-extract.js');
  assert.equal(classifyVenueMarket('Arena Stage'), 'regional');
  assert.equal(classifyVenueMarket('Kreeger Theater'), 'regional');
  assert.equal(classifyVenueMarket('Goodman Theatre'), 'regional');
  assert.equal(classifyVenueMarket('American Repertory Theater'), 'regional');
  // NYC rental complex must NOT classify regional (QA finding 2026-07-08)
  assert.equal(classifyVenueMarket('A.R.T./New York Theatres'), 'off-broadway');
  assert.equal(classifyVenueMarket('La Jolla Playhouse'), 'regional');
  assert.equal(classifyVenueMarket('Steppenwolf Theatre'), 'regional');
  // NYC OB venues stay off-broadway
  assert.equal(classifyVenueMarket("St. Luke's Theatre"), 'off-broadway');
  assert.equal(classifyVenueMarket('Atlantic Theater Company'), 'off-broadway');
  assert.equal(classifyVenueMarket('Signature Center'), 'off-broadway');
  assert.equal(classifyVenueMarket(''), 'off-broadway');
  assert.equal(classifyVenueMarket(null), 'off-broadway');
  // "part" must not fuzzy-hit "mark taper" etc. — word-boundary anchored
  assert.equal(classifyVenueMarket('New Art Theatre'), 'off-broadway');
});

test('UK feeder venues classify as category regional (card #1405, 2026-08-13)', () => {
  const { classifyVenueMarket, feederVenueCity } = require('./aggregator-candidate-extract.js');
  assert.equal(classifyVenueMarket('Royal Shakespeare Theatre, Stratford-upon-Avon'), 'regional');
  assert.equal(classifyVenueMarket('Royal Shakespeare Company'), 'regional');
  assert.equal(classifyVenueMarket('Chichester Festival Theatre'), 'regional');
  assert.equal(feederVenueCity('Royal Shakespeare Theatre, Stratford-upon-Avon'), 'Stratford-upon-Avon');
  assert.equal(feederVenueCity('Chichester Festival Theatre'), 'Chichester');
  // "RSC" alone is deliberately excluded — too short, same rationale as bare "A.R.T."
  assert.equal(classifyVenueMarket('RSC'), 'off-broadway');
});

test('collisionSlugSet: title-derived and suffix-stripped slugs both collide (daily re-fetch loop guard)', () => {
  const { collisionSlugSet, slugCollidesWith } = require('./aggregator-candidate-extract.js');
  const set = collisionSlugSet([
    { slug: 'crazysexycool-regional-2026', title: 'CrazySexyCool: The TLC Musical' },
    { slug: 'iceboy-regional-2026', title: 'Iceboy!' },
  ]);
  assert.equal(slugCollidesWith('Crazysexycool: The Tlc Musical', set), true, 'title-derived slug must collide');
  assert.equal(slugCollidesWith('Iceboy!', set), true, 'suffix-stripped slug must collide');
  assert.equal(slugCollidesWith('Some Unrelated Show', set), false);
});

// --- parenthesised subtitles vs headline venue clauses (2026-08-05) ---------
// normalizeTitle() DROPS parentheticals (right for "(59e59)" venue noise), but
// some titles carry a parenthesised subtitle that is genuinely part of the
// name, and BWW's slug spells it out while its body keeps the brackets and
// appends " at <venue>". That normalized to "two strangers carry a cake across
// new york" vs "two strangers at a r t" — 30 edits apart — so the CORRECT
// roundup was rejected and the show could not be auto-added (run 31029032996,
// GH #542/#548).
test('a parenthesised subtitle plus a headline venue clause still matches', () => {
  assert.equal(
    classifyTitleDelta(
      'Two Strangers Carry A Cake Across New York',
      'TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK) at A.R.T.'
    ),
    'match'
  );
  // A house named WITHOUT venue vocabulary ("the St. James", "the Majestic")
  // is indistinguishable from a title continuation, so it is NOT stripped and
  // the pair stays a mismatch. Deliberate: rejecting costs a manual add, while
  // stripping non-venue words is how "Dinner" matched "Dinner at Eight".
  assert.equal(classifyTitleDelta('Sunset Blvd', 'Sunset Blvd. at the St. James'), 'mismatch');
  // With venue vocabulary present it matches, which is the real BWW shape.
  assert.equal(classifyTitleDelta('Sunset Blvd', 'Sunset Blvd. at the St. James Theatre'), 'match');
});

test('a non-venue "at" clause is part of the title and never stripped', () => {
  // stripTrailingVenueClause() cannot tell a venue from a title: "Dinner at
  // Eight" and "Meet Me at the Fair" are real shows whose "at" clause is part
  // of the NAME. Without a substantiality floor, a request for "Dinner" matched
  // the "Dinner at Eight" roundup and would have written the WRONG show into
  // shows.json — the exact failure the guard exists to prevent (found by
  // ship-check adversarial review, 2026-08-05; the first cut of this feature
  // shipped with it).
  assert.equal(classifyTitleDelta('Dinner', 'Dinner at Eight'), 'mismatch');
  assert.equal(classifyTitleDelta('Meet Me', 'Meet Me at the Fair'), 'mismatch');
  // Collateral, and accepted: a genuine one-word title plus a real venue no
  // longer auto-matches either. Rejecting costs a manual add; a false accept
  // corrupts the catalog.
  assert.equal(classifyTitleDelta('Gypsy', 'Gypsy at the Majestic'), 'mismatch');
});

test('loosening never rescues a genuinely different show', () => {
  assert.equal(classifyTitleDelta('The Outsiders', 'GATSBY Makes its World Premiere at ART'), 'mismatch');
  assert.equal(classifyTitleDelta('Wicked', 'Hamilton at the Richard Rodgers'), 'mismatch');
  // The trap the loosened form must NOT create: stripping a venue clause
  // shortens both sides, and on short titles "Cats"/"Dogs" collapses to edit
  // distance 3 — which add-requested-show.js would ACCEPT, since it rejects
  // only on 'mismatch'. The loosened comparison is therefore exact-equality
  // only and is never fed into the distance threshold.
  assert.equal(classifyTitleDelta('Cats', 'Dogs at the Palace'), 'mismatch');
});

test('pre-existing venue-parenthetical and typo behaviour is unchanged', () => {
  assert.equal(classifyTitleDelta('Cable Street', 'Cable Street (59e59)'), 'match');
  assert.equal(classifyTitleDelta('Hamilton', 'Hamilton'), 'match');
  assert.equal(classifyTitleDelta('Hamilton', 'Hamiltone'), 'typo');
  assert.equal(classifyTitleDelta('Hamilton', 'Wicked'), 'mismatch');
});

// --- stage/hall names, not just company names (2026-08-05, owner decision) ---
// Aggregators name the HALL, not the company: BroadwayWorld filed Two Strangers
// under "A.R.T.'s Loeb Drama Center", which matched nothing, so a genuine
// Cambridge tryout classified 'off-broadway' and add-requested-show refused it
// (run 31029607629). The company was already allowlisted — only its stage name
// was missing. Users talk this way too ("The Weiss at La Jolla", GH #542).
test('a feeder venue is recognised by its stage name, not only its company name', () => {
  const { feederVenueCity } = require('./aggregator-candidate-extract.js');
  assert.equal(feederVenueCity("A.R.T.'s Loeb Drama Center"), 'Cambridge, MA');
  assert.equal(feederVenueCity('Loeb Drama Center'), 'Cambridge, MA');
  assert.equal(feederVenueCity('Mandell Weiss Forum'), 'La Jolla, CA');
  assert.equal(feederVenueCity("La Jolla Playhouse's Mandell Weiss Theatre"), 'La Jolla, CA');
  assert.equal(feederVenueCity('Sheila and Hughes Potiker Theatre'), 'La Jolla, CA');
  assert.equal(feederVenueCity('Lowell Davies Festival Theatre'), 'San Diego, CA');
  assert.equal(feederVenueCity('Roda Theatre'), 'Berkeley, CA');
  assert.equal(feederVenueCity('Toni Rembe Theater'), 'San Francisco, CA');
});

test('company names still classify exactly as before', () => {
  const { feederVenueCity } = require('./aggregator-candidate-extract.js');
  assert.equal(feederVenueCity('American Repertory Theater'), 'Cambridge, MA');
  assert.equal(feederVenueCity('La Jolla Playhouse'), 'La Jolla, CA');
  assert.equal(feederVenueCity('The Old Globe'), 'San Diego, CA');
  assert.equal(feederVenueCity('Berkeley Repertory Theatre'), 'Berkeley, CA');
});

test('A.R.T./New York stays Off-Broadway — the ambiguity the bare pattern avoids', () => {
  const { classifyVenueMarket } = require('./aggregator-candidate-extract.js');
  // A real NYC Off-Broadway rental complex that shares the "A.R.T." initials
  // with Cambridge's American Repertory Theater. Adding stage names must not
  // reintroduce the collision the original comment warned about — which is why
  // the new patterns name HALLS ("Loeb Drama Center") and never bare "A.R.T.".
  assert.equal(classifyVenueMarket('A.R.T./New York Theatres'), 'off-broadway');
  assert.equal(classifyVenueMarket('A.R.T. / New York Theatres'), 'off-broadway');
  // Ordinary Broadway/Off-Broadway houses must never become regional.
  assert.equal(classifyVenueMarket('Booth Theatre'), 'off-broadway');
  assert.equal(classifyVenueMarket('Lucille Lortel Theatre'), 'off-broadway');
  assert.equal(classifyVenueMarket('Vivian Beaumont Theater'), 'off-broadway');
});

// --- editorial headline furniture (2026-08-05) ------------------------------
// BWW headlines describe the EVENT: "THE OUTSIDERS World Premiere Opens at La
// Jolla Playhouse". The slug carries the bare title, so the two disagreed by
// several words and a request for "The Outsiders" was refused against its own
// correct roundup (dry run, 2026-08-05).
test('editorial suffixes on an aggregator headline do not block a real match', () => {
  assert.equal(classifyTitleDelta('The Outsiders', 'THE OUTSIDERS World Premiere'), 'match');
  assert.equal(
    classifyTitleDelta('The Outsiders', 'THE OUTSIDERS World Premiere Opens at La Jolla Playhouse'),
    'match'
  );
  assert.equal(
    classifyTitleDelta('3 Summers of Lincoln', '3 SUMMERS OF LINCOLN at La Jolla Playhouse'),
    'match'
  );
});

test('stripping editorial furniture never rescues a different show', () => {
  // The trap: "World Premiere" appears in BOTH, but the shows differ. This is
  // the real SERP collision that add-requested-show hit while looking for The
  // Outsiders (run 31028149298) — it must stay rejected.
  assert.equal(classifyTitleDelta('The Outsiders', 'GATSBY Makes its World Premiere at ART'), 'mismatch');
  assert.equal(classifyTitleDelta('Wicked', 'Hamilton at the Gershwin Theatre'), 'mismatch');
  // A title whose real name IS one of the stripped words survives intact.
  assert.equal(classifyTitleDelta('The Revival', 'The Revival'), 'match');
  assert.equal(classifyTitleDelta('Opening Night', 'Opening Night'), 'match');
});

// --- a bare venue keyword is ordinary English, not a venue (2026-08-05) ------
// Second adversarial-review catch in this class. Treating any "at <...keyword>"
// clause as a venue stripped real title words: "Meet Me at the Forum" and
// "A Night at the Stage" collapsed to one-word stems and false-matched — the
// same defect as "Dinner"/"Dinner at Eight". A real venue clause names a
// SPECIFIC house, so a keyword now needs a proper-noun word beside it.
test('a bare venue keyword does not make an "at" clause a venue', () => {
  assert.equal(classifyTitleDelta('Meet Me', 'Meet Me at the Forum'), 'mismatch');
  assert.equal(classifyTitleDelta('A Night', 'A Night at the Stage'), 'mismatch');
  assert.equal(classifyTitleDelta('Drama', 'Drama at Eight'), 'mismatch');
  assert.equal(classifyTitleDelta('Dinner', 'Dinner at Eight'), 'mismatch');
});

test('a specific named house IS a venue and still strips', () => {
  assert.equal(classifyTitleDelta('Sunset Blvd', 'Sunset Blvd. at the St. James Theatre'), 'match');
  assert.equal(
    classifyTitleDelta('3 Summers of Lincoln', '3 SUMMERS OF LINCOLN at La Jolla Playhouse'),
    'match'
  );
  // House initialisms resolve too — this is the real Two Strangers headline.
  assert.equal(
    classifyTitleDelta(
      'Two Strangers Carry A Cake Across New York',
      'TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK) at A.R.T.'
    ),
    'match'
  );
});

test('loosened matching terminates fast on adversarial input', () => {
  // EDITORIAL_SUFFIX_RE is global and runs in a loop; guard against a
  // pathological rescan turning a feedback dispatch into a hung job.
  const t0 = Date.now();
  classifyTitleDelta('Hamilton', 'World Premiere Opens '.repeat(400) + 'x');
  classifyTitleDelta('Hamilton', 'at the ' + 'Theatre '.repeat(500));
  assert.ok(Date.now() - t0 < 2000, 'title matching must not backtrack catastrophically');
});

// --- the written title is the SHOW, not the headline (2026-08-05) -----------
// Both shows added on 2026-08-05 landed in the public catalog as
// "THE OUTSIDERS World Premiere" and
// "TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK) at A.R.T." — that is what a
// visitor would have read on the show page, and the id/slug were derived from
// it. Only the WRITTEN record is cleaned; every comparison still runs on the
// raw headline, so no classification or dedupe decision moves.
test('a candidate title is cleaned of headline furniture before it is written', () => {
  assert.equal(cleanCandidateTitle('THE OUTSIDERS World Premiere'), 'The Outsiders');
  assert.equal(
    cleanCandidateTitle('TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK) at A.R.T.'),
    'Two Strangers (Carry A Cake Across New York)'
  );
  assert.equal(cleanCandidateTitle('3 SUMMERS OF LINCOLN at La Jolla Playhouse'), '3 Summers Of Lincoln');
  assert.equal(cleanCandidateTitle('GYPSY World Premiere'), 'Gypsy');
});

test('cleaning never mangles a title that is already correct', () => {
  assert.equal(cleanCandidateTitle('Hamilton'), 'Hamilton');
  assert.equal(
    cleanCandidateTitle('Two Strangers (Carry a Cake Across New York)'),
    'Two Strangers (Carry a Cake Across New York)'
  );
  // A non-venue "at" clause is part of the name and must survive.
  assert.equal(cleanCandidateTitle('Dinner at Eight'), 'Dinner at Eight');
});

test('a show whose real name IS editorial vocabulary is left alone', () => {
  // Stripping "World Premiere" down to "World" would silently rename a show.
  // Better a slightly noisy title than a mangled one — noise is recoverable.
  assert.equal(cleanCandidateTitle('World Premiere'), 'World Premiere');
  assert.equal(cleanCandidateTitle('Opening Night'), 'Opening Night');
  assert.equal(cleanCandidateTitle(''), '');
  assert.equal(cleanCandidateTitle(undefined), '');
});

// The clean title must NOT change the show's IDENTITY. The nightly crawl's
// already-in-shows gate compares slugify(RAW headline) against
// collisionSlugSet(shows). If the slug were cleaned too, every raw-derived
// member of that set disappears, the gate stops matching the headline the show
// came from, and the article re-fetches + re-stages EVERY NIGHT forever — the
// exact failure collisionSlugSet's header warns about. Caught by adversarial
// review, 2026-08-05, after the first cut cleaned the slug as well.
test('cleaning the title does not break the nightly already-in-shows gate', () => {
  const { collisionSlugSet, slugCollidesWith } = require('./aggregator-candidate-extract.js');
  const { slugify } = require('./deduplication.js');
  const RAW = 'THE OUTSIDERS World Premiere';
  // The show exactly as the promoter creates it: raw-derived slug, clean title.
  const promoted = {
    id: slugify(RAW) + '-regional-2023',
    slug: slugify(RAW) + '-regional-2023',
    title: cleanCandidateTitle(RAW),
  };
  assert.equal(promoted.title, 'The Outsiders', 'the visible title is clean');
  assert.ok(promoted.slug.startsWith('the-outsiders-world-premiere'), 'identity stays raw-derived');
  assert.equal(
    slugCollidesWith(RAW, collisionSlugSet([promoted])),
    true,
    'the roundup that created this show must still collide with it, or it re-stages nightly'
  );
});
