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
    fs.writeFileSync(path.join(dir, 'guardian--c3.json'), JSON.stringify({ outletId: 'guardian', criticName: 'Unknown', url: 'https://www.theguardian.com/stage/2026/apr/01/punch-review-other' }));
    fs.writeFileSync(path.join(dir, 'times-uk--b2.json'), JSON.stringify({ outletId: 'times-uk', criticName: 'Unknown', url: REAL[0][1] }));
    let fetches = 0;
    const r = await processShow(PUNCH.id, {
      root, show: PUNCH, dryRun: false, triageOnly: true,
      heldIndex: T.buildHeldUrlIndex([{ showId: 'punch-uk-tour-2026', url: 'https://www.theguardian.com/stage/2026/apr/01/punch-review-other' }]), explicitScope: false,
      fetch: async () => { fetches++; return { content: '<html></html>' }; },
      alert: async () => {}, resolve: () => {}, emit: () => {},
      budget: { exceeded: () => false, minutes: 5 },
    });
    assert.equal(fetches, 0);
    assert.equal(r.tagged, 2);
    assert.equal(r.candidates, 1);
    assert.equal(r.promoted, 0);
    const junk = JSON.parse(fs.readFileSync(path.join(dir, 'hollywood-reporter--a1.json'), 'utf8'));
    assert.match(junk.promoteSkippedReason, /not a review/);
    assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'guardian--c3.json'), 'utf8')).promoteSkippedReason, /already scored under punch-uk-tour-2026.*BRO-8023 triage/);
    assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'times-uk--b2.json'), 'utf8')).promoteSkippedReason);
  });
});
