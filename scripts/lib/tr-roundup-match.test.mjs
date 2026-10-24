// BRO-6084: production matching, REST pagination and reconcile classification for the
// theatre.reviews full-archive run. Real functions, real round-up index (290 posts,
// tests/fixtures/tr-roundups/posts-page{1,2,3}.json from the live reviews-roundup category).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', '..', 'tests', 'fixtures', 'tr-roundups');
const pages = [1, 2, 3].map((n) => JSON.parse(fs.readFileSync(path.join(FIX, `posts-page${n}.json`), 'utf8')));
const allPosts = pages.flat();

const { matchAllRoundups, matchRoundupToShow, parseRoundupPost, cleanRoundupTitle } = require('./tr-roundup-match.js');
const { discoverRoundupPostsRest } = require('./theatre-reviews-discovery.js');
const { classifyRows, coverageEntry, isPseudoRow, canonicalLabel, archiveUrlOf, sameRoundupUrl } = require('./tr-reconcile.js');
const { extractReviews } = require('../scrape-theatre-reviews.js');

const show = (id, title, category, openingDate, venue) => ({ id, title, category, openingDate, venue, market: 'west-end' });
const SHOWS = [
  show('some-woman-west-end-2026', 'Some Woman', 'west-end', '2026-10-15', 'National Theatre'),
  show('martin-guerre-west-end-2026', 'Martin Guerre', 'west-end', '2026-10-20', 'The Old Vic'),
  show('waiting-for-godot-west-end-2024', 'Waiting for Godot', 'west-end', '2024-09-19', 'Theatre Royal Haymarket'),
  show('waiting-for-godot-west-end-2017', 'Waiting for Godot', 'west-end', '2017-09-07', 'Arts Theatre'),
  show('much-ado-about-nothing-west-end-2025', 'Much Ado About Nothing', 'west-end', '2025-02-19', 'Theatre Royal Drury Lane'),
  show('much-ado-about-nothing-west-end-2022', 'Much Ado About Nothing', 'west-end', '2022-07-18', 'Lyttelton Theatre'),
  show('the-seagull-west-end-2022', 'The Seagull', 'west-end', '2022-07-07', 'Harold Pinter Theatre'),
  show('the-hunger-games-on-stage-west-end-2025', 'The Hunger Games on Stage', 'off-west-end', '2025-11-12', 'Troubadour Canary Wharf Theatre'),
];

test('fixture is the whole archive index', () => {
  assert.equal(allPosts.length, 290);
});

test('REST discovery walks every page until a short one, de-duplicating', async () => {
  const urls = [];
  const fetchJSON = async (u) => { urls.push(u); const n = Number(new URL(u).searchParams.get('page')); return pages[n - 1] || []; };
  const r = await discoverRoundupPostsRest(fetchJSON);
  assert.equal(r.posts.length, 290);
  assert.equal(r.pages, 3);
  assert.equal(r.complete, true);
  assert.equal(urls.length, 3, 'stops at the short third page');
  assert.match(urls[0], /categories=2030&per_page=100&page=1/);
});

test('REST discovery reports an incomplete walk when page 1 fails or the page cap is hit', async () => {
  const dead = await discoverRoundupPostsRest(async () => null);
  assert.deepEqual([dead.posts.length, dead.complete], [0, false]);
  const endless = await discoverRoundupPostsRest(async (u) => Array.from({ length: 100 }, (_, i) => ({ id: Number(new URL(u).searchParams.get('page')) * 1000 + i, link: 'x' })), { maxPages: 2 });
  assert.equal(endless.posts.length, 200);
  assert.equal(endless.complete, false);
});

test('REST discovery survives a page that throws after the first', async () => {
  const fetchJSON = async (u) => { const n = Number(new URL(u).searchParams.get('page')); if (n === 2) throw new Error('blocked'); return pages[0]; };
  const r = await discoverRoundupPostsRest(fetchJSON);
  assert.equal(r.posts.length, 100);
  assert.equal(r.complete, false, 'a failed page must not read as the end of the archive');
});

test('title cleaning strips boilerplate, badge and (revised)', () => {
  assert.equal(cleanRoundupTitle('Theatre reviews roundup: Martin Guerre'), 'Martin Guerre');
  assert.equal(cleanRoundupTitle('Reviews roundup: Tom Hiddleston &#038; Hayley Atwell in Much Ado About Nothing'), 'Tom Hiddleston & Hayley Atwell in Much Ado About Nothing');
});

test('right production by opening window and venue', () => {
  const { matched } = matchAllRoundups(allPosts, SHOWS);
  const byShow = Object.fromEntries(matched.map((m) => [m.show.id, m.roundup.slug]));
  assert.equal(byShow['some-woman-west-end-2026'], 'some-woman-dorfman-reviews');
  assert.equal(byShow['martin-guerre-west-end-2026'], 'martin-guerre-old-vic-reviews');
  assert.equal(byShow['waiting-for-godot-west-end-2024'], 'wishaw-waiting-for-godot-reviews');
  assert.equal(byShow['much-ado-about-nothing-west-end-2025'], 'hiddleston-atwell-much-ado-reviews');
});

test('wrong-production cases from BRO-6084 stay unmatched with a reason, never guessed', () => {
  const { matched, unmatched } = matchAllRoundups(allPosts, SHOWS);
  const ids = new Set(matched.map((m) => m.show.id));
  for (const id of ['waiting-for-godot-west-end-2017', 'much-ado-about-nothing-west-end-2022', 'the-seagull-west-end-2022']) {
    assert.ok(!ids.has(id), `${id} must not get another year's round-up`);
  }
  const seagull = unmatched.find((u) => u.roundup.slug === 'cate-blanchett-in-seagull-reviews');
  assert.ok(seagull && seagull.reason, 'the 2025 Seagull round-up is reported unmatched with a reason');
});

test('a round-up with no date to check against the show is not matched', () => {
  const r = matchRoundupToShow(parseRoundupPost({ link: 'https://theatre.reviews/reviews-roundup/some-woman-dorfman-reviews/', slug: 'some-woman-dorfman-reviews', title: { rendered: 'Theatre reviews roundup: Some Woman' } }), SHOWS);
  assert.ok(r.unmatched);
});

test('each show owns at most one round-up; extras are reported as duplicates', () => {
  const dup = [...allPosts.filter((p) => p.slug === 'martin-guerre-old-vic-reviews'),
    { ...allPosts.find((p) => p.slug === 'martin-guerre-old-vic-reviews'), id: 1, slug: 'martin-guerre-old-vic-reviews-2', link: 'https://theatre.reviews/reviews-roundup/martin-guerre-old-vic-reviews-2/', date: '2026-12-30T10:00:00' }];
  const { matched, unmatched } = matchAllRoundups(dup, SHOWS);
  assert.equal(matched.length, 1);
  assert.match(unmatched[0].reason, /^duplicate|no production/);
});

// ---- reconcile ----

const html = fs.readFileSync(path.join(FIX, 'some-woman-dorfman.html'), 'utf8');
const rows = extractReviews(html, 'some-woman-west-end-2026');

test('fixture page extracts every listed critic and drops the Buy tickets pseudo-row', () => {
  assert.equal(rows.length, 10);
  assert.ok(!rows.some((r) => isPseudoRow(r) === false && /buy tickets/i.test(r.outlet)));
  assert.equal(isPseudoRow({ outlet: 'Buy tickets' }), true);
  assert.equal(isPseudoRow({ outlet: '' }), true);
  for (const o of ['Click here to buy  tickets direct', 'www.andrewlloydwebber.com/show/jesus-christ-superstar', 'thedukeofyorks.com', 'Noël Coward Theatre']) {
    assert.equal(isPseudoRow({ outlet: o }), true, o);
  }
  for (const o of ['The Guardian', 'Time Out', 'Evening Standard', 'WhatsOnStage']) assert.equal(isPseudoRow({ outlet: o }), false, o);
  // Registered outlets whose labels look like a domain or a "...Theatre" venue are critic rows (ship-check).
  for (const o of ['London Theatre', 'Everything Theatre', 'A Younger Theatre', 'British Theatre', 'BritishTheatre.com', 'WhatsOnStage.com', 'broadwayworld.com']) {
    assert.equal(isPseudoRow({ outlet: o }), false, o);
  }
  // Prevention: no registered outlet name or alias may be classed as a pseudo-row (ticket resellers aside).
  const reg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'data', 'outlet-registry.json'), 'utf8'));
  const dropped = [];
  for (const [id, v] of Object.entries(reg.outlets || reg)) {
    if (/ticket/i.test(id)) continue;
    for (const n of [v.name, ...(v.aliases || [])].filter(Boolean)) if (isPseudoRow({ outlet: n })) dropped.push(`${id}:${n}`);
  }
  assert.deepEqual(dropped, []);
  assert.equal(canonicalLabel('Guardian review.'), 'The Guardian');
  assert.equal(canonicalLabel('Mail'), 'Daily Mail');
});

test('outlet abbreviations normalise (Time = The Times, Standard, i, Stage)', () => {
  assert.equal(canonicalLabel('Time'), 'The Times');
  assert.equal(canonicalLabel('Standard'), 'Evening Standard');
  assert.equal(canonicalLabel('i'), 'The i');
  assert.equal(canonicalLabel('Stage'), 'The Stage');
  const c = classifyRows([{ outlet: 'Time', critic: 'Clive Davis', url: 'https://www.thetimes.com/x' }], [{ file: 'f', data: { outletId: 'times-uk', criticName: 'Clive Davis', url: 'https://www.thetimes.com/x' } }], SHOWS[0]);
  assert.equal(c.held.length, 1);
});

test('held, excluded and missing are told apart; excluded is never resurrected', () => {
  const files = [
    { file: 'a', data: { outletId: 'standard', criticName: 'Nick Curtis', url: 'https://www.standard.co.uk/culture/theatre/some-woman' } },
    { file: 'b', data: { outletId: 'thestage', criticName: 'Sam Marlowe', wrongProduction: true } },
  ];
  const explain = (d) => (d.wrongProduction ? 'wrongProduction' : null);
  const c = classifyRows(rows, files, SHOWS[0], { explain });
  const names = (arr) => arr.map((r) => r.outlet).sort();
  assert.deepEqual(names(c.held), ['The Standard']);
  assert.equal(c.excluded.length + c.held.length + c.missing.length, c.listed);
  assert.equal(c.listed, 10);
  const stage = c.excluded.find((e) => e.outlet === 'The Stage');
  assert.equal(stage && stage.reason, 'wrongProduction');
  assert.ok(!c.missing.some((m) => m.outlet === 'The Stage'));
  assert.equal(c.missing.length, 8);
});

test('a transient exclusion reason keeps the row held, not excluded', () => {
  const files = [{ file: 'a', data: { outletId: 'standard', criticName: 'Nick Curtis' } }];
  const c = classifyRows(rows, files, SHOWS[0], { explain: () => 'noScore' });
  assert.equal(c.held.length, 1);
  assert.equal(c.excluded.length, 0);
});

test('coverage entry has the card shape', () => {
  const c = classifyRows(rows, [], SHOWS[0], { explain: () => null });
  const e = coverageEntry(SHOWS[0], 'https://theatre.reviews/reviews-roundup/some-woman-dorfman-reviews/', c);
  assert.deepEqual([e.showId, e.listed, e.held, e.excluded, e.missing], ['some-woman-west-end-2026', 10, 0, 0, 10]);
  assert.ok(e.roundupUrl);
});

test('archive canonical URL check catches a wrong-production legacy archive', () => {
  const canon = archiveUrlOf(html);
  assert.equal(canon, 'https://theatre.reviews/reviews-roundup/some-woman-dorfman-reviews/');
  assert.equal(sameRoundupUrl(canon, 'https://theatre.reviews/reviews-roundup/some-woman-dorfman-reviews'), true);
  assert.equal(sameRoundupUrl(canon, 'https://theatre.reviews/reviews-roundup/other-reviews/'), false);
  assert.equal(archiveUrlOf('<html></html>'), null);
});

test('a flagged file for a different url does not hide this round-up\'s real review', () => {
  const stageRow = rows.find((r) => r.outlet === 'The Stage');
  const files = [{ file: 'old', data: { outletId: 'thestage', criticName: stageRow.critic, url: 'https://www.thestage.co.uk/a-2017-production-review', wrongProduction: true } }];
  const explain = (d) => (d.wrongProduction ? 'wrongProduction' : null);
  const c = classifyRows([stageRow], files, SHOWS[0], { explain });
  assert.equal(c.excluded.length, 0);
  assert.equal(c.missing.length, 1);
  const same = [{ file: 'old', data: { ...files[0].data, url: stageRow.url } }];
  const c2 = classifyRows([stageRow], same, SHOWS[0], { explain });
  assert.equal(c2.excluded.length, 1, 'the same url stays excluded');
});

test('REST walk ends cleanly when WP answers 400 one page past a full last page', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, link: `https://theatre.reviews/p${i}/` }));
  const fetchJSON = async (u) => {
    if (new URL(u).searchParams.get('page') === '1') return full;
    throw new Error('HTTP 400');
  };
  const r = await discoverRoundupPostsRest(fetchJSON);
  assert.equal(r.posts.length, 100);
  assert.equal(r.complete, true);
  const flaky = async (u) => { if (new URL(u).searchParams.get('page') === '1') return full; throw new Error('HTTP 500'); };
  assert.equal((await discoverRoundupPostsRest(flaky)).complete, false, 'a 500 stays incomplete');
});
