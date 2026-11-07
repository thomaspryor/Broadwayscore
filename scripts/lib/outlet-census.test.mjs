// BRO-6481: outlet-first census buckets. require()s the real functions (CLAUDE.md §15).
// Titles, dates and headlines are real TheaterMania items from the 2026-10-28 pilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const census = require('./outlet-census.js');

const beaches = { id: 'beaches-2026', title: 'Beaches, A New Musical', market: 'broadway', venue: 'Majestic Theatre', previewsStartDate: '2026-03-27', openingDate: '2026-04-22', closingDate: '2026-05-24', cast: [], creativeTeam: [] };
const giant = { id: 'giant-2026', title: 'Giant', market: 'broadway', venue: 'Music Box Theatre', openingDate: '2026-03-23', closingDate: '2026-06-28', cast: [], creativeTeam: [] };
const giantOld = { id: 'giant-public-theater-off-broadway-2012', title: 'Giant', market: 'broadway', venue: 'Public Theater', openingDate: '2012-11-15', closingDate: '2012-12-16', cast: [], creativeTeam: [] };
const kenrex = { id: 'kenrex-off-broadway-2026', title: 'Kenrex', market: 'broadway', venue: 'Minetta Lane Theatre', openingDate: '2026-04-20', closingDate: '2026-07-12', cast: [], creativeTeam: [] };
const westEnd = { id: 'kenrex-west-end-2025', title: 'Kenrex', market: 'west-end', openingDate: '2025-05-01' };
const shows = [beaches, giant, giantOld, kenrex];

function ctxFor(rows, shows = [beaches, giant, giantOld, kenrex]) {
  return {
    shows,
    nycIds: new Set(shows.map((s) => s.id)),
    corpus: census.buildCorpusIndex(rows),
    outletShowUrls: census.buildOutletShowIndex(rows),
    nycVenues: census.nycVenuePhrases(shows),
  };
}
const tm = (over) => ({ outletId: 'theatermania', sourceSaysReview: true, ...over });

test('BRO-6514: person names and lowercase prose are not single-word show titles in either matching stage', () => {
  const daphne = { id: 'daphne-off-broadway-2023', title: 'Daphne', openingDate: '2023-10-23', closingDate: '2023-11-19' };
  const small = { id: 'small-off-broadway-2026', title: 'Small', openingDate: '2026-05-29', closingDate: '2026-07-25' };
  for (const [show, headline, publishDate] of [
    [daphne, 'Daphne Rubin-Vega steals the show in ‘The Night of the Iguana’ (Off Broadway review)', '2023-12-17'],
    [small, 'At Signature Theatre, ‘Merrily We Roll Along’ makes every small choice count', '2026-09-05'],
  ]) {
    const r = census.bucketItem(tm({ headline, publishDate, url: 'https://example.com/review' }), ctxFor([], [show]));
    assert.deepEqual(r.matchedIds, []);
    assert.notEqual(r.bucket, 'gap');
    assert.deepEqual(census.variantMatches({ headline, publishDate }, [show]), []);
    for (const title of [show.title, `‘${show.title}’`, `${show.title} review`, `Review: ${show.title}`]) {
      assert.equal(census.bucketItem(tm({ headline: title, publishDate, url: 'https://example.com/review' }), ctxFor([], [show])).bucket, 'gap', title);
    }
  }
});

test('BRO-6514: Chicago as a city in another show review cannot become a Chicago gap', () => {
  const chicago = { id: 'chicago-1996', title: 'Chicago', venue: 'Ambassador Theatre', openingDate: '1996-11-14' };
  const r = census.bucketItem(tm({ headline: 'This underground Chicago theater just made ‘Amélie’ better than Broadway', publishDate: '2025-08-04', url: 'https://1minutecritic.com/amelie-kokandy-chicago-review/' }), ctxFor([], [chicago]));
  assert.deepEqual(r.matchedIds, []);
  assert.equal(r.bucket, 'not-review');
  assert.equal(census.bucketItem(tm({ headline: '‘Chicago’ review: still dazzling on Broadway', publishDate: '2025-08-04', url: 'https://example.com/review' }), ctxFor([], [chicago])).bucket, 'gap');
});

test('BRO-6514: collision guards preserve punctuated, parenthetical and legitimate one-word titles', () => {
  for (const [title, headline] of [
    ['Two Strangers (Carry a Cake Across New York)', '‘Two Strangers (Carry a Cake Across New York)’ delivers more crumbs than confection'],
    ['Macbeth (An Undoing)', '‘Macbeth (An Undoing)’ finds the daggers in women’s smiles'],
    ['Ta-Da!', '‘Josh Sharp’s ta-da!’ is a PowerPoint-perfect comedic gem'],
    ['Redwood', 'Five Reasons Why Redwood Reaches Soaring Heights'],
  ]) {
    const show = { id: 'production-2026', title, openingDate: '2026-04-01' };
    assert.equal(census.titleOnlyInVenue(show, headline, [], true), false, title);
    assert.equal(census.bucketItem(tm({ headline, publishDate: '2026-04-26', url: 'https://example.com/review' }), ctxFor([], [show])).bucket, 'gap', title);
  }
});

test('BRO-6514: separately rated shows and paired review headlines are roundups even with one catalog match', () => {
  for (const headline of ['Chess ***, Practice ***', 'Bat Boy ****, Oh Happy Day! ***', '‘Kenrex’ and ‘Unknown Play’: Two theater reviews']) {
    const r = census.bucketItem(tm({ headline, publishDate: '2026-04-26', url: 'https://example.com/reviews/kenrex' }), ctxFor([]));
    assert.equal(r.bucket, 'not-review', headline);
    assert.equal(r.classifyReason, 'multi-show-headline');
  }
  assert.equal(census.classifyItem({ headline: 'Joy: A New True Musical **1/2' }, { sourceSaysReview: true }).review, true);
  assert.equal(census.bucketItem(tm({ headline: 'Review: Kenrex, a Remarkable Tale', publishDate: '2026-04-26', url: 'https://example.com/reviews/kenrex' }), ctxFor([])).bucket, 'gap');
});

test('BRO-6514: explicit touring headlines outweigh Broadway promotional wording', () => {
  for (const headline of ['Kenrex national tour review', 'Kenrex on tour: Broadway arrives in Boston', 'The Broadway touring production of Kenrex']) {
    const r = census.bucketItem(tm({ headline, description: 'The Broadway hit is on the road.', publishDate: '2026-04-26', url: 'https://example.com/review' }), ctxFor([]));
    assert.equal(r.bucket, 'not-review', headline);
    assert.equal(r.classifyReason, 'other-market');
  }
});

test('BRO-6514: review-category news posts remain news', () => {
  for (const headline of ['Company on Broadway Will Close July 31', 'T.Oliver Reid will play Hermes in Hadestown', 'New Production of Cat On a Hot Tin Roof']) {
    assert.equal(census.classifyItem({ headline, url: 'https://theaterpizzazz.com/reviews/news/' }, { sourceSaysReview: true }).review, false, headline);
  }
  assert.equal(census.classifyItem({ headline: 'Review: Kenrex Opens a Window on Vigilante Justice' }, { sourceSaysReview: true }).review, true);
  assert.equal(census.classifyItem({ headline: 'Review: A new production of Hamlet dazzles' }, { sourceSaysReview: true }).review, true);
});

test('BRO-6514: Teeth venue runs are distinct productions and wrong-run holdings stay visible', () => {
  const first = { id: 'teeth-playwrights-horizons-off-broadway-2024', title: 'Teeth', venue: 'Playwrights Horizons', previewsStartDate: '2024-02-21', openingDate: '2024-03-12', closingDate: '2024-04-28' };
  const transfer = { id: 'teeth-off-broadway-2024', title: 'Teeth', venue: 'New World Stages Stage 1', previewsStartDate: '2024-10-16', openingDate: '2024-10-31', closingDate: '2025-01-05', priorRuns: [{ id: first.id, openingDate: first.openingDate, closingDate: first.closingDate, venue: first.venue }] };
  const url = 'https://www.newyorktheatreguide.com/reviews/teeth-off-broadway-review';
  for (const [date, expected] of [['2024-03-19', first.id], ['2024-10-31', transfer.id]]) {
    const r = census.bucketItem(tm({ headline: 'Teeth review', publishDate: date, url }), ctxFor([], [first, transfer]));
    assert.equal(r.bucket, 'gap');
    assert.deepEqual(r.matchedIds, [expected]);
  }
  assert.equal(census.bucketItem(tm({ headline: 'Teeth review', publishDate: '2024-10-31', url }), ctxFor([{ showId: first.id, url }], [first, transfer])).bucket, 'misfile');
  // The other direction is filed by design: the transfer declares the first run in priorRuns,
  // so a March review held only under the transfer is held (real reviews.json rows, BRO-6514).
  const nyt = 'https://www.nytimes.com/2024/03/19/theater/teeth-review-michael-r-jackson.html';
  const viaPrior = census.bucketItem(tm({ headline: "Review: 'Teeth' Bites", publishDate: '2024-03-19', url: nyt }), ctxFor([{ showId: transfer.id, url: nyt }], [first, transfer]));
  assert.equal(viaPrior.bucket, 'held');
  assert.equal(viaPrior.matchVia, 'held-prior-run');
  // A same-title show with no priorRuns link is still a misfile (Illinoise test below).
  const unlinked = { ...transfer, priorRuns: [] };
  assert.equal(census.bucketItem(tm({ headline: "Review: 'Teeth' Bites", publishDate: '2024-03-19', url: nyt }), ctxFor([{ showId: unlinked.id, url: nyt }], [first, unlinked])).bucket, 'misfile');
});

test('a held URL under the matched show is held (www/query/trailing slash ignored)', () => {
  const ctx = ctxFor([{ showId: kenrex.id, outletId: 'theatermania', url: 'https://theatermania.com/news/review-kenrex/?utm_source=x' }]);
  const r = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-kenrex/', headline: 'Review: Kenrex, a Remarkable Tale of Vigilante Justice in America', publishDate: '2026-04-26' }), ctx);
  assert.equal(r.bucket, 'held');
});

test('an unheld review of one in-window show is a gap', () => {
  const r = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-kenrex/', headline: 'Review: Kenrex, a Remarkable Tale of Vigilante Justice in America', publishDate: '2026-04-26' }), ctxFor([]));
  assert.equal(r.bucket, 'gap');
  assert.deepEqual(r.matchedIds, [kenrex.id]);
});

test('same outlet + show held under a legacy URL is held-alt-url, not a gap', () => {
  const ctx = ctxFor([{ showId: kenrex.id, outletId: 'theatermania', url: 'https://www.theatermania.com/off-broadway/reviews/review-kenrex_99999.html' }]);
  const r = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-kenrex/', headline: 'Review: Kenrex', publishDate: '2026-04-26' }), ctx);
  assert.equal(r.bucket, 'held-alt-url');
  assert.equal(census.summarize([r, { bucket: 'gap' }]).recall, 0.5);
  assert.equal(census.summarize([r, { bucket: 'gap' }, { bucket: 'catalog-gap' }]).recallWithCatalog, 0.333);
});

test('a held URL whose matched show differs is a misfile', () => {
  const ctx = ctxFor([{ showId: giant.id, outletId: 'theatermania', url: 'https://www.theatermania.com/news/review-kenrex/' }]);
  const r = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-kenrex/', headline: 'Review: Kenrex', publishDate: '2026-04-26' }), ctx);
  assert.equal(r.bucket, 'misfile');
});

test('subtitle and common-word titles match through the dated title-variant stage', () => {
  const b = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-beaches/', headline: 'Review: Beaches, an Irresistible Broadway Tearjerker', publishDate: '2026-04-22' }), ctxFor([]));
  assert.equal(b.bucket, 'gap');
  assert.equal(b.matchVia, 'title-variant');
  assert.deepEqual(b.matchedIds, [beaches.id]);
  // Giant 2026, not the 2012 Public Theater Giant: the run window picks the production.
  const g = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-giant/', headline: 'Review: Giant on Broadway, How Roald Dahl Accepted His Antisemitism', publishDate: '2026-03-23' }), ctxFor([]));
  assert.deepEqual(g.matchedIds, [giant.id]);
});

test('a one-word cut of a longer title must stand alone, not sit inside another name', () => {
  const david = { id: 'david-a-new-musical-off-broadway-2024', title: 'David, A New Musical', venue: 'AMT Theater', openingDate: '2024-06-09', closingDate: '2024-07-13' };
  const empire = { id: 'empire-the-musical-off-broadway-2024', title: 'Empire: The Musical', venue: 'New World Stages', openingDate: '2024-07-11', closingDate: '2024-09-22' };
  const pool = [david, empire];
  // BRO-6481 census false positives: a venue name, a critic's name, another show.
  assert.deepEqual(census.variantMatches({ headline: 'Theater Review: A LITTLE NIGHT MUSIC IN CONCERT (David Geffen Hall at Lincoln Center)', publishDate: '2024-06-28' }, pool), []);
  assert.deepEqual(census.variantMatches({ headline: 'Beverly Hills Cop III review, David Denby', publishDate: '2024-06-20' }, pool), []);
  assert.deepEqual(census.variantMatches({ headline: 'Review: Empire Records Delivers Nostalgia at the McCarter', publishDate: '2024-08-01' }, pool), []);
  // Still matched: punctuation after the cut, or the title's own next word.
  assert.deepEqual(census.variantMatches({ headline: 'Review: Empire: The Musical Falls Way Short', publishDate: '2024-07-12' }, pool).map((s) => s.id), [empire.id]);
  assert.deepEqual(census.variantMatches({ headline: "'Empire' is a muddled musical", publishDate: '2024-07-12' }, pool).map((s) => s.id), [empire.id]);
  assert.deepEqual(census.variantMatches({ headline: 'David a New Musical review', publishDate: '2024-06-12' }, pool).map((s) => s.id), [david.id]);
  assert.deepEqual(census.variantMatches({ headline: 'Review: Beaches, an Irresistible Tearjerker', publishDate: '2026-04-22' }, shows).map((s) => s.id), [beaches.id]);
  // An all-caps headline has no casing signal to go on.
  assert.deepEqual(census.variantMatches({ headline: 'EMPIRE DAZZLES AT NEW WORLD STAGES', publishDate: '2024-07-12' }, pool).map((s) => s.id), [empire.id]);
  // Title-case headlines: a capitalized function word or headline verb still stands alone,
  // and a cut written in caps inside a mixed-case headline (BWW style) does too.
  assert.deepEqual(census.variantMatches({ headline: 'Review: Empire Is a Big Swing', publishDate: '2024-07-12' }, pool).map((s) => s.id), [empire.id]);
  assert.deepEqual(census.variantMatches({ headline: 'Review: Empire Delivers', publishDate: '2024-07-12' }, pool).map((s) => s.id), [empire.id]);
  assert.deepEqual(census.variantMatches({ headline: 'Review Roundup: EMPIRE DAZZLES at New World Stages', publishDate: '2024-07-12' }, pool).map((s) => s.id), [empire.id]);
  // A lowercase word after the cut is prose, not a longer name ("POTUS at the Shubert").
  assert.deepEqual(census.variantMatches({ headline: 'Review: Empire at New World Stages', publishDate: '2024-07-12' }, pool).map((s) => s.id), [empire.id]);
});

test('a show with no dates still rejects reviews from before its id year', () => {
  const cc = { id: 'counting-and-cracking-off-broadway-2026', title: 'Counting and Cracking', venue: 'Delacorte Theater' };
  assert.equal(census.inRunWindow(cc, '2024-09-14'), false);
  assert.equal(census.inRunWindow(cc, '2026-06-01'), true);
  assert.equal(census.inRunWindow({ id: 'no-year-here', title: 'X' }, '2001-01-01'), true);
});

test('an undated item never takes the title-variant path', () => {
  assert.deepEqual(census.variantMatches({ headline: 'Review: Giant on Broadway' }, shows), []);
});

test('regional reviews and list headlines are not reviews of NYC shows', () => {
  const ctx = ctxFor([]);
  const regional = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-brigadoon/', headline: 'Review: Brigadoon, Reworked and Revised by Alexandra Silber at Pasadena Playhouse', publishDate: '2026-05-26' }), ctx);
  assert.equal(regional.bucket, 'not-review');
  const list = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/best-shows/', headline: 'The 10 Best Shows of 2025', publishDate: '2025-12-20' }), ctx);
  assert.equal(list.bucket, 'not-review');
});

test('an unmatched review with a NYC signal is a catalog-gap candidate', () => {
  const r = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-henry-vi/', headline: 'Review: A Two-Part, All-Asian American Henry VI Returns to the Public Theater', publishDate: '2023-06-23' }), ctxFor([]));
  assert.equal(r.bucket, 'catalog-gap');
});

test('a URL held only under a non-NYC show is held-other-market', () => {
  const ctx = ctxFor([{ showId: westEnd.id, outletId: 'theatermania', url: 'https://www.theatermania.com/news/review-kenrex-london/' }]);
  const r = census.bucketItem(tm({ url: 'https://www.theatermania.com/news/review-kenrex-london/', headline: 'Review: Kenrex in London', publishDate: '2025-05-03' }), ctx);
  assert.equal(r.bucket, 'held-other-market');
});

test('extractPageMeta reads og tags in either attribute order and falls back to soft dateModified', () => {
  const a = census.extractPageMeta('<meta property="og:title" content="Initiative Has 18 Charisma"><script>{"datePublished":"2025-11-20T22:30:27.540-05:00"}</script>');
  assert.deepEqual([a.headline, a.publishDate, a.dateSoft], ['Initiative Has 18 Charisma', '2025-11-20', false]);
  const b = census.extractPageMeta('<meta content="Review of Between Riverside and Crazy" property="og:title"/><script>{"dateModified":"2017-09-22"}</script>');
  assert.deepEqual([b.headline, b.publishDate, b.dateSoft], ['Review of Between Riverside and Crazy', '2017-09-22', true]);
});

test('corpusSideMisses reports URL-less rows and rows the enumeration never saw', () => {
  const misses = census.corpusSideMisses([
    { showId: 'a', url: null, publishDate: '2024-01-01' },
    { showId: 'b', url: 'https://x.com/seen', publishDate: '2024-01-01' },
    { showId: 'c', url: 'https://x.com/unseen', publishDate: '2024-01-01' },
    { showId: 'd', url: 'https://x.com/old', publishDate: '2019-01-01' },
  ], new Set(['x.com/seen']), { sinceMs: Date.parse('2021-06-01') });
  assert.deepEqual(misses.map((m) => [m.showId, m.why]), [['a', 'no-url'], ['c', 'not-enumerated']]);
});

test('slugHeadline turns an article slug into matchable words', () => {
  assert.equal(census.slugHeadline('https://www.vulture.com/article/theater-review-giant-broadway.html?x=1'), 'theater review giant broadway');
  assert.equal(census.slugHeadline('https://www.nytg.com/reviews/kenrex-review/'), 'kenrex review');
});

test('film captures, Tony telecasts and Met Opera reviews are not theater reviews', () => {
  for (const headline of ['Review: The 2026 Tony Awards, a Good Telecast for a So-So Year',
    'Review: Jeanine Tesori’s Grounded, the Story of a Mom/Drone Pilot, at the Metropolitan Opera']) {
    assert.equal(census.classifyItem({ headline }, { sourceSaysReview: true }).review, false, headline);
  }
  assert.equal(census.classifyItem({ headline: 'Review: Laurence Fishburne Leaves Us Wanting Morpheus in Like They Do in the Movies' }, { sourceSaysReview: true }).review, true);
});

test('held under a show the headline names is held, not a misfile; same-title other production stays a misfile', () => {
  const touch = { id: 'touch-off-broadway-2026', title: 'Touch', market: 'broadway', previewsStartDate: '2026-03-14', openingDate: '2026-03-14', closingDate: '2026-03-29' };
  const othello = { id: 'bedlams-othello-off-broadway-2026', title: "Bedlam's Othello", market: 'broadway', openingDate: '2026-05-03', closingDate: '2026-06-01' };
  const ilB = { id: 'illinoise-2024', title: 'Illinoise', market: 'broadway', openingDate: '2024-04-24', closingDate: '2024-08-10' };
  const ilA = { id: 'illinoise-off-broadway-2024', title: 'Illinoise', market: 'broadway', openingDate: '2024-03-02', closingDate: '2024-03-23' };
  const all = [touch, othello, ilB, ilA];
  const ctx = (rows) => ({ shows: all, nycIds: new Set(all.map((s) => s.id)), corpus: census.buildCorpusIndex(rows), outletShowUrls: census.buildOutletShowIndex(rows), nycVenues: census.nycVenuePhrases(all) });
  const u1 = 'https://www.theatermania.com/news/review-bedlam-gives-its-trademark-innovative-touch-to-a-top-notch-othello_1835344/';
  const r1 = census.bucketItem(tm({ url: u1, headline: 'Review: Bedlam Gives Its Trademark Innovative Touch to a Top-Notch Othello', publishDate: '2026-05-03' }), ctx([{ showId: othello.id, outletId: 'theatermania', url: u1 }]));
  assert.equal(r1.bucket, 'held');
  const u2 = 'https://www.newyorktheatreguide.com/reviews/illinoise-off-broadway-review-sufjan-stevens';
  const r2 = census.bucketItem({ outletId: 'nytg', sourceSaysReview: true, url: u2, headline: "'Illinoise' review — dance your way through Sufjan Stevens's album", publishDate: '2024-03-07' }, ctx([{ showId: ilB.id, outletId: 'nytg', url: u2 }]));
  assert.equal(r2.bucket, 'misfile');
});

test('the New York Theater review filter takes "review" anywhere in the slug, not only at the end', () => {
  const { SOURCES } = require('./outlet-census-sources.js');
  const f = SOURCES['nyt-theater'].linkFilter;
  for (const u of ['https://newyorktheater.me/2023/03/16/a-dolls-house-review-jessica-chastain-escapes-her-chair/',
    'https://newyorktheater.me/2026/06/04/theater-reviews-girl-interrupted-a-woman-among-women/',
    'https://newyorktheater.me/2025/09/16/art-broadway-reviews/',
    'https://newyorktheater.me/2024/05/01/some-show-review/']) assert.equal(f.test(u), true, u);
  for (const u of ['https://newyorktheater.me/2024/04/24/illinoise-opens-on-broadway/',
    'https://newyorktheater.me/2024/04/24/reviewers-pick/x']) assert.equal(f.test(u), false, u);
});

test('a touring or regional production of an NYC title is not a gap; regional outlets need an NYC signal', () => {
  const hamilton = { id: 'hamilton-2015', title: 'Hamilton', market: 'broadway', openingDate: '2015-08-06', closingDate: null };
  const ctx = { shows: [hamilton], nycIds: new Set([hamilton.id]), corpus: census.buildCorpusIndex([]), outletShowUrls: census.buildOutletShowIndex([]), nycVenues: [] };
  const item = { outletId: 'stageandcinema', sourceSaysReview: true, url: 'https://stageandcinema.com/2025/03/21/hamilton-houston/', publishDate: '2025-03-21' };
  assert.equal(census.bucketItem({ ...item, headline: 'Theater Review: HAMILTON (National Tour in Houston)' }, ctx).bucket, 'not-review');
  assert.equal(census.bucketItem({ ...item, headline: 'Theater Review: HAMILTON' }, ctx).bucket, 'gap');
  assert.equal(census.bucketItem({ ...item, headline: 'Theater Review: HAMILTON', requireNycSignal: true }, ctx).bucket, 'not-review');
  assert.equal(census.bucketItem({ ...item, headline: 'Broadway Review: HAMILTON (Richard Rodgers Theatre)', requireNycSignal: true }, ctx).bucket, 'gap');
});

test('a regional outlet headline naming another market is not a gap even when the blurb says Broadway', () => {
  const bee = { id: 'bee-off-broadway-2024', title: 'The 25th Annual Putnam County Spelling Bee', market: 'broadway', openingDate: '2024-09-01', closingDate: '2024-12-01' };
  const ctx = { shows: [bee], nycIds: new Set([bee.id]), corpus: census.buildCorpusIndex([]), outletShowUrls: census.buildOutletShowIndex([]), nycVenues: [] };
  const r = census.bucketItem({ outletId: 'dc-theater-arts', sourceSaysReview: true, requireNycSignal: true, url: 'https://dctheaterarts.org/2024/10/15/bee/', publishDate: '2024-10-15',
    headline: "'The 25th Annual Putnam County Spelling Bee' at Kennedy Center is simply P-H-E-N-O-M-E-N-A-L", description: 'The Broadway hit returns.' }, ctx);
  assert.equal(r.bucket, 'not-review');
});

test('a held review naming the main title of a subtitled show is held, not a misfile ("Lady Macbeth" in a School Girls review)', () => {
  const sg = { id: 'school-girls-2026', title: 'School Girls; Or, The African Mean Girls Play', market: 'broadway', openingDate: '2026-09-28', closingDate: '2026-11-15' };
  const mac = { id: 'macbeth-2026', title: 'Macbeth', market: 'broadway', openingDate: '2026-09-22', closingDate: '2026-10-20' };
  const all = [sg, mac];
  const u = 'https://www.thewrap.com/creative-content/theater/school-girls-broadway-review/';
  const rows = [{ showId: sg.id, outletId: 'thewrap', url: u }];
  const ctx = { shows: all, nycIds: new Set(all.map((s) => s.id)), corpus: census.buildCorpusIndex(rows), outletShowUrls: census.buildOutletShowIndex(rows), nycVenues: [] };
  const r = census.bucketItem({ outletId: 'thewrap', url: u, publishDate: '2026-09-28', headline: '‘School Girls’ Broadway Review: Denée Benton Isn’t Just Mean, She’s a Teenage Lady Macbeth' }, ctx);
  assert.equal(r.bucket, 'held');
});

test('a North American tour stop or a "Broadway By The Year" concert is not a Broadway gap (stageandcinema, BRO-6485)', () => {
  const mr = { id: 'moulin-rouge-2019', title: 'Moulin Rouge! The Musical', market: 'broadway', openingDate: '2019-07-25', closingDate: null };
  const ctx = { shows: [mr], nycIds: new Set([mr.id]), corpus: census.buildCorpusIndex([]), outletShowUrls: census.buildOutletShowIndex([]), nycVenues: [] };
  const tour = census.bucketItem({ outletId: 'stageandcinema', requireNycSignal: true, url: 'https://stageandcinema.com/2023/05/20/moulin-rouge-scfta/', publishDate: '2023-05-20',
    headline: 'Theater Review: MOULIN ROUGE! (North American Tour at SCFTA)', description: 'The Broadway smash arrives in Costa Mesa.' }, ctx);
  assert.notEqual(tour.bucket, 'gap');
  const concert = census.bucketItem({ outletId: 'stageandcinema', url: 'https://stageandcinema.com/2023/03/01/broadway-by-the-year/', publishDate: '2023-03-01',
    headline: 'Theater Review: BROADWAY BY THE YEAR (The Town Hall)', description: 'Songs from Moulin Rouge and more.' }, ctx);
  assert.equal(concert.bucket, 'not-review');
});

test('a "tour at" phrase does not outvote an explicit New York signal (Town Hall concert, BRO-6485)', () => {
  const mr = { id: 'moulin-rouge-2019', title: 'Moulin Rouge! The Musical', market: 'broadway', openingDate: '2019-07-25', closingDate: null };
  const ctx = { shows: [mr], nycIds: new Set([mr.id]), corpus: census.buildCorpusIndex([]), outletShowUrls: census.buildOutletShowIndex([]), nycVenues: [] };
  const r = census.bucketItem({ outletId: 'stageandcinema', requireNycSignal: true, url: 'https://stageandcinema.com/2023/06/01/moulin-rouge/', publishDate: '2023-06-01',
    headline: 'Theater Review: MOULIN ROUGE! THE MUSICAL (New York)', description: 'After its world tour at last in Manhattan.' }, ctx);
  assert.equal(r.nycSignal, 'nyc');
});

test('quarterWindows covers since..now in calendar quarters with no gaps', () => {
  const w = census.quarterWindows('2021-06-01', new Date('2021-12-15T00:00:00Z'));
  const ymd = (d) => d.toISOString().slice(0, 10);
  assert.deepEqual(w.map((x) => [ymd(x.dateMin), ymd(x.dateMax)]), [['2021-06-01', '2021-07-01'], ['2021-07-01', '2021-10-01'], ['2021-10-01', '2021-12-15']]);
});

test('serpItemDate rejects impossible dates instead of rolling them into the next month', () => {
  const win = { dateMin: new Date('2023-01-01T00:00:00Z'), dateMax: new Date('2023-04-01T00:00:00Z') };
  const r = census.serpItemDate({ url: 'https://x.com/foo/', snippet: 'Feb 30, 2023' }, win);
  assert.equal(r.dateSoft, true); // fell back to the window midpoint, not 2023-03-02
});

test('serpItemDate prefers the URL date, then the snippet date, else a soft window midpoint', () => {
  const win = { dateMin: new Date('2023-01-01T00:00:00Z'), dateMax: new Date('2023-03-31T00:00:00Z') };
  assert.equal(census.serpItemDate({ url: 'https://x.com/2023/02/14/foo/', snippet: 'Mar 1, 2023' }, win).publishDate, '2023-02-14');
  assert.equal(census.serpItemDate({ url: 'https://x.com/foo/', snippet: 'Mar 12, 2023 — A review' }, win).publishDate, '2023-03-12');
  const soft = census.serpItemDate({ url: 'https://x.com/foo/', snippet: 'no date' }, win);
  assert.equal(soft.dateSoft, true);
  assert.ok(soft.publishDate >= '2023-01-01' && soft.publishDate <= '2023-03-31');
});

test('cleanSerpTitle strips only a suffix the outlet repeats, never a lone trailing segment', () => {
  const titles = ['Review: Hamlet Is Bold - The New York Times', 'Review: Oh, Mary! - The New York Times', 'Review: Cats - The New York Times', 'Theater Review - Hamlet'];
  const sfx = census.commonTitleSuffixes(titles);
  assert.deepEqual([...sfx], ['the new york times']);
  assert.equal(census.cleanSerpTitle(titles[0], sfx), 'Review: Hamlet Is Bold');
  assert.equal(census.cleanSerpTitle('Theater Review - Hamlet', sfx), 'Theater Review - Hamlet');
  assert.equal(census.cleanSerpTitle('Theater Review - Hamlet'), 'Theater Review - Hamlet');
  assert.equal(census.cleanSerpTitle('A long headline that got cut ...'), 'A long headline that got cut');
});

test('extractPageMeta decodes named entities and strips only og:site_name from titles (Off Off Online, BRO-6485)', () => {
  const m = census.extractPageMeta('<meta property="og:site_name" content="Off Off Online"/><title>Kinky Boots &mdash; Off Off Online</title>');
  assert.equal(m.headline, 'Kinky Boots');
  // No site name known: keep the whole <title>; the trailing segment may be the show.
  assert.equal(census.extractPageMeta('<title>Off Off Online | Kinky Boots</title>').headline, 'Off Off Online | Kinky Boots');
  const og = census.extractPageMeta('<meta property="og:title" content="Review: &lsquo;Teeth&rsquo; Bites">');
  assert.equal(og.headline, "Review: 'Teeth' Bites");
  const both = census.extractPageMeta('<meta property="og:site_name" content="Off Off Online"/><meta property="og:title" content="The Dog Show: Come. Sit. Stay. &mdash; Off Off Online"/>');
  assert.equal(both.headline, 'The Dog Show: Come. Sit. Stay.');
  const keep = census.extractPageMeta('<meta property="og:site_name" content="Vulture"/><meta property="og:title" content="Theater Review: Hamlet - A Bold Take"/>');
  assert.equal(keep.headline, 'Theater Review: Hamlet - A Bold Take');
});

test('an enumeration cut short by the SERP budget, a missing provider or a failed sitemap child is incomplete', () => {
  assert.equal(census.isIncompleteEnumeration(['serp budget 8 reached']), true);
  assert.equal(census.isIncompleteEnumeration(['no SERP provider for "site:x.com"']), true);
  assert.equal(census.isIncompleteEnumeration(['child https://x.com/s1.xml: HTTP 503']), true);
  assert.equal(census.isIncompleteEnumeration(['page cap 3 hit in 4 quarter-queries (more results not read)']), true);
  assert.equal(census.isIncompleteEnumeration(['46 SERP calls']), false);
  assert.equal(census.isIncompleteEnumeration(undefined), false);
});

test('BRO-6514: a wp-json walk that stopped on a failed page is incomplete; only transient failures retry', () => {
  assert.equal(census.isIncompleteEnumeration(['page 3: HTTP 503']), true);
  assert.equal(census.isIncompleteEnumeration(['page 1: fetch failed (fetch failed)']), true);
  assert.equal(census.isIncompleteEnumeration(['2026: no URLs (blocked or empty; see log)']), false);
  assert.equal(census.isTransientFetch(0, new Error('ECONNRESET')), true);
  assert.equal(census.isTransientFetch(429), true);
  assert.equal(census.isTransientFetch(502), true);
  for (const s of [200, 400, 403, 404]) assert.equal(census.isTransientFetch(s), false, String(s));
});

test('BRO-6514: Slant Magazine (403 to every direct fetch) is enumerated through SERP', () => {
  const { SOURCES } = require('./outlet-census-sources.js');
  const s = SOURCES.slantmagazine;
  assert.equal(s.kind, 'serp');
  assert.equal(s.urlFilter.test('https://www.slantmagazine.com/theater/review-oh-mary-cole-escola/'), true);
  assert.equal(s.urlFilter.test('https://www.slantmagazine.com/film/review-x/'), false);
});

test('an archival film review naming an old year is not a gap; a show titled with a year still is (Vulture, BRO-6485)', () => {
  const david = { id: 'david-a-new-musical-off-broadway-2024', title: 'David', market: 'broadway', openingDate: '2024-09-01', closingDate: '2024-12-01' };
  const s1776 = { id: '1776-2022', title: '1776', market: 'broadway', openingDate: '2022-10-06', closingDate: '2023-01-08' };
  const all = [david, s1776];
  const ctx = { shows: all, nycIds: new Set(all.map((s) => s.id)), corpus: census.buildCorpusIndex([]), outletShowUrls: census.buildOutletShowIndex([]), nycVenues: [] };
  const film = census.bucketItem({ outletId: 'vulture', sourceSaysReview: true, url: 'https://www.vulture.com/article/beverly-hills-cop-ii-review-david-denby-1987.html', publishDate: '2024-10-01',
    headline: 'beverly hills cop ii review david denby 1987' }, ctx);
  assert.equal(film.bucket, 'not-review');
  const rev = census.bucketItem({ outletId: 'vulture', sourceSaysReview: true, url: 'https://www.vulture.com/article/theater-review-1776-revival.html', publishDate: '2022-10-07',
    headline: 'Theater Review: 1776, revived' }, ctx);
  assert.equal(rev.bucket, 'gap');
  const dated1776 = census.bucketItem({ outletId: 'vulture', sourceSaysReview: true, url: 'https://www.vulture.com/article/theater-review-1776.html', publishDate: '2022-10-07',
    headline: 'Theater Review: 1776' }, ctx);
  assert.equal(dated1776.bucket, 'gap');
  const danny = { id: 'danny-and-the-deep-blue-sea-off-broadway-2023', title: 'Danny and the Deep Blue Sea', market: 'broadway', openingDate: '2023-06-01', closingDate: '2023-08-01' };
  const ctx2 = { ...ctx, shows: [danny], nycIds: new Set([danny.id]) };
  const revival = census.bucketItem({ outletId: 'theater-pizzazz', sourceSaysReview: true, url: 'https://theaterpizzazz.com/danny-and-the-deep-blue-sea/', publishDate: '2023-06-10',
    headline: 'Danny and the Deep Blue Sea: John Patrick Shanley’s 1983 drama revived swimmingly' }, ctx2);
  assert.equal(revival.bucket, 'gap');
});

test('extractPageMeta reads the critic from a JSON-LD Review and ignores an unsigned listing', () => {
  const signed = census.extractPageMeta('<script type="application/ld+json">{"@type":"Review","itemReviewed":{"@type":"TheaterEvent"},"author":{"@type":"Person","name":"Adam Feldman"}}</script>');
  assert.equal(signed.reviewAuthor, 'Adam Feldman');
  const listing = census.extractPageMeta('<script type="application/ld+json">{"@type":"Review","author":{"@type":"Person","name":""}}</script>');
  assert.equal(listing.reviewAuthor, null);
  assert.equal(census.extractPageMeta('<title>Soon | Theater in New York</title>').reviewAuthor, null);
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  assert.equal(census.extractPageMeta(ld({ '@graph': [{ '@type': 'Review', author: [{ '@type': 'Person', name: 'Raven Snook' }] }] })).reviewAuthor, 'Raven Snook');
  assert.equal(census.extractPageMeta(ld({ author: { name: 'Adam Feldman' }, reviewBody: 'x'.repeat(2000), '@type': 'Review' })).reviewAuthor, 'Adam Feldman');
  // A playwright on the reviewed work is not the critic.
  assert.equal(census.extractPageMeta(ld({ '@type': 'Review', itemReviewed: { '@type': 'CreativeWork', author: { name: 'Jordan Harrison' } }, author: { name: '' } })).reviewAuthor, null);
  assert.equal(census.extractPageMeta('<script type="application/ld+json">{not json</script>').reviewAuthor, null);
});

test('a Los Angeles house in the headline marks a same-titled review as another market (Fountain Theatre, BRO-6485)', () => {
  const show = { id: 'fatherland-off-broadway-2024', title: 'Fatherland', market: 'off-broadway', openingDate: '2024-09-01', closingDate: '2024-11-01' };
  const ctx = { shows: [show], nycIds: new Set([show.id]), corpus: census.buildCorpusIndex([]), outletShowUrls: census.buildOutletShowIndex([]), nycVenues: [] };
  const r = census.bucketItem({ outletId: 'frontmezzjunkies', sourceSaysReview: true, url: 'https://frontmezzjunkies.com/2024/10/04/fountain-theatres-fatherland/', publishDate: '2024-10-04',
    headline: 'Fountain Theatre’s “Fatherland” Talks Its Way Through', description: '' }, ctx);
  assert.notEqual(r.bucket, 'gap');
});
