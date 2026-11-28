// BRO-7196: no review card goes live without outlet display name, critic, publish date and pull quote.
// On Wanted's opening night (2026-11-08) the lane published rows with the raw outlet id as the name, no pull quote on
// any card, a null critic (Talkin' Broadway) and a null date (Cititour). These tests run Wanted-shaped reviews through
// the shared contract and through the real lane runner; with the fix reverted the lane publishes those rows as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('../../scripts/lib/review-completeness.js');
const trust = require('../../scripts/lib/opening-night-lane/trust-model.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const cardsCheck = require('../../scripts/lib/opening-night-checks/review-cards-complete.check.js');

const NIGHT = '2026-10-20';
const SHOW = { id: 'test-show-2026', title: 'Test Show', market: 'broadway', category: 'broadway', openingDate: NIGHT, status: 'open' };
const TEXT = [
  'Test Show arrives on Broadway with a cast that knows exactly what it is doing, and a director who trusts them.',
  'The second act is the stronger of the two, with a confrontation scene that left the audience silent.',
  'Not every song lands, but the score has a handful of numbers that will be hummed on the way out.',
  'The design is handsome without being fussy, and the lighting does a lot of quiet storytelling.',
].join(' ').repeat(3);

test('the contract flags each field the Wanted lane rows were missing', () => {
  const wantedRow = { outletId: 'chicagotribune', outlet: 'chicagotribune', criticName: null, publishDate: null };
  assert.deepEqual(card.missingCardFields(wantedRow), ['outlet', 'criticName', 'publishDate', 'pullQuote']);
  assert.deepEqual(card.missingCardFields({ ...wantedRow, criticName: 'Unknown' }, { quote: false }), ['outlet', 'criticName', 'publishDate']);
  const complete = { outletId: 'chicagotribune', outlet: 'Chicago Tribune', criticName: 'Chris Jones', publishDate: '2026-11-09', pullQuote: 'A sharp, funny, deeply felt evening.' };
  assert.deepEqual(card.missingCardFields(complete), []);
  assert.deepEqual(card.missingCardFields({ ...complete, outlet: 'chicagotribune' }), ['outlet'], 'an outlet id is not a display name');
  assert.deepEqual(card.missingCardFields({ ...complete, pullQuote: 'Wow.' }), ['pullQuote'], 'a stub quote does not count');
});

test('the lane names the outlet from the registry, never the raw id', () => {
  const row = trust.buildLaneReview({ showId: SHOW.id, night: NIGHT, source: 'aggregator', seenAt: `${NIGHT}T23:00:00Z`, outletId: 'chicagotribune', url: 'https://www.chicagotribune.com/x', fullText: TEXT });
  assert.equal(row.outlet, 'Chicago Tribune');
  assert.equal(card.outletDisplayName('talkinbroadway'), "Talkin' Broadway");
  assert.equal(card.outletDisplayName('no-such-outlet-xyz'), null);
});

test('the critic comes from a byline the text opens with, never from a credit line', () => {
  assert.equal(card.cardCriticName({ outletId: 'talkinbroadway', fullText: `Theatre Review by Howard Miller - November 8, 2026 Wanted. Book and lyrics by Angelica Cheri. ${TEXT}` }), 'Howard Miller');
  assert.equal(card.cardCriticName({ outletId: 'talkinbroadway', fullText: `Wanted. Book and lyrics by Angelica Cheri. Music by Ross Baum. ${TEXT}` }), null);
  assert.equal(card.cardCriticName({ outletId: 'guardian', criticName: 'Unknown', fullText: TEXT }), null);
  assert.equal(card.cardCriticName({ criticName: 'Arifa Akbar' }), 'Arifa Akbar');
});

test('the date comes from the review URL when the page gives none; never from the opening date', () => {
  assert.equal(card.cardPublishDate({ url: 'https://www.theguardian.com/stage/2026/oct/21/test-show-review' }), '2026-10-21');
  assert.equal(card.cardPublishDate({ url: 'https://example.com/test-show-review', openingDate: NIGHT }), null);
});

test('the card row carries the rebuild quote; the review file never gets pullQuote', () => {
  const file = { outletId: 'guardian', outlet: 'guardian', criticName: 'A Critic', publishDate: NIGHT, fullText: TEXT, assignedScore: 80 };
  const row = card.toCardRow(file, SHOW);
  assert.equal(row.outlet, 'The Guardian');
  assert.ok(row.pullQuote && row.pullQuote.length >= 20, `quote: ${row.pullQuote}`);
  assert.equal(file.pullQuote, undefined);
  assert.equal(file.outlet, 'guardian', 'toCardRow does not mutate the file row');
});

function laneNight(dir, candidates, pages, { maxPasses = 3 } = {}) {
  let doc = { reviews: [] };
  const ports = {
    updateReviews: async (fn) => { const out = fn(doc); doc = out.doc; return out; },
    pushData: async () => ({ ok: true, stderr: '' }), regenShow: async () => ({ missing: [] }), deploy: async () => ({}),
    fetchLiveShow: async () => ({ rv: doc.reviews.map((r) => ({ u: r.url })) }),
  };
  return runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, fetchText: async () => '', maxPasses,
    adapters: [{ name: 'agg', kind: 'aggregator', phase: 'main', discover: async () => candidates }],
    fetchReview: async (a) => pages[a.url] || pages[a.key],
    scoreReview: async () => 80,
    publishPorts: ports, dryRun: true, now: () => Date.parse(`${NIGHT}T23:00:00Z`), wait: async () => {},
  }).then((res) => ({ res, rows: doc.reviews }));
}

test('a Wanted-shaped night: every published card has outlet name, critic, date and quote', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7196-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guardian = 'https://www.theguardian.com/stage/2026/oct/20/test-show-review';
  const tribune = 'https://www.chicagotribune.com/2026/10/20/test-show-review/';
  const talkin = 'https://www.talkinbroadway.com/page/test-show-review';
  const candidates = [
    { url: guardian, outletId: 'guardian', source: 'aggregator', aggregatorCited: true },
    { url: tribune, outletId: 'chicagotribune', source: 'aggregator', aggregatorCited: true },
    { url: talkin, outletId: 'talkinbroadway', source: 'aggregator', aggregatorCited: true, publishDate: NIGHT },
  ];
  const pages = {
    // No outlet name from the page (inline-score's extractMeta never gives one) and no date (from the URL instead).
    [guardian]: { outletId: 'guardian', criticName: 'A Critic', fullText: TEXT },
    [tribune]: { outletId: 'chicagotribune', criticName: 'Chris Jones', fullText: TEXT, publishDate: NIGHT },
    // Talkin' Broadway's markup gave no byline on Wanted; its text opens with one.
    [talkin]: { outletId: 'talkinbroadway', criticName: null, fullText: `Theatre Review by Howard Miller - October 20, 2026 Test Show. ${TEXT}` },
  };
  const { res, rows } = await laneNight(dir, candidates, pages);
  assert.deepEqual(res.failed, []);
  assert.equal(rows.length, 3, 'all three reviews published');
  for (const r of rows) assert.deepEqual(card.missingCardFields(r), [], `${r.url}: ${JSON.stringify({ o: r.outlet, c: r.criticName, d: r.publishDate, q: r.pullQuote })}`);
  const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
  assert.equal(byUrl[tribune].outlet, 'Chicago Tribune');
  assert.equal(byUrl[talkin].criticName, 'Howard Miller');
  assert.equal(byUrl[guardian].publishDate, '2026-10-20');
});

test('a review with no critic anywhere is held, retried, then reported failed; it never goes live', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7196-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = 'https://www.theguardian.com/stage/2026/oct/20/test-show-review';
  let fetches = 0;
  const pages = new Proxy({}, { get: () => { fetches++; return { outletId: 'guardian', criticName: null, fullText: TEXT, publishDate: NIGHT }; } });
  const { res, rows } = await laneNight(dir, [{ url, outletId: 'guardian', source: 'aggregator', aggregatorCited: true }], pages, { maxPasses: 4 });
  assert.equal(rows.length, 0);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /incomplete card \(no criticName\)/);
  assert.equal(fetches, 3, 'retried on later passes (a byline can be late), then left to the regular pipeline');
});

test('a hard-paywall row as the lane really fetches it (no critic, no date, no text) publishes with its gaps reported', async (t) => {
  // inline-score.js fallback: { criticName: null, publishDate: null, fullText: '' }. Holding it would drop the NYT.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7196-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const junk = 'https://www.theguardian.com/stage/2026/oct/20/test-show-review';
  const paywall = 'https://www.nytimes.com/2026/10/20/theater/test-show-review.html';
  const candidates = [
    { url: junk, outletId: 'guardian', source: 'aggregator', aggregatorCited: true },
    { url: paywall, outletId: 'nytimes', source: 'aggregator', aggregatorCited: true },
  ];
  const pages = {
    [junk]: { outletId: 'guardian', criticName: 'A Critic', publishDate: NIGHT, fullText: 'x '.repeat(200) },
    [paywall]: { outletId: 'nytimes', criticName: null, publishDate: null, fullText: '' },
  };
  const { res, rows } = await laneNight(dir, candidates, pages);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(rows.map((r) => r.url).sort(), [junk, paywall].sort(), 'both go live, as the rebuild would ship them');
  const nyt = rows.find((r) => r.url === paywall);
  assert.equal(nyt.outlet, 'The New York Times');
  assert.equal(nyt.publishDate, '2026-10-20', 'date from the URL, never the opening date');
  const byKey = Object.fromEntries(res.quoteless.map((q) => [q.key, q.missing]));
  assert.deepEqual(byKey['https://nytimes.com/2026/10/20/theater/test-show-review.html'], ['criticName', 'pullQuote']);
  assert.deepEqual(byKey['https://theguardian.com/stage/2026/oct/20/test-show-review'], ['pullQuote'], 'junk text gives no quote: reported, not hidden');
});

test('a byline the rebuild would erase (outlet name, staff) counts as no critic', () => {
  for (const c of ["Talkin' Broadway", 'Staff Writer', 'Editorial Staff']) {
    assert.ok(card.missingCardFields({ outletId: 'talkinbroadway', outlet: "Talkin' Broadway", criticName: c, publishDate: NIGHT }, { quote: false }).includes('criticName'), c);
  }
  assert.deepEqual(card.missingCardFields({ outletId: 'talkinbroadway', outlet: "Talkin' Broadway", criticName: 'Howard Miller', publishDate: NIGHT }, { quote: false }), []);
});

test('opening-night check: a live card with an outlet id for a name or no quote alerts; unsigned or undated is listed only', () => {
  const show = { id: 'test-show-2026', title: 'Test Show' };
  const good = { outletId: 'guardian', outlet: 'The Guardian', criticName: 'A Critic', publishDate: NIGHT, pullQuote: 'A sharp, funny, deeply felt evening.', assignedScore: 80 };
  const ctx = (rows) => ({ reviewsDoc: { [show.id]: rows } });
  assert.equal(cardsCheck.run(show, ctx([good])).ok, true);
  const unsigned = cardsCheck.run(show, ctx([good, { ...good, criticName: null, publishDate: null }]));
  assert.equal(unsigned.ok, true, 'an unsigned, undated review is common and does not alert');
  assert.match(unsigned.message, /1 no criticName/);
  const wanted = cardsCheck.run(show, ctx([good, { ...good, outlet: 'chicagotribune', outletId: 'chicagotribune', pullQuote: undefined }]));
  assert.equal(wanted.ok, false);
  assert.equal(wanted.severity, 'warning');
  assert.equal(wanted.details.remediation.kind, 'alert');
  assert.equal(wanted.details.remediation.conditionKey, `opening-night-review-cards-complete-${show.id}`);
  assert.equal(cardsCheck.run(show, ctx([{ ...good, pullQuote: undefined, wrongProduction: true }])).ok, true, 'excluded rows are not live cards');
});

test('a show-listing footer is never a pull quote (Cititour on Wanted, The Counter, Titanique)', () => {
  const { hasListingChrome } = require('../../scripts/lib/pull-quote-guards.js');
  for (const chrome of [
    'Visit the Site Open/Close Dates Opening 11/8/2026 Closing Open-ended Theatre Info James Earl Jones Theatre 138 West 48th Street New York, NY 10036 Map',
    'Theatre Info Laura Pels Theatre 111 West 46th Street New York, NY 10036. Map Cititour.com is your guide to interesting places',
  ]) assert.equal(hasListingChrome(chrome), true, chrome);
  for (const prose of ['The cast is superb and the second act soars.', 'She lives at 200 West 54th Street and dreams of the stage.', 'The show is open-ended in the best way.'])
    assert.equal(hasListingChrome(prose), false, prose);
});

test('every registered outlet has a display name the lane accepts (no id-shaped displayName)', () => {
  // 11 outlets (oklahoman, masslive, 3views, ...) carried their own id as displayName, so the lane held every review
  // from them as "no outlet" and the site showed the lowercase id. Sentinel ids (junk parses) are excluded on purpose.
  const { isSentinelOutletId } = require('../../scripts/lib/review-normalization.js');
  const outlets = require('../../data/outlet-registry.json').outlets;
  // displayNameReviewed marks a verified lowercase brand ("letterboxd", BRO-6991): a human chose it, so it stays.
  const bad = Object.keys(outlets).filter((id) => !isSentinelOutletId(id) && !outlets[id].displayNameReviewed && !card.outletDisplayName(id));
  assert.deepEqual(bad, []);
});

// BRO-7273: Here There Are Blueberries (2026-11-09). Cititour's page text opens "Cititour.com Review" with no byline, so
// the lane held its row 3 passes for "no criticName" and the review went live ~6h after press night, via the regular pipeline.
const CITITOUR_PAGE = 'NYC Events, Restaurants, Music, & Nightlife\n\nCititour.com Review\n In theater, as in life, timing is often everything. '
  + 'Take the arrival of the Tectonic Project’s production of “Here There Are Blueberries,” now at Broadway’s Barrymore Theatre. '.repeat(3);

test('a Cititour page with no printed byline resolves to the outlet\'s fallback critic, so the lane does not hold it', () => {
  const row = { outletId: 'cititour', outlet: 'Cititour', criticName: null, fullText: CITITOUR_PAGE, publishDate: '2026-11-09' };
  assert.equal(card.cardCriticName(row), 'Brian Scott Lipton');
  const reg = require('../../data/outlet-registry.json');
  assert.ok(reg.outlets.cititour.laneFallbackCritic, 'cititour must keep its laneFallbackCritic');
});

test('the fallback never applies to an outlet without one, or one that rotates writers', () => {
  assert.equal(card.cardCriticName({ outletId: 'nysun', outlet: 'New York Sun', criticName: null, fullText: CITITOUR_PAGE }), null);
  // Class guard: no outlet may carry both a lane fallback and multiAuthor (a rotating byline would be mislabelled).
  const reg = require('../../data/outlet-registry.json');
  for (const [id, o] of Object.entries(reg.outlets)) {
    if (o.laneFallbackCritic) assert.notEqual(o.multiAuthor, true, `${id}: laneFallbackCritic on a multiAuthor outlet`);
  }
});
