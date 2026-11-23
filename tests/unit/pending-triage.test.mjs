/**
 * BRO-8023: no-fetch _pending triage. Fixtures are the real queue rows from the
 * 2026-11-21 sample: title-word site-search hits (film/TV reviews, section
 * indexes, box office) must settle without a fetch; real stage reviews,
 * including ones filed under screen-looking sections, must stay candidates.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
// BRO-8107: the shared guards this reaches read shows from a fixture, not the live
// data/shows.json, so this test stays in test.yml's blocking batch.
process.on('exit', require('../../scripts/lib/shows-json-fixture.js').useShowsFixture([]));
// replay-pending-bylines.js resolves the review-texts root at import; on a
// checkout with the private corpus that lists it (a live read). Empty fixture dir.
if (!process.env.REVIEW_TEXTS_DIR) {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-triage-rt-'));
  process.env.REVIEW_TEXTS_DIR = rt;
  process.on('exit', () => fs.rmSync(rt, { recursive: true, force: true }));
}
const T = require('../../scripts/lib/pending-triage.js');
const { offTopicSectionReason } = require('../../scripts/lib/non-review-url-patterns.js');

const PUNCH = { id: 'punch-west-end-2025', title: 'Punch', previewsStartDate: '2025-09-22', openingDate: '2025-09-26', closingDate: '2025-11-29', market: 'west-end' };

const JUNK = [
  ['hamlet-off-broadway-2026', 'https://www.hollywoodreporter.com/movies/movie-reviews/hamlet-review-riz-ahmed-1236354173/'],
  ['end-west-end-2025', 'https://www.hollywoodreporter.com/tv/tv-reviews/the-end-of-an-era-review-taylor-swift-disney-plus-1236449325/'],
  ['ha-ha-ha-ha-ha-ha-ha-regional-2026', 'https://www.hollywoodreporter.com/t/classic-reviews/'],
  ['ha-ha-ha-ha-ha-ha-ha-regional-2026', 'https://ew.com/tv/tv-reviews-recommendations/'],
  ['ha-ha-ha-ha-ha-ha-ha-regional-2026', 'https://ew.com/movie-reviews-recommendations/'],
  ['maddie-off-broadway-2025', 'https://deadline.com/2026/03/pretty-lethal-review-maddie-ziegler-uma-thurman-sxsw-1236746453/'],
  ['spellbound-2025', 'https://deadline.com/2024/11/spellbound-film-review-1236185047/'],
  ['dog-day-afternoon-2026', 'https://deadline.com/2026/04/broadway-box-office-lost-boys-dog-day-afternoon-1236783387/'],
  ['the-heart-of-the-beast-2026', 'https://deadline.com/2026/09/box-office-avengers-endgame-primetime-heart-of-the-beast-1237111302/'],
  ['rock-of-ages-regional-2026', 'https://ew.com/article/2012/06/14/box-office-preview-rock-of-ages-thats-my-boy-madagascar-3/'],
  // First local batch run promoted these three (2026-11-21); each is now settled before a fetch.
  ['grace-pervades-west-end-2026', 'https://theatreweekly.com/production-images-released-for-grace-pervades-as-west-end-run-continues/'],
  ['hamlet-off-broadway-2026', 'http://www.BAM.org/Hamlet'],
  ['hamlet-off-broadway-2026', 'https://playbill.com/article/raymond-lee-in-hamlet-more-board-south-coast-repertory-2026-2027-season'],
  // Second batch promotions (2026-11-21).
  ['clarkston-west-end-2025', 'https://www.thetimes.com/culture/theatre-dance/article/joe-locke-interview-heartstopper-clarkston-trafalgar-theatre-xjnc0tz7v'],
  ['stereophonic-west-end-2025', 'https://www.thetimes.com/culture/theatre-dance/article/stereophonic-duke-york-theatre-david-adjmi-will-butler-interview-x8500l8n7'],
  ['little-bear-ridge-road-2025', 'https://deadline.com/2025/12/little-bear-ridge-road-closing-date-1236647056/'],
  ['liberation-off-broadway-2025', 'https://www.hollywoodreporter.com/movies/movie-reviews/the-liberation-review-carrie-coon-guy-nattiv-lily-james-1236690996/'],
];

// Real stage reviews: the queue's own (Times Punch, The Stage, artsdesk ENO) plus scored corpus rows that live in
// screen-looking sections (EW /movies/ + /music/, THR theater review under /movies/, Daily Mail /tvshowbiz/).
const REAL = [
  ['punch-west-end-2025', 'https://www.thetimes.com/culture/theatre-dance/article/punch-review-james-graham-young-vic-9wbqsjxl6'],
  ['dogstar-off-west-end-2026', 'https://www.thestage.co.uk/reviews/dogstar-review-hampstead-theatre-studio-london'],
  ['iphigenie-en-tauride-2026', 'https://theartsdesk.com/opera/iphigenie-en-tauride-english-national-opera-review-stylised-stylishly-sung-rarity'],
  ['an-evening-with-an-immigrant-2026', 'https://thetheatretimes.com/an-evening-with-an-immigrant-bridge-theatre/'],
  ['the-hope-theory-2026', 'https://larchmontbuzz.com/theater/theater-review-the-hope-theory/'],
  ['diana-2021', 'https://ew.com/movies/movie-reviews/diana-the-musical-review/'],
  ['springsteen-2017', 'http://ew.com/music/2017/10/12/bruce-springsteen-on-broadway-ew-review/'],
  ['x-2011', 'https://www.hollywoodreporter.com/movies/movie-reviews/sister-act-theater-review-123456/'],
  ['42nd-street-2017', 'https://www.dailymail.com/tvshowbiz/article-4380924/Quentin-Letts-reviews-42nd-Street-Theatre-Royal.html'],
  ['midnight-movie-2019', 'https://www.thestage.co.uk/reviews/midnight-movie-review-at-royal-court-london--ambitious-but-opaque'],
  ['merrily-2025', 'https://www.rogerebert.com/reviews/merrily-we-roll-along-daniel-radcliffe-musical-film-review-2025'],
];

describe('triagePendingStub (BRO-8023)', () => {
  for (const [showId, url] of JUNK) {
    test(`junk without a fetch: ${url}`, () => {
      const v = T.triagePendingStub({ url }, { showId, heldIndex: new Map() });
      assert.equal(v.verdict, 'junk', JSON.stringify(v));
      assert.ok(v.reason && v.reason.length > 10);
    });
  }
  for (const [showId, url] of REAL) {
    test(`stays a fetch candidate: ${url}`, () => {
      assert.equal(T.triagePendingStub({ url }, { showId, heldIndex: new Map() }).verdict, 'candidate');
      assert.equal(offTopicSectionReason(url), null);
    });
  }

  test('url scored for this show = duplicate; scored under another show = junk naming that show', () => {
    const idx = T.buildHeldUrlIndex([{ showId: 'oedipus-west-end-2025', url: 'https://www.thetimes.com/culture/theatre-dance/article/oedipus-review-x-cc73c8dgt/?a=1' }]);
    const url = 'https://thetimes.com/culture/theatre-dance/article/oedipus-review-x-cc73c8dgt';
    assert.equal(T.triagePendingStub({ url }, { showId: 'oedipus-west-end-2025', heldIndex: idx }).verdict, 'duplicate');
    const other = T.triagePendingStub({ url }, { showId: 'oedipus-off-west-end-2026', heldIndex: idx });
    assert.equal(other.verdict, 'junk');
    assert.match(other.reason, /oedipus-west-end-2025/);
  });

  test('stub publishDate outside the production window settles a same-title earlier production; inside stays', () => {
    const url = 'https://www.thetimes.com/culture/theatre-dance/article/punch-review-abc';
    assert.equal(T.triagePendingStub({ url, publishDate: '2019-03-01' }, { showId: PUNCH.id, show: PUNCH }).verdict, 'junk');
    assert.equal(T.triagePendingStub({ url, publishDate: '2025-09-27' }, { showId: PUNCH.id, show: PUNCH }).verdict, 'candidate');
  });

  test('a venue-host rule never settles a host the corpus has scored a review from', () => {
    const idx = T.buildHeldUrlIndex([{ showId: 'a-2024', url: 'https://www.bam.org/some-real-review' }]);
    assert.equal(T.triagePendingStub({ url: 'http://www.BAM.org/Hamlet' }, { showId: 'hamlet-off-broadway-2026', heldIndex: idx }).verdict, 'candidate');
  });

  test('byline equal to a creative-team name is the show creator, not a critic', () => {
    const show = { creativeTeam: [{ name: 'William Shakespeare', role: 'Playwright' }] };
    assert.equal(T.bylineIsShowCreator('William Shakespeare', show), true);
    assert.equal(T.bylineIsShowCreator('Gareth Carr', show), false);
    assert.equal(T.bylineIsShowCreator('Unknown', show), false);
  });

  test('prose stub dates count (aggregator stubs store "December 14, 2014")', () => {
    assert.equal(T.stubDateIso('December 14, 2014'), '2014-12-14');
    assert.equal(T.stubDateIso('2025-09-27'), '2025-09-27');
    assert.equal(T.stubDateIso('yesterday'), null);
    assert.equal(T.stubDateIso(null), null);
    const url = 'http://www.theatermania.com/new-york-city-theater/reviews/every-brilliant-thing-barrow-street-review_70976.html';
    assert.equal(T.triagePendingStub({ url, publishDate: 'December 14, 2014' }, { showId: PUNCH.id, show: PUNCH }).verdict, 'junk');
  });

  test('dateless show: url year two years off its id year is junk; same year stays', () => {
    const myth = { id: 'myth-off-broadway-2026', title: 'Myth', closingDate: '2026-10-18' };
    assert.equal(T.triagePendingStub({ url: 'https://observer.com/2024/12/a-complete-unknown-review-a-thrilling-tour-of-established-myth/' }, { showId: myth.id, show: myth }).verdict, 'junk');
    assert.equal(T.triagePendingStub({ url: 'https://observer.com/2026/09/myth-review-x/' }, { showId: myth.id, show: myth }).verdict, 'candidate');
  });

  test('query-routed archives keep their id: two LSA stories are two keys (review finding)', () => {
    const idx = T.buildHeldUrlIndex([{ showId: 'a-2020', url: 'https://www.lightingandsoundamerica.com/news/story.asp?ID=1111' }]);
    assert.equal(T.triagePendingStub({ url: 'https://www.lightingandsoundamerica.com/news/story.asp?ID=2222' }, { showId: 'b-2026', heldIndex: idx }).verdict, 'candidate');
    assert.equal(T.triagePendingStub({ url: 'https://www.lightingandsoundamerica.com/news/story.asp?ID=1111' }, { showId: 'b-2026', heldIndex: idx }).verdict, 'junk');
  });

  test('a joint review naming this show too is not "another show\'s review" (review finding)', () => {
    const url = 'https://www.thetimes.com/culture/theatre-dance/article/theatre-review-faith-hope-and-charity-big-the-musical-abc';
    const idx = T.buildHeldUrlIndex([{ showId: 'faith-hope-and-charity-west-end-2019', url }]);
    const big = { id: 'big-the-musical-west-end-2019', title: 'Big the Musical' };
    const titles = { 'faith-hope-and-charity-west-end-2019': 'Faith, Hope and Charity' };
    assert.equal(T.triagePendingStub({ url }, { showId: big.id, show: big, heldIndex: idx, showTitleOf: (id) => titles[id] }).verdict, 'candidate');
  });

  test('a same-title holder is another production of this show: still junk even though the url names the title', () => {
    const url = 'https://nypost.com/2025/03/11/entertainment/a-streetcar-named-desire-review-paul-mescal-sizzles/';
    const idx = T.buildHeldUrlIndex([{ showId: 'a-streetcar-named-desire-west-end-2025', url }]);
    const old = { id: 'a-streetcar-named-desire-1973', title: 'A Streetcar Named Desire' };
    assert.equal(T.triagePendingStub({ url }, { showId: old.id, show: old, heldIndex: idx, showTitleOf: () => 'A Streetcar Named Desire' }).verdict, 'junk');
  });

  test('ordinal dates parse', () => { assert.equal(T.stubDateIso('August 12th, 2021'), '2021-08-12'); });

  test('no held index (reviews.json unreadable) turns the host rule off, not on', () => {
    assert.equal(T.triagePendingStub({ url: 'https://theaterscene.org/2022/10/1776/' }, { showId: 'x-2026', heldIndex: null }).verdict, 'candidate');
  });

  test('showEra buckets by id year suffix', () => {
    assert.equal(T.showEra('punch-west-end-2025'), '2025-26');
    assert.equal(T.showEra('hamlet-2019'), '2015-24');
    assert.equal(T.showEra('cats-1982'), 'pre-2015');
  });
});

describe('replay-pending-bylines processShow --triage-only (BRO-8023)', () => {
  test('tags junk (kept on disk), fetches nothing, counts candidates', async () => {
    const { processShow } = require('../../scripts/replay-pending-bylines.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8023-'));
    const dir = path.join(root, '_pending', PUNCH.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hollywood-reporter--a1.json'), JSON.stringify({ outletId: 'hollywood-reporter', criticName: 'Unknown', url: 'https://www.hollywoodreporter.com/movies/movie-reviews/punch-review-1236000000/' }));
    fs.writeFileSync(path.join(dir, 'guardian--c3.json'), JSON.stringify({ outletId: 'guardian', criticName: 'Unknown', url: 'https://www.theguardian.com/stage/2026/apr/01/other-play-review' }));
    fs.writeFileSync(path.join(dir, 'times-uk--b2.json'), JSON.stringify({ outletId: 'times-uk', criticName: 'Unknown', url: REAL[0][1] }));
    let fetches = 0; let resolved = 0;
    const r = await processShow(PUNCH.id, {
      root, show: PUNCH, dryRun: false, triageOnly: true,
      heldIndex: T.buildHeldUrlIndex([{ showId: 'punch-uk-tour-2026', url: 'https://www.theguardian.com/stage/2026/apr/01/other-play-review' }]), explicitScope: false,
      fetch: async () => { fetches++; return { content: '<html></html>' }; },
      alert: async () => {}, resolve: () => { resolved++; }, emit: () => {},
      budget: { exceeded: () => false, minutes: 5 },
    });
    assert.equal(fetches, 0);
    assert.equal(resolved, 0, 'a no-fetch pass must not resolve the show\'s unrecoverable alert');
    assert.equal(r.tagged, 2);
    assert.equal(r.candidates, 1);
    assert.equal(r.promoted, 0);
    const junk = JSON.parse(fs.readFileSync(path.join(dir, 'hollywood-reporter--a1.json'), 'utf8'));
    assert.match(junk.promoteSkippedReason, /not a review/);
    assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'guardian--c3.json'), 'utf8')).promoteSkippedReason, /already scored under punch-uk-tour-2026.*BRO-8023 triage/);
    assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'times-uk--b2.json'), 'utf8')).promoteSkippedReason);
  });
});

describe('BRO-8023: sameArticleSettleReason (text-bearing same-url stubs are tagged, never deleted)', () => {
  const { sameArticleSettleReason, isRedundantPendingStub } = require('../../scripts/replay-pending-bylines.js');
  const U = 'https://www.thewrap.com/creative-content/theater/the-heart-off-broadway-review-organ-transplant-musical/';
  const body = 'x'.repeat(4000);
  const stub = { criticName: 'Unknown', url: U, fullText: body };
  const good = { url: U, fullText: body, contentTier: 'complete' };
  test('a sound primary with the same article settles the stub, with the reason', () => {
    assert.match(sameArticleSettleReason(stub, good, 'thewrap--robert-hofler.json'), /same article already filed as thewrap--robert-hofler\.json/);
    assert.ok(sameArticleSettleReason({ ...stub, fullText: body + body }, { ...good, contentTier: 'truncated' }, 'f.json'));
  });
  test('a junk, flagged or wrong-author primary never settles it', () => {
    for (const p of [{ ...good, contentTier: 'invalid' }, { ...good, contentTier: 'stub' }, { ...good, wrongProduction: true }, { ...good, fullTextWrongAuthor: true }, { ...good, duplicateOf: 'x.json' }, { ...good, fullText: '' }]) {
      assert.equal(sameArticleSettleReason(stub, p, 'f.json'), null, JSON.stringify(Object.keys(p)));
    }
  });
  test('a score the primary lacks keeps it open; an excerpt does not (BRO-8091: sound body outranks excerpt)', () => {
    assert.equal(sameArticleSettleReason({ ...stub, originalScore: '4/5' }, good, 'f.json'), null);
    assert.equal(sameArticleSettleReason({ ...stub, aggregatorStars: '4/5' }, good, 'f.json'), null);
    for (const k of ['dtliThumb', 'bwwThumb', 'bwwScore', 'originalRating']) assert.equal(sameArticleSettleReason({ ...stub, [k]: 'Up', dtliExcerpt: 'x' }, good, 'f.json'), null, k);
    assert.ok(sameArticleSettleReason({ ...stub, dtliExcerpt: 'A fine show', showScoreExcerpt: 'x', bwwExcerpt: 'y' }, good, 'f.json'), 'excerpt-only stub settles against a sound primary');
    assert.equal(sameArticleSettleReason({ ...stub, dtliExcerpt: 'A fine show' }, { ...good, contentTier: 'stub' }, 'f.json'), null, 'unsound primary still keeps it open');
    assert.ok(sameArticleSettleReason({ ...stub, originalScore: '4/5' }, { ...good, originalScore: '4/5' }, 'f.json'));
  });
  test('a stub naming a different critic than the primary stays open (two critics, one url)', () => {
    assert.equal(sameArticleSettleReason({ ...stub, criticName: 'Jane Roe' }, { ...good, criticName: 'Robert Hofler' }, 'f.json'), null);
    assert.ok(sameArticleSettleReason({ ...stub, criticName: 'Robert Hofler' }, { ...good, criticName: 'Robert Hofler' }, 'f.json'));
  });
  test('id-routed urls are different articles (LSA story.asp?ID=)', () => {
    const a = 'https://www.lastagetimes.com/story.asp?ID=1111', b = 'https://www.lastagetimes.com/story.asp?ID=2222';
    assert.equal(sameArticleSettleReason({ ...stub, url: a }, { ...good, url: b }, 'f.json'), null);
  });
  test('the deletion rule is unchanged: any text keeps the stub', () => {
    assert.equal(isRedundantPendingStub(stub, 'thewrap--robert-hofler.json'), false);
    assert.equal(isRedundantPendingStub({ criticName: 'Unknown', url: U }, 'thewrap--robert-hofler.json'), true);
  });
});

describe('BRO-8023: processShow settles same-url stubs against the filed primary', () => {
  const { processShow } = require('../../scripts/replay-pending-bylines.js');
  const URL1 = 'https://culturesauce.com/punch-west-end-review/';
  function setup(stubText, primaryText, primaryTier = 'complete') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8023b-'));
    const pdir = path.join(root, '_pending', PUNCH.id);
    fs.mkdirSync(pdir, { recursive: true });
    fs.mkdirSync(path.join(root, PUNCH.id), { recursive: true });
    fs.writeFileSync(path.join(root, PUNCH.id, 'culturesauce--thom-geier.json'), JSON.stringify({ outletId: 'culturesauce', criticName: 'Thom Geier', url: URL1, fullText: primaryText, contentTier: primaryTier }));
    fs.writeFileSync(path.join(pdir, 'culturesauce--abc.json'), JSON.stringify({ outletId: 'culturesauce', criticName: 'Unknown', url: URL1, fullText: stubText }));
    return { root, stub: path.join(pdir, 'culturesauce--abc.json') };
  }
  const deps = (root, counter) => ({
    root, show: PUNCH, dryRun: false, heldIndex: null, explicitScope: false,
    fetch: async () => { counter.n++; return { content: '<html></html>' }; },
    alert: async () => {}, resolve: () => {}, emit: () => {}, budget: { exceeded: () => false, minutes: 5 },
  });
  test('a fetched copy of a filed article is tagged before any fetch, kept on disk', async () => {
    const body = 'word '.repeat(600);
    const { root, stub } = setup(body, body + ' more');
    const c = { n: 0 };
    const r = await processShow(PUNCH.id, deps(root, c));
    assert.equal(fs.existsSync(stub), true);
    assert.match(JSON.parse(fs.readFileSync(stub, 'utf8')).promoteSkippedReason, /same article already filed as culturesauce--thom-geier\.json/);
    assert.equal(r.tagged, 1);
    assert.equal(c.n, 0);
  });
  test('a stub carrying a longer body than the primary is tagged with the reason (kept), not re-fetched forever', async () => {
    const { root, stub } = setup('word '.repeat(900), 'word '.repeat(600));
    const c = { n: 0 };
    const d = deps(root, c);
    d.fetch = async () => { c.n++; return { content: '<html><head><meta name="author" content="Thom Geier"><meta property="article:published_time" content="2025-09-27T10:00:00Z"><title>Punch review</title></head><body><article><p>' + 'Punch at the Young Vic is a play. '.repeat(80) + '</p></article></body></html>' }; };
    const r = await processShow(PUNCH.id, d);
    assert.equal(fs.existsSync(stub), true, 'kept on disk');
    const j = JSON.parse(fs.readFileSync(stub, 'utf8'));
    assert.match(j.promoteSkippedReason || '', /same article already filed as culturesauce--thom-geier\.json/);
    assert.equal(r.tagged, 1);
  });
  test('a dry run neither drops nor tags', async () => {
    const body = 'word '.repeat(600);
    const { root, stub } = setup(body, body + ' more');
    const before = fs.readFileSync(stub, 'utf8');
    const d = deps(root, { n: 0 }); d.dryRun = true;
    await processShow(PUNCH.id, d);
    assert.equal(fs.readFileSync(stub, 'utf8'), before);
  });
  test('a stub against a stub-tier primary is kept pending, not tagged', async () => {
    const { root, stub } = setup('word '.repeat(900), '', 'stub');
    const d = deps(root, { n: 0 });
    d.fetch = async () => ({ content: '<html><head><meta name="author" content="Thom Geier"><meta property="article:published_time" content="2025-09-27T10:00:00Z"></head><body><article><p>' + 'Punch at the Young Vic is a play. '.repeat(80) + '</p></article></body></html>' });
    await processShow(PUNCH.id, d);
    assert.ok(fs.existsSync(stub));
    const kept = JSON.parse(fs.readFileSync(stub, 'utf8'));
    assert.ok(!kept.promoteSkippedReason);
    assert.equal(kept.pendingFetchAttemptResult, 'target-exists:culturesauce--thom-geier.json', 'why it stays open is recorded');
  });
});

// BRO-8065: the 18 known-junk 2025-26 queue urls (session 12bb3cbc sample) and the 6 real reviews beside them.
// Show records carry the real shows.json dates so the url-date rule is exercised as the drain sees it.
const S8065 = {
  'punch-west-end-2025': PUNCH,
  'girl-interrupted-off-broadway-2026': { title: 'Girl, Interrupted', previewsStartDate: '2026-05-13', openingDate: '2026-06-04', closingDate: '2026-07-12', category: 'off-broadway' },
  'the-story-west-end-2026': { title: 'The Story', previewsStartDate: '2026-08-27', openingDate: '2026-09-03', closingDate: '2026-10-24', category: 'west-end' },
  'fire-fire-off-west-end-2026': { title: 'Fire Fire', previewsStartDate: '2026-09-09', openingDate: '2026-09-11', closingDate: '2026-10-03', category: 'off-west-end' },
  'girls-off-west-end-2026': { title: 'Girls', previewsStartDate: '2026-10-22', openingDate: '2026-10-27', closingDate: '2026-11-21', category: 'off-west-end' },
  'the-years-west-end-2025': { title: 'The Years', previewsStartDate: '2025-01-24', openingDate: '2025-02-04', closingDate: '2025-04-19', category: 'west-end' },
  'endgame-off-broadway-2025': { title: 'Endgame', previewsStartDate: '2025-10-22', openingDate: '2025-10-26', closingDate: '2025-11-23', category: 'off-broadway' },
  'are-you-mad-at-me-off-broadway-2026': { title: 'Are You Mad At Me??', previewsStartDate: '2026-07-10', openingDate: '2026-07-20', closingDate: '2026-08-15', category: 'off-broadway' },
  'anonymous-off-broadway-2026': { title: 'Anonymous', openingDate: '2026-01-29', closingDate: '2026-03-07', category: 'off-broadway' },
  'catch-of-the-day-off-broadway-2026': { title: 'Catch of the Day', openingDate: '2026-06-10', closingDate: '2026-06-28', category: 'off-broadway' },
  'blood-of-my-blood-west-end-2026': { title: 'Blood of my Blood', previewsStartDate: '2026-10-01', openingDate: '2026-10-07', closingDate: '2026-11-07', category: 'west-end' },
  'spellbound-off-broadway-2026': { title: 'Spellbound', openingDate: '2026-08-19', closingDate: '2026-09-06', category: 'off-broadway' },
  '44-off-broadway-2025': { title: '44', previewsStartDate: '2025-10-14', openingDate: '2025-11-06', closingDate: '2026-01-04', category: 'off-broadway' },
  'jerome-off-broadway-2025': { title: 'Jerome', previewsStartDate: '2026-05-14', openingDate: '2026-06-02', closingDate: '2026-06-21', category: 'off-broadway' },
  'erebus-off-broadway-2026': { title: 'Erebus', previewsStartDate: '2026-10-28', closingDate: '2026-10-30', category: 'off-broadway' },
  'tosca-off-broadway-2026': { title: 'Tosca', previewsStartDate: '2026-11-01', openingDate: '2026-11-01', closingDate: '2027-05-27', category: 'off-broadway', venue: 'Metropolitan Opera House' },
  'the-cherry-orchard-west-end-2026': { title: 'The Cherry Orchard', previewsStartDate: '2026-10-03', openingDate: '2026-10-13', closingDate: '2027-01-09', category: 'west-end' },
  'iphigenie-en-tauride-english-national-opera-west-end-2026': { title: 'Iphigenie en Tauride - English National Opera', previewsStartDate: '2026-11-06', openingDate: '2026-11-06', closingDate: '2026-11-14', category: 'west-end' },
  'murder-cathedral-off-west-end-2026': { title: 'Murder in the Cathedral', previewsStartDate: '2026-10-12', openingDate: '2026-10-19', closingDate: '2026-11-07', category: 'off-west-end' },
  'an-evening-with-an-immigrant-off-west-end-2026': { title: 'An Evening With An Immigrant', previewsStartDate: '2026-10-06', openingDate: '2026-10-06', closingDate: '2026-10-07', category: 'off-west-end' },
  'the-hope-theory-off-broadway-2026': { title: 'The Hope Theory', previewsStartDate: '2026-09-09', openingDate: '2026-09-17', closingDate: '2026-12-06', category: 'off-broadway' },
  'cinderella-lyric-hammersmith-off-west-end-2026': { title: 'Cinderella', previewsStartDate: '2026-11-14', openingDate: '2026-11-21', closingDate: '2027-01-03', category: 'off-west-end' },
};

// 15 settle with no fetch (7 caught before BRO-8065, 8 by its rules).
const JUNK_8065 = [
  ['punch-west-end-2025', 'https://www.thetimes.com/culture/theatre-dance/article/james-graham-interview-punch-dear-england-87xz2w8rj'],
  ['girl-interrupted-off-broadway-2026', 'https://www.nytimes.com/2026/06/05/theater/tony-awards-2026-predictions.html'],
  ['the-story-west-end-2026', 'https://www.hollywoodreporter.com/movies/movie-features/katie-lee-biegel-interview-windows-on-the-world-cnn-kitchen-1236690000'],
  ['fire-fire-off-west-end-2026', 'https://www.hollywoodreporter.com/movies/movie-reviews/earth-wind-and-fire-review-questlove-documentary-hbo-1236610757'],
  ['girls-off-west-end-2026', 'https://www.hollywoodreporter.com/movies/movie-reviews/destroy-all-girls-review-1236665457'],
  ['endgame-off-broadway-2025', 'https://www.hollywoodreporter.com/movies/movie-news/avengers-endgame-encore-box-office-previews-primetime-beast-1236709715'],
  ['catch-of-the-day-off-broadway-2026', 'https://www.nytimes.com/2026/06/07/theater/june-squibb-tony-awards.html'],
  ['the-story-west-end-2026', 'https://www.indiewire.com/criticism/movies/iron-boy-review-1235216358/'],
  ['catch-of-the-day-off-broadway-2026', 'https://www.nytimes.com/live/2026/06/07/theater/tony-awards-2026/lesley-manville-wins-the-tony-for-best-actress-in-a-play'],
  ['blood-of-my-blood-west-end-2026', 'https://storiesfromthenewworld.com/outlander-blood-of-my-blood-episode-2-review/'],
  ['spellbound-off-broadway-2026', 'https://deadline.com/2024/11/spellbound-film-review-1236185047/'],
  ['44-off-broadway-2025', 'https://www.vulture.com/article/ayo-edebiri-snoopy-youre-a-good-man-charlie-brown.html'],
  ['jerome-off-broadway-2025', 'https://www.hollywoodreporter.com/movies/movie-reviews/unstoppable-review-jharrel-jerome-jennifer-lopez-1235994309/'],
  ['erebus-off-broadway-2026', 'https://watchcrunch.com/sean283/reviews/erebus-origin-review-340947'],
  ['tosca-off-broadway-2026', 'https://www.broadwayworld.com/bwwopera/article/review-met-audience-tips-its-hat-to-fedora-on-new-years-eve-20230101'],
];

// 3 stay fetch candidates on purpose; the fetching drain settled each on its fetched date/body. Url text alone
// cannot settle them without rejecting real reviews (measured over the 49,907 scored urls, BRO-8065):
//  - 28-years-later names "Years" + "review" and is 57 days past close: a url-date rule that near flags 34 real reviews.
//  - diego-andres-rodriguez-anonymous-content names "Anonymous", 136 days before opening (inside the OB 180-day lead).
//  - les-miserables-valjean-javert shares no word with the show: the card's own rule is "needs fetch, not junk"
//    (an opaque or descriptive slug is how FT/Times reviews look); an other-show-title rule flagged 26 real reviews.
const NEEDS_FETCH_8065 = [
  ['the-years-west-end-2025', 'https://deadline.com/2025/06/28-years-later-review-danny-boyle-jodie-comer-zombie-horror-1236436839/'],
  ['anonymous-off-broadway-2026', 'https://deadline.com/2025/09/diego-andres-rodriguez-anonymous-content-1236553226/'],
  ['are-you-mad-at-me-off-broadway-2026', 'https://www.nytimes.com/2026/07/21/theater/les-miserables-valjean-javert.html'],
];

const REAL_8065 = [
  ['the-cherry-orchard-west-end-2026', 'https://www.thetimes.com/culture/theatre-dance/article/the-cherry-orchard-review-skittish-revival-kenneth-branagh-x1'],
  ['iphigenie-en-tauride-english-national-opera-west-end-2026', 'https://www.thestage.co.uk/reviews/iphigenie-en-tauride-review-london-coliseum-english-national-opera'],
  ['murder-cathedral-off-west-end-2026', 'https://www.telegraph.co.uk/theatre/what-to-see/murder-cathedral-review-southwark-cathedraltough-brain-butt/'],
  ['an-evening-with-an-immigrant-off-west-end-2026', 'https://www.afridiziak.com/reviews/an-evening-with-an-immigrant/'],
  ['the-hope-theory-off-broadway-2026', 'https://thetheatretimes.com/the-hope-theory-a-recipe-for-believing-in-your-dreams/'],
  ['cinderella-lyric-hammersmith-off-west-end-2026', 'https://www.thetimes.com/culture/theatre-dance/article/cinderella-pantomime-reviews-lyric-hammersmith-x2'],
  // Scored corpus rows the BRO-8065 rules must leave alone (stage reviews under screen/awards-looking urls).
  ['a-few-good-men-2026', 'https://www.usatoday.com/story/entertainment/movies/2026/10/29/a-few-good-men-broadway-tom-blyth-review/92444731007/'],
  ['journeys-end-2007', 'https://variety.com/2007/film/awards/journey-s-end-1200510125/'],
  ['carousel-2018', 'https://www.showbiz411.com/2018/04/13/broadway-amy-adams-uma-thurman-hit-opening-night-of-magnificent-carousel-revival-with-joshua-henry-sealing-the-deal-on-a-tony-award'],
  ['yellow-face-2024', 'https://www.nysun.com/article/tony-winner-david-henry-hwangs-2007-play-yellow-face-makes-its-broadway-bow'],
];
const SHOWS_8065 = { ...S8065,
  'a-few-good-men-2026': { title: 'A Few Good Men', openingDate: '2026-11-03', category: 'broadway' },
  'journeys-end-2007': { title: "Journey's End", openingDate: '2007-02-22', closingDate: '2007-06-10', category: 'broadway' },
  'carousel-2018': { title: 'Carousel', openingDate: '2018-04-12', closingDate: '2018-09-16', category: 'broadway' },
  'yellow-face-2024': { title: 'Yellow Face', openingDate: '2024-10-01', closingDate: '2024-11-24', category: 'broadway' },
};

describe('triagePendingStub BRO-8065 fixtures', () => {
  const ctx = (showId) => ({ showId, show: SHOWS_8065[showId], heldIndex: new Map() });
  for (const [showId, url] of JUNK_8065) {
    test(`junk without a fetch: ${url}`, () => {
      const v = T.triagePendingStub({ url }, ctx(showId));
      assert.equal(v.verdict, 'junk', JSON.stringify(v));
    });
  }
  for (const [showId, url] of [...NEEDS_FETCH_8065, ...REAL_8065]) {
    test(`stays a fetch candidate: ${url}`, () => {
      assert.equal(T.triagePendingStub({ url }, ctx(showId)).verdict, 'candidate');
    });
  }
  test('url date: a year+ outside the run settles; inside the margin, a containing year, or no show dates does not', () => {
    const tosca = SHOWS_8065['tosca-off-broadway-2026'];
    assert.match(T.urlDateOutsideWindowReason('https://x.com/2023/01/tosca-review/', tosca), /more than a year/);
    assert.equal(T.urlDateOutsideWindowReason('https://x.com/2026/11/tosca-review/', tosca), null);
    assert.equal(T.urlDateOutsideWindowReason('https://x.com/2026/tosca-review/', tosca), null);
    assert.equal(T.urlDateOutsideWindowReason('https://x.com/2026/03/tosca-review/', tosca), null);
    assert.equal(T.urlDateOutsideWindowReason('https://x.com/2020/03/tosca-review/', { title: 'Tosca' }), null);
    assert.equal(T.urlDateOutsideWindowReason('https://www.broadwayworld.com/x/article/Review-TOSCA-20010101', tosca), null);
  });
  test('the bare-title rule exempts owner/manual stubs', () => {
    const url = 'https://www.vulture.com/article/ayo-edebiri-snoopy-youre-a-good-man-charlie-brown.html';
    assert.equal(T.triagePendingStub({ url, source: 'manual-user-request' }, ctx('44-off-broadway-2025')).verdict, 'candidate');
  });
});

// BRO-8065: 15 queue stubs (and 1 primary) stored a SiteGround bot-wall page as the article url.
describe('BRO-8065: bot-wall (sgcaptcha) urls', () => {
  const N = require('../../scripts/lib/non-review-url-patterns.js');
  const WALL = 'https://www.londontheatre1.com/.well-known/captcha/?y=ipr:4.236.167.0:1793232769.555&r=%2Freviews%2Fmemoriam-southwark-playhouse-borough%2F';
  test('unwrapChallengeUrl returns the guarded article url; anything else is null', () => {
    assert.equal(N.unwrapChallengeUrl(WALL), 'https://www.londontheatre1.com/reviews/memoriam-southwark-playhouse-borough/');
    assert.equal(N.unwrapChallengeUrl('https://www.londontheatre1.com/reviews/memoriam/'), null);
    assert.equal(N.unwrapChallengeUrl('https://x.com/.well-known/captcha/?r=%2F%2Fevil.com%2Fa'), null, 'never a protocol-relative hop');
    assert.equal(N.unwrapChallengeUrl('https://x.com/.well-known/captcha/?y=1'), null);
    assert.equal(N.unwrapChallengeUrl('https://example.com/.well-known/captcha/?r=%2F%5Cother.example%2Freview'), null, 'never a slash-backslash hop off-site');
    assert.equal(N.unwrapChallengeUrl('https://example.com/.well-known/captcha/?r=%2F'), null, 'a bare root is no article');
    assert.equal(N.unwrapChallengeUrl('https://example.com/.well-known/captcha/?r=%2F%3Fp%3D10339'), 'https://example.com/?p=10339', 'a query-routed post is an article');
    assert.ok(N.isChallengeUrl(WALL));
  });
  test('maybeUpgradeUrl never adopts a bot-wall url', () => {
    const { maybeUpgradeUrl } = require('../../scripts/lib/review-normalization.js');
    const rec = { url: 'https://www.londontheatre1.com/reviews/girls-young-vic/', contentTier: 'stub' };
    assert.equal(maybeUpgradeUrl(rec, WALL, 'google-news-rss'), false);
    assert.equal(rec.url, 'https://www.londontheatre1.com/reviews/girls-young-vic/');
  });
  test('the drain restores the url and re-opens a skip decided from the wall url alone', async () => {
    const { processShow } = require('../../scripts/replay-pending-bylines.js');
    const show = { id: 'memoriam-off-west-end-2026', title: 'Memoriam', previewsStartDate: '2026-10-20', openingDate: '2026-10-24', closingDate: '2026-11-14', category: 'off-west-end' };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8065-'));
    const dir = path.join(root, '_pending', show.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'londontheatre1--1.json'), JSON.stringify({ outletId: 'londontheatre1', criticName: 'Unknown', url: WALL, promoteSkippedReason: 'not this show (url-token-mismatch)' }));
    fs.writeFileSync(path.join(dir, 'londontheatre1--2.json'), JSON.stringify({ outletId: 'londontheatre1', criticName: 'Unknown', url: WALL, promoteSkippedReason: 'byline resolves to x.json, which already holds a different article' }));
    // The write guard unwrapped this one first (url already real), but its url-only skip came from the wall url.
    fs.writeFileSync(path.join(dir, 'londontheatre1--3.json'), JSON.stringify({ outletId: 'londontheatre1', criticName: 'Unknown', url: 'https://www.londontheatre1.com/reviews/memoriam-southwark-playhouse-borough/', challengeUrlUnwrappedFrom: WALL, promoteSkippedReason: 'not this show (url-token-mismatch)' }));
    const r = await processShow(show.id, { root, show, dryRun: false, triageOnly: true, heldIndex: new Map(), explicitScope: false,
      fetch: async () => { throw new Error('no fetch in triage-only'); }, alert: async () => {}, resolve: () => {}, emit: () => {},
      budget: { exceeded: () => false, minutes: 5 } });
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'londontheatre1--1.json'), 'utf8'));
    assert.equal(a.url, 'https://www.londontheatre1.com/reviews/memoriam-southwark-playhouse-borough/');
    assert.equal(a.challengeUrlUnwrappedFrom, WALL);
    assert.ok(!a.promoteSkippedReason, 'url-only skip re-opened: ' + JSON.stringify(a));
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'londontheatre1--3.json'), 'utf8'));
    assert.ok(!c.promoteSkippedReason, 'a skip from the wall url is re-opened even when another writer unwrapped first');
    assert.equal(r.candidates, 2);
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'londontheatre1--2.json'), 'utf8'));
    assert.match(b.promoteSkippedReason, /byline resolves/, 'a skip decided from the page itself stands');
    assert.equal(b.url, 'https://www.londontheatre1.com/reviews/memoriam-southwark-playhouse-borough/');
  });
});

test('BRO-8065: safeWriteReview stores the guarded article url, never the bot-wall page', () => {
  const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8065w-'));
  const f = path.join(dir, 'girls-off-west-end-2026', 'londontheatre1--unknown.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  safeWriteReview(f, { showId: 'girls-off-west-end-2026', outletId: 'londontheatre1', criticName: 'Unknown',
    url: 'https://www.londontheatre1.com/.well-known/captcha/?y=ipr:20.83.175.21:1793302839.755&r=%2Freviews%2Fgirls-young-vic%2F' });
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(out.url, 'https://www.londontheatre1.com/reviews/girls-young-vic/');
  assert.match(out.challengeUrlUnwrappedFrom, /well-known\/captcha/);
});

test('BRO-8065: the flip-flop breaker never keeps (or pins) a bot-wall url over the article it guards', () => {
  const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8065f-'));
  const f = path.join(dir, 'girls-off-west-end-2026', 'londontheatre1--unknown.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const WALL = 'https://www.londontheatre1.com/.well-known/captcha/?y=ipr:20.83.175.21:1793302839.755&r=%2Freviews%2Fgirls-young-vic%2F';
  const REAL = 'https://www.londontheatre1.com/reviews/girls-young-vic/';
  // The real file's shape: upgraded onto the wall url, with the real url as the change breadcrumb.
  fs.writeFileSync(f, JSON.stringify({ showId: 'girls-off-west-end-2026', outletId: 'londontheatre1', criticName: 'Unknown', url: WALL,
    urlCorrectedFrom: REAL, urlUpdatedFrom: REAL, _urlChangedClear: { from: REAL, to: WALL } }));
  safeWriteReview(f, { ...JSON.parse(fs.readFileSync(f, 'utf8')), url: WALL });
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(out.url, REAL);
  assert.notEqual(out.urlVerified, true);
  // And a file the breaker already pinned onto the wall is released by the next write.
  fs.writeFileSync(f, JSON.stringify({ ...out, url: WALL, urlVerified: true, urlVerifiedAuto: true, _urlChangedClear: { from: REAL, to: WALL } }));
  safeWriteReview(f, { ...JSON.parse(fs.readFileSync(f, 'utf8')) });
  const out2 = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(out2.url, REAL);
  assert.notEqual(out2.urlVerified, true);
  // Only the guarded article releases a pin: an unrelated url is not the "correction".
  const { _flipFlopShouldTakeIncoming } = require('../../scripts/lib/review-write-guard.js');
  if (typeof _flipFlopShouldTakeIncoming === 'function') {
    assert.equal(_flipFlopShouldTakeIncoming(WALL, 'https://www.othersite.com/reviews/girls/'), false);
    assert.equal(_flipFlopShouldTakeIncoming(WALL, REAL), true);
    const QW = 'https://www.lsa.com/.well-known/captcha/?r=%2Fnews%2Fstory.asp%3FID%3D1111';
    assert.equal(_flipFlopShouldTakeIncoming(QW, 'https://www.lsa.com/news/story.asp?ID=2222'), false, 'a different query-routed article');
    assert.equal(_flipFlopShouldTakeIncoming(QW, 'https://www.lsa.com/news/story.asp?ID=1111'), true);
  }
});

describe('BRO-8065 ship-check: rules that must not settle on url text alone', () => {
  test('an opaque url never settles a short title; a range url date never settles a show with a declared earlier run', () => {
    const NOID = { title: 'No I.D.', openingDate: '2023-04-19', closingDate: '2023-05-06' };
    assert.equal(T.triagePendingStub({ url: 'https://www.ft.com/content/0b6c1d6e-3d2a-4c1e-9f1e-123456789abc', title: 'No I.D. review' }, { showId: 'no-i-d-west-end-2023', show: NOID }).verdict, 'candidate');
    assert.equal(T.triagePendingStub({ url: 'https://www.ft.com/content/abcdef12-abcd-4abc-9abc-abcdef123456' }, { showId: 'no-i-d-west-end-2023', show: NOID }).verdict, 'candidate');
    const S = { title: 'Some Play', openingDate: '2026-03-01', closingDate: '2026-05-01', priorRuns: [{ openingDate: '2023-06-01', closingDate: '2023-06-30', venue: 'Almeida' }] };
    assert.equal(T.urlDateOutsideWindowReason('https://x.com/2023/review-of-a-show/', S), null);
    assert.equal(T.urlDateOutsideWindowReason('https://foo.blogspot.com/2023/06/review.html', S), null);
    const S2 = { title: 'Some Play', openingDate: '2026-03-01', closingDate: '2026-05-01' };
    assert.match(T.urlDateOutsideWindowReason('https://foo.blogspot.com/2023/06/review.html', S2), /2023-06/);
  });
  test('an awards slug that is itself a review, and a transfer slug, stay candidates', () => {
    const show = { title: 'Hamlet', openingDate: '2026-03-01', venue: 'Olivier Theatre' };
    assert.equal(T.triagePendingStub({ url: 'https://www.examplenews.com/theatre/tony-awards-contender-review-a-new-play/' }, { showId: 'h', show }).verdict, 'candidate');
    assert.equal(T.triagePendingStub({ url: 'https://www.examplenews.com/theatre/tony-awards-contender-review.html' }, { showId: 'h', show }).verdict, 'candidate');
    const sib = [{ id: 'hamlet-off-west-end-2025', venue: 'Young Vic' }];
    assert.equal(T.triagePendingStub({ url: 'https://www.examplenews.com/hamlet-transfers-from-the-young-vic-review' }, { showId: 'h', show, sameTitleShows: sib }).verdict, 'candidate');
  });
});

describe('BRO-8065: short titles and same-title sibling venues (2015-24 queue)', () => {
  const NOID = { title: 'No I.D.', previewsStartDate: '2023-04-18', openingDate: '2023-04-19', closingDate: '2023-05-06', venue: 'Royal Court' };
  test('"No I.D.": a url that never spells it out is junk; one that does stays a candidate; "N/A" is not judged', () => {
    const v = T.triagePendingStub({ url: 'https://www.dailymail.com/news/article-16194341/Cornell-rape-Jonathan-Newell-fraternity-sober-monitor-party.html' }, { showId: 'no-i-d-west-end-2023', show: NOID });
    assert.equal(v.verdict, 'junk');
    assert.equal(T.triagePendingStub({ url: 'https://www.thestage.co.uk/reviews/no-i-d-review-royal-court-london' }, { showId: 'no-i-d-west-end-2023', show: NOID }).verdict, 'candidate');
    assert.equal(T.triagePendingStub({ url: 'https://www.theguardian.com/stage/2023/apr/20/noid-review-royal-court' }, { showId: 'no-i-d-west-end-2023', show: NOID }).verdict, 'candidate');
    assert.equal(T.triagePendingStub({ url: 'http://www.lightingandsoundamerica.com/news/story.asp?ID=SFSTE5' }, { showId: 'n-a-off-broadway-2024', show: { title: 'N/A', openingDate: '2024-06-10' } }).verdict, 'candidate');
  });
  const TN = { title: 'Twelfth Night', previewsStartDate: '2017-02-15', openingDate: '2017-02-22', closingDate: '2017-05-13', venue: 'Olivier Theatre' };
  const SIBS = [{ id: 'twelfth-night-off-west-end-2014', venue: 'Young Vic' }, { id: 'twelfth-night-regional-2016', venue: 'Royal Exchange Theatre, Manchester' }];
  test('a slug placing the review at another same-title entry\'s venue is that entry\'s review', () => {
    const v = T.triagePendingStub({ url: 'https://www.thetimes.com/culture/theatre-dance/article/theatre-review-twelfth-night-at-the-young-vic-se1-88w8873pc' }, { showId: 'twelfth-night-west-end-2017', show: TN, sameTitleShows: SIBS });
    assert.equal(v.verdict, 'junk');
    assert.match(v.reason, /twelfth-night-off-west-end-2014/);
  });
  test('own venue, an undeclared pre-transfer venue, a playwright-named venue or a venue word in the title never settle', () => {
    const own = 'https://www.thetimes.com/culture/theatre-dance/article/twelfth-night-review-at-the-olivier-theatre-x1';
    assert.equal(T.triagePendingStub({ url: own }, { showId: 'twelfth-night-west-end-2017', show: TN, sameTitleShows: SIBS }).verdict, 'candidate');
    // Death of a Salesman 2019 (Piccadilly) transferred from the Young Vic; no Young Vic entry exists, so no sibling.
    const dos = { title: 'Death of a Salesman', openingDate: '2019-10-31', venue: 'Piccadilly Theatre' };
    assert.equal(T.triagePendingStub({ url: 'https://www.thetimes.com/culture/theatre-dance/article/review-death-of-a-salesman-at-the-young-vic-se1-r9d8xhgnw' }, { showId: 'death-of-a-salesman-west-end-2019', show: dos, sameTitleShows: [{ id: 'death-of-a-salesman-1949', venue: 'Morosco Theatre' }] }).verdict, 'candidate');
    const betrayal = { title: 'Betrayal', openingDate: '2019-09-05', venue: 'Bernard B. Jacobs Theatre' };
    assert.equal(T.triagePendingStub({ url: 'https://observer.com/2019/09/tom-hiddleston-betrayal-broadway-debut-review-harold-pinter/' }, { showId: 'betrayal-2019', show: betrayal, sameTitleShows: [{ id: 'betrayal-west-end-2019', venue: 'Harold Pinter Theatre' }] }).verdict, 'candidate');
    const crucible = { title: 'The Crucible', openingDate: '2016-03-31', venue: 'Walter Kerr Theatre' };
    assert.equal(T.triagePendingStub({ url: 'http://www.hollywoodreporter.com/review/saoirse-ronan-crucible-theater-review-879646' }, { showId: 'the-crucible-2016', show: crucible, sameTitleShows: [{ id: 'the-crucible-crucible-regional-2024', venue: 'Crucible Theatre, Sheffield' }] }).verdict, 'candidate');
  });
});

test('BRO-8065 review: the drain never deletes a stub whose url year is a declared earlier run', async () => {
  const { processShow } = require('../../scripts/replay-pending-bylines.js');
  const show = { id: 'some-play-west-end-2026', title: 'Some Play', openingDate: '2026-03-01', closingDate: '2026-05-01', category: 'west-end',
    priorRuns: [{ openingDate: '2023-06-01', closingDate: '2023-06-30', venue: 'Almeida Theatre' }] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8065y-'));
  const dir = path.join(root, '_pending', show.id);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'guardian--1.json');
  fs.writeFileSync(f, JSON.stringify({ outletId: 'guardian', criticName: 'Unknown', url: 'https://www.theguardian.com/stage/2023/jun/10/some-play-review-almeida' }));
  const r = await processShow(show.id, { root, show, dryRun: false, triageOnly: true, heldIndex: new Map(), explicitScope: false,
    fetch: async () => { throw new Error('no fetch'); }, alert: async () => {}, resolve: () => {}, emit: () => {},
    budget: { exceeded: () => false, minutes: 5 } });
  assert.ok(fs.existsSync(f), 'kept on disk');
  assert.equal(r.rejected || 0, 0);
  assert.ok(!JSON.parse(fs.readFileSync(f, 'utf8')).promoteSkippedReason);
});

test('BRO-8065: --shard=1/n .. n/n together cover every show exactly once', () => {
  const { inShard } = require('../../scripts/replay-pending-bylines.js');
  const ids = Array.from({ length: 400 }, (_, i) => `show-${i}-west-end-20${10 + (i % 15)}`);
  for (const n of [1, 2, 4, 7]) {
    for (const id of ids) {
      const hits = Array.from({ length: n }, (_, k) => k + 1).filter((i) => inShard(id, i, n)).length;
      assert.equal(hits, 1, `${id} in ${hits} of ${n} shards`);
    }
  }
});

// BRO-8023 intake: gather-reviews refused only off-topic sections before writing a no-byline stub, so these real
// queue rows were written and sat in _pending. The intake guard is the drain's triage, so both judge them alike.
describe('pendingIntakeRejectReason (BRO-8023 intake guard)', () => {
  const TENDER = { id: 'tender-off-west-end-2026', title: 'Tender', openingDate: '2026-07-09', closingDate: '2026-08-01', category: 'off-west-end',
    priorRuns: [{ openingDate: '2024-11-19', closingDate: '2024-12-21', venue: 'Bush Theatre Studio' }] };
  const INTAKE_JUNK = [
    ['girl-interrupted-off-broadway-2026', { url: 'https://www.nytimes.com/2026/06/05/theater/tony-awards-2026-predictions.html' }],
    ['catch-of-the-day-off-broadway-2026', { url: 'https://www.nytimes.com/live/2026/06/07/theater/tony-awards-2026/lesley-manville-wins-the-tony-for-best-actress-in-a-play' }],
    ['blood-of-my-blood-west-end-2026', { url: 'https://storiesfromthenewworld.com/outlander-blood-of-my-blood-episode-2-review/' }],
    ['girls-off-west-end-2026', { url: 'https://www.hollywoodreporter.com/movies/movie-reviews/destroy-all-girls-review-1236665457' }],
    ['spellbound-off-broadway-2026', { url: 'https://deadline.com/2024/11/spellbound-film-review-1236185047/' }],
    ['endgame-off-broadway-2025', { url: 'https://www.hollywoodreporter.com/movies/movie-news/avengers-endgame-encore-box-office-previews-primetime-beast-1236709715' }],
  ];
  const showOf = (id) => (id === TENDER.id ? TENDER : SHOWS_8065[id] ? { id, ...SHOWS_8065[id] } : null);
  for (const [id, review] of INTAKE_JUNK) {
    test(`refused at intake: ${review.url}`, () => {
      assert.ok(T.pendingIntakeRejectReason({ ...review, source: 'site-search' }, showOf(id)), review.url);
    });
  }
  // A stored stub date is production identity, not page kind: the drain settles it (tag and keep), intake does not.
  const TENDER_NAPALM = { url: 'http://theater.nytimes.com/2012/08/30/theater/reviews/tender-napalm-by-philip-ridley-at-59e59-theaters.html?ref=theater',
    publishDate: 'August 30, 2012', source: 'dtli' };
  test('the drain settles a 2012 Tender Napalm review (url date) under the 2026 Tender without a fetch', () => {
    const v = T.triagePendingStub(TENDER_NAPALM, { showId: TENDER.id, show: TENDER, heldIndex: new Map() });
    assert.equal(v.verdict, 'junk');
    assert.match(v.reason, /outside this production's window/);
  });
  test('intake does not judge on the url date (CLAUDE.md: no metadata from URLs; the drain tags and keeps)', () => {
    assert.equal(T.pendingIntakeRejectReason(TENDER_NAPALM, TENDER), null);
  });
  test('intake leaves production-identity rules to the drain (stub date alone, sibling venue, bare title)', () => {
    // Real scored reviews the identity rules flag: Hadestown at the Olivier under the West End entry, a 13 review.
    const hades = { id: 'hadestown-west-end-2024', title: 'Hadestown', openingDate: '2024-02-21', category: 'west-end', venue: 'Lyric Theatre' };
    assert.equal(T.pendingIntakeRejectReason({ url: 'https://www.telegraph.co.uk/theatre/what-to-see/hadestown-review-nationals-olivier-theatre-enjoyable-winter/' }, hades), null);
    assert.equal(T.pendingIntakeRejectReason({ url: 'http://theater.nytimes.com/2008/10/06/theater/reviews/06bran.html' }, { id: '13-2008', title: '13', openingDate: '2008-10-05' }), null);
    assert.equal(T.pendingIntakeRejectReason({ url: 'https://example.com/some-play-review', publishDate: '2012-01-01' }, TENDER), null);
  });
  test('the old intake rule (off-topic section only) let most of them through', () => {
    const passedOld = INTAKE_JUNK.filter(([, r]) => !offTopicSectionReason(r.url)).length;
    assert.ok(passedOld >= 3, `${passedOld}`);
  });
  for (const [id, url] of [...REAL_8065, ...NEEDS_FETCH_8065]) {
    test(`still written to _pending: ${url}`, () => {
      assert.equal(T.pendingIntakeRejectReason({ url, source: 'site-search' }, showOf(id)), null);
    });
  }
  test('human submissions are never refused here', () => {
    assert.equal(T.pendingIntakeRejectReason({ url: 'https://www.nytimes.com/2026/06/05/theater/tony-awards-2026-predictions.html', source: 'submit-review-form' },
      showOf('girl-interrupted-off-broadway-2026')), null);
  });
  test('no show entry: url-only rules still apply, dates are not guessed', () => {
    assert.ok(T.pendingIntakeRejectReason({ url: 'https://www.nytimes.com/live/2026/06/07/theater/tony-awards-2026/x' }, null));
    assert.equal(T.pendingIntakeRejectReason({ url: 'https://www.thestage.co.uk/reviews/some-play-review-almeida' }, null), null);
  });
});

test('BRO-8023: a ".html" review slug naming "interview" is not rejected as an interview', async () => {
  const { createRequire } = await import('node:module');
  const { pendingIntakeRejectReason } = createRequire(import.meta.url)('../../scripts/lib/pending-triage.js');
  const r = pendingIntakeRejectReason({ url: 'https://www.nytimes.com/2026/05/02/theater/the-interview-review.html' }, null);
  assert.equal(r, null);
});

// BRO-7930 class guard (audit BRO-8093): a byline that resolves to a filename already holding the same critic's
// OTHER article was "kept pending" forever and re-fetched on every sweep (43 of ~82 unresolved open-show stubs,
// the main reason the drain printed Promoted: 0 while starving the rest of the budget). It must be tagged once
// (kept on disk, reason recorded) and never fetched again.
test('BRO-7930: a stub whose byline lands on the same critic\'s OTHER article is tagged once, not re-fetched every run', async () => {
  const { processShow } = require('../../scripts/replay-pending-bylines.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7930c-'));
  const pdir = path.join(root, '_pending', PUNCH.id);
  fs.mkdirSync(pdir, { recursive: true });
  fs.mkdirSync(path.join(root, PUNCH.id), { recursive: true });
  fs.writeFileSync(path.join(root, PUNCH.id, 'culturesauce--thom-geier.json'), JSON.stringify({ outletId: 'culturesauce', criticName: 'Thom Geier', url: 'https://culturesauce.com/punch-west-end-review/', fullText: 'word '.repeat(600), contentTier: 'complete' }));
  const stub = path.join(pdir, 'culturesauce--def.json');
  fs.writeFileSync(stub, JSON.stringify({ outletId: 'culturesauce', criticName: 'Unknown', url: 'https://culturesauce.com/punch-young-vic-second-look-review/' }));
  const c = { n: 0 };
  const d = {
    root, show: PUNCH, dryRun: false, heldIndex: null, explicitScope: false,
    fetch: async () => { c.n++; return { content: '<html><head><meta name="author" content="Thom Geier"><meta property="article:published_time" content="2025-09-27T10:00:00Z"><title>Punch review</title></head><body><article><p>' + 'Punch at the Young Vic is a play. '.repeat(80) + '</p></article></body></html>' }; },
    alert: async () => {}, resolve: () => {}, emit: () => {}, budget: { exceeded: () => false, minutes: 5 },
  };
  const r1 = await processShow(PUNCH.id, d);
  assert.equal(r1.promoted, 0);
  assert.equal(r1.tagged, 1, 'the colliding stub is tagged, not silently kept');
  assert.equal(fs.existsSync(stub), true, 'kept on disk (KEEP-not-delete)');
  assert.match(JSON.parse(fs.readFileSync(stub, 'utf8')).promoteSkippedReason || '', /already holds a different article/);
  const fetchesAfterFirst = c.n;
  await processShow(PUNCH.id, d);
  assert.equal(c.n, fetchesAfterFirst, 'a tagged stub is not fetched again on the next sweep');
});

// ---------------------------------------------------------------------------------------------------------------
// BRO-8089: settle triage junk where it is written, and stop producers re-sending the same quarantine every run.
// ---------------------------------------------------------------------------------------------------------------
describe('BRO-8089: _pending intake settles what the drain would settle', () => {
  const HENRY = { id: 'henry-iv-off-broadway-2015', title: 'Henry IV', openingDate: '2015-11-06', closingDate: '2015-12-13' };
  const ctx = { byId: new Map([[HENRY.id, HENRY]]), allShows: [HENRY], heldIndex: new Map() };

  test('gather-reviews writes an identity-junk no-byline stub already settled (kept, not refused); a candidate stays open', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-gather-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = `
      const intake = require(${JSON.stringify(path.resolve('scripts/lib/pending-intake.js'))});
      intake._setContextForTests({ byId: new Map([[${JSON.stringify(HENRY.id)}, ${JSON.stringify(HENRY)}]]), allShows: [${JSON.stringify(HENRY)}], heldIndex: new Map() });
      const g = require(${JSON.stringify(path.resolve('scripts/gather-reviews.js'))});
      const base = { outletId: 'variety', outlet: 'Variety', criticName: 'Unknown', source: 'show-score' };
      const junk = g.createReviewFile(${JSON.stringify(HENRY.id)}, { ...base, url: 'https://variety.com/legit/reviews/london-theater-review-henry-iv-1201325786/', publishDate: '2014-10-10' });
      const real = g.createReviewFile(${JSON.stringify(HENRY.id)}, { ...base, outletId: 'nytimes', outlet: 'NYT', url: 'https://www.nytimes.com/2015/11/07/theater/henry-iv-review.html', publishDate: '2015-11-07' });
      process.stdout.write(JSON.stringify({ junk, real }));`;
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, REVIEW_TEXTS_DIR: root }, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { junk: true, real: true });
    const dir = path.join(root, '_pending', HENRY.id);
    const recs = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.equal(recs.length, 2, 'both kept on disk');
    const junkRec = recs.find((x) => x.url.includes('variety'));
    const realRec = recs.find((x) => x.url.includes('nytimes'));
    assert.match(junkRec.promoteSkippedReason || '', /outside this production's window.*BRO-8089 intake triage/);
    assert.equal(T.isSettledPendingStub(junkRec), true);
    assert.equal(T.isSettledPendingStub(realRec), false, 'an in-window candidate is left for the drain to fetch');
  });

  test('pending-intake fails open (candidate) when data cannot load', () => {
    const { intakeVerdict } = require('../../scripts/lib/pending-intake.js');
    assert.equal(intakeVerdict({ url: 'https://x.com/a', publishDate: '1999-01-01' }, HENRY.id, { dataDir: '/nonexistent-bro8089' }).verdict, 'candidate');
  });

  function quarantineOnce(root, extra = {}) {
    const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
    const sid = 'cyrano-de-bergerac-west-end-2026';
    const showRow = { id: sid, title: 'Cyrano de Bergerac', previewsStartDate: '2026-03-10', openingDate: '2026-03-25', closingDate: '2026-06-01' };
    _setShowsCacheForTest(new Map([[sid, showRow]]));
    require('../../scripts/lib/pending-intake.js')._setContextForTests({ byId: new Map([[sid, showRow]]), allShows: [showRow], heldIndex: new Map() });
    const target = path.join(root, sid, 'guardian--arifa-akbar.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const res = safeWriteReview(target, { publishDate: '2025-08-01', criticName: 'Arifa Akbar', url: 'https://www.theguardian.com/stage/2025/aug/01/cyrano-review', ...extra });
    return { res, qPath: path.join(root, '_pending', sid, 'guardian--arifa-akbar.json') };
  }

  test('write guard: a date_implausible quarantine is settled on arrival', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-q-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const { res, qPath } = quarantineOnce(root, { firstSeenAt: '2026-11-21T16:42:04.561Z' });
    assert.equal(res.skipped, 'date_implausible');
    assert.ok(res.quarantinedPath, 'still a completed move for move-then-delete callers');
    const q = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    assert.match(q.promoteSkippedReason, /BRO-8089 intake triage/);
  });

  test('write guard: the same out-of-window review re-sent next run does not rewrite the settled stub (show-score churn)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-churn-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const { qPath } = quarantineOnce(root, { firstSeenAt: '2026-11-21T16:42:04.561Z' });
    const before = fs.readFileSync(qPath, 'utf8');
    const { res } = quarantineOnce(root, { firstSeenAt: '2026-11-22T16:56:35.296Z' });
    assert.ok(res.quarantinedPath);
    assert.equal(fs.readFileSync(qPath, 'utf8'), before, 'settled stub left byte-identical; firstSeenAt not reset');
  });

  test('write guard: an open stub re-quarantined keeps its oldest firstSeenAt; an un-settled (nulled) stub is not re-settled', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-open-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const { qPath } = quarantineOnce(root, { firstSeenAt: '2026-11-01T00:00:00.000Z' });
    const rec = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    rec.promoteSkippedReason = null; rec.promoteSkippedAt = null; // the drain's retry un-settles this way
    fs.writeFileSync(qPath, JSON.stringify(rec));
    quarantineOnce(root, { firstSeenAt: '2026-11-22T00:00:00.000Z' });
    const after = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    assert.equal(after.firstSeenAt, '2026-11-01T00:00:00.000Z');
    assert.equal(T.isSettledPendingStub(after), false);
  });

  test('open-stub growth week over week files an auto Fix card (ACTION), quiet when flat', async () => {
    const { raiseDrainHealthAlerts } = require('../../scripts/replay-pending-bylines.js');
    const row = (at, n) => ({ at, scope: 'all-pending', pending: 100, promoted: 1, dropped: 0, rejected: 0, tagged: 0, inspected: 5, openByEra: { '2025-26': n, '2015-24': 0, 'pre-2015': 0 } });
    const calls = [];
    const deps = { alert: async (o) => { calls.push(o); }, resolve: async (k) => { calls.push({ resolved: k }); } };
    await raiseDrainHealthAlerts([row('2026-11-08T00:00:00Z', 100), row('2026-11-15T00:00:00Z', 160)], deps);
    const a = calls.find((c) => c.conditionKey === 'pending-open-growth');
    assert.ok(a, 'growth alert raised');
    assert.equal(a.disposition, 'auto');
    assert.equal(a.cardAction, 'Fix');
    calls.length = 0;
    await raiseDrainHealthAlerts([row('2026-11-08T00:00:00Z', 100), row('2026-11-15T00:00:00Z', 101)], deps);
    assert.ok(calls.some((c) => c.resolved === 'pending-open-growth'));
  });
});

describe('BRO-8089 ship-check: intake context and re-quarantine merges', () => {
  test('loadContext reads the real reviews.json shape ({_meta, reviews:[rows]}) into a non-empty held index', (t) => {
    const { loadContext } = require('../../scripts/lib/pending-intake.js');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-ctx-'));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    fs.writeFileSync(path.join(d, 'shows.json'), JSON.stringify({ shows: [{ id: 'a-2026', title: 'A' }] }));
    fs.writeFileSync(path.join(d, 'reviews.json'), JSON.stringify({ _meta: {}, reviews: [{ showId: 'a-2026', url: 'https://www.nytimes.com/2026/01/01/theater/a-review.html' }] }));
    const ctx = loadContext(d);
    assert.equal(ctx.heldIndex.size, 1, 'an empty index makes every non-review-host url look unscored');
  });
  test('an empty held index fails open (candidate), never settles', () => {
    const { intakeVerdict } = require('../../scripts/lib/pending-intake.js');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-empty-'));
    fs.writeFileSync(path.join(d, 'shows.json'), JSON.stringify({ shows: [] }));
    fs.writeFileSync(path.join(d, 'reviews.json'), JSON.stringify({ _meta: {}, reviews: [] }));
    assert.equal(intakeVerdict({ url: 'https://www.bam.org/theater/2026/x' }, 'x-2026', { dataDir: d }).verdict, 'candidate');
  });
  test('a settled quarantine re-sent WITH recovered text is merged (text kept, settlement kept), not discarded', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-text-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const { qPath } = quarantineOnce2(root, {});
    assert.ok(T.isSettledPendingStub(JSON.parse(fs.readFileSync(qPath, 'utf8'))));
    quarantineOnce2(root, { fullText: 'Recovered article body. '.repeat(20) });
    const after = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    assert.match(after.fullText, /Recovered article body/);
    assert.equal(T.isSettledPendingStub(after), true);
  });
  test('an explicit null un-settle survives two producer replays', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-null-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const { qPath } = quarantineOnce2(root, {});
    const rec = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    rec.promoteSkippedReason = null; rec.promoteSkippedAt = null;
    fs.writeFileSync(qPath, JSON.stringify(rec));
    quarantineOnce2(root, {}); quarantineOnce2(root, {});
    const after = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    assert.equal(after.promoteSkippedReason, null);
    assert.equal(T.isSettledPendingStub(after), false);
  });
  function quarantineOnce2(root, extra) {
    const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
    const sid = 'cyrano-de-bergerac-west-end-2026';
    const showRow = { id: sid, title: 'Cyrano de Bergerac', previewsStartDate: '2026-03-10', openingDate: '2026-03-25', closingDate: '2026-06-01' };
    _setShowsCacheForTest(new Map([[sid, showRow]]));
    require('../../scripts/lib/pending-intake.js')._setContextForTests({ byId: new Map([[sid, showRow]]), allShows: [showRow], heldIndex: new Map() });
    const target = path.join(root, sid, 'guardian--arifa-akbar.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    safeWriteReview(target, { publishDate: '2025-08-01', criticName: 'Arifa Akbar', url: 'https://www.theguardian.com/stage/2025/aug/01/cyrano-review', ...extra });
    return { qPath: path.join(root, '_pending', sid, 'guardian--arifa-akbar.json') };
  }
});

describe('BRO-8089 ship-check pass 2: text is never lost on a re-quarantine', () => {
  function q(root, extra) {
    const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
    const sid = 'cyrano-de-bergerac-west-end-2026';
    const showRow = { id: sid, title: 'Cyrano de Bergerac', previewsStartDate: '2026-03-10', openingDate: '2026-03-25', closingDate: '2026-06-01' };
    _setShowsCacheForTest(new Map([[sid, showRow]]));
    require('../../scripts/lib/pending-intake.js')._setContextForTests({ byId: new Map([[sid, showRow]]), allShows: [showRow], heldIndex: new Map() });
    const target = path.join(root, sid, 'guardian--arifa-akbar.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    safeWriteReview(target, { publishDate: '2025-08-01', criticName: 'Arifa Akbar', url: 'https://www.theguardian.com/stage/2025/aug/01/cyrano-review', ...extra });
    return path.join(root, '_pending', sid, 'guardian--arifa-akbar.json');
  }
  test('a settled stub holding a teaser is upgraded by a re-send with the full article', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-up-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const p = q(root, { fullText: 'Teaser only.' });
    q(root, { fullText: 'The complete article. '.repeat(40) });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.match(after.fullText, /complete article/);
    assert.equal(T.isSettledPendingStub(after), true);
  });
  test('an un-settled stub with recovered text keeps it when a textless re-send arrives', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-keep-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const p = q(root, {});
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    Object.assign(rec, { promoteSkippedReason: null, promoteSkippedAt: null, fullText: 'Recovered body. '.repeat(30), contentTier: 'complete' });
    fs.writeFileSync(p, JSON.stringify(rec));
    q(root, {});
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.match(after.fullText, /Recovered body/);
    assert.equal(after.contentTier, 'complete');
    assert.equal(after.promoteSkippedReason, null);
  });
});

describe('BRO-8089 ship-check pass 3: longer body and scraped rating survive a re-quarantine', () => {
  function q(root, extra) {
    const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
    const sid = 'cyrano-de-bergerac-west-end-2026';
    const showRow = { id: sid, title: 'Cyrano de Bergerac', previewsStartDate: '2026-03-10', openingDate: '2026-03-25', closingDate: '2026-06-01' };
    _setShowsCacheForTest(new Map([[sid, showRow]]));
    require('../../scripts/lib/pending-intake.js')._setContextForTests({ byId: new Map([[sid, showRow]]), allShows: [showRow], heldIndex: new Map() });
    const target = path.join(root, sid, 'guardian--arifa-akbar.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    safeWriteReview(target, { publishDate: '2025-08-01', criticName: 'Arifa Akbar', url: 'https://www.theguardian.com/stage/2025/aug/01/cyrano-review', ...extra });
    return path.join(root, '_pending', sid, 'guardian--arifa-akbar.json');
  }
  test('a replayed teaser does not replace a settled full article', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-teaser-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const p = q(root, { fullText: 'The complete article. '.repeat(60), contentTier: 'complete' });
    q(root, { fullText: 'Teaser.', contentTier: 'excerpt' });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.match(after.fullText, /complete article/);
    assert.equal(after.contentTier, 'complete');
  });
  test('a textless re-send keeps the scraped rating read with a recovered body', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-rating-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const p = q(root, {});
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    Object.assign(rec, { promoteSkippedReason: null, fullText: 'Recovered body. '.repeat(30), originalScore: '4/5', scoreExtractedFrom: 'scraped-html' });
    fs.writeFileSync(p, JSON.stringify(rec));
    q(root, {});
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.originalScore, '4/5');
    assert.equal(after.pendingReason, 'date_implausible');
  });
});

test('BRO-8089: two different urls quarantined under one critic filename both survive repeated runs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-collide-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
  const { safeWriteReview, _setShowsCacheForTest } = require('../../scripts/lib/review-write-guard.js');
  const sid = 'the-dead-1904-off-broadway-2026';
  const showRow = { id: sid, title: 'The Dead, 1904', previewsStartDate: '2026-11-21', openingDate: '2026-11-24', closingDate: '2027-01-03' };
  _setShowsCacheForTest(new Map([[sid, showRow]]));
  require('../../scripts/lib/pending-intake.js')._setContextForTests({ byId: new Map([[sid, showRow]]), allShows: [showRow], heldIndex: new Map() });
  const target = path.join(root, sid, 'theatermania--pete-hempstead.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const A = { publishDate: '2018-11-29', criticName: 'Pete Hempstead', url: 'https://www.theatermania.com/off-broadway/reviews/a-holiday-party-turns-political-in-the-dead-1904_87180.html' };
  const B = { publishDate: '2017-11-30', criticName: 'Pete Hempstead', url: 'https://www.theatermania.com/off-broadway/reviews/the-dead-1904-irish-rep_83000.html' };
  for (let run = 0; run < 2; run++) { safeWriteReview(target, { ...A }); safeWriteReview(target, { ...B }); }
  const dir = path.join(root, '_pending', sid);
  const urls = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).url).sort();
  assert.deepEqual(urls, [A.url, B.url].sort());
  const before = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('|');
  safeWriteReview(target, { ...A }); safeWriteReview(target, { ...B });
  assert.equal(fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('|'), before, 'a third run rewrites nothing');
});

describe('BRO-8089 ship-check pass 4', () => {
  function setup(sid, showRow) {
    const g = require('../../scripts/lib/review-write-guard.js');
    g._setShowsCacheForTest(new Map([[sid, showRow]]));
    require('../../scripts/lib/pending-intake.js')._setContextForTests({ byId: new Map([[sid, showRow]]), allShows: [showRow], heldIndex: new Map() });
    return g.safeWriteReview;
  }
  const sid = 'cyrano-de-bergerac-west-end-2026';
  const showRow = { id: sid, title: 'Cyrano de Bergerac', previewsStartDate: '2026-03-10', openingDate: '2026-03-25', closingDate: '2026-06-01' };
  const base = { publishDate: '2025-08-01', criticName: 'Arifa Akbar', url: 'https://www.theguardian.com/stage/2025/aug/01/cyrano-review' };
  test('a teaser keeps the longer body, its word count and its rating; the oldest firstSeenAt wins', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-p4-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const write = setup(sid, showRow);
    const target = path.join(root, sid, 'guardian--arifa-akbar.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    write(target, { ...base, firstSeenAt: '2026-11-20T00:00:00.000Z', fullText: 'Full article. '.repeat(60), textWordCount: 120, originalScore: '4/5', scoreExtractedFrom: 'scraped-html' });
    write(target, { ...base, firstSeenAt: '2026-11-01T00:00:00.000Z', fullText: 'Teaser.', textWordCount: 1 });
    const after = JSON.parse(fs.readFileSync(path.join(root, '_pending', sid, 'guardian--arifa-akbar.json'), 'utf8'));
    assert.equal(after.textWordCount, 120);
    assert.equal(after.originalScore, '4/5');
    assert.equal(after.firstSeenAt, '2026-11-01T00:00:00.000Z');
  });
  test('a filename collision reports the url-hashed sibling as quarantinedPath', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8089-p4b-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); require('../../scripts/lib/pending-intake.js')._resetForTests(); });
    const write = setup(sid, showRow);
    const target = path.join(root, sid, 'guardian--arifa-akbar.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const r1 = write(target, { ...base });
    const r2 = write(target, { ...base, url: 'https://www.theguardian.com/stage/2025/jul/02/other-review' });
    assert.notEqual(r1.quarantinedPath, r2.quarantinedPath);
    assert.equal(JSON.parse(fs.readFileSync(r2.quarantinedPath, 'utf8')).url, 'https://www.theguardian.com/stage/2025/jul/02/other-review');
  });
});

// ---- BRO-8090: opaque urls are never "not this show"; a sibling-owned article is rehomed, not settled ----
const S = require('../../scripts/lib/pending-sibling-productions.js');
const V = require('../../scripts/lib/show-match-verifier.js');
const { pendingPromoteRejectReason, isInconclusiveReject } = require('../../scripts/replay-pending-bylines.js');

// Real shows.json rows (2026-11-22).
const YEES = { id: 'king-of-the-yees-off-broadway-2026', title: 'King of the Yees', market: 'broadway', venue: 'Signature Theatre Company/Alice Griffin Jewel Box Theater', previewsStartDate: '2026-10-06', openingDate: '2026-10-19', closingDate: '2026-11-15' };
const A1536 = { id: '1536-off-west-end-2026', title: '1536', market: 'west-end', venue: 'Almeida Theatre', previewsStartDate: '2025-05-06', openingDate: '2025-05-13', closingDate: '2025-06-07' };
const B1536 = { id: '1536-west-end-2026', title: '1536', market: 'west-end', venue: 'Ambassadors Theatre', previewsStartDate: '2026-05-02', openingDate: '2026-05-12', closingDate: '2026-08-01' };
const GHOST23 = { id: '2-22-a-ghost-story-west-end-2023', title: '2:22 A Ghost Story', market: 'west-end', venue: 'Lyric Theatre', previewsStartDate: '2023-01-21', openingDate: '2023-02-01', closingDate: '2023-04-23' };
const GHOST26 = { id: '222-a-ghost-story-off-broadway-2026', title: '2:22 A Ghost Story', market: 'broadway', venue: 'Other Venue', previewsStartDate: '2026-03-01', openingDate: '2026-03-12', closingDate: '2026-06-01' };
const ALL = [YEES, A1536, B1536, GHOST23, GHOST26];

describe('BRO-8090 A: opaque urls are judged on page text, never settled by the slug', () => {
  const OPAQUE = [
    'https://www.talkinbroadway.com/page/ob/10_19_26b.html',
    'https://www.ft.com/content/4347fa86-1c2d-4a1e-9b0a-6f3d2e8c9a10',
    'https://variety.com/review/VE1117941432.html',
  ];
  for (const u of OPAQUE) test(`isOpaqueSlug: ${u}`, () => assert.equal(V.isOpaqueSlug(u), true));
  test('a url with title-ish words is not opaque', () => {
    assert.equal(V.isOpaqueSlug('https://www.standard.co.uk/culture/theatre/1536-at-ambassadors-theatre-review-b1282189.html'), false);
    assert.equal(V.isOpaqueSlug('https://www.nytimes.com/2026/10/19/theater/king-of-the-yees-review.html'), false);
  });
  test('King of the Yees opaque Talkin\' Broadway url whose page names the show is NOT rejected', () => {
    const html = '<html><head><title>Talkin\' Broadway Off-Broadway Reviews</title></head><body><h2>King of the Yees</h2><p>Lloyd Suh\'s King of the Yees, at the Signature, opens tonight.</p></body></html>';
    const r = pendingPromoteRejectReason(OPAQUE[0], html, YEES, '2026-10-19');
    assert.equal(r, null, String(r));
  });
  test('opaque url whose page does not name the show is inconclusive (unsettled), not "not this show"', () => {
    const r = pendingPromoteRejectReason(OPAQUE[1], '<html><title>FT</title><body>Markets rally.</body></html>', YEES, '2026-10-19');
    assert.equal(isInconclusiveReject(r), true, String(r));
    assert.doesNotMatch(String(r), /not this show/);
  });
  test('an opaque url whose only mention of the show is a sidebar link stays inconclusive (Codex ship-check)', () => {
    const html = '<html><title>FT</title><body><h1>Markets rally</h1><p>Stocks rose.</p><aside>Also read: King of the Yees review</aside></body></html>';
    const r = pendingPromoteRejectReason(OPAQUE[1], html, YEES, '2026-10-19');
    assert.equal(isInconclusiveReject(r), true, String(r));
  });
  test('a DESCRIPTIVE slug sharing no title word still settles as not this show', () => {
    const r = pendingPromoteRejectReason('https://www.nytimes.com/2026/10/19/theater/hamilton-review.html', '<html><title>x</title><body>nothing</body></html>', YEES, '2026-10-19');
    assert.match(String(r), /not this show \(url-token-mismatch\)/);
  });
});

describe('BRO-8090 B: an out-of-window article owned by exactly one sibling production is rehomed', () => {
  test('1536 Ambassadors review (Almeida stub) resolves to 1536-west-end-2026', () => {
    const r = S.resolveOutOfWindowStub({ show: A1536, allShows: ALL, publishDate: '2026-05-13', stub: {} });
    assert.deepEqual([r.kind, r.sibling], ['rehome', '1536-west-end-2026']);
  });
  test('sibling already holding the url (live copy or scored) = duplicate', () => {
    assert.equal(S.resolveOutOfWindowStub({ show: A1536, allShows: ALL, publishDate: '2026-05-13', hasCopy: () => true }).kind, 'duplicate');
    assert.equal(S.resolveOutOfWindowStub({ show: A1536, allShows: ALL, publishDate: '2026-05-13', holdsUrl: () => true }).kind, 'duplicate');
  });
  test('no sibling window fits = outside-all; a stub already rehomed once is never bounced again', () => {
    assert.equal(S.resolveOutOfWindowStub({ show: A1536, allShows: ALL, publishDate: '2019-01-01' }).kind, 'outside-all');
    assert.notEqual(S.resolveOutOfWindowStub({ show: A1536, allShows: ALL, publishDate: '2026-05-13', stub: { rehomedFrom: 'x' } }).kind, 'rehome');
  });
  test('rehomedStub retargets showId, clears the settle, takes the verdict date', () => {
    const o = S.rehomedStub({ showId: A1536.id, publishDate: '2025-05-18', promoteSkippedReason: 'x', promoteSkippedAt: 'y', url: 'u' }, A1536.id, B1536.id, { publishDate: '2026-05-13', nowIso: 'n' });
    assert.equal(o.showId, B1536.id); assert.equal(o.publishDate, '2026-05-13'); assert.equal(o.rehomedFrom, A1536.id);
    assert.equal(o.promoteSkippedReason, undefined);
  });
  test('triage with a stub date inside the sibling window returns rehome, not junk (222 A Ghost Story)', () => {
    const v = T.triagePendingStub({ url: 'https://example.com/theatre/222-ghost-story-review', publishDate: '2023-02-03' }, { showId: GHOST26.id, show: GHOST26, allShows: ALL, heldIndex: new Map() });
    assert.deepEqual([v.verdict, v.sibling], ['rehome', GHOST23.id]);
  });
  test('triage without a sibling list keeps the old junk settle (old callers unchanged)', () => {
    const v = T.triagePendingStub({ url: 'https://example.com/theatre/222-ghost-story-review', publishDate: '2023-02-03' }, { showId: GHOST26.id, show: GHOST26, heldIndex: new Map() });
    assert.equal(v.verdict, 'junk');
  });
  test('rehomeStubFile moves the file, and refuses to overwrite a sibling copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8090-'));
    fs.mkdirSync(path.join(root, '_pending', A1536.id), { recursive: true });
    const f = 'standard--1e731241.json';
    const data = { showId: A1536.id, url: 'u', publishDate: '2025-05-18' };
    fs.writeFileSync(path.join(root, '_pending', A1536.id, f), JSON.stringify(data));
    assert.equal(S.rehomeStubFile({ root, file: f, fromShowId: A1536.id, toShowId: B1536.id, data, publishDate: '2026-05-13' }), 'rehomed');
    assert.equal(fs.existsSync(path.join(root, '_pending', A1536.id, f)), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '_pending', B1536.id, f), 'utf8')).showId, B1536.id);
    fs.writeFileSync(path.join(root, '_pending', A1536.id, f), JSON.stringify(data));
    assert.equal(S.rehomeStubFile({ root, file: f, fromShowId: A1536.id, toShowId: B1536.id, data }), 'sibling-has-copy');
    assert.equal(fs.existsSync(path.join(root, '_pending', A1536.id, f)), true);
  });
});

describe('BRO-8090 root cause: intake files a stub under the sibling whose window holds its date', () => {
  test('intakeShowIdForStub routes by date; in-window or ambiguous stays put', () => {
    assert.equal(S.intakeShowIdForStub(A1536, ALL, '2026-05-13'), B1536.id);
    assert.equal(S.intakeShowIdForStub(A1536, ALL, '2025-05-18'), A1536.id);
    assert.equal(S.intakeShowIdForStub(A1536, ALL, '2019-01-01'), A1536.id);
    assert.equal(S.intakeShowIdForStub(A1536, ALL, null), A1536.id);
  });
  test('gather-reviews pending writer uses it (guard against reverting the wiring)', () => {
    const src = fs.readFileSync(new URL('../../scripts/gather-reviews.js', import.meta.url), 'utf8');
    assert.match(src, /intakeShowIdForStub\(_showMeta, _allShows, require\('.\/lib\/pending-triage'\)\.stubDateIso\(review\.publishDate\), review\)/);
    assert.match(src, /path\.join\(REVIEW_TEXTS_DIR, '_pending', pendingShowId\)/);
  });
});

describe('BRO-8090: a many-production title needs venue corroboration before a rehome', () => {
  const mk = (id, venue, open, close) => ({ id, title: 'A Christmas Carol', venue, previewsStartDate: open, openingDate: open, closingDate: close, market: 'west-end' });
  const FAM = [mk('acc-2012', 'Noel Coward', '2012-11-01', '2012-12-31'), mk('acc-2022', 'Old Vic', '2022-11-01', '2022-12-31'),
    mk('acc-2023', 'Old Vic', '2023-11-20', '2024-01-10'), mk('acc-2024', 'Old Vic', '2024-11-15', '2025-01-05')];
  test('Dundee Rep review dated in the Old Vic window stays settled (unverified-family)', () => {
    const stub = { url: 'https://www.whatsonstage.com/news/a-christmas-carol-at-dundee-rep-theatre-review_1555376/' };
    // The slug names Dundee Rep, not the Old Vic: venue-mismatch (BRO-8090 audit) settles it before the family rule.
    assert.ok(['unverified-family', 'venue-mismatch'].includes(S.resolveOutOfWindowStub({ show: FAM[0], allShows: FAM, publishDate: '2023-12-04', stub }).kind));
  });
  test('the same review naming the Old Vic rehomes', () => {
    const stub = { url: 'https://www.thetimes.com/culture/theatre-dance/article/a-christmas-carol-review-john-simm-old-vic-w2wtzgpqq' };
    assert.equal(S.resolveOutOfWindowStub({ show: FAM[0], allShows: FAM, publishDate: '2023-12-04', stub }).kind, 'rehome');
  });
});

describe('BRO-8090: guards found by the real-data sample audit', () => {
  const MAT = [{ id: 'matilda-off-2026', title: 'Matilda the Musical', venue: 'Theatre Row', market: 'broadway', previewsStartDate: '2026-01-01', openingDate: '2026-01-10', closingDate: '2026-03-01' },
    { id: 'matilda-west-end-2021', title: 'Matilda the Musical', venue: 'Cambridge Theatre', market: 'west-end', previewsStartDate: '2022-11-01', openingDate: '2022-11-10', closingDate: '2023-03-01' }];
  test('a film review dated inside a stage run is not rehomed', () => {
    const r = S.resolveOutOfWindowStub({ show: MAT[0], allShows: MAT, publishDate: '2022-12-23', stub: { url: 'https://www.thewrap.com/matilda-the-musical-film-review-netflix-emma-thompson/' } });
    assert.equal(r.kind, 'screen-not-stage');
  });
  test('a venue homepage settled by url-token-mismatch is NOT un-settled; an opaque article path is', async () => {
    const R = require('../../scripts/rejudge-settled-pending.js');
    const base = { promoteSkippedReason: 'not this show (url-token-mismatch)' };
    assert.equal(R.rejudgeSettledStub({ stub: { ...base, url: 'https://delfontmackintosh.co.uk/' }, show: YEES, allShows: ALL }).action, 'keep');
    assert.equal(R.rejudgeSettledStub({ stub: { ...base, url: 'https://www.talkinbroadway.com/page/ob/10_19_26b.html' }, show: YEES, allShows: ALL }).action, 'unsettle');
  });
});

describe('BRO-8090: an open-ended sibling window needs venue corroboration (Tosca, Harry Potter)', () => {
  const TOSCA26 = { id: 'tosca-off-broadway-2026', title: 'Tosca', venue: 'Metropolitan Opera House', previewsStartDate: '2026-11-01', openingDate: '2026-11-01', closingDate: '2027-05-27' };
  const TOSCA17 = { id: 'tosca-off-broadway-2017', title: 'Tosca', venue: 'Metropolitan Opera House', openingDate: '2017-12-31' };
  test('Oxford International Opera Tosca is not rehomed onto the undated 2017 Met production', () => {
    const r = S.resolveOutOfWindowStub({ show: TOSCA26, allShows: [TOSCA26, TOSCA17], publishDate: '2026-09-28', stub: { url: 'https://seenandheard-international.com/2026/09/oxford-international-opera-makes-its-debut-with-a-b' } });
    assert.notEqual(r.kind, 'rehome');
  });
  test('a review that names the sibling venue still rehomes', () => {
    const r = S.resolveOutOfWindowStub({ show: TOSCA26, allShows: [TOSCA26, TOSCA17], publishDate: '2018-01-10', stub: { url: 'https://www.thestage.co.uk/reviews/tosca-review-metropolitan-opera-house' } });
    assert.equal(r.kind, 'rehome');
  });
});

// Real shows.json rows (2026-11-22). The Oh, Mary! family has 4 entries, so the date alone never moves a stub.
const OHM = [
  { id: 'oh-mary-2024', title: 'Oh, Mary!', category: 'broadway', venue: 'Lyceum Theatre', previewsStartDate: '2024-06-26', openingDate: '2024-07-11', closingDate: '2025-12-01' },
  { id: 'oh-mary-west-end-2025', title: 'Oh, Mary!', category: 'west-end', venue: 'Trafalgar Theatre', previewsStartDate: '2025-12-03', openingDate: '2025-12-18', closingDate: '2027-06-05' },
  { id: 'oh-mary-off-broadway-2024', title: 'Oh, Mary!', category: 'off-broadway', venue: 'Lucille Lortel Theatre', previewsStartDate: '2024-01-26', openingDate: '2024-02-11', closingDate: '2024-05-26' },
  { id: 'oh-mary-tour-2026', title: 'Oh, Mary!', category: 'tour', venue: 'North American Tour', openingDate: '2026-09-19' },
];
const MINCE = [
  { id: 'operation-mincemeat-2025', title: 'Operation Mincemeat', category: 'broadway', venue: 'John Golden Theatre', previewsStartDate: '2025-02-15', openingDate: '2025-03-20', closingDate: '2027-07-04' },
  { id: 'operation-mincemeat-west-end-2024', title: 'Operation Mincemeat', category: 'west-end', venue: 'Fortune Theatre', previewsStartDate: '2023-03-29', openingDate: '2023-05-09' },
  { id: 'operation-mincemeat-tour-2026', title: 'Operation Mincemeat', category: 'tour', venue: 'North American Tour', openingDate: '2026-09-20' },
];

describe('BRO-8090: a big family or 2+ fitting siblings are told apart by venue or market in the url', () => {
  test('Time Out "oh-mary-broadway-review" filed under the West End run rehomes to the Broadway run', () => {
    const stub = { url: 'https://www.timeout.com/newyork/theater/oh-mary-broadway-review-cole-escola' };
    const r = S.resolveOutOfWindowStub({ show: OHM[1], allShows: OHM, publishDate: '2024-07-11', stub });
    assert.equal(r.kind, 'rehome'); assert.equal(r.sibling, 'oh-mary-2024');
  });
  test('the same family without a market word stays settled (NYT url has none)', () => {
    const stub = { url: 'https://www.nytimes.com/2024/07/11/theater/oh-mary-review-cole-escola.html' };
    assert.equal(S.resolveOutOfWindowStub({ show: OHM[1], allShows: OHM, publishDate: '2024-07-12', stub }).kind, 'unverified-family');
  });
  test('Operation Mincemeat Broadway review under the tour: 2 siblings fit, the url names Broadway', () => {
    const stub = { url: 'https://www.timeout.com/newyork/theater/operation-mincemeat-musical-broadway-review' };
    const r = S.resolveOutOfWindowStub({ show: MINCE[2], allShows: MINCE, publishDate: '2025-03-20', stub });
    assert.equal(r.kind, 'rehome'); assert.equal(r.sibling, 'operation-mincemeat-2025');
  });
  test('"off-broadway" and the host name never count as Broadway', () => {
    assert.equal(S.stubNamesMarket({ url: 'https://www.broadwayworld.com/off-broadway/article/x' }, MINCE[0], MINCE[2]), false);
    assert.equal(S.stubNamesMarket({ url: 'https://www.broadwaynews.com/x-review/' }, MINCE[0], MINCE[2]), false);
    assert.equal(S.stubNamesMarket({ url: 'https://www.broadwayworld.com/westend/article/x' }, MINCE[1], MINCE[2]), true);
  });
  test('a Christmas Carol at the Gate dated inside the Broadway run stays settled', () => {
    const CC = [{ id: 'a-christmas-carol-west-end-2023', title: 'A Christmas Carol', category: 'west-end', venue: 'The Old Vic', previewsStartDate: '2023-11-13', openingDate: '2023-11-22', closingDate: '2024-01-06' },
      { id: 'a-christmas-carol-2019', title: 'A Christmas Carol', category: 'broadway', venue: 'Lyceum Theatre', previewsStartDate: '2019-11-07', openingDate: '2019-11-20', closingDate: '2020-01-05' },
      { id: 'a-christmas-carol-west-end-2022', title: 'A Christmas Carol', category: 'west-end', venue: 'The Old Vic', previewsStartDate: '2022-11-12', openingDate: '2022-11-20', closingDate: '2023-01-07' },
      { id: 'a-christmas-carol-2022', title: 'A Christmas Carol', category: 'broadway', venue: 'Nederlander Theatre', previewsStartDate: '2022-11-12', openingDate: '2022-11-21', closingDate: '2023-01-01' }];
    const r = S.resolveOutOfWindowStub({ show: CC[0], allShows: CC, publishDate: '2019-12-01', stub: { url: 'https://www.thetimes.com/uk/article/review-a-christmas-carol-at-the-gate-2tn90znpv' } });
    assert.notEqual(r.kind, 'rehome');
  });
});

describe('BRO-8090 cousins: the no-fetch triage rehomes instead of junking a sibling\'s review', () => {
  const T = require('../../scripts/lib/pending-triage.js');
  test('url-date rule: a 2023 Lyric review of 2:22 dated by its url, filed under the 2026 run, rehomes to the 2023 entry', () => {
    const stub = { url: 'https://www.theguardian.com/stage/2023/feb/02/222-a-ghost-story-review-lyric-theatre' };
    const v = T.triagePendingStub(stub, { showId: GHOST26.id, show: GHOST26, allShows: ALL, sameTitleShows: T.sameTitleShowsFrom(GHOST26, ALL) });
    assert.equal(v.verdict, 'rehome', JSON.stringify(v)); assert.equal(v.sibling, GHOST23.id); assert.equal(v.publishDate, '2023-02-02');
  });
  test('url-date rule with no sibling in the window still settles as junk', () => {
    const stub = { url: 'https://www.theguardian.com/stage/2019/may/14/1536-review' };
    assert.equal(T.triagePendingStub(stub, { showId: B1536.id, show: B1536, allShows: ALL }).verdict, 'junk');
  });
  test('url-date rule: the sibling already holding the url is a duplicate settle', () => {
    const stub = { url: 'https://www.theguardian.com/stage/2023/feb/02/222-a-ghost-story-review-lyric-theatre' };
    const v = T.triagePendingStub(stub, { showId: GHOST26.id, show: GHOST26, allShows: ALL, siblingHasCopy: (sid) => sid === GHOST23.id });
    assert.equal(v.verdict, 'junk'); assert.match(v.reason, /already holds this url/);
  });
  test('sibling-venue rule: "twelfth-night-at-the-young-vic" under the Olivier run rehomes to the Young Vic entry', () => {
    const OL = { id: 'twelfth-night-west-end-2017', title: 'Twelfth Night', category: 'west-end', venue: 'Olivier Theatre', previewsStartDate: '2017-02-15', openingDate: '2017-02-22', closingDate: '2017-05-13' };
    const YV = { id: 'twelfth-night-off-west-end-2014', title: 'Twelfth Night', category: 'off-west-end', venue: 'Young Vic', previewsStartDate: '2014-03-01', openingDate: '2014-03-10', closingDate: '2014-04-12' };
    const all = [OL, YV];
    const stub = { url: 'https://example.com/theatre/twelfth-night-at-the-young-vic-review', publishDate: '2014-03-11' };
    const v = T.triagePendingStub(stub, { showId: OL.id, show: OL, allShows: all, sameTitleShows: T.sameTitleShowsFrom(OL, all) });
    assert.equal(v.verdict, 'rehome', JSON.stringify(v)); assert.equal(v.sibling, YV.id);
    // Dateless: a venue hosts the same title again, so the venue alone never moves it (sample audit 2026-11-23).
    const { publishDate: _d, ...dateless } = stub;
    assert.equal(T.triagePendingStub(dateless, { showId: OL.id, show: OL, allShows: all, sameTitleShows: T.sameTitleShowsFrom(OL, all) }).verdict, 'junk');
    // Without the full list (old callers) the old junk settle stands.
    assert.equal(T.triagePendingStub(stub, { showId: OL.id, show: OL, sameTitleShows: T.sameTitleShowsFrom(OL, all) }).verdict, 'junk');
  });
});

describe('BRO-8090 root cause: the write guard quarantines a sibling\'s review into the sibling\'s _pending', () => {
  const G = require('../../scripts/lib/review-write-guard.js');
  test('a 2026 Ambassadors review written under the 2025 Almeida entry is quarantined under 1536-west-end-2026', () => {
    G._setShowsCacheForTest(new Map(ALL.map((s) => [s.id, s])));
    const q = G._quarantineTarget(A1536.id, A1536, { url: 'https://www.standard.co.uk/culture/theatre/1536-ambassadors-review-b1', publishDate: '2026-05-13' });
    assert.equal(q.dirId, B1536.id); assert.equal(q.payload.showId, B1536.id); assert.equal(q.payload.rehomedFrom, A1536.id);
  });
  test('no fitting sibling: stays under its own show', () => {
    G._setShowsCacheForTest(new Map(ALL.map((s) => [s.id, s])));
    assert.equal(G._quarantineTarget(A1536.id, A1536, { url: 'https://x.com/1536-review', publishDate: '2019-01-01' }).dirId, A1536.id);
  });
});

describe('BRO-8090 sample-audit guards: the url says it is about something else', () => {
  test('a Romeo and Juliet review is never moved to & Juliet (longer tracked title in the slug)', () => {
    const AJ = [{ id: 'and-juliet-west-end-2019', title: '& Juliet', category: 'west-end', venue: 'Shaftesbury Theatre', previewsStartDate: '2019-11-02', openingDate: '2019-11-20', closingDate: '2023-03-25' },
      { id: 'and-juliet-2022', title: '& Juliet', category: 'broadway', venue: 'Stephen Sondheim Theatre', previewsStartDate: '2022-10-28', openingDate: '2022-11-17', closingDate: '2025-07-27' },
      { id: 'romeo-and-juliet-west-end-2024', title: 'Romeo & Juliet', category: 'west-end', venue: 'Duke of York\'s Theatre', previewsStartDate: '2024-05-11', openingDate: '2024-05-23', closingDate: '2024-08-03' }];
    const r = S.resolveOutOfWindowStub({ show: AJ[0], allShows: AJ, publishDate: '2024-05-23', stub: { url: 'https://www.thetimes.com/culture/theatre-dance/article/romeo-and-juliet-review-tom-holland-spiderman-theatre-london-zjjr6wjwg' } });
    assert.equal(r.kind, 'longer-title');
    const bourne = S.resolveOutOfWindowStub({ show: AJ[0], allShows: AJ, publishDate: '2023-08-07', stub: { url: 'https://ew.com/romeo-juliet-review-matthew-bourne-mounts-searing-ballet-8557736' } });
    assert.equal(bourne.kind, 'longer-title');
    // a real & Juliet review still moves
    const ok = S.resolveOutOfWindowStub({ show: AJ[0], allShows: AJ, publishDate: '2022-11-17', stub: { url: 'https://www.thewrap.com/and-juliet-broadway-review/' } });
    assert.equal(ok.kind, 'rehome'); assert.equal(ok.sibling, 'and-juliet-2022');
  });
  test('a Summer Holiday review at the Crucible, Sheffield is not The Crucible', () => {
    const CR = [{ id: 'the-crucible-west-end-2022', title: 'The Crucible', category: 'west-end', venue: 'National Theatre', previewsStartDate: '2022-09-01', openingDate: '2022-09-22', closingDate: '2022-11-05' },
      { id: 'the-crucible-crucible-regional-2024', title: 'The Crucible', category: 'regional', venue: 'Crucible Theatre, Sheffield', previewsStartDate: '2026-06-20', openingDate: '2026-06-25', closingDate: '2026-07-18' }];
    const r = S.resolveOutOfWindowStub({ show: CR[0], allShows: CR, publishDate: '2026-07-01', stub: { url: 'https://www.thetimes.com/culture/theatre-dance/article/summer-holiday-review-cliff-richard-musical-crucible-sheffield-blackpool-grand-ptw7d77lz' } });
    assert.equal(r.kind, 'title-not-in-url');
    const ok = S.resolveOutOfWindowStub({ show: CR[0], allShows: CR, publishDate: '2026-07-01', stub: { url: 'https://www.thestage.co.uk/reviews/the-crucible-review-crucible-theatre-sheffield' } });
    assert.equal(ok.kind, 'rehome');
  });
  test('a url naming Broadway never moves a stub to the West End sibling (Oedipus)', () => {
    const OE = [{ id: 'oedipus-2025', title: 'Oedipus', category: 'broadway', venue: 'Studio 54', previewsStartDate: '2026-10-01', openingDate: '2026-10-20', closingDate: '2027-01-10' },
      { id: 'oedipus-west-end-2025', title: 'Oedipus', category: 'west-end', venue: 'Wyndham\'s Theatre', previewsStartDate: '2024-10-04', openingDate: '2024-10-15', closingDate: '2025-03-31' }];
    const r = S.resolveOutOfWindowStub({ show: OE[0], allShows: OE, publishDate: '2025-03-06', stub: { url: 'https://deadline.com/2025/03/oedipus-broadway-mark-strong-lesley-manville-roundabout-season-1236312536/' } });
    assert.equal(r.kind, 'market-mismatch');
  });
  test('a Times travel piece naming Kyoto is not the play Kyoto', () => {
    const KY = [{ id: 'kyoto-west-end-2025', title: 'Kyoto', category: 'west-end', venue: 'Soho Place', previewsStartDate: '2025-06-02', openingDate: '2025-06-10', closingDate: '2025-08-30' },
      { id: 'kyoto-off-broadway-2025', title: 'Kyoto', category: 'off-broadway', venue: 'Mitzi E. Newhouse Theater', previewsStartDate: '2025-10-16', openingDate: '2025-11-03', closingDate: '2026-01-04' }];
    const r = S.resolveOutOfWindowStub({ show: KY[0], allShows: KY, publishDate: '2025-11-06', stub: { url: 'https://www.thetimes.com/travel/destinations/asia-travel/japan/intrepid-travel-tokyo-mishima-kawane-kyoto-osaka-tour-review-zmwrs5cbb' } });
    assert.equal(r.kind, 'travel-not-stage');
  });
  test('opaque slugs carry no title evidence (King of the Yees talkinbroadway page)', () => {
    assert.equal(S.urlContradictsTitle({ url: 'https://www.talkinbroadway.com/page/ob/10_19_26b.html' }, YEES, null, ALL), null);
  });
});

describe('BRO-8090 second sample audit', () => {
  test('"minions-and-monsters-review" is not The Monsters (compound title)', () => {
    const M = [{ id: 'the-monsters-off-broadway-2026', title: 'The Monsters', category: 'off-broadway', venue: 'Manhattan Theatre Club', previewsStartDate: '2026-10-01', openingDate: '2026-10-20', closingDate: '2026-12-01' },
      { id: 'the-monsters-regional-2026', title: 'The Monsters', category: 'regional', venue: 'Some Rep', previewsStartDate: '2026-06-01', openingDate: '2026-06-10', closingDate: '2026-07-20' }];
    assert.equal(S.resolveOutOfWindowStub({ show: M[0], allShows: M, publishDate: '2026-06-29', stub: { url: 'https://deadline.com/2026/06/minions-and-monsters-review-pierre-coffin-allison-janney-trey-parker-1236969888/' } }).kind, 'compound-title');
    assert.equal(S.resolveOutOfWindowStub({ show: M[0], allShows: M, publishDate: '2026-06-29', stub: { url: 'https://www.thestage.co.uk/reviews/review-and-the-monsters-play' } }).kind, 'rehome');
  });
  test('a "uk-tour" review never moves to the New York run (People, Places and Things)', () => {
    const P = [{ id: 'people-places-and-things-west-end-2016', title: 'People, Places and Things', category: 'west-end', venue: 'Wyndham\'s Theatre', previewsStartDate: '2016-03-15', openingDate: '2016-03-23', closingDate: '2016-06-18' },
      { id: 'people-places-and-things-off-broadway-2017', title: 'People, Places and Things', category: 'off-broadway', venue: 'St. Ann\'s Warehouse', previewsStartDate: '2017-10-03', openingDate: '2017-10-10', closingDate: '2017-11-19' }];
    assert.equal(S.resolveOutOfWindowStub({ show: P[0], allShows: P, publishDate: '2017-10-16', stub: { url: 'https://www.whatsonstage.com/news/review-people-places-and-things-uk-tour_44890/' } }).kind, 'market-mismatch');
  });
  test('a stub the sibling\'s own triage would junk is not moved (Deadline box-office story)', () => {
    const H = [{ id: 'harry-potter-and-the-cursed-child-one-part-west-end-2026', title: 'Harry Potter and the Cursed Child', category: 'west-end', venue: 'Palace Theatre', previewsStartDate: '2026-09-01', openingDate: '2026-09-10' },
      { id: 'harry-potter-2021', title: 'Harry Potter and the Cursed Child', category: 'broadway', venue: 'Lyric Theatre', previewsStartDate: '2021-10-12', openingDate: '2021-11-16', closingDate: '2027-01-01' }];
    assert.equal(S.resolveOutOfWindowStub({ show: H[0], allShows: H, publishDate: '2025-12-09', stub: { url: 'https://deadline.com/2025/12/broadway-box-office-tom-felton-harry-potter-cursed-child-ragtime-1236643496/' } }).kind, 'junk-for-sibling');
  });
});

describe('BRO-8090 ship-check fixes', () => {
  test('rehomeStubFile: same-named destination with a DIFFERENT url gets a hashed name; the same url is a duplicate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8090r-'));
    for (const d of [GHOST26.id, GHOST23.id]) fs.mkdirSync(path.join(root, '_pending', d), { recursive: true });
    const other = { url: 'https://www.telegraph.co.uk/theatre/what-to-see/some-other-review/' };
    fs.writeFileSync(path.join(root, '_pending', GHOST23.id, 'telegraph--dominic-cavendish.json'), JSON.stringify(other));
    const data = { url: 'https://www.telegraph.co.uk/theatre/what-to-see/2-22-a-ghost-story-review-lyric/' };
    fs.writeFileSync(path.join(root, '_pending', GHOST26.id, 'telegraph--dominic-cavendish.json'), JSON.stringify(data));
    const out = S.rehomeStubFile({ root, file: 'telegraph--dominic-cavendish.json', fromShowId: GHOST26.id, toShowId: GHOST23.id, data, publishDate: '2023-02-01' });
    assert.equal(out, 'rehomed');
    const files = fs.readdirSync(path.join(root, '_pending', GHOST23.id)).sort();
    assert.equal(files.length, 2, files.join(','));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '_pending', GHOST23.id, 'telegraph--dominic-cavendish.json'), 'utf8')), other, 'the other article is untouched');
    assert.equal(fs.existsSync(path.join(root, '_pending', GHOST26.id, 'telegraph--dominic-cavendish.json')), false);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0);
    // moving the same url again is a duplicate, not a third copy
    fs.writeFileSync(path.join(root, '_pending', GHOST26.id, 'x.json'), JSON.stringify(other));
    fs.writeFileSync(path.join(root, '_pending', GHOST23.id, 'x.json'), JSON.stringify({ url: other.url + '?utm_source=x' }));
    assert.equal(S.rehomeStubFile({ root, file: 'x.json', fromShowId: GHOST26.id, toShowId: GHOST23.id, data: other }), 'sibling-has-copy');
  });
  test('two same-title revivals at the named venue: settled, never moved (no owner id)', () => {
    const T = require('../../scripts/lib/pending-triage.js');
    const OL = { id: 'tn-west-end-2017', title: 'Twelfth Night', category: 'west-end', venue: 'Olivier Theatre', previewsStartDate: '2017-02-15', openingDate: '2017-02-22', closingDate: '2017-05-13' };
    const Y1 = { id: 'tn-off-west-end-2014', title: 'Twelfth Night', category: 'off-west-end', venue: 'Young Vic', previewsStartDate: '2014-03-01', openingDate: '2014-03-10', closingDate: '2014-04-12' };
    const Y2 = { id: 'tn-off-west-end-2004', title: 'Twelfth Night', category: 'off-west-end', venue: 'Young Vic', previewsStartDate: '2004-03-01', openingDate: '2004-03-10', closingDate: '2004-04-12' };
    for (const all of [[OL, Y1, Y2], [OL, Y2, Y1]]) {
      const v = T.triagePendingStub({ url: 'https://www.thestage.co.uk/reviews/twelfth-night-at-the-young-vic-review' }, { showId: OL.id, show: OL, allShows: all, sameTitleShows: T.sameTitleShowsFrom(OL, all) });
      assert.equal(v.verdict, 'junk', JSON.stringify(v));
    }
  });
  test('the venue route obeys the same guards (a url naming Broadway is not the Young Vic run)', () => {
    const T = require('../../scripts/lib/pending-triage.js');
    const BW = { id: 'tn-2026', title: 'Twelfth Night', category: 'broadway', venue: 'Lyceum Theatre', previewsStartDate: '2026-02-15', openingDate: '2026-02-22', closingDate: '2026-05-13' };
    const Y1 = { id: 'tn-off-west-end-2014', title: 'Twelfth Night', category: 'off-west-end', venue: 'Young Vic', previewsStartDate: '2014-03-01', openingDate: '2014-03-10', closingDate: '2014-04-12' };
    const v = T.triagePendingStub({ url: 'https://www.thestage.co.uk/reviews/broadway-twelfth-night-at-the-young-vic-review' }, { showId: BW.id, show: BW, allShows: [BW, Y1], sameTitleShows: T.sameTitleShowsFrom(BW, [BW, Y1]) });
    assert.notEqual(v.verdict, 'rehome');
  });
  test('the sibling re-check uses the verdict date, not the stale stub date (Codex repro)', () => {
    const r = S.resolveOutOfWindowStub({ show: GHOST26, allShows: ALL, publishDate: '2023-02-01', stub: { url: 'https://www.theguardian.com/stage/2-22-a-ghost-story-review-lyric', publishDate: '2026-03-15' } });
    assert.equal(r.kind, 'rehome', JSON.stringify(r));
  });
  test('processShow (triage path) moves an out-of-window stub to the sibling and deletes nothing else', async () => {
    const { processShow } = require('../../scripts/replay-pending-bylines.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8090p-'));
    const src = path.join(root, '_pending', GHOST26.id);
    fs.mkdirSync(src, { recursive: true });
    const stub = { outletId: 'times-uk', criticName: 'Unknown', url: 'https://www.thetimes.com/culture/theatre-dance/article/2-22-a-ghost-story-review-haunted-cheryl-makes-a-confident-west-end-debut-6kdxd9cnh', publishDate: '2023-02-01' };
    fs.writeFileSync(path.join(src, 'times-uk--rh.json'), JSON.stringify(stub));
    let fetches = 0;
    await processShow(GHOST26.id, { root, show: GHOST26, allShows: ALL, dryRun: false, triageOnly: true, heldIndex: new Map(), explicitScope: false,
      fetch: async () => { fetches++; return { content: '' }; }, alert: async () => {}, resolve: () => {}, emit: () => {}, budget: { exceeded: () => false, minutes: 5 } });
    assert.equal(fetches, 0);
    assert.equal(fs.existsSync(path.join(src, 'times-uk--rh.json')), false);
    const moved = JSON.parse(fs.readFileSync(path.join(root, '_pending', GHOST23.id, 'times-uk--rh.json'), 'utf8'));
    assert.equal(moved.showId, GHOST23.id); assert.equal(moved.rehomedFrom, GHOST26.id); assert.ok(!moved.promoteSkippedReason);
  });
});

describe('BRO-8090 second ship-check fixes (Gemini)', () => {
  test('rehomedStub drops the old show\'s auto wrong-production stamp and quarantine reasons, keeps a human stamp', () => {
    const auto = S.rehomedStub({ url: 'u', wrongProduction: true, wrongProductionNote: 'Auto-flagged: published 400 days before show earliest date 2026-03-01', pendingReason: 'date_implausible', _dateImplausibleDetail: 'x' }, A1536.id, B1536.id, { nowIso: 'now' });
    assert.equal(auto.wrongProduction, undefined); assert.equal(auto.wrongProductionNote, undefined);
    assert.equal(auto.pendingReason, undefined); assert.equal(auto._dateImplausibleDetail, undefined);
    const human = S.rehomedStub({ url: 'u', wrongProduction: true, wrongProductionNote: 'Auto-flagged: x', wrongProductionManual: true }, A1536.id, B1536.id, {});
    assert.equal(human.wrongProduction, true);
    const other = S.rehomedStub({ url: 'u', wrongProduction: true, wrongProductionNote: 'LLM: reviews the 1998 revival' }, A1536.id, B1536.id, {});
    assert.equal(other.wrongProduction, true);
  });
  test('write guard: sibling route strips the date_implausible stamp; an existing sibling file is never overwritten', () => {
    const G = require('../../scripts/lib/review-write-guard.js');
    G._setShowsCacheForTest(new Map(ALL.map((s) => [s.id, s])));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8090q-'));
    const filePath = path.join(root, A1536.id, 'standard--nick-curtis.json');
    const payload = { url: 'https://www.standard.co.uk/culture/theatre/1536-ambassadors-review-b1', publishDate: '2026-05-13', pendingReason: 'date_implausible', _dateImplausibleDetail: 'd' };
    const q = G._quarantineTarget(A1536.id, A1536, payload, filePath);
    assert.equal(q.dirId, B1536.id); assert.equal(q.payload.pendingReason, undefined); assert.equal(q.payload._dateImplausibleDetail, undefined);
    fs.mkdirSync(path.join(root, '_pending', B1536.id), { recursive: true });
    fs.writeFileSync(path.join(root, '_pending', B1536.id, 'standard--nick-curtis.json'), '{"url":"other"}');
    const q2 = G._quarantineTarget(A1536.id, A1536, payload, filePath);
    assert.equal(q2.dirId, A1536.id); assert.equal(q2.payload.pendingReason, 'date_implausible');
  });
  test('after corroboration narrows 2 fitting siblings to one, the url is re-checked against THAT sibling', () => {
    const X = { id: 'hampstead-2010', title: 'Hampstead', category: 'west-end', venue: 'Some Theatre', previewsStartDate: '2010-01-01', openingDate: '2010-01-10', closingDate: '2010-02-01' };
    const H = { id: 'hampstead-2024', title: 'Hampstead', category: 'off-west-end', venue: 'Hampstead Theatre', previewsStartDate: '2024-01-01', openingDate: '2024-01-10', closingDate: '2024-03-01' };
    const L = { id: 'hampstead-2024-lyric', title: 'Hampstead', category: 'west-end', venue: 'Lyric Theatre', previewsStartDate: '2024-01-05', openingDate: '2024-01-12', closingDate: '2024-03-01' };
    // The slug names the venue only ("hampstead-theatre-..."), not the play: with the venue words stripped no title is left.
    const r = S.resolveOutOfWindowStub({ show: X, allShows: [X, H, L], publishDate: '2024-01-20', stub: { url: 'https://www.thestage.co.uk/news/hampstead-theatre-season-announced-review' } });
    assert.equal(r.kind, 'title-not-in-url', JSON.stringify(r));
  });
  test('rejudge-settled-pending: --help prints usage; --apply refuses without the held-url index', () => {
    const { execFileSync, spawnSync } = require('child_process');
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/rejudge-settled-pending.js');
    assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /Usage: node scripts\/rejudge-settled-pending\.js/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8090h-')); fs.mkdirSync(path.join(root, '_pending'));
    const r = spawnSync(process.execPath, [script, `--root=${root}`, '--apply', `--reviews-json=${path.join(root, 'missing.json')}`], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, /refusing --apply/);
  });
});

// Real cases the 2026-11-23 sample audit (43 pending re-judgements on broadway-review-texts main) caught being moved
// to the wrong production. Real shows.json rows; red before the guards in pending-sibling-productions.js.
describe('BRO-8090 audit 2026-11-23: a fitting date is not enough when the stub points elsewhere', () => {
  const G13 = { id: 'ghosts-west-end-2013', title: 'Ghosts', category: 'west-end', venue: 'Trafalgar Theatre', previewsStartDate: '2013-12-17', openingDate: '2014-01-14', closingDate: '2014-03-22' };
  const G25 = { id: 'ghosts-off-broadway-2025', title: 'Ghosts', category: 'off-broadway', venue: 'Mitzi E. Newhouse Theater', previewsStartDate: '2025-02-13', openingDate: '2025-03-10', closingDate: '2025-04-26' };
  const ALLG = [G13, G25];
  test('a London-only outlet (Time Out London) is not moved to the New York run', () => {
    const stub = { outletId: 'timeout-london', url: 'https://www.timeout.com/london/theatre/ghosts-1-review' };
    assert.equal(S.resolveOutOfWindowStub({ show: G13, allShows: ALLG, publishDate: '2025-04-16', stub }).kind, 'outlet-market-mismatch');
  });
  test('a slug naming another venue (Lyric Hammersmith) is not moved to the Mitzi Newhouse run', () => {
    const stub = { outletId: 'whatsonstage', url: 'https://www.whatsonstage.com/news/ghosts-at-lyric-hammersmith-theatre-review_1674175/' };
    assert.equal(S.resolveOutOfWindowStub({ show: G13, allShows: ALLG, publishDate: '2025-04-17', stub }).kind, 'venue-mismatch');
  });
  test('a UK outlet reviewing a US production, filed under another US entry, still moves within the US', () => {
    const T17 = { id: 'tosca-off-broadway-2017', title: 'Tosca', category: 'off-broadway', venue: 'Metropolitan Opera House', previewsStartDate: '2017-12-31', openingDate: '2017-12-31', closingDate: '2021-01-31' };
    const T26 = { id: 'tosca-off-broadway-2026', title: 'Tosca', category: 'off-broadway', venue: 'Metropolitan Opera House', previewsStartDate: '2026-01-10', openingDate: '2026-01-10', closingDate: '2026-02-10' };
    const stub = { outletId: 'british-theatre', url: 'https://www.britishtheatreguide.info/reviews/tosca-metropolitan-op-19674' };
    assert.equal(S.stubContradictsSibling(stub, T17, T26), null);
    assert.equal(S.stubContradictsSibling({ outletId: 'timeout-london', url: stub.url }, G25, G13), 'outlet-market-mismatch');
  });
  test('a dual-market outlet naming the sibling venue still rehomes', () => {
    const stub = { outletId: 'whatsonstage', url: 'https://www.whatsonstage.com/news/ghosts-at-the-mitzi-e-newhouse-theater-review_1/' };
    assert.equal(S.resolveOutOfWindowStub({ show: G13, allShows: ALLG, publishDate: '2025-04-17', stub }).kind, 'rehome');
  });
  test('Royal Lyceum Edinburgh, dateless, is never moved to the Broadway Lyceum Macbeth', () => {
    const M13 = { id: 'macbeth-west-end-2013', title: 'Macbeth', category: 'west-end', venue: 'Trafalgar Studios', previewsStartDate: '2013-02-09', openingDate: '2013-02-22', closingDate: '2013-04-27' };
    const M08 = { id: 'macbeth-2008', title: 'Macbeth', category: 'broadway', venue: 'Lyceum Theatre', previewsStartDate: '2008-03-28', openingDate: '2008-04-08', closingDate: '2008-05-24' };
    const all = [M13, M08];
    const v = T.triagePendingStub({ outletId: 'whatsonstage', url: 'https://www.whatsonstage.com/news/macbeth-an-undoing-at-royal-lyceum-theatre-edinburgh-review_58311/' },
      { showId: M13.id, show: M13, allShows: all, sameTitleShows: T.sameTitleShowsFrom(M13, all) });
    assert.notEqual(v.verdict, 'rehome', JSON.stringify(v));
  });
});

// BRO-8090 cousin in BRO-8089's on-arrival settler: intakeVerdict called the triage without allShows, so a review
// of a same-title sibling (2026 Ambassadors 1536 under the 2025 Almeida entry) was settled as out-of-window junk the
// moment it was written. Red with the allShows argument removed from pending-intake.js.
test('BRO-8090: intake triage does not junk a review that a same-title sibling owns', () => {
  const { intakeVerdict } = require('../../scripts/lib/pending-intake.js');
  const ctx = { byId: new Map([[A1536.id, A1536], [B1536.id, B1536]]), allShows: [A1536, B1536], heldIndex: new Map() };
  const stub = { outletId: 'standard', criticName: 'Unknown', url: 'https://www.standard.co.uk/culture/theatre/1536-ambassadors-theatre-review-b1234567.html', publishDate: '2026-05-13' };
  const v = intakeVerdict(stub, A1536.id, { ctx });
  assert.notEqual(v.verdict, 'junk', JSON.stringify(v));
});

describe('BRO-8090 ship-check 2026-11-23 (Claude + Codex reviewers)', () => {
  const M13 = { id: 'macbeth-west-end-2013', title: 'Macbeth', category: 'west-end', venue: 'Trafalgar Studios', previewsStartDate: '2013-02-09', openingDate: '2013-02-22', closingDate: '2013-04-27' };
  const M08 = { id: 'macbeth-2008', title: 'Macbeth', category: 'broadway', venue: 'Lyceum Theatre', previewsStartDate: '2008-03-28', openingDate: '2008-04-08', closingDate: '2008-05-24' };
  test('a DATED Royal Lyceum Edinburgh review is not moved to the Broadway Lyceum (whole-phrase venue compare)', () => {
    const stub = { outletId: 'whatsonstage', url: 'https://www.whatsonstage.com/news/macbeth-an-undoing-at-royal-lyceum-theatre-edinburgh-review_58311/' };
    assert.equal(S.stubContradictsSibling(stub, M08, M13), 'venue-mismatch');
    assert.notEqual(S.resolveOutOfWindowStub({ show: M13, allShows: [M13, M08], publishDate: '2008-04-09', stub }).kind, 'rehome');
  });
  test('a producing company ("at-lincoln-center-theater") and a possessive prefix ("rscs-royal-shakespeare") are not venue mismatches', () => {
    const VB = { id: 'x-2020', title: 'X', category: 'broadway', venue: 'Vivian Beaumont Theater' };
    assert.equal(S.stubContradictsSibling({ url: 'https://example.com/x-at-lincoln-center-theater-review' }, VB, null), null);
    const RST = { id: 'y-2025', title: 'Y', category: 'regional', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon' };
    assert.equal(S.stubContradictsSibling({ url: 'https://www.whatsonstage.com/news/y-at-the-rscs-royal-shakespeare-theatre-review_1/' }, RST, null), null);
  });
  test('a rehomed stub drops the preview-placeholder flag and keeps a human wrongProduction verdict', () => {
    const out = S.rehomedStub({ url: 'u', isPreviewPlaceholder: true, wrongProduction: true, wrongProductionNote: 'Auto-flagged x', humanReviewedWrongProduction: true }, 'a', 'b', {});
    assert.equal(out.isPreviewPlaceholder, undefined);
    assert.equal(out.wrongProduction, true);
  });
  test('a SETTLED sibling copy is not a duplicate target: the source is left alone, never two settled copies', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8090sc-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const url = 'https://www.standard.co.uk/culture/theatre/1536-at-ambassadors-theatre-review-b1282189.html';
    fs.mkdirSync(path.join(root, '_pending', A1536.id), { recursive: true }); fs.mkdirSync(path.join(root, '_pending', B1536.id), { recursive: true });
    const src = path.join(root, '_pending', A1536.id, 'standard--x.json');
    fs.writeFileSync(src, JSON.stringify({ url, promoteSkippedReason: 'old' }));
    fs.writeFileSync(path.join(root, '_pending', B1536.id, 'standard--x.json'), JSON.stringify({ url, promoteSkippedReason: 'settled there' }));
    assert.equal(S.siblingHoldsSameUrl({ root, toShowId: B1536.id, file: 'standard--x.json', url }), false);
    assert.equal(S.rehomeStubFile({ root, file: 'standard--x.json', fromShowId: A1536.id, toShowId: B1536.id, data: { url } }), 'sibling-copy-settled');
    assert.equal(fs.existsSync(src), true);
  });
  test('an opaque url whose show mention sits only in an <aside> inside <article> stays inconclusive', () => {
    const html = '<html><title>FT</title><body><article><h1>Markets rally</h1><p>Stocks rose.</p><aside><h3>King of the Yees review</h3></aside></article></body></html>';
    assert.notEqual(V.verifyAggregatorUrl({ url: 'https://www.ft.com/content/fe1c433f-2786-4c16-b3e3-61e386182235', html, show: YEES }).isValid, true);
  });
});
describe('BRO-8091 noBylineTerminalReason: fetched, bodied, bylineless page on an old show settles', () => {
  const { noBylineTerminalReason } = require('../../scripts/lib/pending-triage.js');
  const body = 'x'.repeat(400);
  const old = { openingDate: '2009-10-04' };
  const NOW = Date.parse('2026-11-23');
  test('settles an archive page: fetched, real body, old show', () => {
    assert.match(noBylineTerminalReason({ pendingRefetchedAt: 'x', fullText: body }, old, NOW), /^no-byline-on-page/);
  });
  test('keeps: never fetched / no body / opening window / no show', () => {
    assert.equal(noBylineTerminalReason({ fullText: body }, old, NOW), null);
    assert.equal(noBylineTerminalReason({ pendingRefetchedAt: 'x', fullText: 'short' }, old, NOW), null);
    assert.equal(noBylineTerminalReason({ pendingRefetchedAt: 'x', fullText: body }, { openingDate: '2026-11-01' }, NOW), null);
    assert.equal(noBylineTerminalReason({ pendingRefetchedAt: 'x', fullText: body }, null, NOW), null);
  });
});
