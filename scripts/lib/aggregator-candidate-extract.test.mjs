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
  classifyCandidate,
  slugCollidesWith,
  pruneUnmatchedAudit,
  referenceTitle,
} = require('./aggregator-candidate-extract.js');

const html = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const NO_SLUGS = new Set();

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
    existingSlugs: NO_SLUGS,
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
    existingSlugs: NO_SLUGS,
  });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'typo-detected');
});

test('acceptance #6: historical backtest — Broken Snow / Bedlam / Heated Rivalry', () => {
  const brokenSnow = classifyCandidate({
    source: 'playbill-verdict',
    record: { url: 'https://playbill.com/article/broken-snow', slug: 'broken-snow', title: 'Broken Snow' },
    html: html('pv-broken-snow.html'),
    existingSlugs: NO_SLUGS,
  });
  assert.equal(brokenSnow.status, 'accept');
  assert.equal(brokenSnow.candidate.venue, 'Theatre 71');

  const bedlam = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-BEDLAMS-OTHELLO-At-The-West-End-Theatre-20260520', slug: 'Review-Roundup-BEDLAMS-OTHELLO-At-The-West-End-Theatre-20260520' },
    html: html('bww-bedlam-othello.html'),
    existingSlugs: NO_SLUGS,
  });
  assert.equal(bedlam.status, 'accept');
  assert.equal(bedlam.candidate.title, "Bedlam's Othello");
  assert.equal(bedlam.candidate.venue, 'West End Theatre');

  const heated = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-HEATED-RIVALRY-THE-UNAUTHORIZED-MUSICAL-PARODY-Opens-Off-Broadway-20260526', slug: 'Review-Roundup-HEATED-RIVALRY-THE-UNAUTHORIZED-MUSICAL-PARODY-Opens-Off-Broadway-20260526' },
    html: html('bww-heated-rivalry.html'),
    existingSlugs: NO_SLUGS,
  });
  assert.equal(heated.status, 'accept', 'venue from body prose');
  assert.equal(heated.candidate.venue, '6th Floor Theater');
});

test('bot-shell article is rejected even with a venue-shaped headline', () => {
  const r = classifyCandidate({
    source: 'playbill-verdict',
    record: { url: 'https://playbill.com/article/some-show', slug: 'some-show', title: 'Some Show' },
    html: html('bot-shell-no-date.html'),
    existingSlugs: NO_SLUGS,
  });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'bot-shell');
});

test('slug-collision guard rejects a title already in shows.json', () => {
  const r = classifyCandidate({
    source: 'bww-roundup',
    record: { url: 'https://www.broadwayworld.com/article/Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515', slug: 'Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre-20260515' },
    html: html('bww-dad-dont-read-this.html'),
    existingSlugs: new Set(['dad-dont-read-this']),
  });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'slug-collision');
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

test('low-confidence PV entries are not new candidates', () => {
  const r = classifyCandidate({
    source: 'playbill-verdict',
    record: { url: 'https://playbill.com/article/x', slug: 'x', title: 'X', reason: 'low-confidence' },
    html: html('pv-broken-snow.html'),
    existingSlugs: NO_SLUGS,
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
  assert.equal(classifyTitleDelta('Gypsy', 'Gypsy at the Majestic'), 'match');
  assert.equal(classifyTitleDelta('Sunset Blvd', 'Sunset Blvd. at the St. James'), 'match');
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
