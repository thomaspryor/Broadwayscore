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

const { matchAllRoundups, matchRoundupToShow, parseRoundupPost, cleanRoundupTitle, rematchWithVenues, venueFromContent } = require('./tr-roundup-match.js');
const { classifyOutOfScope, markOutOfScope, pinsFromOverrides } = require('./tr-out-of-scope.js');
const { fetchRoundupBodyVenues } = require('./theatre-reviews-discovery.js');
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

// ---- BRO-6096: body venue, run windows, ranking, pins, scope ------------------------------

const rd = (slug, title, date, venue) => ({ slug, title, date, url: `https://theatre.reviews/reviews-roundup/${slug}/`, venue });

test('venueFromContent reads the first short <h5>', () => {
  assert.equal(venueFromContent('<h5>Aldwych Theatre</h5><p>text</p><h5>other</h5>'), 'Aldwych Theatre');
  assert.equal(venueFromContent('<p>no heading</p>'), null);
  assert.equal(venueFromContent('<h5>' + 'x'.repeat(120) + '</h5>'), null, 'a paragraph-length heading is not a venue');
});

test('a body venue beats a misleading slug (Burlesque at the Savoy)', () => {
  const shows = [show('burlesque-west-end-2026', 'Burlesque', 'west-end', '2025-07-22', 'Savoy Theatre')];
  const r = matchRoundupToShow(rd('burlesque-savoy-reviews', 'Burlesque', '2025-07-23T10:00:00', 'Savoy Theatre'), shows);
  assert.equal(r.show && r.show.id, 'burlesque-west-end-2026');
});

test('a body venue naming another house vetoes the match', () => {
  const shows = [show('x-west-end-2025', 'Wings', 'west-end', '2025-03-01', 'Savoy Theatre')];
  const r = matchRoundupToShow(rd('wings-reviews', 'Wings', '2025-03-05T10:00:00', 'Almeida Theatre'), shows);
  assert.ok(r.unmatched, 'Almeida is not the Savoy');
});

test('a round-up during a long run matches through the in-run window', () => {
  const shows = [{ ...show('tina-west-end-2018', 'Tina', 'west-end', '2018-04-17', 'Aldwych Theatre'), closingDate: '2025-04-12' }];
  const r = matchRoundupToShow(rd('tina-reviews', 'Tina', '2024-01-10T10:00:00'), shows);
  assert.equal(r.show && r.show.id, 'tina-west-end-2018');
  assert.ok(r.reasons.includes('in-run'));
});

test('an open show with no closing date is in-run until today', () => {
  const shows = [{ ...show('cab-west-end-2021', 'Cabaret', 'west-end', '2021-12-01', 'Playhouse Theatre'), status: 'open' }];
  const r = matchRoundupToShow(rd('cabaret-reviews', 'Cabaret', '2025-09-06T10:00:00'), shows);
  assert.equal(r.show && r.show.id, 'cab-west-end-2021');
});

test('a round-up from a declared prior run matches, judged against the prior run venue', () => {
  const shows = [{ ...show('years-west-end-2025', 'The Years', 'west-end', '2025-02-04', 'Harold Pinter Theatre'),
    priorRuns: [{ openingDate: '2024-07-27', closingDate: '2024-08-31', venue: 'Almeida Theatre' }] }];
  const ok = matchRoundupToShow(rd('the-years-reviews', 'The Years', '2024-08-22T10:00:00', 'Almeida Theatre'), shows);
  assert.equal(ok.show && ok.show.id, 'years-west-end-2025');
  assert.ok(ok.reasons.includes('prior-run'));
  const wrong = matchRoundupToShow(rd('the-years-reviews', 'The Years', '2024-08-22T10:00:00', 'Donmar Warehouse'), shows);
  assert.ok(wrong.unmatched, 'a different house in the same window is not the prior run');
});

test('a touring prior run has no single venue to veto on', () => {
  const shows = [{ ...show('allegra-west-end-2026', 'Allegra', 'west-end', '2026-07-09', 'Harold Pinter Theatre'),
    priorRuns: [{ openingDate: '2026-05-12', closingDate: '2026-07-04', venue: 'UK tour (Theatre Royal Windsor, Bath and others)' }] }];
  const r = matchRoundupToShow(rd('allegra-lipman-reviews', 'Allegra', '2026-06-17T10:00:00', 'Orange Tree Theatre Richmond'), shows);
  assert.equal(r.show && r.show.id, 'allegra-west-end-2026');
});

test('the longer matching title wins over a one-word title ("A Good House" over "Good")', () => {
  const shows = [
    show('good-west-end-2025', 'Good', 'west-end', '2025-05-20', 'Royal Court'),
    show('a-good-house-west-end-2025', 'A Good House', 'west-end', '2025-05-22', 'Royal Court'),
  ];
  const r = matchRoundupToShow(rd('the-good-house-royal-court-reviews', 'The Good House', '2025-05-28T10:00:00', 'Royal Court'), shows);
  assert.equal(r.show && r.show.id, 'a-good-house-west-end-2025');
});

test('plural-only differences still match ("Hot Wings King" for "The Hot Wing King")', () => {
  const shows = [show('the-hot-wing-king-west-end-2024', 'The Hot Wing King', 'west-end', '2024-05-01', 'Dorfman Theatre')];
  const r = matchRoundupToShow(rd('hot-wings-king-reviews', 'Hot Wings King', '2024-05-07T10:00:00'), shows);
  assert.equal(r.show && r.show.id, 'the-hot-wing-king-west-end-2024');
});

test('a pin attaches a round-up whose date does not track the run, and is ignored if the show is gone', () => {
  const shows = [show('till-west-end-2024', 'Till the Stars Come Down', 'west-end', '2024-05-01', 'Dorfman Theatre')];
  const post = rd('til-the-stars-come-down-reviews', 'Til The Stars Come Down', '2025-01-06T10:00:00', 'Theatre Royal Haymarket');
  assert.ok(matchAllRoundups([post], shows).unmatched.length, 'unpinned: Jan 2025 is outside the Dorfman window');
  const pinned = matchAllRoundups([post], shows, { 'til-the-stars-come-down-reviews': 'till-west-end-2024' });
  assert.equal(pinned.matched[0].show.id, 'till-west-end-2024');
  assert.deepEqual(pinned.matched[0].reasons, ['pinned']);
  assert.equal(matchAllRoundups([post], shows, { 'til-the-stars-come-down-reviews': 'gone' }).matched.length, 0);
});

test('rematchWithVenues moves a round-up once its body venue is known, and never steals an owned show', () => {
  const shows = [show('burlesque-west-end-2026', 'Burlesque', 'west-end', '2025-07-22', 'Savoy Theatre')];
  const u = { roundup: { ...rd('burlesque-savoy-reviews', 'Burlesque', '2025-07-23T10:00:00'), id: 7 }, reason: 'venue in slug disagrees with the show', candidates: [] };
  const out = rematchWithVenues([], [u], shows, { 7: 'Savoy Theatre' });
  assert.equal(out.matched.length, 1);
  assert.ok(out.matched[0].reasons.includes('body-venue'));
  const owned = rematchWithVenues([{ roundup: {}, show: shows[0] }], [u], shows, { 7: 'Savoy Theatre' });
  assert.equal(owned.matched.length, 1);
  assert.equal(owned.unmatched.length, 1, 'the show already has a round-up');
});

test('fetchRoundupBodyVenues returns id -> venue and skips failures', async () => {
  const fetchJSON = async (u) => {
    if (u.includes('/posts/2?')) throw new Error('HTTP 500');
    return { id: 1, content: { rendered: '<h5>Almeida Theatre</h5><p>x</p>' } };
  };
  const m = await fetchRoundupBodyVenues(fetchJSON, [1, 2]);
  assert.deepEqual(m, { 1: 'Almeida Theatre' });
});

test('classifyOutOfScope: Off-West-End before 2026 is out; West End, 2026+ and mixed transfer strings are not', () => {
  const e = (venue, date = '2025-03-01') => ({ url: 'https://theatre.reviews/reviews-roundup/x-reviews/', date, venue });
  assert.match(classifyOutOfScope(e('Almeida Theatre')), /Off-West-End venue \(Almeida Theatre\)/);
  assert.equal(classifyOutOfScope(e('Almeida Theatre', '2026-03-01')), null, 'tracked from 2026-01-01');
  assert.equal(classifyOutOfScope(e('Savoy Theatre')), null);
  assert.equal(classifyOutOfScope(e('Dorfman at the national theatre')), null);
  assert.equal(classifyOutOfScope(e('menier chocolate factory / Garrick Theatre')), null, 'a transfer into the West End is a real gap');
  assert.equal(classifyOutOfScope(e(undefined)), null, 'no venue evidence, no verdict');
});

test('overrides: an explicit reason wins, a venue override feeds the rule, pins are extracted', () => {
  const ov = {
    'a-reviews': { outOfScope: 'immersive installation' },
    'b-reviews': { venue: 'Hampstead Theatre' },
    'c-reviews': { pin: 'c-west-end-2024' },
  };
  const e = (slug) => ({ url: `https://theatre.reviews/reviews-roundup/${slug}/`, date: '2024-05-01' });
  assert.equal(classifyOutOfScope(e('a-reviews'), ov), 'immersive installation');
  assert.match(classifyOutOfScope(e('b-reviews'), ov), /Hampstead Theatre/);
  assert.equal(classifyOutOfScope(e('c-reviews'), ov), null);
  assert.deepEqual(pinsFromOverrides(ov), { 'c-reviews': 'c-west-end-2024' });
  const marked = markOutOfScope([e('a-reviews'), e('c-reviews')], ov);
  assert.equal(marked.length, 2, 'never drops an entry');
  assert.equal(marked[0].outOfScope, true);
  assert.equal(marked[1].outOfScope, undefined);
});

test('the committed overrides file only holds well-formed entries', () => {
  const ov = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'data', 'theatre-reviews-scope-overrides.json'), 'utf8'));
  for (const [slug, o] of Object.entries(ov)) {
    assert.ok(o.outOfScope || o.venue || o.pin, `${slug} needs outOfScope, venue or pin`);
    assert.ok(typeof (o.evidence || o.outOfScope) === 'string', `${slug} needs evidence`);
  }
});

test('regression: a long run does not make a same-title round-up ambiguous (extra windows are a fallback)', () => {
  const shows = [
    { ...show('arcadia-a', 'Arcadia', 'west-end', '2026-03-10', 'The Old Vic'), closingDate: '2026-05-30' },
    { ...show('arcadia-b', 'Arcadia', 'west-end', '2025-01-10', 'Duke of York’s Theatre'), closingDate: '2026-04-01' },
  ];
  const r = matchRoundupToShow(rd('arcadia-old-vic-reviews', 'Arcadia', '2026-03-13T10:00:00', 'The Old Vic'), shows);
  assert.equal(r.show && r.show.id, 'arcadia-a');
});

test('regression: a subset-only match on a longer title does not outrank a full title match', () => {
  const shows = [
    show('jcs-a', 'Jesus Christ Superstar', 'west-end', '2026-06-01', 'Palladium'),
    show('jcs-b', 'Jesus Christ Superstar Theatre Royal Drury Lane', 'west-end', '2026-06-02', 'Theatre Royal Drury Lane'),
  ];
  const r = matchRoundupToShow(rd('jesus-christ-superstar-palladium-reviews', 'Jesus Christ Superstar', '2026-06-03T10:00:00', 'Palladium'), shows);
  assert.equal(r.show && r.show.id, 'jcs-a');
});

test('one shared venue word is not a venue hit ("Theatre Royal Haymarket" is not Drury Lane)', () => {
  const shows = [
    show('twin-west-end-2025', 'Twin Peaks Play', 'west-end', '2025-03-01', 'Theatre Royal Drury Lane'),
    show('twin-west-end-2025b', 'Twin Peaks Play', 'west-end', '2025-03-06', 'Palace Theatre'),
  ];
  const r = matchRoundupToShow(rd('twin-peaks-play-reviews', 'Twin Peaks Play', '2025-03-20T10:00:00', 'Theatre Royal Haymarket'), shows);
  assert.ok(!r.show, 'neither house is named, so the two same-window shows stay ambiguous');
  const ok = matchRoundupToShow(rd('twin-peaks-play-reviews', 'Twin Peaks Play', '2025-03-20T10:00:00', 'Theatre Royal Drury Lane'), shows);
  assert.equal(ok.show && ok.show.id, 'twin-west-end-2025');
});

test('accented house names match the plain spelling (Noel Coward / Noël Coward)', () => {
  const shows = [show('x-west-end-2025', 'The Last Laugh', 'west-end', '2025-02-25', 'Noël Coward Theatre')];
  const r = matchRoundupToShow(rd('the-last-laugh-reviews', 'The Last Laugh', '2025-02-27T10:00:00', 'Noel Coward Theatre'), shows);
  assert.equal(r.show && r.show.id, 'x-west-end-2025');
});

test('plural stemming does not turn a one-word headline into a longer title', () => {
  const shows = [show('girl-from-the-north-country-west-end-2017', 'Girl from the North Country', 'west-end', '2017-07-03', 'Noël Coward Theatre')];
  const r = matchRoundupToShow(rd('girls-reviews', 'Girls', '2017-07-10T10:00:00', null), shows);
  assert.ok(!r.show);
});

test('classifyOutOfScope reads TR venue spellings: Sohoplace and "company at the house" are West End', () => {
  const e = (venue) => ({ url: 'https://theatre.reviews/reviews-roundup/x-reviews/', date: '2024-08-05', venue });
  assert.equal(classifyOutOfScope(e('Sohoplace')), null);
  assert.equal(classifyOutOfScope(e('Kit Kat Club at the Playhouse Theatre')), null);
  assert.match(classifyOutOfScope(e('Huron Club at the SoHo Playhouse')), /Off-West-End/);
});
