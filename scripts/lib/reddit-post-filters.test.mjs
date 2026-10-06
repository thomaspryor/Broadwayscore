import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isRoundupOrMegathread,
  isGenericTitle,
  isRedditVolumeInflated,
  commentAnchorsToShow,
  otherSourceReviewCounts,
  buildAudienceSearchQueries,
  isPreFixReddit,
  isRefreshStaleCandidate,
  refreshStaleSortKey,
  REDDIT_CONTAMINATION_FIX_DATE,
} = require('./reddit-post-filters.js');

test('roundup/megathread posts are detected (real contaminators seen for music-city)', () => {
  // These exact titles were observed polluting music-city-off-broadway-2026.
  assert.equal(isRoundupOrMegathread('Drama Desk Awards 2025'), true);
  assert.equal(isRoundupOrMegathread('Theater Wrap 2025'), true);
  assert.equal(isRoundupOrMegathread('What does your theatre week look like this week?'), true);
  assert.equal(isRoundupOrMegathread('Tony Award Nominations 2025'), true);
  assert.equal(isRoundupOrMegathread('Outer Critics Circle winners thread'), true);
  assert.equal(isRoundupOrMegathread('2025 Olivier Awards reactions'), true);
  assert.equal(isRoundupOrMegathread('Best musicals of 2025'), true);
  assert.equal(isRoundupOrMegathread('Weekly Discussion Thread'), true);
  assert.equal(isRoundupOrMegathread('Recommendations thread'), true);
  assert.equal(isRoundupOrMegathread('What should I see in NYC?'), true);
});

test('genuine show-specific posts are NOT flagged as roundups', () => {
  assert.equal(isRoundupOrMegathread('Has anyone seen Music City yet?'), false);
  assert.equal(isRoundupOrMegathread('Music City is an awesome hidden gem off-off-Broadway'), false);
  assert.equal(isRoundupOrMegathread('Just saw Maybe Happy Ending — wow'), false);
  assert.equal(isRoundupOrMegathread('Review: The Outsiders broke me'), false);
  assert.equal(isRoundupOrMegathread('My thoughts on Hadestown'), false);
  // "award"-adjacent but show-specific (no ceremony/thread phrasing)
  assert.equal(isRoundupOrMegathread('This show is award-worthy'), false);
});

test('single-significant-word titles are generic/collision-prone', () => {
  for (const t of ['Chess', 'Proof', 'Giant', 'Mercury', 'Sukkot', 'Masquerade', 'Burlesque', 'Hadestown', 'Wicked']) {
    assert.equal(isGenericTitle(t), true, `${t} should be generic`);
  }
});

test('known multi-word film/phrase collisions are generic', () => {
  for (const t of ['Music City', 'Dog Day Afternoon', 'The Lost Boys', 'Lean-To', 'Every Brilliant Thing']) {
    assert.equal(isGenericTitle(t), true, `${t} should be generic`);
  }
});

test('distinctive multi-word titles are NOT generic', () => {
  for (const t of ['Maybe Happy Ending', 'Buena Vista Social Club', 'Two Strangers (Carry a Cake Across New York)', 'Operation Mincemeat']) {
    assert.equal(isGenericTitle(t), false, `${t} should not be generic`);
  }
});

test('isRedditVolumeInflated catches multi-word generic phrases isGenericTitle misses', () => {
  // These MULTI-WORD titles are NOT flagged by isGenericTitle (they have 2+
  // significant words and aren't on the denylist), yet showed the exact
  // contamination signature (huge Reddit volume, ~zero corroboration).
  assert.equal(isGenericTitle('Pied à Terre'), false);
  assert.equal(isGenericTitle('La Breve y Maravillosa Vida de Oscar Wao'), false);
  assert.equal(isGenericTitle('Drunk Romeo & Juliet'), false);
  // Sole-source: a real show with 80+ genuine Reddit reviews would have SOME
  // other audience source, so sole-source + volume floor is unambiguous.
  assert.equal(isRedditVolumeInflated(371, [], 'La Breve y Maravillosa Vida de Oscar Wao'), true);
  assert.equal(isRedditVolumeInflated(117, [3], 'Pied à Terre'), true); // 39x, non-generic
  assert.equal(isRedditVolumeInflated(192, [22], 'Drunk Romeo & Juliet'), true); // 8.7x, non-generic
});

test('isRedditVolumeInflated protects genuinely Reddit-corroborated shows', () => {
  // Drunk Shakespeare: real long-running show, 153 Reddit vs 69 ShowScore votes
  // (2.2x). Non-generic titles need 4x, so it is NOT suppressed.
  assert.equal(isRedditVolumeInflated(153, [69], 'Drunk Shakespeare'), false);
  // Below the volume floor — never flagged regardless of ratio.
  assert.equal(isRedditVolumeInflated(50, [], 'Ice Queen'), false);
  // Reddit not dominant enough (multi-word, 3x < 4x).
  assert.equal(isRedditVolumeInflated(120, [40], 'Some Distinctive Play'), false);
});

test('commentAnchorsToShow drops non-naming comments from roundup/other-show threads', () => {
  // The exact false-positive pattern Gemini passed for Pied à Terre (99-seat
  // immersive show): generic replies + comments in other-show/roundup threads
  // that never name the production.
  assert.equal(commentAnchorsToShow({ postTitle: 'Saw eleven Broadway and Off-Broadway shows', body: "I'm totally with you in spirit" }, 'Pied à Terre'), false);
  assert.equal(commentAnchorsToShow({ postTitle: 'Favorite New Musical of the 2020s?', body: 'I saw an excellent regional production' }, 'Pied à Terre'), false);
  assert.equal(commentAnchorsToShow({ postTitle: "what's your favorite", body: 'the show was great' }, 'Misterman'), false);
});

test('commentAnchorsToShow keeps comments that name the show (in body or thread)', () => {
  assert.equal(commentAnchorsToShow({ postTitle: 'random thread', body: 'Just saw Pied a Terre last night, wonderful' }, 'Pied à Terre'), true);
  assert.equal(commentAnchorsToShow({ postTitle: 'Pied à Terre review', body: 'loved it' }, 'Pied à Terre'), true);
  // Thread named after the show anchors even a bare "the show was great" body.
  assert.equal(commentAnchorsToShow({ postTitle: 'Misterman at Theatre Row', body: 'the show was great' }, 'Misterman'), true);
  assert.equal(commentAnchorsToShow({ postTitle: 'Maybe Happy Ending discussion', body: 'the ending destroyed me' }, 'Maybe Happy Ending'), true);
});

test('commentAnchorsToShow needs 2+ distinctive tokens for long titles (novel-collision defense)', () => {
  // "Oscar Wao" alone (novel chatter) matches only 1 distinctive token of the
  // long play title → dropped before the LLM. Requires more of the actual title.
  assert.equal(commentAnchorsToShow({ postTitle: 'Oscar Wao book club', body: 'the novel is a masterpiece' }, 'La Breve y Maravillosa Vida de Oscar Wao'), false);
  assert.equal(commentAnchorsToShow({ postTitle: 'saw Oscar Wao at Repertorio', body: 'la vida de oscar wao was moving' }, 'La Breve y Maravillosa Vida de Oscar Wao'), true);
});

test('commentAnchorsToShow full-title match is word-bounded (no substring-in-word anchor)', () => {
  // "Cats" must not anchor on "advocats"/"catserver" (substring), but must still
  // anchor on a real word-boundary mention.
  assert.equal(commentAnchorsToShow({ postTitle: 'r/webdev', body: 'the advocatserver crashed again' }, 'Cats'), false);
  assert.equal(commentAnchorsToShow({ postTitle: 'Cats revival', body: 'loved it' }, 'Cats'), true);
  // Multi-word title still matches as a bounded phrase.
  assert.equal(commentAnchorsToShow({ postTitle: 'x', body: 'saw pied a terre last night' }, 'Pied à Terre'), true);
});

test('commentAnchorsToShow does not pre-drop when title has no distinctive token', () => {
  // All-short/stopword title → no reliable anchor → let the LLM decide (return true).
  assert.equal(commentAnchorsToShow({ postTitle: 'unrelated', body: 'unrelated' }, 'Us'), true);
});

test('otherSourceReviewCounts includes West End sources (audit/neutralize parity)', () => {
  // Regression: the audit previously omitted seatplan/lbo/ltd, so it saw a WE
  // show's Reddit as sole-source and over-flagged shows the suppressor left
  // alone. myras-story-west-end-2026: reddit 244 vs lbo 98 → 2.5x < 4x → NOT
  // inflated. Both must agree via this shared counts builder.
  const weSources = { reddit: { reviewCount: 244 }, lbo: { reviewCount: 98 } };
  const counts = otherSourceReviewCounts(weSources);
  assert.deepEqual(counts, [98]);
  assert.equal(isRedditVolumeInflated(244, counts, "Myra's Story"), false);
  // ltd and seatplan are counted too (returned in canonical source order).
  assert.deepEqual(otherSourceReviewCounts({ ltd: { reviewCount: 30 }, seatplan: { reviewCount: 12 } }), [12, 30]);
  // reddit is never counted as an "other" source; zero-count sources dropped.
  assert.deepEqual(otherSourceReviewCounts({ reddit: { reviewCount: 500 }, showScore: { reviewCount: 0 } }), []);
});

test('isRedditVolumeInflated keeps the aggressive 2x ratio for generic titles', () => {
  // Single-word generic title: 2x dominance is enough (bare-phrase searches are
  // very leaky), so this IS flagged where a multi-word title would not be.
  assert.equal(isGenericTitle('Mercury'), true);
  assert.equal(isRedditVolumeInflated(90, [40], 'Mercury'), true); // 2.25x, generic
  assert.equal(isRedditVolumeInflated(90, [40], 'A Distinctive Title'), false); // 2.25x, non-generic → safe
});

test('no show runs a bare-phrase Reddit query; widest query is market-anchored', () => {
  const qs = buildAudienceSearchQueries({
    cleanTitle: 'Music City', marketName: 'Off-Broadway', isWestEnd: false,
  });
  assert.ok(!qs.includes('"Music City"'), 'bare phrase query must not appear');
  assert.ok(qs.includes('"Music City" "Off-Broadway"'), 'market-anchored phrase present');
});

test('weak queries stay unanchored for ALL shows (recall — distinctive single-word shows too)', () => {
  // Generic flag no longer changes query anchoring; the universal bare-phrase
  // removal is the qualification. Weak queries unanchored preserves recall for
  // distinctive one-word shows (Hadestown/Wicked) that isGenericTitle flags.
  for (const cleanTitle of ['Mercury', 'Hadestown']) {
    const qs = buildAudienceSearchQueries({ cleanTitle, marketName: 'Broadway', isWestEnd: false });
    assert.ok(qs.includes(`"${cleanTitle}" thoughts`), `${cleanTitle} thoughts unanchored`);
    assert.ok(qs.includes(`"${cleanTitle}" loved`), `${cleanTitle} loved unanchored`);
    assert.ok(qs.includes(`"${cleanTitle}" recommend`), `${cleanTitle} recommend unanchored`);
  }
});

test('every KNOWN_GENERIC_TITLES entry round-trips through normalizeForGenericCheck', () => {
  // A dead key (short form that never equals the normalized stored title)
  // silently no-ops. Guard against that class of bug.
  const { KNOWN_GENERIC_TITLES, normalizeForGenericCheck } = require('./reddit-post-filters.js');
  for (const key of KNOWN_GENERIC_TITLES) {
    assert.equal(normalizeForGenericCheck(key), key, `KNOWN key "${key}" must be its own normalized form`);
    assert.equal(isGenericTitle(key), true, `KNOWN key "${key}" must be generic`);
  }
});

test('isPreFixReddit: pre-fix / undated records flagged, post-fix / suppressed / absent are not', () => {
  // Pre-fix scrape (the contamination-prone era) → true
  assert.equal(isPreFixReddit({ lastUpdated: '2026-05-15T00:00:00Z', reviewCount: 481 }), true);
  // Undated legacy record (predates the lastUpdated field) → true
  assert.equal(isPreFixReddit({ reviewCount: 100 }), true);
  // Post-fix clean scrape → false
  assert.equal(isPreFixReddit({ lastUpdated: '2026-06-30T00:00:00Z', reviewCount: 132 }), false);
  // Exactly on the boundary is NOT pre-fix (strict <)
  assert.equal(isPreFixReddit({ lastUpdated: REDDIT_CONTAMINATION_FIX_DATE }), false);
  // Already suppressed → handled, not counted as backlog
  assert.equal(isPreFixReddit({ lastUpdated: '2026-01-01', suppressed: true }), false);
  // No reddit source → false
  assert.equal(isPreFixReddit(null), false);
  assert.equal(isPreFixReddit(undefined), false);
});

test('isRefreshStaleCandidate: score window + staleness gating', () => {
  const now = Date.now();
  const staleBefore = new Date(now - 45 * 864e5);
  const closedWindowCutoff = new Date(now - 3 * 365 * 864e5);
  const nowISO = new Date(now).toISOString();
  const opts = { staleBefore, closedWindowCutoff };
  const openShow = { status: 'open' };
  const recentClosed = { status: 'closed', closingDate: new Date(now - 30 * 864e5).toISOString() };
  const oldClosed = { status: 'closed', closingDate: '2020-01-01' };

  // In-window + stale reddit → refresh
  assert.equal(isRefreshStaleCandidate(openShow, { sources: { reddit: { lastUpdated: '2026-02-01' } } }, opts), true);
  // In-window + fresh reddit → skip
  assert.equal(isRefreshStaleCandidate(openShow, { sources: { reddit: { lastUpdated: nowISO } } }, opts), false);
  // In-window + never scraped/attempted → refresh
  assert.equal(isRefreshStaleCandidate(openShow, { sources: {} }, opts), true);
  assert.equal(isRefreshStaleCandidate(openShow, undefined, opts), true);
  // THE STUCK-BACKLOG FIX: no-data show just attempted → NOT re-selected
  assert.equal(isRefreshStaleCandidate(openShow, { redditLastAttempted: nowISO, sources: {} }, opts), false);
  // ...but a stale attempt marker → retry
  assert.equal(isRefreshStaleCandidate(openShow, { redditLastAttempted: '2026-01-01', sources: {} }, opts), true);
  // Recently-closed (within 3yr) is in the score window
  assert.equal(isRefreshStaleCandidate(recentClosed, { sources: {} }, opts), true);
  // Long-closed (>3yr) is NOT — its Reddit no longer affects any live score
  assert.equal(isRefreshStaleCandidate(oldClosed, { sources: {} }, opts), false);
  // Missing show record → not a candidate
  assert.equal(isRefreshStaleCandidate(undefined, { sources: {} }, opts), false);
});

test('refreshStaleSortKey: never-touched sorts oldest; attempt marker counts', () => {
  assert.equal(refreshStaleSortKey({ sources: {} }), 0);
  assert.equal(refreshStaleSortKey(undefined), 0);
  const t = '2026-03-01T00:00:00Z';
  assert.equal(refreshStaleSortKey({ sources: { reddit: { lastUpdated: t } } }), new Date(t).getTime());
  // attempt marker used when no reddit.lastUpdated
  assert.equal(refreshStaleSortKey({ redditLastAttempted: t, sources: {} }), new Date(t).getTime());
});

test('opera queries keep their Met anchoring unchanged', () => {
  const qs = buildAudienceSearchQueries({
    cleanTitle: 'Innocence', marketName: 'Broadway', isWestEnd: false, isOpera: true,
  });
  assert.ok(qs.every((q) => /Met|Metropolitan/.test(q)));
});

test('isRedditFresh (BRO-4215): skips shows touched within the window, using the later of scrape/attempt', () => {
  const { isRedditFresh, lastRedditTouchMs } = require('./reddit-post-filters.js');
  const now = Date.parse('2026-09-28T12:00:00Z');
  const scraped = (iso) => ({ sources: { reddit: { lastUpdated: iso } } });
  assert.equal(isRedditFresh(scraped('2026-09-28T01:00:00Z'), 20, now), true, '11h ago');
  assert.equal(isRedditFresh(scraped('2026-09-27T12:00:00Z'), 20, now), false, '24h ago');
  assert.equal(isRedditFresh({ redditLastAttempted: '2026-09-28T06:00:00Z' }, 20, now), true, 'no-data attempt counts');
  // Old data + newer failed attempt: the attempt wins (max, not ||).
  const both = { sources: { reddit: { lastUpdated: '2026-04-01T00:00:00Z' } }, redditLastAttempted: '2026-09-28T10:00:00Z' };
  assert.equal(lastRedditTouchMs(both), Date.parse('2026-09-28T10:00:00Z'));
  assert.equal(isRedditFresh(both, 20, now), true);
  assert.equal(isRedditFresh(undefined, 20, now), false, 'never touched');
  assert.equal(isRedditFresh({ sources: {} }, 20, now), false);
  assert.equal(isRedditFresh(scraped('garbage'), 20, now), false, 'unparseable date ignored');
  assert.equal(isRedditFresh(scraped('2026-09-28T11:00:00Z'), 0, now), false, 'hours=0 disables');
});

test('isRedditFresh backs off shows that keep finding no Reddit data (1/2/4/8/14 days)', () => {
  const { isRedditFresh } = require('./reddit-post-filters.js');
  const now = Date.parse('2026-10-01T12:00:00Z');
  const h = (n) => new Date(now - n * 3600 * 1000).toISOString();
  const noData = (hoursAgo, streak) => ({ sources: {}, redditLastAttempted: h(hoursAgo), redditNoDataStreak: streak });
  assert.equal(isRedditFresh(noData(23, 1), 20, now), true, 'streak 1: waits 1 day');
  assert.equal(isRedditFresh(noData(25, 1), 20, now), false, 'streak 1: retries after 1 day');
  assert.equal(isRedditFresh(noData(47, 2), 20, now), true, 'streak 2: waits 2 days');
  assert.equal(isRedditFresh(noData(95, 3), 20, now), true, 'streak 3: waits 4 days');
  assert.equal(isRedditFresh(noData(24 * 13, 9), 20, now), true, 'streak caps at 14 days');
  assert.equal(isRedditFresh(noData(24 * 15, 9), 20, now), false, 'retries after 14 days');
  assert.equal(isRedditFresh(noData(1, 5), 0, now), false, 'hours=0 still forces a refresh');
  assert.equal(isRedditFresh({ sources: {}, redditLastAttempted: h(23) }, 20, now), false, 'no streak: plain 20h rule');
  const newerData = { sources: { reddit: { lastUpdated: h(30) } }, redditLastAttempted: h(40), redditNoDataStreak: 4 };
  assert.equal(isRedditFresh(newerData, 20, now), false, 'data newer than the attempt ignores a stale streak');
});

test('isRedditFresh caps the no-data backoff at 2 days within 14 days of opening or previews', () => {
  const { isRedditFresh } = require('./reddit-post-filters.js');
  const now = Date.parse('2026-10-01T12:00:00Z');
  const rec = { sources: {}, redditLastAttempted: new Date(now - 72 * 3600 * 1000).toISOString(), redditNoDataStreak: 5 };
  assert.equal(isRedditFresh(rec, 20, now), true, 'far from opening: 14-day hold');
  assert.equal(isRedditFresh(rec, 20, now, { openingDate: '2026-09-25' }), false, '6 days after opening: 2-day cap, 3 days passed');
  assert.equal(isRedditFresh(rec, 20, now, { previewsStartDate: '2026-10-10' }), false, 'previews in 9 days: capped');
  assert.equal(isRedditFresh(rec, 20, now, { openingDate: '2026-06-01' }), true, 'months after opening: full backoff');
});

test('redditBackoffReason (BRO-4777): below-floor samples back off like no-data, without a freshness window', () => {
  const { redditBackoffReason, isRedditFresh } = require('./reddit-post-filters.js');
  const now = Date.parse('2026-10-06T12:00:00Z');
  const h = (n) => new Date(now - n * 3600 * 1000).toISOString();
  // Saved a 12-item sample 30h ago; the scraper stamps the attempt just after the save.
  const small = (hoursAgo, streak, reviewCount = 12) => ({
    sources: { reddit: { score: 70, reviewCount, lastUpdated: h(hoursAgo + 0.01) } },
    redditLastAttempted: h(hoursAgo),
    redditNoDataStreak: streak,
  });
  assert.equal(redditBackoffReason(small(30, 2), null, now), 'below-floor', 'streak 2 holds 2 days');
  assert.equal(redditBackoffReason(small(50, 2), null, now), null, 'retries after 2 days');
  assert.equal(redditBackoffReason(small(24 * 10, 5), null, now), 'below-floor', 'streak 5 holds 14 days');
  assert.equal(redditBackoffReason(small(24 * 10, 5), { openingDate: '2026-10-01' }, now), null, 'near opening: 2-day cap');
  assert.equal(redditBackoffReason(small(30, 2, 49), null, now), 'below-floor', '49 items is below the floor');
  assert.equal(redditBackoffReason({ sources: {}, redditLastAttempted: h(5), redditNoDataStreak: 1 }, null, now), 'no-data');
  assert.equal(redditBackoffReason(undefined, null, now), null, 'never touched');
  assert.equal(redditBackoffReason({ sources: { reddit: { score: 80, reviewCount: 300, lastUpdated: h(2) } } }, null, now), null,
    'a counting sample has no streak, so no backoff');
  // isRedditFresh composes the same backoff with its window; hours=0 still forces.
  assert.equal(isRedditFresh(small(30, 2), 20, now), true);
  assert.equal(isRedditFresh(small(30, 2), 0, now), false, 'forced refresh ignores the backoff');
});

test('redditSaveDecision (BRO-4777): fetch errors never demote a counting Reddit sample', () => {
  const { redditSaveDecision } = require('./reddit-post-filters.js');
  const counting = { score: 80, reviewCount: 120 };
  const small = { score: 70, reviewCount: 20 };
  const big = { score: 75, reviewCount: 90 };
  assert.equal(redditSaveDecision(counting, small, { fetchFailed: true }), 'keep-existing', 'partial scrape would drop it below 50');
  assert.equal(redditSaveDecision(counting, small, { fetchFailed: false }), 'save-below-floor', 'a clean scrape is believed');
  assert.equal(redditSaveDecision(counting, big, { fetchFailed: true }), 'save', 'still counts: save as today');
  assert.equal(redditSaveDecision(undefined, small, { fetchFailed: true }), 'save-below-floor', 'nothing to protect');
  assert.equal(redditSaveDecision({ score: null, reviewCount: 120 }, small, { fetchFailed: true }), 'save-below-floor',
    'a stored sample with no score never counted');
  assert.equal(redditSaveDecision(small, { score: 70, reviewCount: 50 }), 'save', '50 is at the floor');
});
