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

const require = createRequire(import.meta.url);
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

describe('BRO-8023: a same-url stub with a copy of the primary body is redundant', () => {
  const { isRedundantPendingStub } = require('../../scripts/replay-pending-bylines.js');
  const body = 'x'.repeat(4000);
  const stub = { criticName: 'Unknown', url: 'https://www.thewrap.com/creative-content/theater/the-heart-off-broadway-review-organ-transplant-musical/', fullText: body };
  test('primary body as long or longer → redundant (dropped)', () => {
    assert.equal(isRedundantPendingStub(stub, 'thewrap--robert-hofler.json', { fullText: body + 'more', contentTier: 'complete' }), true);
    assert.equal(isRedundantPendingStub(stub, 'thewrap--robert-hofler.json', { fullText: body, contentTier: 'truncated' }), true);
  });
  test('a junk or flagged primary body never outweighs the stub text', () => {
    assert.equal(isRedundantPendingStub(stub, 'thewrap--robert-hofler.json', { fullText: body + 'paywall', contentTier: 'invalid' }), false);
    assert.equal(isRedundantPendingStub(stub, 'thewrap--robert-hofler.json', { fullText: body + 'x', contentTier: 'complete', wrongProduction: true }), false);
  });
  test('stub body longer than the primary → kept (it carries something)', () => {
    assert.equal(isRedundantPendingStub(stub, 'thewrap--robert-hofler.json', { fullText: 'short' }), false);
  });
  test('no primary data passed → old rule (text keeps it)', () => {
    assert.equal(isRedundantPendingStub(stub, 'thewrap--robert-hofler.json'), false);
  });
  test('a score still keeps it', () => {
    assert.equal(isRedundantPendingStub({ ...stub, originalScore: '4/5' }, 'thewrap--robert-hofler.json', { fullText: body, contentTier: 'complete' }), false);
    assert.equal(isRedundantPendingStub({ ...stub, fullText: '', dtliExcerpt: 'A fine show' }, 'thewrap--robert-hofler.json', { fullText: body, contentTier: 'complete' }), false);
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
  test('a fetched copy no longer than the primary body is dropped before any fetch', async () => {
    const body = 'word '.repeat(600);
    const { root, stub } = setup(body, body + ' more');
    const c = { n: 0 };
    const r = await processShow(PUNCH.id, deps(root, c));
    assert.equal(fs.existsSync(stub), false);
    assert.equal(r.droppedRedundant, 1);
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
    assert.ok(!JSON.parse(fs.readFileSync(stub, 'utf8')).promoteSkippedReason);
  });
});
