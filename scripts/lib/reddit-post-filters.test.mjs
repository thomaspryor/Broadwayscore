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
