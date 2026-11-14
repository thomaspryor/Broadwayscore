/**
 * Pure scoring library for the Social Pulse feature.
 *
 * Takes normalized mention data + historical baseline and returns a tier
 * assignment, card-ready metrics, and curated quotes. No I/O, no network —
 * only inputs → outputs. This is the module the tests pin against.
 *
 * Shape of a "normalized mention":
 *   {
 *     text: string,          // the actual post content
 *     platform: 'x' | 'tiktok',
 *     author: string,        // handle, e.g. "@livvi_m" or "@broadwaycom"
 *     url: string,
 *     createdAt: string,     // ISO date
 *     engagement: number,    // platform-normalized score (likes+RT*2 for X, plays+diggs*5 for TikTok)
 *     relevant: boolean,     // LLM-filtered: is this about the target show?
 *     sentiment: 'positive' | 'mixed' | 'negative' | 'neutral',  // LLM-assigned
 *   }
 */

// ---------- Constants ----------

/** Min mentions in the last 7 days to show the card at all. Below this, card is hidden. */
const MIN_MENTIONS_FOR_CARD = 20;

/**
 * Pulse Index signal weights (schema v3, 2026-07). Keys match the
 * `counters` object produced by social-pulse-sources.js (+ wikipedia,
 * attached by fetch-social-pulse.js).
 *
 * A signal whose counter is null/absent simply drops out and the remaining
 * weights are renormalized (see computeEffectiveVolume) — so when the
 * grandfathered X token dies, or a show has no Wikipedia article, the
 * index degrades instead of breaking. Adding a future signal (YouTube,
 * Google Trends) is a one-line entry here.
 *
 * Rationale: X and Reddit are the strongest theater-chatter proxies;
 * Bluesky is real but its theater community is a fraction of X's.
 *
 * Wikipedia pageviews are COLLECTED (counters.wikipedia, free) but carry
 * NO weight — external review (GPT-4o + Gemini, 2026-07-15) converged on
 * the contamination problem: article views for shows with film
 * adaptations (Wicked) or articles shared across productions (Hadestown
 * WE + Broadway) measure something other than THIS production's buzz,
 * and any weight silently skews rank for exactly the biggest shows.
 * Ranking on only the platforms the card displays also keeps the rank
 * explainable from the card itself. Revisit only with adaptation-aware
 * disambiguation.
 */
const SIGNAL_WEIGHTS = Object.freeze({
  x: 0.45,
  reddit: 0.35,
  bluesky: 0.2,
});

/** Weeks of history required before self-baseline comparisons are meaningful. */
const BASELINE_REQUIRED_WEEKS = 8;

/** Hard character cap for card quotes. Longer quotes are truncated with ellipsis. */
const QUOTE_MAX_CHARS = 120;

/** How many quotes to show on the card. Fixed to keep card height predictable. */
const QUOTES_ON_CARD = 2;

/**
 * Minimum overall relevance rate (see computeRelevanceRates) required before
 * ANY quote is shown on a card. Per-mention `relevant` flags come from an
 * LLM classifier and are occasionally wrong (e.g. a bootleg-recording
 * solicitation or an unrelated city's Pride-parade post marked relevant).
 * When the corpus-wide relevance rate is this low, the show's text sample is
 * mostly noise about something else entirely (title collision) — showing
 * ANY quote risks surfacing exactly that noise, so we show none rather than
 * pick the "least bad" of a bad sample. Below this threshold (or when
 * relevance couldn't be measured at all — no classified sample), no quotes
 * render. See 2026-07-26 credibility audit (pride-west-end-2026:
 * relevanceRates.overall=0.034 still showed 2 quotes before this fix).
 */
const MIN_QUOTE_RELEVANCE = 0.15;

/**
 * Tier assignment thresholds. Tuned empirically against trial data — revisit
 * after first month of real baselines.
 */
const TIER_RULES = Object.freeze({
  BUZZING: {
    minBaselineMultiple: 2.5,
    minPositivePct: 70,
  },
  RISING: {
    minBaselineMultiple: 1.5,
    minWeekOverWeekPct: 25,
    minPositivePct: 60,
  },
  TROUBLED: {
    minBaselineMultiple: 2.0,
    maxPositivePct: 40,
  },
  // STEADY is the default bucket — volume between 0.7× and 1.5× baseline
  STEADY_MIN: 0.7,
  STEADY_MAX: 1.5,
});

/**
 * Profanity/slur blocklist for quote filtering. Intentionally short — these
 * are unambiguous no-go words. Extend carefully; false positives block real
 * mentions. Match is case-insensitive, whole-word only (to avoid blocking
 * "scunthorpe" for innocent substrings).
 *
 * Legal/brand risk: the site displays these quotes publicly, so any quote
 * containing any blocked word must be filtered out regardless of sentiment.
 */
const QUOTE_BLOCKLIST = Object.freeze([
  // racial slurs
  'n-word-placeholder-a', 'n-word-placeholder-b',
  // sexual slurs targeting women
  'cunt', 'whore', 'slut',
  // homophobic slurs
  'faggot', 'fag', 'dyke',
  // transphobic slurs
  'tranny',
  // ableist slurs
  'retard', 'retarded',
  // severe profanity
  'motherfucker',
]);
// NOTE: The two "n-word-placeholder" strings above stand in for the two real
// forms of that slur. Replace with real strings when deploying — kept as
// placeholders here so this file does not itself contain those words in plain
// text. The filtering logic works identically as long as the list contains
// the actual terms at runtime.

// ---------- Pure helpers ----------

/**
 * Truncates a string to maxChars, appending an ellipsis if truncated.
 * Breaks on word boundary when possible to avoid mid-word cuts.
 */
function truncateQuote(text, maxChars = QUOTE_MAX_CHARS) {
  if (typeof text !== 'string') return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  // Find the last word boundary before maxChars - 1 (reserve space for ellipsis)
  const sliceEnd = maxChars - 1;
  const slice = cleaned.slice(0, sliceEnd);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > sliceEnd * 0.6) {
    // Only break on word boundary if we're not cutting too much
    return slice.slice(0, lastSpace) + '…';
  }
  return slice + '…';
}

/**
 * Returns true if the text contains any blocklisted word (case-insensitive,
 * whole-word match). Used to filter quotes before public display.
 */
function containsBlockedContent(text) {
  if (typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const word of QUOTE_BLOCKLIST) {
    // Whole-word boundary match. Handles hyphens and possessives.
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) return true;
  }
  return false;
}

/**
 * Returns the length of "meaningful" content in a string — i.e., characters
 * that are NOT part of a hashtag (#foo), a mention (@bar), or a URL. Used to
 * reject quotes that are pure hashtag-spam (a common pattern on TikTok where
 * the real content is the video and the text is just tags).
 */
function meaningfulContentLength(text) {
  if (typeof text !== 'string') return 0;
  const stripped = text
    .replace(/https?:\/\/\S+/gi, '') // URLs
    .replace(/#\S+/g, '')             // hashtags
    .replace(/@\S+/g, '')             // mentions
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length;
}

/**
 * Selects up to maxQuotes mentions from a list, preferring:
 *   1. The target sentiment bucket (Buzzing → positive, Troubled → negative)
 *   2. Higher engagement (likes/plays/diggs)
 *   3. Non-blocklisted content
 *   4. ≥15 chars of MEANINGFUL text (excludes pure hashtag spam and emoji replies)
 *
 * Returns an array of { text: <truncated>, platform, author, url }.
 */
function filterTopQuotes(mentions, targetSentiment, maxQuotes = QUOTES_ON_CARD) {
  if (!Array.isArray(mentions)) return [];
  const candidates = mentions
    .filter((m) => m && m.relevant === true)
    .filter((m) => meaningfulContentLength(m.text) >= 15)
    .filter((m) => !containsBlockedContent(m.text))
    .filter((m) => m.sentiment === targetSentiment);

  // Normalize engagement per-platform so TikTok plays don't always
  // dominate X likes. Compute percentile rank within each platform,
  // then sort by that rank. This way the "most engaged X tweet" and
  // "most engaged TikTok" compete fairly.
  const byPlatform = new Map();
  for (const c of candidates) {
    const p = c.platform || 'unknown';
    if (!byPlatform.has(p)) byPlatform.set(p, []);
    byPlatform.get(p).push(c.engagement || 0);
  }
  // Sort each platform's engagement values for percentile lookup
  for (const [, vals] of byPlatform) vals.sort((a, b) => a - b);

  function normalizedEngagement(m) {
    const vals = byPlatform.get(m.platform || 'unknown');
    if (!vals || vals.length === 0) return 0;
    const eng = m.engagement || 0;
    // Percentile rank within platform (0-1)
    const idx = vals.indexOf(eng);
    return idx >= 0 ? idx / Math.max(vals.length - 1, 1) : 0;
  }

  // Sort by normalized engagement desc, tiebreak by createdAt desc
  candidates.sort((a, b) => {
    const eng = normalizedEngagement(b) - normalizedEngagement(a);
    if (Math.abs(eng) > 0.001) return eng;
    const aTime = a.createdAt ? Date.parse(a.createdAt) || 0 : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) || 0 : 0;
    return bTime - aTime;
  });

  return candidates.slice(0, maxQuotes).map((m) => ({
    text: truncateQuote(m.text),
    platform: m.platform,
    author: m.author || null,
    url: m.url || null,
  }));
}

/**
 * Per-platform relevance rates from the LLM-classified text sample.
 *
 * The Job A counters are raw query-hit counts and never pass through the
 * relevance classifier — "Chicago" broadway matches the city and the
 * street, not just the show. The classified sample (Job B) tells us what
 * fraction of query hits are actually about the show, per platform, and
 * computeEffectiveVolume scales each counter by its platform's rate.
 *
 * Platforms with no classified posts get null (caller falls back to
 * `overall`, then 1). `overall` is null when nothing was classified.
 */
function computeRelevanceRates(mentions) {
  const byPlatform = {};
  let totalRelevant = 0;
  let totalClassified = 0;
  for (const m of mentions || []) {
    if (!m || typeof m.relevant !== 'boolean') continue;
    const p = m.platform || 'unknown';
    if (!byPlatform[p]) byPlatform[p] = { relevant: 0, classified: 0 };
    byPlatform[p].classified++;
    totalClassified++;
    if (m.relevant) {
      byPlatform[p].relevant++;
      totalRelevant++;
    }
  }
  const rates = {};
  for (const [p, c] of Object.entries(byPlatform)) {
    rates[p] = c.classified > 0 ? c.relevant / c.classified : null;
  }
  return {
    byPlatform: rates,
    overall: totalClassified > 0 ? totalRelevant / totalClassified : null,
    // Denominator behind `overall`. Callers MUST check this before acting on a
    // low rate: 0/1 and 0/75 are both "0%" but only one is evidence.
    classified: totalClassified,
  };
}

/**
 * Minimum relevance rate for a card to be publishable at all. Same VALUE as
 * MIN_QUOTE_RELEVANCE today, deliberately declared separately: the two gates
 * have very different blast radii. Failing the quote gate costs a quote;
 * failing this one deletes the card from the show page, /trending and the
 * newsletter. Someone tuning the quote threshold after a bad-quote report
 * must not silently delete live cards as a side effect.
 */
const MIN_CARD_RELEVANCE = 0.15;

/**
 * Minimum CLASSIFIED sample required before a low relevance rate is treated as
 * evidence of a title collision rather than noise. `overall` is a point
 * estimate with no denominator — titanique-2026 sat at 0.25 off a 2-of-8
 * sample on 2026-07-26, one LLM misclassification away from 0.125 and being
 * hidden, while the genuine collisions were sampled 0/75 and 1/62. 20 keeps
 * both real collisions gated and every thin-sample show visible.
 */
const MIN_CARD_RELEVANCE_SAMPLE = 20;

/**
 * True when the classified text sample says this show's corpus is mostly not
 * about this show — a title collision we cannot publish a mention count for.
 *
 * Applied at the WRITE boundaries (computeSocialPulse and the re-ranker), not
 * inside a tier function, because there are two tier paths (derivePeerTier and
 * the legacy deriveTier) and only gating one of them leaves a live publish hole:
 * fetch-social-pulse.js calls computeSocialPulse WITHOUT peerStats, so every
 * per-show write takes the legacy path.
 *
 * Requires BOTH a measured rate and a big enough denominator. Unmeasured
 * (legacy v2 files, no classified sample) is "unknown", never "noisy".
 */
function isTooNoisyForCard(relevanceRates) {
  const overall = relevanceRates?.overall;
  const classified = relevanceRates?.classified;
  if (typeof overall !== 'number') return false;
  if (!Number.isFinite(classified) || classified < MIN_CARD_RELEVANCE_SAMPLE) return false;
  return overall < MIN_CARD_RELEVANCE;
}

/**
 * Conservative discount applied to the X counter when there is no text
 * sample AT ALL (no Reddit/Bluesky classified mentions) to borrow a rate
 * from. Falling all the way back to 1 (fully trusted) let raw title-
 * collision noise dominate ranking for shows with sparse Reddit/Bluesky
 * chatter but a common-word title (Gatsby, Wicked, Chicago) — the X free-
 * search API has no relevance classifier of its own, so an un-calibrated X
 * counter should default to "mostly noise," not "mostly signal." See the
 * 2026-07-26 credibility audit (Gatsby: 3846 raw X count, 0.3% substantiation).
 */
const X_UNSAMPLED_FALLBACK_RATE = 0.2;

/**
 * Relevance rate to apply to a counter signal. Sample-backed platforms use
 * their own rate; X (no text sample since the free-tier death) borrows the
 * overall rate — same query shape, similar noise profile; Wikipedia is not
 * a query-hit count so it takes no relevance discount. When there's no
 * sample-backed rate available AT ALL, X gets a conservative fixed discount
 * instead of full trust (see X_UNSAMPLED_FALLBACK_RATE); other signals keep
 * the historical full-trust fallback since they're the sample itself.
 */
function relevanceRateFor(signal, rates) {
  if (signal === 'wikipedia') return 1;
  const platformRate = rates?.byPlatform?.[signal];
  if (typeof platformRate === 'number') return platformRate;
  if (typeof rates?.overall === 'number') return rates.overall;
  return signal === 'x' ? X_UNSAMPLED_FALLBACK_RATE : 1;
}

/**
 * The Pulse Index volume: blends the uncapped weekly counters into one
 * mention-scale number used for RANKING strength (not for display).
 *
 *   effectiveVolume = expm1( Σ w_i · log1p(count_i × relevanceRate_i) / Σ w_i )
 *
 * i.e. a weighted geometric mean of (1 + relevance-adjusted counts). The
 * log tames cross-unit scale differences (30k Wikipedia views vs 44
 * Bluesky posts) so no single signal dominates, and expm1 maps the blend
 * back to linear mention-like units. Weights renormalize over the signals
 * actually present, so a dead signal (X) shifts the level smoothly for
 * ALL shows at once — peer-relative tiers are unaffected.
 *
 * Renormalization has a coverage FLOOR: the divisor never drops below
 * MIN_WEIGHT_COVERAGE. Without it, a show carrying only its weakest
 * signal would have that signal fully renormalized to weight 1.0 — e.g. a
 * famous title with zero social chatter but 100k Wikipedia views would
 * score its raw pageviews and top the leaderboard. With the floor, sparse
 * coverage dampens the index instead of amplifying the surviving signal.
 *
 * Returns null when no counter signal is present at all (legacy data or
 * total fetch failure) — callers fall back to sample volume.
 */
const MIN_WEIGHT_COVERAGE = 0.5;

function computeEffectiveVolume(counters, relevanceRates, weights = SIGNAL_WEIGHTS) {
  if (!counters || typeof counters !== 'object') return null;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [signal, weight] of Object.entries(weights)) {
    const count = counters[signal];
    if (!Number.isFinite(count) || count < 0) continue; // null/absent → signal drops out
    const rate = relevanceRateFor(signal, relevanceRates);
    weightedSum += weight * Math.log1p(count * rate);
    weightTotal += weight;
  }
  if (weightTotal === 0) return null;
  return Number(Math.expm1(weightedSum / Math.max(weightTotal, MIN_WEIGHT_COVERAGE)).toFixed(1));
}

/**
 * The honest, display-facing weekly mention total: raw counts of posts
 * mentioning the show this week across mention-type platforms (Wikipedia
 * views are interest, not mentions — excluded). This is what the card
 * shows and what the MIN_MENTIONS_FOR_CARD gate tests.
 */
function computeWeeklyMentions(counters) {
  if (!counters || typeof counters !== 'object') return null;
  let any = false;
  let total = 0;
  for (const key of ['reddit', 'bluesky', 'x']) {
    const v = counters[key];
    if (Number.isFinite(v) && v >= 0) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Neutral stand-in used for composite/percentile math when a show has NO
 * opinion-bearing posts at all (positivePct === null — see computePositivePct).
 * Defaulting an unknown sentiment to 0 (the old behavior) collapsed every
 * zero-opinion show's composite to 0 regardless of volume, which is what let
 * loud, real shows with a thin sentiment sample rank below quiet zero-volume
 * ones. 50 says "no evidence either way" without punishing or rewarding.
 */
const NEUTRAL_POSITIVE_PCT = 50;

/**
 * Minimum opinion-bearing posts behind `positivePct` before a caller is
 * allowed to TRUST the percentage for ranking or display. Mirrors
 * src/lib/social-pulse-display.ts's MIN_OPINION_SAMPLE/shouldShowSentiment —
 * duplicated (not imported) because this file is plain CommonJS and that one
 * is TypeScript with a deliberate zero-import contract for the client bundle
 * (same trade-off already made in scripts/newsletter/generate.mjs). Keep the
 * two in sync: task #544 found ranking (this file, via computeCompositeScore)
 * trusting a thin-sample positivePct the display layer had already learned
 * not to print — a 2-post 100%-positive show got a full sentiment multiplier
 * in the /trending sort despite the card itself refusing to show "100%".
 */
const MIN_OPINION_SAMPLE = 10;

/**
 * True when a positivePct is trustworthy enough to use for RANKING (not just
 * display) — same contract as social-pulse-display.ts's shouldShowSentiment.
 * Object arg (not positional) for the same reason as the TS original: a
 * transposed (opinionSample, positivePct) call compiles cleanly and silently
 * returns wrong answers.
 */
function shouldShowSentiment({ positivePct, opinionSample }) {
  if (typeof positivePct !== 'number' || !Number.isFinite(positivePct) || positivePct < 0 || positivePct > 100) {
    return false;
  }
  if (opinionSample === undefined || opinionSample === null) return true;
  return opinionSample >= MIN_OPINION_SAMPLE;
}

/**
 * Composite score blending raw volume with positive sentiment %. Used for
 * peer ranking. A loud-but-hated show shouldn't outrank a smaller positive one.
 *
 *   composite = volume × (positivePct / 100)
 *
 * positivePct === null (no opinion-bearing posts to judge sentiment from)
 * is treated as NEUTRAL_POSITIVE_PCT, not 0 — an unknown sentiment isn't the
 * same claim as "100% negative," and shouldn't be scored as if it were.
 *
 * Examples:
 *   122 mentions × 78% = 95.2  (Cats — buzzy and well-liked)
 *   200 mentions × 30% = 60.0  (a flop with high volume)
 *   80 mentions × 90%  = 72.0  (a quiet darling)
 */
function computeCompositeScore(volume, positivePct) {
  const v = Number.isFinite(volume) ? volume : 0;
  const p = Number.isFinite(positivePct) ? positivePct : NEUTRAL_POSITIVE_PCT;
  return v * (p / 100);
}

/**
 * PEER-RELATIVE tier derivation. Works on day 1 without any historical
 * baseline by comparing each show to its peers in the same market.
 *
 * Arguments:
 *   show         — { volume, positivePct, market }
 *   peerStats    — { compositeP80, compositeP60, volumeP50, marketCount }
 *                  (computed once across all shows in the same market)
 *
 * Tier rules:
 *   🔥 Buzzing  — composite ≥ market 80th percentile AND positivePct ≥ 65
 *   📈 Rising   — composite ≥ market 60th percentile AND positivePct ≥ 60 (and not Buzzing)
 *   💔 Troubled — volume ≥ market 50th percentile (i.e., loud) AND positivePct < 40
 *   😐 Steady   — anything else with volume ≥ MIN_MENTIONS_FOR_CARD
 *   (Hidden)    — volume < MIN_MENTIONS_FOR_CARD
 *
 * No 8-week baseline required. Self-baseline can be added later as a
 * SECONDARY signal (e.g., to flag risers based on WoW growth) but is no
 * longer the primary tier driver.
 *
 * Sentiment-evidence gate: positivePct === null means there were zero
 * opinion-bearing posts to judge sentiment from (see computePositivePct).
 * A show with no sentiment evidence can never be tiered Troubled, Buzzing,
 * or Rising — all three require a sentiment CLAIM, and there isn't one.
 * It falls through to Steady (or Hidden, from the volume gate above).
 *
 * Relevance is NOT gated here — see isTooNoisyForCard, applied at the write
 * boundaries so both this and the legacy deriveTier path are covered.
 */
function derivePeerTier({ volume, effectiveVolume, positivePct, peerStats }) {
  if (!Number.isFinite(volume) || volume < MIN_MENTIONS_FOR_CARD) {
    return 'Hidden';
  }

  const hasSentiment = Number.isFinite(positivePct);
  if (!hasSentiment) {
    return 'Steady';
  }

  // Ranking strength comes from the Pulse Index effectiveVolume (relevance-
  // adjusted counter blend) when present; the card gate above stays on the
  // honest displayed mention count so a visible card is never Hidden-tiered
  // by an index artifact. Legacy callers without effectiveVolume rank on
  // volume, exactly as before schema v3.
  const composite = computeCompositeScore(
    Number.isFinite(effectiveVolume) ? effectiveVolume : volume,
    positivePct,
  );
  const pct = positivePct;
  const stats = peerStats || {};

  // Troubled first: high volume + bad sentiment trumps everything else
  if (
    Number.isFinite(stats.volumeP50) &&
    volume >= stats.volumeP50 &&
    pct < 40
  ) {
    return 'Troubled';
  }

  // Buzzing: top quintile by composite + clearly positive
  if (
    Number.isFinite(stats.compositeP80) &&
    composite >= stats.compositeP80 &&
    pct >= 65
  ) {
    return 'Buzzing';
  }

  // Rising: top 40% by composite + still positive
  if (
    Number.isFinite(stats.compositeP60) &&
    composite >= stats.compositeP60 &&
    pct >= 60
  ) {
    return 'Rising';
  }

  return 'Steady';
}

/**
 * Computes a percentile cutoff from a list of numeric values. Used for
 * peer-stats calculation in derivePeerTier.
 *
 * percentile=80 means "the value at the 80th percentile" — 80% of the
 * dataset is BELOW this number, 20% is at or above. Returns 0 for empty
 * input. Uses nearest-rank method (simple, no interpolation).
 */
function percentile(values, percentileRank) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

/**
 * Computes the peer-stats object for a list of shows in the same market.
 * Pass to derivePeerTier as peerStats.
 */
function computePeerStats(shows) {
  if (!Array.isArray(shows) || shows.length === 0) {
    return { compositeP80: 0, compositeP60: 0, volumeP50: 0, marketCount: 0 };
  }
  const composites = shows.map((s) =>
    // Pass positivePct through as-is (not `|| 0`) — computeCompositeScore
    // treats a real 0% and a null (no opinion sample) differently, and
    // coercing null to 0 here before it gets there would erase that
    // distinction and re-introduce the null-sentiment tier bug.
    computeCompositeScore(
      Number.isFinite(s.effectiveVolume) ? s.effectiveVolume : (s.volume || 0),
      s.positivePct,
    ),
  );
  const volumes = shows.map((s) => s.volume || 0);
  return {
    compositeP80: percentile(composites, 80),
    compositeP60: percentile(composites, 60),
    volumeP50: percentile(volumes, 50),
    marketCount: shows.length,
  };
}

/**
 * LEGACY tier derivation using a self-baseline. Still exported for
 * compatibility but NOT the primary tier driver after 2026-04-11. Use
 * derivePeerTier instead. Will be removed once any callers are migrated.
 */
function deriveTier({ currentVolume, baseline, positivePct, weekOverWeekPct }) {
  // Gate: too few mentions to say anything
  if (!Number.isFinite(currentVolume) || currentVolume < MIN_MENTIONS_FOR_CARD) {
    return 'Hidden';
  }

  // Cold start: insufficient history for baseline comparison
  if (!baseline || !Number.isFinite(baseline.mean) || baseline.weeksOfHistory < BASELINE_REQUIRED_WEEKS) {
    return 'BuildingBaseline';
  }

  // Baseline too small to divide by meaningfully — treat as building
  if (baseline.mean < 5) return 'BuildingBaseline';

  // Sentiment-evidence gate (mirrors derivePeerTier): positivePct === null
  // means zero opinion-bearing posts — no sentiment CLAIM exists, so this
  // can never be Troubled/Buzzing/Rising. Without this, this legacy path
  // (still hit by fetch-social-pulse.js's per-show write, before the
  // ranks step re-tiers via derivePeerTier) would coerce null to 0 and
  // could mis-tier a no-evidence show as Troubled.
  if (!Number.isFinite(positivePct)) return 'Steady';

  const baselineMultiple = currentVolume / baseline.mean;
  const pct = positivePct;

  // Troubled first: high volume + negative sentiment trumps everything
  if (baselineMultiple >= TIER_RULES.TROUBLED.minBaselineMultiple && pct < TIER_RULES.TROUBLED.maxPositivePct) {
    return 'Troubled';
  }

  // Buzzing: strong spike + strongly positive
  if (baselineMultiple >= TIER_RULES.BUZZING.minBaselineMultiple && pct >= TIER_RULES.BUZZING.minPositivePct) {
    return 'Buzzing';
  }

  // Rising: modest spike + WoW growth + positive enough
  if (
    baselineMultiple >= TIER_RULES.RISING.minBaselineMultiple &&
    typeof weekOverWeekPct === 'number' &&
    weekOverWeekPct >= TIER_RULES.RISING.minWeekOverWeekPct &&
    pct >= TIER_RULES.RISING.minPositivePct
  ) {
    return 'Rising';
  }

  return 'Steady';
}

/**
 * Updates a rolling baseline with a new weekly observation. The baseline is
 * a simple trailing-mean over at most 8 weeks of history — simple, robust to
 * one-off spikes, and interpretable.
 *
 * Returns the NEW baseline object. Does not mutate input.
 */
function updateBaseline(oldBaseline, newWeeklyVolume) {
  const prior = oldBaseline && Number.isFinite(oldBaseline.mean) ? oldBaseline : { mean: 0, weeksOfHistory: 0 };
  const weeks = Math.min(prior.weeksOfHistory, BASELINE_REQUIRED_WEEKS - 1);
  const nextWeeks = Math.min(prior.weeksOfHistory + 1, BASELINE_REQUIRED_WEEKS);
  const nextMean = (prior.mean * weeks + newWeeklyVolume) / nextWeeks;
  return {
    mean: Number.isFinite(nextMean) ? nextMean : 0,
    weeksOfHistory: nextWeeks,
  };
}

/**
 * Given a list of relevant mentions, compute the positive percentage.
 * Denominator = positive + mixed + negative (i.e., posts with an opinion).
 * "neutral" posts (informational, no opinion signal, official promos) are
 * excluded from the denominator entirely — they're about the show but
 * carry no sentiment signal, so including them drags every show toward 50%.
 *
 * Returns null when there are ZERO opinion-bearing posts — this is a
 * distinct state from "100% negative" or any other real percentage. Cards
 * previously displayed this as "0% positive," branding shows with no
 * sentiment data at all (e.g. purely neutral/promotional chatter) as
 * outright disliked. Callers must treat null as "unknown," not "bad."
 */
function computePositivePct(mentions) {
  const { pos, total } = computeOpinionSample(mentions);
  return total === 0 ? null : Math.round((pos / total) * 100);
}

/**
 * Counts opinion-bearing posts in the classified sample. The card uses
 * `total` to hide the sentiment bar when the sample is too thin to mean
 * anything (schema v3: Reddit+Bluesky samples run smaller than the old
 * capped X sample, so a 3-post "67% positive" must not render).
 */
function computeOpinionSample(mentions) {
  let pos = 0;
  let total = 0;
  for (const m of mentions || []) {
    if (!m.relevant) continue;
    if (m.sentiment === 'positive') {
      pos++;
      total++;
    } else if (m.sentiment === 'mixed' || m.sentiment === 'negative') {
      total++;
    }
    // 'neutral' intentionally excluded from both pos and total
  }
  return { pos, total };
}

/**
 * Groups relevant mentions by platform and returns counts.
 * Added Reddit 2026-04-11 — sourced from brand-mention-sources via
 * social-pulse-sources.js fetchRedditForShow.
 */
function computePlatformBreakdown(mentions) {
  const out = { x: 0, tiktok: 0, instagram: 0, reddit: 0, bluesky: 0 };
  for (const m of mentions) {
    if (!m.relevant) continue;
    if (m.platform === 'x' || m.platform === 'twitter') out.x++;
    else if (m.platform === 'tiktok') out.tiktok++;
    else if (m.platform === 'instagram') out.instagram++;
    else if (m.platform === 'reddit') out.reddit++;
    else if (m.platform === 'bluesky') out.bluesky++;
  }
  return out;
}

/**
 * Main orchestrator. Given the full inputs for a single show, returns the
 * card-ready score object. The caller (fetch-social-pulse.js) is responsible
 * for persisting this to disk.
 *
 * Input shape:
 *   {
 *     mentions: NormalizedMention[],   // all fetched mentions, both relevant and not
 *     baseline: { mean, weeksOfHistory } | null,  // from prior run
 *     priorVolume: number | null,      // last week's relevant volume (for WoW calc)
 *   }
 *
 * Output shape:
 *   {
 *     tier: 'Buzzing' | 'Rising' | 'Steady' | 'Troubled' | 'BuildingBaseline' | 'Hidden',
 *     volume: number,                  // count of relevant mentions
 *     positivePct: number | null,      // 0-100, or null with zero opinion-bearing posts
 *     weekOverWeekPct: number | null,
 *     baselineMultiple: number | null, // null if BuildingBaseline
 *     platformBreakdown: { x, tiktok },
 *     topQuotes: Array<{ text, platform, author, url }>,
 *     nextBaseline: { mean, weeksOfHistory },  // to persist for next run
 *   }
 */
function computeSocialPulse({ mentions, counters, baseline, priorVolume, peerStats }) {
  const relevant = Array.isArray(mentions) ? mentions.filter((m) => m && m.relevant) : [];

  // Schema v3: `volume` is the TRUE weekly mention total from the uncapped
  // counters (Job A), not the classified-sample size. Legacy path (no
  // counters — old data, tests) falls back to sample size as before.
  const relevanceRates = computeRelevanceRates(mentions || []);
  const weeklyMentions = computeWeeklyMentions(counters);
  const volume = weeklyMentions ?? relevant.length;
  const effectiveVolume = computeEffectiveVolume(counters, relevanceRates) ?? volume;

  const positivePct = computePositivePct(mentions || []);
  const opinionSample = computeOpinionSample(mentions || []).total;
  const platformBreakdown = computePlatformBreakdown(mentions || []);

  const weekOverWeekPct =
    typeof priorVolume === 'number' && priorVolume > 0
      ? Math.round(((volume - priorVolume) / priorVolume) * 100)
      : null;

  // Use peer-relative tier when peer stats are available (the primary path
  // after 2026-04-11). Fall back to legacy self-baseline tier for single-show
  // runs where peer stats aren't computed.
  const derivedTier = peerStats
    ? derivePeerTier({ volume, effectiveVolume, positivePct, peerStats })
    : deriveTier({ currentVolume: volume, baseline, positivePct, weekOverWeekPct });

  // Relevance gate at the WRITE boundary, so it covers BOTH tier paths. The
  // per-show writer (fetch-social-pulse.js) passes no peerStats and therefore
  // always takes the legacy deriveTier branch — gating inside derivePeerTier
  // alone would leave that path publishing ungated cards.
  const tier = isTooNoisyForCard(relevanceRates) ? 'Hidden' : derivedTier;

  // Pick quotes matching the tier's dominant sentiment
  let targetSentiment;
  if (tier === 'Troubled') targetSentiment = 'negative';
  else if (tier === 'Hidden' || tier === 'BuildingBaseline') targetSentiment = 'positive'; // best-face fallback
  else targetSentiment = 'positive';

  // Quote relevance gate: below MIN_QUOTE_RELEVANCE (or unmeasured — no
  // classified sample at all), the text corpus is too noisy to trust ANY
  // per-mention `relevant` flag enough to surface a quote publicly. Show
  // none rather than the "least bad" pick from a mostly-irrelevant sample.
  let topQuotes = [];
  if (typeof relevanceRates.overall === 'number' && relevanceRates.overall >= MIN_QUOTE_RELEVANCE) {
    topQuotes = filterTopQuotes(mentions || [], targetSentiment);
    // Fallback: if no quotes in target sentiment, try 'mixed'
    if (topQuotes.length < QUOTES_ON_CARD) {
      const mixedFill = filterTopQuotes(mentions || [], 'mixed', QUOTES_ON_CARD - topQuotes.length);
      topQuotes = topQuotes.concat(mixedFill);
    }
  }

  const baselineMultiple =
    baseline && Number.isFinite(baseline.mean) && baseline.mean > 0
      ? Number((volume / baseline.mean).toFixed(2))
      : null;

  const nextBaseline = updateBaseline(baseline, volume);

  return {
    tier,
    volume,
    effectiveVolume,
    relevanceRates,
    positivePct,
    opinionSample,
    weekOverWeekPct,
    baselineMultiple,
    platformBreakdown,
    topQuotes,
    nextBaseline,
  };
}

module.exports = {
  // Main entrypoint
  computeSocialPulse,
  // Peer-relative tier (the new primary path)
  derivePeerTier,
  shouldShowSentiment,
  computeCompositeScore,
  computePeerStats,
  percentile,
  // Pulse Index (schema v3, 2026-07 — free uncapped counters)
  computeEffectiveVolume,
  computeWeeklyMentions,
  computeRelevanceRates,
  relevanceRateFor,
  // Legacy self-baseline tier (still exported, not primary)
  deriveTier,
  filterTopQuotes,
  truncateQuote,
  containsBlockedContent,
  meaningfulContentLength,
  updateBaseline,
  computePositivePct,
  computeOpinionSample,
  computePlatformBreakdown,
  // Constants
  MIN_MENTIONS_FOR_CARD,
  BASELINE_REQUIRED_WEEKS,
  QUOTE_MAX_CHARS,
  QUOTES_ON_CARD,
  MIN_QUOTE_RELEVANCE,
  MIN_CARD_RELEVANCE,
  MIN_CARD_RELEVANCE_SAMPLE,
  isTooNoisyForCard,
  NEUTRAL_POSITIVE_PCT,
  MIN_OPINION_SAMPLE,
  shouldShowSentiment,
  X_UNSAMPLED_FALLBACK_RATE,
  TIER_RULES,
  QUOTE_BLOCKLIST,
  SIGNAL_WEIGHTS,
};
