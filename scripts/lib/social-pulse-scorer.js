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
 *     sentiment: 'positive' | 'mixed' | 'negative',  // LLM-assigned
 *   }
 */

// ---------- Constants ----------

/** Min mentions in the last 7 days to show the card at all. Below this, card is hidden. */
const MIN_MENTIONS_FOR_CARD = 20;

/** Weeks of history required before self-baseline comparisons are meaningful. */
const BASELINE_REQUIRED_WEEKS = 8;

/** Hard character cap for card quotes. Longer quotes are truncated with ellipsis. */
const QUOTE_MAX_CHARS = 120;

/** How many quotes to show on the card. Fixed to keep card height predictable. */
const QUOTES_ON_CARD = 2;

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
    .filter((m) => m && m.relevant)
    .filter((m) => meaningfulContentLength(m.text) >= 15)
    .filter((m) => !containsBlockedContent(m.text))
    .filter((m) => m.sentiment === targetSentiment);

  // Sort by engagement desc, stable tiebreak by createdAt desc
  candidates.sort((a, b) => {
    const eng = (b.engagement || 0) - (a.engagement || 0);
    if (eng !== 0) return eng;
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
 * Derives the show's social-pulse tier from volume + sentiment + baseline.
 *
 * Arguments:
 *   currentVolume  — total relevant mentions in the last 7 days
 *   baseline       — { mean: number, weeksOfHistory: number } from prior runs (null OK)
 *   positivePct    — % of relevant mentions classified as 'positive' (0-100)
 *   weekOverWeekPct — % change from previous week's volume (null if no prior data)
 *
 * Returns one of: 'Buzzing' | 'Rising' | 'Steady' | 'Troubled' | 'BuildingBaseline'
 *
 * BuildingBaseline is a system state (not a user tier) that renders as a
 * muted card with raw volume only — no comparison claims until the show has
 * at least 8 weeks of data collected.
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

  const baselineMultiple = currentVolume / baseline.mean;
  const pct = typeof positivePct === 'number' ? positivePct : 0;

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
 * Given a list of relevant mentions, compute the positive percentage
 * (relative to positive+mixed+negative, ignoring items with missing sentiment).
 */
function computePositivePct(mentions) {
  let pos = 0;
  let total = 0;
  for (const m of mentions) {
    if (!m.relevant) continue;
    if (m.sentiment === 'positive') {
      pos++;
      total++;
    } else if (m.sentiment === 'mixed' || m.sentiment === 'negative') {
      total++;
    }
  }
  return total === 0 ? 0 : Math.round((pos / total) * 100);
}

/**
 * Groups relevant mentions by platform and returns counts.
 */
function computePlatformBreakdown(mentions) {
  const out = { x: 0, tiktok: 0, instagram: 0 };
  for (const m of mentions) {
    if (!m.relevant) continue;
    if (m.platform === 'x' || m.platform === 'twitter') out.x++;
    else if (m.platform === 'tiktok') out.tiktok++;
    else if (m.platform === 'instagram') out.instagram++;
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
 *     positivePct: number,             // 0-100
 *     weekOverWeekPct: number | null,
 *     baselineMultiple: number | null, // null if BuildingBaseline
 *     platformBreakdown: { x, tiktok },
 *     topQuotes: Array<{ text, platform, author, url }>,
 *     nextBaseline: { mean, weeksOfHistory },  // to persist for next run
 *   }
 */
function computeSocialPulse({ mentions, baseline, priorVolume }) {
  const relevant = Array.isArray(mentions) ? mentions.filter((m) => m && m.relevant) : [];
  const volume = relevant.length;

  const positivePct = computePositivePct(mentions || []);
  const platformBreakdown = computePlatformBreakdown(mentions || []);

  const weekOverWeekPct =
    typeof priorVolume === 'number' && priorVolume > 0
      ? Math.round(((volume - priorVolume) / priorVolume) * 100)
      : null;

  const tier = deriveTier({ currentVolume: volume, baseline, positivePct, weekOverWeekPct });

  // Pick quotes matching the tier's dominant sentiment
  let targetSentiment;
  if (tier === 'Troubled') targetSentiment = 'negative';
  else if (tier === 'Hidden' || tier === 'BuildingBaseline') targetSentiment = 'positive'; // best-face fallback
  else targetSentiment = 'positive';

  let topQuotes = filterTopQuotes(mentions || [], targetSentiment);
  // Fallback: if no quotes in target sentiment, try 'mixed'
  if (topQuotes.length < QUOTES_ON_CARD) {
    const mixedFill = filterTopQuotes(mentions || [], 'mixed', QUOTES_ON_CARD - topQuotes.length);
    topQuotes = topQuotes.concat(mixedFill);
  }

  const baselineMultiple =
    baseline && Number.isFinite(baseline.mean) && baseline.mean > 0
      ? Number((volume / baseline.mean).toFixed(2))
      : null;

  const nextBaseline = updateBaseline(baseline, volume);

  return {
    tier,
    volume,
    positivePct,
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
  // Exposed for unit tests and tier validation
  deriveTier,
  filterTopQuotes,
  truncateQuote,
  containsBlockedContent,
  meaningfulContentLength,
  updateBaseline,
  computePositivePct,
  computePlatformBreakdown,
  // Constants
  MIN_MENTIONS_FOR_CARD,
  BASELINE_REQUIRED_WEEKS,
  QUOTE_MAX_CHARS,
  QUOTES_ON_CARD,
  TIER_RULES,
  QUOTE_BLOCKLIST,
};
