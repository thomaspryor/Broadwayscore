/**
 * Regression tests for the 2026-08-12 collection blackout.
 *
 * Two Off-Broadway shows opened with a live NYT review, a Playbill Verdict
 * article and a BWW Review Roundup each, and the site showed zero critics for
 * both. One field — a null `openingDate` — silently removed them from the
 * collection queue, from the aggregator gap audit, and from the backstop that
 * was supposed to notice. These tests pin each of those three paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  showRecencyKey,
  buildShowRecencyMap,
  compareReviewPriority,
  NO_DATE_SENTINEL,
} = require('../../scripts/lib/collection-priority.js');
const {
  isNeverAttempted,
  assessShow,
} = require('../../scripts/lib/uncollected-strand.js');
const {
  datesFromDiscoveredReviews,
  openSignalFromDiscovery,
} = require('../../scripts/lib/opening-signal.js');

// The two real shows, as they actually sat in shows.json that morning.
const WINTERS_TALE = {
  id: 'the-winters-tale-off-broadway-2026',
  title: "The Winter's Tale",
  status: 'previews',
  category: 'off-broadway',
  openingDate: null,
  previewsStartDate: '2026-07-25',
};
const CATS = {
  id: 'cats-west-end-2026',
  title: 'Cats',
  status: 'open',
  category: 'west-end',
  openingDate: '2026-08-06',
  previewsStartDate: '2026-07-15',
};

test('recency key falls back to previewsStartDate when openingDate is null', () => {
  assert.equal(showRecencyKey(WINTERS_TALE), '2026-07-25');
  assert.equal(showRecencyKey(CATS), '2026-08-06');
  // No dates at all still yields a string — the comparator calls localeCompare
  // on it, and '' would silently sort last, which is the original bug.
  assert.equal(showRecencyKey({ id: 'x' }), NO_DATE_SENTINEL);
  assert.equal(showRecencyKey(null), NO_DATE_SENTINEL);
});

test('a null-openingDate show is NOT sorted behind the whole corpus', () => {
  const map = buildShowRecencyMap([WINTERS_TALE, CATS]);
  const entry = (show, priority = 1) => ({
    isOpenShow: true,
    recencyDate: map.get(show.id) || NO_DATE_SENTINEL,
    fetchAttempts: 0,
    priority,
  });
  // A 2003 long-runner: this is what the sentinel used to lose to.
  const oldShow = { isOpenShow: true, recencyDate: '2003-10-30', fetchAttempts: 0, priority: 1 };

  const queue = [oldShow, entry(WINTERS_TALE), entry(CATS)];
  queue.sort((a, b) => compareReviewPriority(a, b));

  assert.equal(queue[0].recencyDate, '2026-08-06', 'Cats (newest) first');
  assert.equal(queue[1].recencyDate, '2026-07-25', "Winter's Tale ahead of the 2003 show");
  assert.equal(queue[2].recencyDate, '2003-10-30');

  // The precise regression: under the old rule its key was 1900-01-01, so with
  // max_reviews=300 against ~2,800 shows it was never reachable at all.
  assert.ok(
    queue.findIndex(e => e.recencyDate === '2026-07-25') < queue.length - 1,
    'null-openingDate show must not land last'
  );
});

test('strand detector flags a discovered-but-never-fetched review, date-independently', () => {
  const nyt = {
    url: 'https://www.nytimes.com/2026/08/12/theater/winters-tale-review-shakespeare-in-the-park.html',
    outlet: 'The New York Times',
    contentTier: 'stub',
    incompleteReason: 'not_attempted',
    // The real file carried this — it is what proves press night happened and
    // separates a genuine blackout from a show that simply has not opened.
    publishDate: '2026-08-12',
    firstSeenAt: '2026-08-12T11:39:49.729Z',
  };
  assert.equal(isNeverAttempted(nyt), true);

  // A file we DID look at and rejected is a decision, not a strand.
  assert.equal(isNeverAttempted({ url: 'u', rejectionReason: 'not_a_review' }), false);
  assert.equal(isNeverAttempted({ url: 'u', fullText: 'real body', incompleteReason: 'not_attempted' }), false);
  assert.equal(isNeverAttempted({ incompleteReason: 'not_attempted' }), false, 'no URL, nothing to fetch');

  // Real timing: discovered 11:39 UTC, owner spotted the blank page ~02:00 UTC
  // the next morning — 14h. The threshold has to be tight enough to fire here.
  const nowMs = Date.parse('2026-08-13T02:00:00Z');
  const result = assessShow(
    WINTERS_TALE,
    [
      { file: 'nytimes--unknown.json', review: nyt },
      { file: 'theatermania--unknown.json', review: { ...nyt, url: 'https://theatermania.com/x' } },
      { file: 'nysun--unknown.json', review: { ...nyt, url: 'https://nysun.com/x' } },
    ],
    { nowMs }
  );
  assert.equal(result.stranded.length, 3);
  assert.equal(result.usable, 0);
  assert.equal(result.totalBlackout, true, 'live show, 0 usable, 3+ discovered');
});

test('strand detector does not exempt a file just because it has no timestamp', () => {
  const nowMs = Date.parse('2026-08-13T02:00:00Z');
  const result = assessShow(
    WINTERS_TALE,
    [{ file: 'a.json', review: { url: 'https://x/y', incompleteReason: 'not_attempted' } }],
    { nowMs }
  );
  assert.equal(result.stranded.length, 1, 'undated strand still counts');
  assert.equal(result.stranded[0].ageHours, null);
});

test('closed shows are out of scope', () => {
  assert.equal(assessShow({ ...WINTERS_TALE, status: 'closed' }, [], { nowMs: Date.now() }), null);
});

test('discovery open-signal fires from an uncollected review, ignoring prior-run dates', () => {
  // Exactly what sat in the folder: one dated 2026 NYT review, plus seven 2023
  // Shakespeare's Globe reviews already flagged wrongProduction.
  const files = [
    { url: 'https://www.nytimes.com/2026/08/12/theater/winters-tale-review-shakespeare-in-the-park.html', publishDate: '2026-08-12', contentTier: 'stub' },
    { url: 'https://www.theguardian.com/stage/2023/feb/23/the-winters-tale-review-sam-wanamaker-playhouse-shakespeares-globe', publishDate: '2023-02-25', wrongProduction: true },
    { url: 'https://www.thestage.co.uk/reviews/the-winters-tale-review', publishDate: '2023-02-25', wrongProduction: true },
  ];
  const dates = datesFromDiscoveredReviews(files, WINTERS_TALE);
  assert.deepEqual(dates, ['2026-08-12'], 'prior-production reviews must not become press night');

  const isDateReached = (d) => d <= '2026-08-13';
  const signal = openSignalFromDiscovery(WINTERS_TALE, files, isDateReached);
  assert.equal(signal.date, '2026-08-12');
  assert.equal(signal.source, 'discovery-open-signal');
});

test('discovery open-signal stays silent when only stale prior-run reviews exist', () => {
  const staleOnly = [
    { url: 'https://x/2023', publishDate: '2023-02-25' },
  ];
  // Dated before previews started: not press coverage of this run.
  assert.deepEqual(datesFromDiscoveredReviews(staleOnly, WINTERS_TALE), []);
  assert.equal(openSignalFromDiscovery(WINTERS_TALE, staleOnly, () => true), null);
});

test('discovery open-signal never fabricates a future opening date', () => {
  const future = [{ url: 'https://x/y', publishDate: '2026-09-01' }];
  const isDateReached = (d) => d <= '2026-08-13';
  assert.equal(
    openSignalFromDiscovery(WINTERS_TALE, future, isDateReached),
    null,
    'a future press night would let Check 2c oscillate open→previews'
  );
});

test('discovery open-signal only applies to pre-open shows', () => {
  const files = [{ url: 'https://x/y', publishDate: '2026-08-12' }];
  assert.equal(openSignalFromDiscovery(CATS, files, () => true), null, 'already open');
});

// --- ship-check findings, 2026-08-13 ---

test('discovery open-signal refuses to guess when previewsStartDate is missing', () => {
  // Without previewsStartDate there is nothing separating this run's press
  // coverage from a prior production's, and the discovery layer holds both.
  // Guessing here writes a wrong user-visible "Opened {date}".
  const noPreviews = { ...WINTERS_TALE, previewsStartDate: null };
  const files = [{ url: 'https://x/y', publishDate: '2023-02-25' }];
  assert.equal(openSignalFromDiscovery(noPreviews, files, () => true), null);
});

test('a roundup article never becomes press night', () => {
  // BWW/Playbill roundups carry a url and a publishDate and are exactly what
  // lands in a show's folder the day its reviews drop.
  const files = [
    { url: 'https://www.broadwayworld.com/article/Review-Roundup-X', publishDate: '2026-08-12', isRoundupArticle: true },
    { url: 'https://x/news', publishDate: '2026-08-12', isNotReview: true },
    { url: 'https://x/bad', publishDate: '2026-08-12', wrongUrl: true },
  ];
  assert.deepEqual(datesFromDiscoveredReviews(files, WINTERS_TALE), []);
  assert.equal(openSignalFromDiscovery(WINTERS_TALE, files, () => true), null);
});

test('a show that has not opened yet is never a blackout', () => {
  // Abigail's Party, 2026-08-13: previews from 08-12, press night 08-19, and
  // six dead URLs from earlier revivals of the same Mike Leigh play. Zero
  // usable reviews is the CORRECT state — it has not been reviewed yet.
  const abigails = {
    id: 'abigails-party-west-end-2026',
    status: 'previews',
    category: 'west-end',
    openingDate: '2026-08-19',
    previewsStartDate: '2026-08-12',
  };
  // Dated BEFORE previews began, so this pins the prior-run filter rather than
  // passing trivially on "no dates present" (the first cut of this test did the
  // latter and did not exercise the mechanism its comment claimed).
  const staleLinks = ['thestage', 'timeout-london', 'telegraph', 'times-uk', 'whatsonstage', 'lbo']
    .map((o) => ({
      file: `${o}.json`,
      review: {
        url: `https://${o}.example/abigails-party-review`,
        contentTier: 'invalid',
        incompleteReason: 'wrong_content',
        publishDate: '2012-04-18',
      },
    }));
  const result = assessShow(abigails, staleLinks, { nowMs: Date.parse('2026-08-13T09:00:00Z') });
  assert.equal(result.discovered, 6);
  assert.equal(result.usable, 0);
  assert.equal(result.totalBlackout, false, 'unopened show must not raise a blackout alarm');
  assert.equal(result.stranded.length, 0, 'wrong_content was judged, not stranded');
});

test('an OPEN show alarms even when every discovered file is dateless', () => {
  // The over-correction that shipped briefly on 2026-08-13: keying "has it
  // opened?" on review dates alone. Measured on the live corpus, 95 of 99
  // not_attempted files carry no parseable date, so this silenced the alarm
  // everywhere. show.status/openingDate is the stronger, always-present witness.
  const matilda = {
    id: 'matilda-the-musical-theatre-row-off-broadway-2026',
    status: 'open',
    category: 'off-broadway',
    openingDate: '2026-08-06',
    previewsStartDate: '2026-07-20',
  };
  const dateless = [
    { file: 'a.json', review: { url: 'https://a/1', incompleteReason: 'not_attempted' } },
    { file: 'b.json', review: { url: 'https://b/1', incompleteReason: 'not_attempted' } },
  ];
  const r = assessShow(matilda, dateless, { nowMs: Date.parse('2026-08-13T09:00:00Z') });
  assert.equal(r.totalBlackout, true, 'an open show past its opening date is opened, dates or no dates');
});

test('an open show whose real reviews were all wrongly flagged still alarms', () => {
  // The nastiest shape: wrongProduction flags both CAUSE the blackout and erase
  // the dated evidence, so review data can never license the alarm. Only the
  // show record can. Live case on 2026-08-13: matilda-the-musical-theatre-row.
  const show = { id: 'x', status: 'open', category: 'off-broadway', openingDate: '2026-08-06', previewsStartDate: '2026-07-20' };
  const flagged = [
    { file: 'a.json', review: { url: 'https://a/1', publishDate: '2026-08-06', wrongProduction: true } },
    { file: 'b.json', review: { url: 'https://b/1', publishDate: '2026-08-06', wrongProduction: true } },
  ];
  const r = assessShow(show, flagged, { nowMs: Date.parse('2026-08-13T09:00:00Z') });
  assert.equal(r.totalBlackout, true);
});

test('a future review date cannot license the alarm', () => {
  const show = { id: 'x', status: 'previews', category: 'west-end', openingDate: null, previewsStartDate: '2026-08-12' };
  const future = [
    { file: 'a.json', review: { url: 'https://a/1', publishDate: '2027-03-01' } },
    { file: 'b.json', review: { url: 'https://b/1', publishDate: '2027-03-01' } },
  ];
  const r = assessShow(show, future, { nowMs: Date.parse('2026-08-13T09:00:00Z') });
  assert.equal(r.totalBlackout, false, 'press night in 2027 has not happened');
});

test('with no previewsStartDate, prior-production dates are not treated as press night', () => {
  // datesFromDiscoveredReviews can only filter stale runs when it has the
  // previews boundary; openSignalFromDiscovery refuses to guess without it and
  // so must this.
  const show = { id: 'x', status: 'previews', category: 'off-broadway', openingDate: null, previewsStartDate: null };
  const ancient = [
    { file: 'a.json', review: { url: 'https://a/1', publishDate: '2003-05-01' } },
    { file: 'b.json', review: { url: 'https://b/1', publishDate: '2003-05-01' } },
  ];
  const r = assessShow(show, ancient, { nowMs: Date.parse('2026-08-13T09:00:00Z') });
  assert.equal(r.totalBlackout, false);
});

test('two discovered URLs with nothing collected is already a blackout', () => {
  // An Off-Broadway press slate can be two outlets; requiring 3 would let a
  // real blackout through.
  const nowMs = Date.parse('2026-08-13T02:00:00Z');
  const twoUrls = [
    { file: 'a.json', review: { url: 'https://a/1', publishDate: '2026-08-12' } },
    { file: 'b.json', review: { url: 'https://b/1', publishDate: '2026-08-12' } },
  ];
  assert.equal(assessShow(WINTERS_TALE, twoUrls, { nowMs }).totalBlackout, true);
  assert.equal(
    assessShow(WINTERS_TALE, twoUrls.slice(0, 1), { nowMs }).totalBlackout,
    false,
    'a single discovered URL is not yet evidence of a blackout'
  );
});
