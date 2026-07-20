/**
 * Unit tests for the Social Pulse scoring library.
 *
 * Tests cover:
 * - truncateQuote: truncation + word boundary
 * - containsBlockedContent: profanity/slur blocklist
 * - filterTopQuotes: sentiment bucket + engagement + blocklist
 * - deriveTier: every tier transition + cold-start + hidden state
 * - updateBaseline: rolling 8-week mean + cold start
 * - computeSocialPulse: end-to-end with realistic fixtures
 *
 * Run with: node --test tests/unit/social-pulse-scorer.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  computeSocialPulse,
  deriveTier,
  filterTopQuotes,
  truncateQuote,
  containsBlockedContent,
  meaningfulContentLength,
  updateBaseline,
  computePositivePct,
  computePlatformBreakdown,
  MIN_MENTIONS_FOR_CARD,
  BASELINE_REQUIRED_WEEKS,
  QUOTE_MAX_CHARS,
} = require('../../scripts/lib/social-pulse-scorer');

// ---------- Fixtures ----------

/** Build a normalized mention with sensible defaults for tests. */
function mention(overrides = {}) {
  return {
    text: 'I loved maybe happy ending on broadway, such a gorgeous show',
    platform: 'x',
    author: '@test_user',
    url: 'https://x.com/test_user/status/1',
    createdAt: '2026-04-08T12:00:00Z',
    engagement: 50,
    relevant: true,
    sentiment: 'positive',
    ...overrides,
  };
}

/** Build N positive mentions with varying engagement. */
function positiveBatch(n, baseEngagement = 10) {
  return Array.from({ length: n }, (_, i) =>
    mention({
      text: `this show is amazing, highly recommend (variant ${i})`,
      engagement: baseEngagement + i,
      author: `@user${i}`,
      url: `https://x.com/user${i}/status/${i}`,
    }),
  );
}

// ---------- truncateQuote ----------

describe('truncateQuote', () => {
  test('returns short text unchanged', () => {
    assert.strictEqual(truncateQuote('short tweet'), 'short tweet');
  });

  test('normalizes whitespace', () => {
    assert.strictEqual(truncateQuote('  multi\n\nspaced  '), 'multi spaced');
  });

  test('truncates long text with ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = truncateQuote(long);
    assert.strictEqual(result.length, QUOTE_MAX_CHARS);
    assert.ok(result.endsWith('…'));
  });

  test('breaks on word boundary when possible', () => {
    const text = 'this is a perfectly reasonable tweet about the show that goes on and on and keeps going past the limit forever';
    const result = truncateQuote(text, 60);
    assert.ok(result.length <= 60);
    assert.ok(result.endsWith('…'));
    // Should not cut mid-word — last char before ellipsis should not be a letter continuing a word
    assert.ok(!result.match(/[a-z]…$/i) || result.slice(-10).includes(' '));
  });

  test('handles non-string input safely', () => {
    assert.strictEqual(truncateQuote(null), '');
    assert.strictEqual(truncateQuote(undefined), '');
    assert.strictEqual(truncateQuote(42), '');
  });
});

// ---------- containsBlockedContent ----------

describe('containsBlockedContent', () => {
  test('blocks slur as whole word', () => {
    assert.strictEqual(containsBlockedContent('this show is a total fag'), true);
  });

  test('blocks uppercase slur', () => {
    assert.strictEqual(containsBlockedContent('THIS IS CUNT BEHAVIOR'), true);
  });

  test('does not block innocent substrings', () => {
    // "cunt" must be whole-word only — "scunthorpe" must not trigger
    assert.strictEqual(containsBlockedContent('visiting scunthorpe this weekend'), false);
  });

  test('clean text passes', () => {
    assert.strictEqual(
      containsBlockedContent('I loved maybe happy ending, beautiful show'),
      false,
    );
  });

  test('handles non-string input', () => {
    assert.strictEqual(containsBlockedContent(null), false);
    assert.strictEqual(containsBlockedContent(undefined), false);
  });
});

// ---------- filterTopQuotes ----------

describe('filterTopQuotes', () => {
  test('returns top 2 by engagement for target sentiment', () => {
    const mentions = [
      mention({ text: 'mid positive review one, not bad at all', engagement: 10 }),
      mention({ text: 'best show of the year, go see it now', engagement: 500 }),
      mention({ text: 'solid performance, recommend for fans', engagement: 100 }),
    ];
    const quotes = filterTopQuotes(mentions, 'positive');
    assert.strictEqual(quotes.length, 2);
    assert.ok(quotes[0].text.startsWith('best show of the year'));
    assert.ok(quotes[1].text.startsWith('solid performance'));
  });

  test('excludes irrelevant mentions', () => {
    const mentions = [
      mention({ text: 'clearly positive and relevant mention here', engagement: 100 }),
      mention({ text: 'this one is off topic garbage', engagement: 999, relevant: false }),
    ];
    const quotes = filterTopQuotes(mentions, 'positive');
    assert.strictEqual(quotes.length, 1);
    assert.ok(quotes[0].text.startsWith('clearly positive'));
  });

  test('excludes blocklisted content even with high engagement', () => {
    const mentions = [
      mention({ text: 'this show is a real piece of cunt trash', engagement: 9999 }),
      mention({ text: 'wonderful show, cannot recommend enough', engagement: 10 }),
    ];
    const quotes = filterTopQuotes(mentions, 'positive');
    assert.strictEqual(quotes.length, 1);
    assert.ok(quotes[0].text.startsWith('wonderful show'));
  });

  test('excludes quotes with <15 chars of meaningful content', () => {
    const mentions = [
      mention({ text: '🔥🔥🔥', engagement: 1000 }),
      mention({ text: 'omg', engagement: 500 }),
      mention({ text: 'this is a full meaningful quote', engagement: 10 }),
    ];
    const quotes = filterTopQuotes(mentions, 'positive');
    assert.strictEqual(quotes.length, 1);
    assert.strictEqual(quotes[0].text, 'this is a full meaningful quote');
  });

  test('excludes hashtag-only TikTok descriptions', () => {
    const mentions = [
      // Real pattern from Apify trial: pure hashtag spam, no sentence
      mention({
        text: '#maybehappyending #mhe #maybehappyendingbway #darrencriss #helenjshen #edit #capcut',
        platform: 'tiktok',
        engagement: 9999,
      }),
      mention({
        text: 'absolutely loved this show, incredible performances',
        engagement: 10,
      }),
    ];
    const quotes = filterTopQuotes(mentions, 'positive');
    assert.strictEqual(quotes.length, 1);
    assert.ok(quotes[0].text.startsWith('absolutely loved'));
  });

  test('hashtag-heavy but still substantive text IS kept', () => {
    // "Loading: MAYBE HAPPY ENDING Broadway Sneak Peek starring Darren Criss..."
    // followed by hashtags should still qualify because the lead text is real
    const mentions = [
      mention({
        text: 'Loading: MAYBE HAPPY ENDING Broadway Sneak Peek starring Darren Criss #maybehappyending #broadway',
        platform: 'tiktok',
        engagement: 500,
      }),
    ];
    const quotes = filterTopQuotes(mentions, 'positive');
    assert.strictEqual(quotes.length, 1);
    assert.ok(quotes[0].text.includes('Darren Criss'));
  });
});

describe('meaningfulContentLength', () => {
  test('strips hashtags', () => {
    assert.strictEqual(meaningfulContentLength('#foo #bar #baz'), 0);
  });

  test('strips mentions', () => {
    assert.strictEqual(meaningfulContentLength('@user1 @user2'), 0);
  });

  test('strips URLs', () => {
    assert.strictEqual(meaningfulContentLength('https://t.co/abc123'), 0);
  });

  test('keeps real content', () => {
    assert.strictEqual(meaningfulContentLength('loved this show'), 15);
  });

  test('preserves mixed content', () => {
    const len = meaningfulContentLength('loved this show #broadway #musical');
    assert.ok(len >= 14 && len <= 16);
  });

  test('filters to target sentiment only', () => {
    const mentions = [
      mention({ text: 'absolutely loved this one for sure', sentiment: 'positive', engagement: 100 }),
      mention({ text: 'complete disaster of a production', sentiment: 'negative', engagement: 500 }),
    ];
    const quotes = filterTopQuotes(mentions, 'negative');
    assert.strictEqual(quotes.length, 1);
    assert.ok(quotes[0].text.startsWith('complete disaster'));
  });

  test('returns empty array when no matches', () => {
    const mentions = [mention({ sentiment: 'mixed' })];
    assert.deepStrictEqual(filterTopQuotes(mentions, 'negative'), []);
  });
});

// ---------- deriveTier ----------

describe('deriveTier', () => {
  const baseline = { mean: 100, weeksOfHistory: 8 };

  test('returns Hidden for volume below minimum', () => {
    assert.strictEqual(
      deriveTier({ currentVolume: 5, baseline, positivePct: 100, weekOverWeekPct: 0 }),
      'Hidden',
    );
  });

  test('returns BuildingBaseline when history is insufficient', () => {
    assert.strictEqual(
      deriveTier({
        currentVolume: 50,
        baseline: { mean: 30, weeksOfHistory: 3 },
        positivePct: 80,
        weekOverWeekPct: 0,
      }),
      'BuildingBaseline',
    );
  });

  test('returns BuildingBaseline when baseline is null', () => {
    assert.strictEqual(
      deriveTier({ currentVolume: 50, baseline: null, positivePct: 80, weekOverWeekPct: 0 }),
      'BuildingBaseline',
    );
  });

  test('returns Buzzing with 2.5× baseline + 70%+ positive', () => {
    assert.strictEqual(
      deriveTier({ currentVolume: 250, baseline, positivePct: 75, weekOverWeekPct: 50 }),
      'Buzzing',
    );
  });

  test('returns Rising with 1.5× baseline + 25%+ WoW + 60%+ positive', () => {
    assert.strictEqual(
      deriveTier({ currentVolume: 150, baseline, positivePct: 65, weekOverWeekPct: 30 }),
      'Rising',
    );
  });

  test('returns Troubled with 2× baseline + <40% positive', () => {
    assert.strictEqual(
      deriveTier({ currentVolume: 200, baseline, positivePct: 30, weekOverWeekPct: 100 }),
      'Troubled',
    );
  });

  test('Troubled beats Buzzing even with high volume', () => {
    // Volume is 2.5× (would qualify for Buzzing) BUT sentiment is bad
    assert.strictEqual(
      deriveTier({ currentVolume: 250, baseline, positivePct: 25, weekOverWeekPct: 100 }),
      'Troubled',
    );
  });

  test('returns Steady in normal range', () => {
    assert.strictEqual(
      deriveTier({ currentVolume: 100, baseline, positivePct: 70, weekOverWeekPct: 0 }),
      'Steady',
    );
    assert.strictEqual(
      deriveTier({ currentVolume: 140, baseline, positivePct: 70, weekOverWeekPct: 0 }),
      'Steady',
    );
  });

  test('Rising requires WoW growth, not just baseline multiple', () => {
    // 1.5× baseline + 60% positive BUT no WoW growth → Steady, not Rising
    assert.strictEqual(
      deriveTier({ currentVolume: 150, baseline, positivePct: 65, weekOverWeekPct: 0 }),
      'Steady',
    );
  });

  test('tiny baselines return BuildingBaseline to avoid divide-by-small', () => {
    assert.strictEqual(
      deriveTier({
        currentVolume: 50,
        baseline: { mean: 2, weeksOfHistory: 8 },
        positivePct: 90,
        weekOverWeekPct: 0,
      }),
      'BuildingBaseline',
    );
  });
});

// ---------- updateBaseline ----------

describe('updateBaseline', () => {
  test('cold start from null baseline', () => {
    const next = updateBaseline(null, 100);
    assert.strictEqual(next.mean, 100);
    assert.strictEqual(next.weeksOfHistory, 1);
  });

  test('accumulates over weeks 1-8', () => {
    let b = null;
    for (let i = 0; i < BASELINE_REQUIRED_WEEKS; i++) {
      b = updateBaseline(b, 50);
    }
    assert.strictEqual(b.mean, 50);
    assert.strictEqual(b.weeksOfHistory, BASELINE_REQUIRED_WEEKS);
  });

  test('caps at 8 weeks of history', () => {
    let b = { mean: 50, weeksOfHistory: 8 };
    b = updateBaseline(b, 150);
    assert.strictEqual(b.weeksOfHistory, BASELINE_REQUIRED_WEEKS);
    // New mean with rolling window: (50*7 + 150) / 8 = 62.5
    assert.strictEqual(b.mean, 62.5);
  });

  test('spikes do not permanently distort baseline', () => {
    // 7 steady weeks of 50, then one spike of 500
    let b = null;
    for (let i = 0; i < 7; i++) b = updateBaseline(b, 50);
    assert.strictEqual(b.weeksOfHistory, 7);
    assert.strictEqual(b.mean, 50);

    // Spike: (50*7 + 500) / 8 = 106.25 — elevated but not equal to spike
    b = updateBaseline(b, 500);
    assert.strictEqual(b.mean, 106.25);
    assert.ok(b.mean < 500);
  });
});

// ---------- computeSocialPulse end-to-end ----------

describe('computeSocialPulse', () => {
  test('returns Hidden tier for tiny show', () => {
    const result = computeSocialPulse({
      mentions: positiveBatch(5),
      baseline: { mean: 10, weeksOfHistory: 8 },
      priorVolume: 4,
    });
    assert.strictEqual(result.tier, 'Hidden');
    assert.strictEqual(result.volume, 5);
  });

  test('returns BuildingBaseline on first run with no history', () => {
    const result = computeSocialPulse({
      mentions: positiveBatch(30),
      baseline: null,
      priorVolume: null,
    });
    assert.strictEqual(result.tier, 'BuildingBaseline');
    assert.strictEqual(result.volume, 30);
    assert.strictEqual(result.baselineMultiple, null);
    assert.strictEqual(result.nextBaseline.weeksOfHistory, 1);
    assert.strictEqual(result.nextBaseline.mean, 30);
  });

  test('returns Buzzing for 2.5× baseline with 80% positive', () => {
    // Build mentions: 80% positive, 20% mixed
    const positives = positiveBatch(80);
    const mixed = Array.from({ length: 20 }, (_, i) =>
      mention({
        sentiment: 'mixed',
        text: `mid reaction to the show number ${i} lukewarm at best`,
        engagement: 5,
        author: `@mixed${i}`,
      }),
    );
    const result = computeSocialPulse({
      mentions: [...positives, ...mixed],
      baseline: { mean: 40, weeksOfHistory: 8 },
      priorVolume: 40,
    });
    assert.strictEqual(result.tier, 'Buzzing');
    assert.strictEqual(result.volume, 100);
    assert.strictEqual(result.positivePct, 80);
    assert.ok(result.baselineMultiple >= 2.5);
    assert.strictEqual(result.topQuotes.length, 2);
  });

  test('quotes fall back to mixed when target sentiment has too few', () => {
    // Buzzing show but only 1 long positive quote — the filter should
    // supplement with a mixed quote so we always show 2 on the card
    const mentions = [
      mention({ text: 'absolutely stunning production cannot recommend enough', engagement: 100 }),
      // 3 short positives that get filtered out by min-length
      mention({ text: 'yes', engagement: 50 }),
      mention({ text: '🔥🔥', engagement: 50 }),
      // Fill with mixed
      mention({
        text: 'decent if you have nothing else to do this week',
        sentiment: 'mixed',
        engagement: 30,
      }),
      // Bulk mentions to hit Buzzing thresholds
      ...positiveBatch(99),
    ];
    const result = computeSocialPulse({
      mentions,
      baseline: { mean: 30, weeksOfHistory: 8 },
      priorVolume: 30,
    });
    assert.ok(result.topQuotes.length >= 1);
    // Card always shows up to 2 quotes
    assert.ok(result.topQuotes.length <= 2);
  });

  test('Troubled show shows negative quotes', () => {
    const negatives = Array.from({ length: 80 }, (_, i) =>
      mention({
        sentiment: 'negative',
        text: `walked out at intermission, just awful this show is a mess variant ${i}`,
        engagement: 50 + i,
        author: `@neg${i}`,
      }),
    );
    const positives = positiveBatch(20);
    const result = computeSocialPulse({
      mentions: [...negatives, ...positives],
      baseline: { mean: 40, weeksOfHistory: 8 },
      priorVolume: 40,
    });
    assert.strictEqual(result.tier, 'Troubled');
    assert.strictEqual(result.positivePct, 20);
    assert.strictEqual(result.topQuotes.length, 2);
    // Both quotes should be from the negative set
    for (const q of result.topQuotes) {
      assert.ok(q.text.includes('walked out') || q.text.includes('awful'));
    }
  });

  test('computes WoW percentage correctly', () => {
    const result = computeSocialPulse({
      mentions: positiveBatch(100),
      baseline: { mean: 50, weeksOfHistory: 8 },
      priorVolume: 50,
    });
    assert.strictEqual(result.weekOverWeekPct, 100);
  });

  test('WoW is null when no prior volume', () => {
    const result = computeSocialPulse({
      mentions: positiveBatch(30),
      baseline: { mean: 20, weeksOfHistory: 8 },
      priorVolume: null,
    });
    assert.strictEqual(result.weekOverWeekPct, null);
  });

  test('platform breakdown counts by platform', () => {
    const mentions = [
      ...positiveBatch(30).map((m) => ({ ...m, platform: 'x' })),
      ...positiveBatch(10).map((m, i) => ({
        ...m,
        platform: 'tiktok',
        author: `@tt${i}`,
        url: `https://tiktok.com/@tt${i}/video/${i}`,
      })),
    ];
    const result = computeSocialPulse({
      mentions,
      baseline: { mean: 30, weeksOfHistory: 8 },
      priorVolume: 30,
    });
    assert.strictEqual(result.platformBreakdown.x, 30);
    assert.strictEqual(result.platformBreakdown.tiktok, 10);
  });

  test('irrelevant mentions are excluded from volume and quotes', () => {
    const mentions = [
      ...positiveBatch(50),
      ...Array.from({ length: 20 }, (_, i) =>
        mention({ relevant: false, text: `random noise ${i}`, engagement: 999 }),
      ),
    ];
    const result = computeSocialPulse({
      mentions,
      baseline: { mean: 25, weeksOfHistory: 8 },
      priorVolume: 25,
    });
    assert.strictEqual(result.volume, 50);
    // Top quotes should never include an irrelevant mention
    for (const q of result.topQuotes) {
      assert.ok(!q.text.startsWith('random noise'));
    }
  });
});

// ---------- computePositivePct ----------

describe('computePositivePct', () => {
  test('only counts relevant mentions', () => {
    const mentions = [
      mention({ sentiment: 'positive', relevant: true }),
      mention({ sentiment: 'positive', relevant: true }),
      mention({ sentiment: 'negative', relevant: true }),
      mention({ sentiment: 'positive', relevant: false }),
      mention({ sentiment: 'positive', relevant: false }),
    ];
    assert.strictEqual(computePositivePct(mentions), 67);
  });

  test('returns 0 for empty input', () => {
    assert.strictEqual(computePositivePct([]), 0);
  });

  test('ignores mentions with missing sentiment', () => {
    const mentions = [
      mention({ sentiment: 'positive' }),
      mention({ sentiment: null }),
      mention({ sentiment: undefined }),
    ];
    assert.strictEqual(computePositivePct(mentions), 100);
  });
});

// ---------- Schema v3: Pulse Index (free uncapped counters) ----------

const {
  computeEffectiveVolume,
  computeWeeklyMentions,
  computeRelevanceRates,
  computeOpinionSample,
  SIGNAL_WEIGHTS,
} = require('../../scripts/lib/social-pulse-scorer');

describe('computeRelevanceRates', () => {
  test('per-platform rates from the classified sample', () => {
    const mentions = [
      { platform: 'reddit', relevant: true },
      { platform: 'reddit', relevant: true },
      { platform: 'reddit', relevant: false },
      { platform: 'bluesky', relevant: false },
      { platform: 'bluesky', relevant: true },
    ];
    const rates = computeRelevanceRates(mentions);
    assert.ok(Math.abs(rates.byPlatform.reddit - 2 / 3) < 1e-9);
    assert.strictEqual(rates.byPlatform.bluesky, 0.5);
    assert.strictEqual(rates.overall, 3 / 5);
  });

  test('unclassified mentions (relevant: null) are excluded', () => {
    const rates = computeRelevanceRates([{ platform: 'reddit', relevant: null }]);
    assert.strictEqual(rates.overall, null);
    assert.strictEqual(rates.byPlatform.reddit, undefined);
  });
});

describe('computeWeeklyMentions', () => {
  test('sums mention-type counters, excludes wikipedia views', () => {
    assert.strictEqual(
      computeWeeklyMentions({ reddit: 30, bluesky: 40, x: 200, wikipedia: 30000 }),
      270,
    );
  });

  test('null counters are skipped (dead X token)', () => {
    assert.strictEqual(computeWeeklyMentions({ reddit: 30, bluesky: 40, x: null }), 70);
  });

  test('no counters at all → null (legacy data path)', () => {
    assert.strictEqual(computeWeeklyMentions(null), null);
    assert.strictEqual(computeWeeklyMentions({ reddit: null, bluesky: null, x: null }), null);
  });
});

describe('computeEffectiveVolume', () => {
  const allRelevant = { byPlatform: {}, overall: 1 };

  test('weights renormalize when a signal is absent — dead X shifts level, not order', () => {
    const rates = allRelevant;
    const a = computeEffectiveVolume({ reddit: 40, bluesky: 20, x: 200, wikipedia: 5000 }, rates);
    const b = computeEffectiveVolume({ reddit: 10, bluesky: 5, x: 50, wikipedia: 1000 }, rates);
    const aNoX = computeEffectiveVolume({ reddit: 40, bluesky: 20, x: null, wikipedia: 5000 }, rates);
    const bNoX = computeEffectiveVolume({ reddit: 10, bluesky: 5, x: null, wikipedia: 1000 }, rates);
    assert.ok(a > b, 'bigger show ranks higher with X');
    assert.ok(aNoX > bNoX, 'bigger show still ranks higher without X');
  });

  test('relevance rate discounts contaminated counters (common-word titles)', () => {
    const clean = computeEffectiveVolume(
      { reddit: 50, bluesky: 100 },
      { byPlatform: { reddit: 1, bluesky: 1 }, overall: 1 },
    );
    const noisy = computeEffectiveVolume(
      { reddit: 50, bluesky: 100 },
      { byPlatform: { reddit: 0.2, bluesky: 0.1 }, overall: 0.15 },
    );
    assert.ok(noisy < clean * 0.5, `noisy (${noisy}) should be well under clean (${clean})`);
  });

  test('wikipedia views carry NO ranking weight (external-review consensus: contamination)', () => {
    // Collected in counters but excluded from SIGNAL_WEIGHTS — film
    // adaptations and shared articles across productions contaminate it.
    const wikiOnly = computeEffectiveVolume({ wikipedia: 100000 }, allRelevant);
    assert.strictEqual(wikiOnly, null, 'wiki-only show has no rankable signal');
    const withWiki = computeEffectiveVolume({ reddit: 60, bluesky: 40, x: 300, wikipedia: 100000 }, allRelevant);
    const withoutWiki = computeEffectiveVolume({ reddit: 60, bluesky: 40, x: 300 }, allRelevant);
    assert.strictEqual(withWiki, withoutWiki, 'wikipedia counter must not move the index');
  });

  test('no counters → null', () => {
    assert.strictEqual(computeEffectiveVolume(null, allRelevant), null);
    assert.strictEqual(computeEffectiveVolume({}, allRelevant), null);
  });

  test('weights sum to 1', () => {
    const sum = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

describe('computeSocialPulse with counters (schema v3)', () => {
  function sampleMention(overrides = {}) {
    return {
      text: 'This show is fantastic, loved every minute of it',
      platform: 'reddit',
      author: 'u/test',
      url: 'https://reddit.com/x',
      createdAt: '2026-07-10T00:00:00Z',
      engagement: 10,
      relevant: true,
      sentiment: 'positive',
      ...overrides,
    };
  }

  test('volume comes from counters, not sample size', () => {
    const mentions = Array.from({ length: 8 }, () => sampleMention());
    const result = computeSocialPulse({
      mentions,
      counters: { reddit: 45, bluesky: 30, x: 150, wikipedia: 9000 },
      baseline: null,
      priorVolume: null,
    });
    assert.strictEqual(result.volume, 225); // 45+30+150, NOT 8
    assert.ok(Number.isFinite(result.effectiveVolume) && result.effectiveVolume > 0);
    assert.strictEqual(result.opinionSample, 8);
  });

  test('legacy path without counters keeps sample-size volume', () => {
    const mentions = Array.from({ length: 25 }, () => sampleMention());
    const result = computeSocialPulse({ mentions, baseline: null, priorVolume: null });
    assert.strictEqual(result.volume, 25);
    assert.strictEqual(result.effectiveVolume, 25); // falls back to volume
  });

  test('bluesky sample posts count in platform breakdown', () => {
    const mentions = [sampleMention(), sampleMention({ platform: 'bluesky' })];
    const result = computeSocialPulse({ mentions, baseline: null, priorVolume: null });
    assert.strictEqual(result.platformBreakdown.bluesky, 1);
    assert.strictEqual(result.platformBreakdown.reddit, 1);
  });
});
