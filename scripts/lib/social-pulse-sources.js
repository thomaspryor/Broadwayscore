/**
 * Free per-platform sources for the Social Pulse feature.
 *
 * Replaced the Apify actor stack 2026-07 (see sprint-plan-social-pulse-
 * input-redesign.md + PR #431). The old design bought capped samples
 * (X ≤150, TikTok ≤20, IG ≤15) for ~$100/mo and the caps made the volume
 * metric meaningless — TikTok sat at exactly its 20-cap for 118/119 shows.
 *
 * The redesign splits the two jobs the caps conflated:
 *
 *   Job A — VOLUME: uncapped weekly COUNTERS, all free.
 *     reddit    — post count from the Reddit JSON search (API caps at 100/
 *                 query; note the cap, it rarely binds for theater volumes)
 *     bluesky   — searchPosts hitsTotal with a 7-day since/until window
 *                 (windowing is load-bearing: unwindowed hitsTotal is an
 *                 ALL-TIME count and measures show age, not buzz)
 *     x         — tweets/counts/recent via the grandfathered free X API
 *                 token (nullable — X killed the free tier Feb 2026, this
 *                 dies whenever they finish the pay-per-use migration)
 *     wikipedia — weekly article pageviews (fetched by the caller via
 *                 scripts/lib/wikipedia-pageviews.js; not in this module
 *                 because it needs the show→article map, not a query)
 *
 *   Job B — SENTIMENT + QUOTES: a text sample. Reddit + Bluesky posts,
 *     classified downstream by social-pulse-llm.js. A ~50-150 post sample
 *     is statistically plenty; it does NOT need to be uncapped.
 *
 * Every fetcher returns platform-normalized "mention" objects (the same
 * shape the Apify fetchers produced) so the LLM classifier and scorer are
 * unchanged.
 */

const { fetchRedditMentions, searchBlueskyPosts } = require('./brand-mention-sources');

// ---------- Reddit ----------
//
// Reddit uses the FREE reddit JSON search API (routed through ScrapingBee
// fallback for 403 resilience — GitHub datacenter IPs are blocked by
// reddit.com) via the existing brand-mention-sources.js fetcher.

/**
 * Normalizes a Reddit post from fetchRedditMentions() into our common
 * mention shape.
 *
 * Engagement = score (upvotes - downvotes) + numComments × 3.
 * Comments are 3× weighted because a comment reply is a stronger signal
 * than a passive upvote on Reddit's voting culture.
 *
 * `text` combines title + excerpt so the LLM has the fullest context
 * available when classifying relevance + sentiment.
 */
function normalizeRedditPost(p) {
  if (!p || !p.title) return null;
  const text = p.excerpt ? `${p.title}\n${p.excerpt}` : p.title;
  const author = p.author ? `u/${p.author}` : null;
  return {
    text,
    platform: 'reddit',
    author,
    url: p.url || null,
    createdAt: p.publishedAt || null,
    engagement: (p.score || 0) + (p.numComments || 0) * 3,
    relevant: null,
    sentiment: null,
  };
}

/**
 * Fetches Reddit mentions for a show title. Uses 'week' time window and
 * Reddit's 100-post ceiling. Failures are non-fatal — returns empty and
 * lets the other platforms carry.
 */
async function fetchRedditForShow({ showTitle, marketQualifier, maxItems = 100, logger = console }) {
  try {
    // searchQualifier disambiguates the Reddit search (e.g., "Hamilton"
    // alone returns F1/city results) without affecting the containsKeyword
    // post-filter, which still checks for the bare show title in post text.
    const rawMentions = await fetchRedditMentions([showTitle], {
      limit: Math.min(maxItems, 100),
      timeWindow: 'week',
      searchQualifier: marketQualifier || 'broadway',
    });
    const mentions = rawMentions.map(normalizeRedditPost).filter(Boolean);
    if (rawMentions.length >= 100) {
      // Reddit's API ceiling — the counter reads "100" but the real weekly
      // volume is higher. Rare for theater content; surfaced so a run
      // where hot shows saturate is visible in the workflow log.
      logger.warn(`[${showTitle}] Reddit sample saturated at the 100/query API cap — true weekly count is >=100`);
    }
    return { mentions, rawCount: rawMentions.length };
  } catch (err) {
    logger.warn(`[${showTitle}] Reddit fetch failed: ${err.message}`);
    return { mentions: [], rawCount: 0 };
  }
}

// ---------- Bluesky ----------

/**
 * Normalizes a Bluesky post from searchBlueskyPosts() into our common
 * mention shape.
 *
 * Engagement = likes + reposts*2 + replies — same weighting philosophy as
 * the old X normalizer (active sharing counts more than passive likes).
 */
function normalizeBlueskyPost(post) {
  if (!post) return null;
  const record = post.record || {};
  const text = typeof record.text === 'string' ? record.text : '';
  if (!text.trim()) return null;
  const handle = (post.author && post.author.handle) || null;
  const postId = (post.uri || '').split('/').pop() || post.cid || '';
  return {
    text,
    platform: 'bluesky',
    author: handle ? `@${handle}` : null,
    url: handle && postId ? `https://bsky.app/profile/${handle}/post/${postId}` : null,
    createdAt: record.createdAt || null,
    engagement:
      (post.likeCount || 0) +
      (post.repostCount || 0) * 2 +
      (post.replyCount || 0),
    relevant: null,
    sentiment: null,
  };
}

/**
 * Builds the exact-phrase search query for a show. Quoted title +
 * market qualifier, mirroring the old X query construction: the quotes
 * pin common-word titles ("Chess", "Cats") to the exact phrase and the
 * qualifier ("broadway" / "west end") disambiguates from non-theatrical
 * uses. The LLM relevance classifier catches what the query can't.
 */
function buildShowQuery(showTitle, marketQualifier) {
  return `"${showTitle}" ${marketQualifier || 'broadway'}`;
}

/**
 * Fetches Bluesky posts + the TRUE weekly mention count for a show.
 *
 * Returns { mentions, rawCount, hitsTotal } where hitsTotal is Bluesky's
 * uncapped total for the windowed query (the Job A counter) and mentions
 * is the ≤maxItems text sample (the Job B input). Both come from ONE call.
 *
 * The 7-day window is mandatory — see searchBlueskyPosts docs.
 */
async function fetchBlueskyForShow({ showTitle, marketQualifier, maxItems = 100, now = Date.now(), logger = console }) {
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { posts, hitsTotal } = await searchBlueskyPosts({
      query: buildShowQuery(showTitle, marketQualifier),
      limit: Math.min(maxItems, 100),
      since,
      sort: 'latest',
    });
    const mentions = posts.map(normalizeBlueskyPost).filter(Boolean);
    return { mentions, rawCount: posts.length, hitsTotal };
  } catch (err) {
    logger.warn(`[${showTitle}] Bluesky fetch failed: ${err.message}`);
    return { mentions: [], rawCount: 0, hitsTotal: null };
  }
}

// ---------- X weekly tweet count (free API, at-risk) ----------

/**
 * Fetches the total tweet count for a show over the last 7 days using
 * X API v2 tweet_counts/recent. Returns the total count or null on
 * failure/missing token.
 *
 * X discontinued the free API tier in Feb 2026; this token is
 * grandfathered and WILL eventually stop working or start billing.
 * Everything downstream treats null as "signal absent" and renormalizes
 * (see SIGNAL_WEIGHTS in social-pulse-scorer.js), so its death degrades
 * the Pulse Index gracefully instead of breaking it.
 */
async function fetchXTweetCount({ showTitle, marketQualifier, logger = console }) {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) return null;

  const query = `${buildShowQuery(showTitle, marketQualifier)} lang:en`;
  const url = `https://api.x.com/2/tweets/counts/recent?query=${encodeURIComponent(query)}&granularity=day`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn(`[${showTitle}] X counts API ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data?.meta?.total_tweet_count ?? null;
  } catch (err) {
    logger.warn(`[${showTitle}] X counts API failed: ${err.message}`);
    return null;
  }
}

// ---------- Orchestrator ----------

/**
 * Fetches all free pulse sources for a single show.
 *
 * Returns:
 *   {
 *     mentions: NormalizedMention[],       // Reddit + Bluesky texts (Job B)
 *     counters: { reddit, bluesky, x },    // weekly counts; null = signal absent (Job A)
 *     rawCounts: { reddit, bluesky },      // sample sizes actually fetched
 *     errors: [{ platform, error }],
 *   }
 *
 * The wikipedia counter is attached by the caller (needs the show→article
 * map). Failures on ONE platform never block the others.
 *
 * Counter semantics: `reddit` is the fetched post count (Reddit's API caps
 * a query at 100 — practically uncapped for theater volumes). `bluesky` is
 * hitsTotal (truly uncapped). `x` is the 7-day tweet count or null.
 */
async function fetchAllPulseSources({ showTitle, marketQualifier, redditMax = 100, blueskyMax = 100, logger = console }) {
  const result = {
    mentions: [],
    counters: { reddit: null, bluesky: null, x: null },
    rawCounts: { reddit: 0, bluesky: 0 },
    errors: [],
  };

  const [redditRes, blueskyRes, xCountRes] = await Promise.allSettled([
    fetchRedditForShow({ showTitle, marketQualifier, maxItems: redditMax, logger }),
    fetchBlueskyForShow({ showTitle, marketQualifier, maxItems: blueskyMax, logger }),
    fetchXTweetCount({ showTitle, marketQualifier, logger }),
  ]);

  if (redditRes.status === 'fulfilled') {
    result.mentions.push(...redditRes.value.mentions);
    result.rawCounts.reddit = redditRes.value.rawCount;
    result.counters.reddit = redditRes.value.rawCount;
  } else {
    result.errors.push({ platform: 'reddit', error: redditRes.reason.message });
  }

  if (blueskyRes.status === 'fulfilled') {
    result.mentions.push(...blueskyRes.value.mentions);
    result.rawCounts.bluesky = blueskyRes.value.rawCount;
    result.counters.bluesky = blueskyRes.value.hitsTotal;
    if (blueskyRes.value.hitsTotal === null) {
      result.errors.push({ platform: 'bluesky', error: 'fetch failed (see log)' });
    }
  } else {
    result.errors.push({ platform: 'bluesky', error: blueskyRes.reason.message });
  }

  if (xCountRes.status === 'fulfilled') {
    result.counters.x = xCountRes.value; // may be null (token missing/dead)
  } else {
    result.errors.push({ platform: 'x', error: xCountRes.reason.message });
  }

  return result;
}

module.exports = {
  fetchAllPulseSources,
  fetchRedditForShow,
  fetchBlueskyForShow,
  fetchXTweetCount,
  buildShowQuery,
  normalizeRedditPost,
  normalizeBlueskyPost,
};
