// BRO-7683: BroadwayWorld local-review coverage audit + the add step for the US city hubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../../scripts/lib/bww-local-reviews.js');
const A = require('../../scripts/lib/bww-review-add.js');
const { hubsToAudit, auditHub } = require('../../scripts/bww-regional-coverage.js');
const registry = require('../../data/city-hubs.json');

const dc = hubsToAudit(registry, 'washington-dc')[0];
const NIXON_URL = 'https://www.broadwayworld.com/washington-dc/article/Review-NIXON-IN-CHINA-at-Washington-National-Opera-20261116';

const listing = (items) => `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, item: it })) })}</script></html>`;

test('every launched US hub has a BroadwayWorld region to audit', () => {
  const hubs = hubsToAudit(registry);
  for (const slug of ['washington-dc', 'chicago-il', 'los-angeles-ca', 'san-diego-ca', 'boston-ma']) assert.ok(hubs.find((h) => h.metro === slug), slug);
});

test('parse: JSON-LD list, "Review:" prefix, title cleaned out of mixed-case headlines, other regions ignored', () => {
  const rows = L.parseLocalReviews(listing([
    { url: NIXON_URL, headline: 'Review: NIXON IN CHINA at Washington National Opera', datePublished: '2026-11-16T10:00:00Z' },
    { url: 'https://www.broadwayworld.com/chicago/article/Review-JEKYLL-HYDE-20261101', headline: "Review: Kokandy Productions' JEKYLL &amp; HYDE at Chopin Theatre", datePublished: '2026-11-01' },
    { url: 'https://www.broadwayworld.com/boston/article/Review-X-20261101', headline: 'Review: X at Y', datePublished: '2026-11-01' },
  ]), 'washington-dc');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].title, rows[0].venue, rows[0].date], ['NIXON IN CHINA', 'Washington National Opera', '2026-11-16']);
  assert.equal(L.cleanTitle("Kokandy Productions' JEKYLL & HYDE"), 'JEKYLL & HYDE');
  assert.equal(L.cleanTitle('DIRTY DANCING Presented by Broadway In Chicago'), 'DIRTY DANCING');
  assert.equal(L.cleanTitle("The Huntington's TO KILL A MOCKINGBIRD Isn't Novel"), 'TO KILL A MOCKINGBIRD');
});

test('classify: the Nixon in China miss (a resident opera company at a tour house) is reported, then covered once added', () => {
  const review = { url: NIXON_URL, title: 'NIXON IN CHINA', venue: 'Kennedy Center Opera House', headline: 'Review: NIXON IN CHINA at Kennedy Center Opera House', date: '2026-11-16' };
  // Kennedy Center is a DC tour house: without the WNO exemption this was skipped as a tour.
  assert.equal(L.classifyReview(review, { shows: [], metro: 'washington-dc', tourHouses: dc.tourHouses }).status, 'tour-house');
  const wno = { ...review, venue: 'Washington National Opera' };
  assert.equal(L.classifyReview(wno, { shows: [], metro: 'washington-dc', tourHouses: dc.tourHouses }).status, 'missing');
  const row = { id: 'nixon-in-china-regional-2026', title: 'Nixon in China', category: 'regional', city: 'washington-dc', venue: 'Kennedy Center Opera House, Washington, DC', openingDate: '2026-11-08' };
  assert.equal(L.classifyReview(wno, { shows: [row], metro: 'washington-dc', tourHouses: dc.tourHouses }).status, 'covered');
});

test('classify: tours in their window, non-theatre, kids venues and declined reviews are not reported', () => {
  const ctx = (shows, decisions) => ({ shows, metro: 'chicago-il', tourHouses: [/cadillac palace/i], decisions });
  const tour = { id: 'dirty-dancing-tour', title: 'Dirty Dancing', category: 'tour', openingDate: '2026-09-01' };
  const r = { url: 'u1', title: 'DIRTY DANCING', venue: 'Cadillac Palace Theatre', headline: '', date: '2026-11-01' };
  assert.equal(L.classifyReview(r, ctx([tour])).status, 'covered-tour');
  assert.equal(L.classifyReview(r, ctx([])).status, 'tour-house');
  assert.equal(L.classifyReview({ ...r, title: 'SWAN LAKE', venue: 'Joffrey Ballet' }, ctx([])).status, 'excluded');
  assert.equal(L.classifyReview({ ...r, venue: 'Steppenwolf' }, ctx([], { u1: { decision: 'community' } })).status, 'declined');
  assert.equal(L.classifyReview({ ...r, venue: 'Steppenwolf' }, ctx([])).status, 'missing');
  // A same-title row that closed long before the review is a different production.
  const old = { id: 'dirty-dancing-regional-2019', title: 'Dirty Dancing', category: 'regional', city: 'chicago-il', openingDate: '2019-01-01', closingDate: '2019-03-01' };
  assert.equal(L.classifyReview({ ...r, venue: 'Steppenwolf' }, ctx([old])).status, 'missing');
});

test('auditHub: a page that fails to load is a fetch error, never coverage; one production with two reviews is one row', async () => {
  const failing = await auditHub(dc, { shows: [], since: '2026-10-01', maxPages: 3, fetchHtml: async () => { throw new Error('blocked'); } });
  assert.equal(failing.fetchErrors.length, 1);
  assert.equal(failing.missing.length, 0);
  const page = listing([
    { url: NIXON_URL, headline: 'Review: NIXON IN CHINA at Washington National Opera', datePublished: '2026-11-16' },
    { url: NIXON_URL.replace('20261116', '20261117'), headline: 'BWW Review: NIXON IN CHINA at Washington National Opera', datePublished: '2026-11-17' },
  ]);
  const ok = await auditHub(dc, { shows: [], since: '2026-10-01', maxPages: 1, fetchHtml: async () => page });
  assert.equal(ok.missing.length, 1);
  assert.equal(ok.missing[0].urls.length, 2);
});

const TEXT = 'Washington National Opera opened Nixon in China at the Kennedy Center Opera House on November 8, and it runs through November 22. The Kennedy Center production is a triumph in Washington.';

test('checkReading: keeps only what the text prints; rejects a reading of another show', () => {
  const ok = A.checkReading({ title: 'Nixon in China', kind: 'professional', type: 'opera', theatre: 'Kennedy Center Opera House', town: 'Washington', state: 'DC', openingDate: '2026-11-08', closingDate: '2026-11-22', firstPerformance: '2026-11-01' }, { text: TEXT, today: '2026-11-17', headline: 'Review: NIXON IN CHINA at Washington National Opera' });
  assert.ok(ok.ok);
  assert.equal(ok.facts.openingDate, '2026-11-08');
  assert.equal(ok.facts.firstPerformance, null, 'Nov 1 is not printed');
  assert.equal(A.checkReading({ title: 'Legally Blonde', kind: 'professional', theatre: 'Kennedy Center' }, { text: `${TEXT} Legally Blonde`, today: '2026-11-17', headline: 'Review: NIXON IN CHINA' }).ok, false);
  assert.equal(A.checkReading({ title: 'Nixon in China', kind: 'professional', theatre: 'Arena Stage' }, { text: TEXT, today: '2026-11-17' }).ok, false);
});

test('buildShow: a closing date before the start or a run past five months is dropped; ids skip a leading article', () => {
  const ctx = { review: { url: 'u', date: '2026-10-14' }, hubSlug: 'chicago-il', hubShows: [], hubHome: { town: 'Chicago', state: 'IL' }, taken: new Set(), today: '2026-11-17' };
  const f = { title: 'Heroes of the Fourth Turning', kind: 'professional', type: 'play', theatre: 'A Red Orchid', town: 'Chicago', state: 'IL', openingDate: null, firstPerformance: null, closingDate: '2026-10-03' };
  const s = A.buildShow(f, ctx).show;
  assert.equal(s.closingDate, undefined);
  assert.ok(!/-a-regional/.test(s.id), s.id);
  assert.equal(s.city, 'chicago-il');
  assert.equal(A.buildShow({ ...f, closingDate: '2027-12-12' }, ctx).show.closingDate, undefined);
  assert.equal(A.buildShow({ ...f, closingDate: '2026-11-30' }, ctx).show.closingDate, '2026-11-30');
});

test('placeFor: a known venue without a town gets the model town only inside the hub metro', () => {
  const boston = { hubSlug: 'boston-ma', hubShows: [], hubHome: { town: 'Boston', state: 'MA' } };
  assert.deepEqual(A.placeFor({ theatre: 'Merrimack Repertory Theatre', town: null, modelTown: 'Lowell', state: 'MA' }, boston), { town: 'Lowell', state: 'MA' });
  assert.equal(A.placeFor({ theatre: 'Some Theatre', town: null, modelTown: 'Hartford', state: 'CT' }, boston), null);
});

// Ship-check findings (BRO-7683): the cases each fix covers.
test('auditHub: two companies\' productions of one title stay two rows', async () => {
  const page = listing([
    { url: 'https://www.broadwayworld.com/washington-dc/article/Review-LITTLE-SHOP-OF-HORRORS-at-Signature-Theatre-20261101', headline: 'Review: LITTLE SHOP OF HORRORS at Signature Theatre', datePublished: '2026-11-01' },
    { url: 'https://www.broadwayworld.com/washington-dc/article/Review-LITTLE-SHOP-OF-HORRORS-at-Port-City-Playhouse-20261105', headline: 'Review: LITTLE SHOP OF HORRORS at Port City Playhouse', datePublished: '2026-11-05' },
  ]);
  const r = await auditHub(dc, { shows: [], since: '2026-10-01', maxPages: 1, fetchHtml: async () => page });
  assert.equal(r.missing.length, 2);
});

test('classify: an "exists" verdict lapses when its row is gone', () => {
  const review = { url: NIXON_URL, title: 'Nixon in China', venue: 'Washington National Opera', date: '2026-11-16' };
  const decisions = { [NIXON_URL]: { decision: 'exists', showId: 'gone-regional-2026' } };
  assert.equal(L.classifyReview(review, { shows: [], metro: 'washington-dc', decisions }).status, 'missing');
  assert.equal(L.classifyReview(review, { shows: [{ id: 'gone-regional-2026', title: 'Other', openingDate: '2020-01-01' }], metro: 'washington-dc', decisions }).status, 'declined');
});

test('buildShow: an open-ended run past 60 days is closed; an all-caps title is title-cased', () => {
  const ctx = { review: { url: 'u', date: '2026-09-13' }, hubSlug: 'chicago-il', hubShows: [], hubHome: { town: 'Chicago', state: 'IL' }, taken: new Set(), today: '2026-11-17' };
  const f = { title: 'SUMMER, 1976', kind: 'professional', type: 'play', theatre: 'Northlight Theatre', town: 'Chicago', state: 'IL', openingDate: null, firstPerformance: null, closingDate: null };
  const s = A.buildShow(f, ctx).show;
  assert.equal(s.status, 'closed');
  assert.equal(s.title, 'Summer, 1976');
  assert.equal(A.buildShow(f, { ...ctx, review: { url: 'u', date: '2026-11-01' } }).show.status, 'open');
});

test('existingRow: a company playing a second stage matches its existing row (American Repertory Theater at Farkas Hall)', () => {
  const shows = [{ id: '1972-regional-2026', title: '1972', venue: 'American Repertory Theater, Cambridge, MA', openingDate: '2026-10-27', closingDate: '2026-12-06' }];
  const show = { title: '1972', openingDate: '2026-11-05', closingDate: '2026-12-06' };
  assert.equal(A.existingRow({ theatre: 'Farkas Hall', company: 'American Repertory Theater' }, show, shows).id, '1972-regional-2026');
  assert.equal(A.existingRow({ theatre: 'Farkas Hall', company: null }, show, shows), null);
});

test('classify: a row that cites the review as evidence covers it, even filed under another city', () => {
  const url = 'https://www.broadwayworld.com/boston/article/Review-SUMMER-1976-at-Berkshire-Theatre-Group-20261012';
  const review = { url, title: 'Summer, 1976', venue: 'Berkshire Theatre Group', date: '2026-10-12' };
  const row = { id: 'summer-1976-regional-2026', title: 'Summer, 1976', category: 'regional', city: 'stockbridge-ma', venue: 'Unicorn Theatre, Stockbridge, MA', openingDate: '2026-10-12', evidenceUrls: [url] };
  assert.equal(L.classifyReview(review, { shows: [row], metro: 'boston-ma' }).status, 'covered');
  assert.equal(L.classifyReview(review, { shows: [{ ...row, evidenceUrls: [] }], metro: 'boston-ma' }).status, 'missing');
  assert.equal(L.classifyReview(review, { shows: [{ ...row, category: 'tour', market: 'tour' }], metro: 'boston-ma' }).status, 'covered-tour');
});

test('auditHub: a second company\'s production of a title already added from another review is reported', async () => {
  const chi = hubsToAudit(registry, 'chicago-il')[0];
  const csUrl = 'https://www.broadwayworld.com/chicago/article/Review-THE-WINTERS-TALE-at-Chicago-Shakespeare-Theater-20261023';
  const maUrl = 'https://www.broadwayworld.com/chicago/article/Review-THE-WINTERS-TALE-at-Modern-Archaic-Theatre-Company-20261115';
  const page = listing([
    { url: csUrl, headline: "Review: THE WINTER'S TALE at Chicago Shakespeare Theater", datePublished: '2026-10-23' },
    { url: maUrl, headline: "Review: THE WINTER'S TALE at Modern Archaic Theatre Company", datePublished: '2026-11-15' },
  ]);
  const row = { id: 'the-winters-tale-regional-2026', title: "The Winter's Tale", category: 'regional', city: 'chicago-il', venue: 'Jentes Family Courtyard Theater, Chicago, IL', openingDate: '2026-10-23', evidenceUrls: [csUrl] };
  const r = await auditHub(chi, { shows: [row], since: '2026-10-01', maxPages: 1, fetchHtml: async () => page });
  assert.deepEqual(r.missing.map((m) => m.urls[0]), [maUrl]);
  assert.equal(r.covered, 1);
});

test('auditHub: a same-title review stays covered when it was already ruled on, or names the row\'s own house', async () => {
  const chi = hubsToAudit(registry, 'chicago-il')[0];
  const csUrl = 'https://www.broadwayworld.com/chicago/article/Review-THE-WINTERS-TALE-at-Chicago-Shakespeare-Theater-20261023';
  const maUrl = 'https://www.broadwayworld.com/chicago/article/Review-THE-WINTERS-TALE-at-Modern-Archaic-Theatre-Company-20261115';
  const jfUrl = 'https://www.broadwayworld.com/chicago/article/Review-THE-WINTERS-TALE-at-Jentes-Family-Courtyard-Theater-20261101';
  const page = listing([
    { url: csUrl, headline: "Review: THE WINTER'S TALE at Chicago Shakespeare Theater", datePublished: '2026-10-23' },
    { url: jfUrl, headline: "Review: THE WINTER'S TALE at Jentes Family Courtyard Theater", datePublished: '2026-11-01' },
    { url: maUrl, headline: "Review: THE WINTER'S TALE at Modern Archaic Theatre Company", datePublished: '2026-11-15' },
  ]);
  const row = { id: 'the-winters-tale-regional-2026', title: "The Winter's Tale", category: 'regional', city: 'chicago-il', venue: 'Jentes Family Courtyard Theater, Chicago, IL', openingDate: '2026-10-23', evidenceUrls: [csUrl] };
  // Building named instead of the company: the row's own venue matches, so it is the same production.
  // Modern Archaic was already ruled on (community), so it is not re-read every day.
  const decisions = { [maUrl]: { decision: 'community' } };
  const r = await auditHub(chi, { shows: [row], since: '2026-10-01', maxPages: 1, fetchHtml: async () => page, decisions });
  assert.deepEqual(r.missing, []);
});
