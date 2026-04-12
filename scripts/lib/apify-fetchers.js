/**
 * Apify per-platform fetchers for the Social Pulse feature.
 *
 * Calls proven Apify actors (not the broken sovereigntaylor/brand-monitor),
 * normalizes their output into our common "mention" shape, and returns a
 * uniform { mentions, usageUsd } response.
 *
 * Actors used:
 *   - X/Twitter: kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest
 *     (34.9M runs, $0.00025/tweet, trial-verified in T1)
 *   - TikTok:    clockworks/tiktok-scraper
 *     (75M runs, 96.5% success, $0.003/result + $0.005 actor-start)
 *
 * Both use the sync-get-dataset-items endpoint so the caller doesn't have to
 * poll run status. Timeout is 300s per platform — each run typically takes
 * 5-30 seconds.
 *
 * Cost is reported via the run stats endpoint after completion. The caller
 * is responsible for aggregating costs against the cumulative budget.
 */

const APIFY_BASE = 'https://api.apify.com/v2';
const DEFAULT_TIMEOUT_SECS = 300;

/**
 * Makes an Apify actor call via run-sync-get-dataset-items. Returns the
 * dataset items (or throws if the run failed).
 *
 * Separately fetches the run metadata to get the final usageTotalUsd.
 * The sync endpoint doesn't return it in the response.
 */
async function runApifyActor({ actorId, input, token, timeoutSecs = DEFAULT_TIMEOUT_SECS, buildTag }) {
  const buildParam = buildTag ? `&build=${encodeURIComponent(buildTag)}` : '';
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}${buildParam}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  // The sync endpoint sets these headers after the run completes. Used to
  // fetch usage metadata without a second round-trip.
  const runId = res.headers.get('x-apify-pagination-total') || null;

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify run failed (${actorId}): ${res.status} ${body.slice(0, 500)}`);
  }

  const items = await res.json();

  return {
    items: Array.isArray(items) ? items : [],
    runId,
  };
}

/**
 * Fetches the most recent run for an actor belonging to the current user.
 * Used to retrieve usageTotalUsd after run-sync completes (which doesn't
 * return it in the body).
 */
async function fetchLatestRunUsage({ actorId, token }) {
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}&limit=1&desc=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const run = data?.data?.items?.[0];
  if (!run) return null;
  return {
    runId: run.id,
    status: run.status,
    usageTotalUsd: run.usageTotalUsd || 0,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

// ---------- X/Twitter ----------

/**
 * Normalizes a tweet from kaitoeasyapi/twitter-x-data-tweet-scraper into our
 * common mention shape. Drops tweets missing core fields.
 *
 * Engagement = likes + retweets*2 + replies — weighted so retweets (which
 * indicate active sharing) count more than passive likes.
 */
function normalizeTweet(t) {
  if (!t || typeof t.text !== 'string' || !t.text.trim()) return null;
  const author = t.author?.userName ? `@${t.author.userName}` : null;
  return {
    text: t.text,
    platform: 'x',
    author,
    url: t.url || null,
    createdAt: t.createdAt || null,
    engagement:
      (t.favoriteCount || 0) +
      (t.retweetCount || 0) * 2 +
      (t.replyCount || 0),
    // relevant + sentiment are set by the LLM filter downstream
    relevant: null,
    sentiment: null,
  };
}

/**
 * Fetches up to maxItems tweets matching the search query.
 *
 * Query format uses Twitter/X advanced search syntax. We wrap the show title
 * in quotes for exact-phrase match, then append `broadway` (or `"west end"`)
 * to disambiguate from non-theatrical uses. `lang:en` filters to English.
 */
async function fetchTweets({ showTitle, marketQualifier, maxItems, token }) {
  const phrase = `"${showTitle}"`;
  const qualifier = marketQualifier || 'broadway';
  const searchTerm = `${phrase} ${qualifier} lang:en`;

  const { items } = await runApifyActor({
    actorId: 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest',
    input: {
      searchTerms: [searchTerm],
      maxItems: Math.max(20, maxItems), // actor enforces minimum 20
      queryType: 'Latest',
      lang: 'en',
    },
    token,
  });

  const mentions = items.map(normalizeTweet).filter(Boolean);
  // Trim to the caller's requested max (actor's min=20 may return more)
  const trimmed = mentions.slice(0, maxItems);

  return { mentions: trimmed, rawCount: items.length };
}

// ---------- TikTok ----------

/**
 * Normalizes a TikTok post from clockworks/tiktok-scraper into our common
 * mention shape.
 *
 * Engagement = diggs + plays/100. Plays are high-volume on TikTok (thousands
 * per video is normal), so we scale down to keep it comparable to X's likes/RTs.
 */
function normalizeTikTok(t) {
  if (!t || typeof t.text !== 'string') return null;
  const author = t.authorMeta?.name ? `@${t.authorMeta.name}` : null;
  return {
    text: t.text,
    platform: 'tiktok',
    author,
    url: t.webVideoUrl || null,
    createdAt: t.createTimeISO || null,
    engagement: (t.diggCount || 0) + Math.round((t.playCount || 0) / 100),
    relevant: null,
    sentiment: null,
  };
}

/**
 * Fetches up to maxItems TikToks matching the search query. TikTok's text
 * field is often hashtag-dominated; the LLM + filterTopQuotes logic handles
 * selection downstream.
 */
async function fetchTikToks({ showTitle, marketQualifier, maxItems, token }) {
  const query = `${showTitle} ${marketQualifier || 'broadway'}`;

  const { items } = await runApifyActor({
    actorId: 'clockworks~tiktok-scraper',
    input: {
      searchQueries: [query],
      resultsPerPage: maxItems,
      // Don't set searchSorting — the default is "relevance" which is what we want
    },
    token,
  });

  const mentions = items.map(normalizeTikTok).filter(Boolean);
  return { mentions, rawCount: items.length };
}

// ---------- Instagram ----------

/**
 * Normalizes an Instagram post from apify/instagram-scraper into our common
 * mention shape.
 *
 * Engagement = likes + comments*3 — comments are higher-intent than likes on IG.
 */
function normalizeInstagramPost(p) {
  if (!p || typeof p.caption !== 'string') return null;
  const author = p.ownerUsername ? `@${p.ownerUsername}` : null;
  return {
    text: p.caption,
    platform: 'instagram',
    author,
    url: p.url || null,
    createdAt: p.timestamp || null,
    engagement: (p.likesCount || 0) + (p.commentsCount || 0) * 3,
    relevant: null,
    sentiment: null,
  };
}

/**
 * Fetches Instagram posts tagged with the show's hashtag.
 *
 * IMPORTANT: The `search` + `searchType=hashtag` field uses Google SERP to
 * discover hashtag pages, which is broken (Google no longer reliably indexes
 * Instagram tag URLs). We use `directUrls` with the actual Instagram hashtag
 * page URL, which queries Instagram directly. Trial-verified 2026-04-10.
 *
 * The hashtag is derived from the show title: lowercased, alphanumeric only.
 * "Maybe Happy Ending" → #maybehappyending. This matches real fan tagging
 * conventions on Broadway Instagram.
 */
async function fetchInstagramPosts({ showTitle, marketQualifier, maxItems, token }) {
  // Instagram hashtag search — keep the bare title as the hashtag.
  // Unlike text search, adding "broadway" to the hashtag would be too
  // restrictive (#hamiltonbroadway has almost no posts vs #hamilton).
  // The LLM relevance classifier downstream handles noise, and IG is
  // capped at 15 results so the signal-to-noise ratio is manageable.
  const hashtag = showTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (hashtag.length < 3) {
    return { mentions: [], rawCount: 0 };
  }
  const url = `https://www.instagram.com/explore/tags/${hashtag}/`;

  const { items } = await runApifyActor({
    actorId: 'apify~instagram-scraper',
    input: {
      directUrls: [url],
      resultsType: 'posts',
      resultsLimit: maxItems,
    },
    token,
  });

  // The scraper returns error-shape items for failed hashtag pages
  // ({ error: "no_items", ... }). Filter those out.
  const mentions = items
    .filter((i) => !i.error)
    .map(normalizeInstagramPost)
    .filter(Boolean);
  return { mentions, rawCount: items.length };
}

// ---------- Reddit ----------
//
// Reddit is the 4th platform for the Socials Scorecard — added 2026-04-11.
// Unlike X/TikTok/Instagram, Reddit uses the FREE reddit JSON search API
// (routed through ScrapingBee fallback for 403 resilience) via the existing
// brand-mention-sources.js fetcher. No Apify cost — adds ~$0.50/mo for
// occasional fallback proxy usage only.
//
// Reddit is the closest thing to an "uncapped" platform in the scorecard:
// the limit of 100 per query is Reddit's own API ceiling, which almost
// never binds for Broadway content (typical hot show: 20-80 relevant
// posts per week across all subreddits).

const { fetchRedditMentions } = require('./brand-mention-sources');

/**
 * Normalizes a Reddit post from fetchRedditMentions() into our common
 * mention shape. The brand-mention shape and the socials-pulse mention
 * shape differ slightly — this adapter bridges them.
 *
 * Engagement = score (upvotes - downvotes) + numComments × 3.
 * Comments are 3× weighted because a comment reply is a stronger signal
 * than a passive upvote on Reddit's voting culture.
 *
 * `text` combines title + excerpt so the LLM has the fullest context
 * available when classifying relevance + sentiment. Most Reddit theater
 * discussion lives in the title (which is often the full hot take) plus
 * the selftext body. 500-char excerpt cap is inherited from the source.
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
 * Fetches Reddit mentions for a show title via the existing
 * brand-mention-sources.js#fetchRedditMentions. Uses 'week' time window
 * (vs brand-monitor's default 'month') and Reddit's 100-post ceiling.
 *
 * Failures are non-fatal — if Reddit search 403s and ScrapingBee fallback
 * also fails, we return an empty array and let the other platforms carry.
 */
async function fetchRedditForShow({ showTitle, marketQualifier, maxItems, logger = console }) {
  try {
    // searchQualifier disambiguates the Reddit search (e.g., "Hamilton"
    // alone returns F1/city results) without affecting the containsKeyword
    // post-filter, which still checks for the bare show title in post text.
    const rawMentions = await fetchRedditMentions([showTitle], {
      limit: Math.min(maxItems || 100, 100),
      timeWindow: 'week',
      searchQualifier: marketQualifier || 'broadway',
    });
    const mentions = rawMentions.map(normalizeRedditPost).filter(Boolean);
    return { mentions, rawCount: rawMentions.length };
  } catch (err) {
    logger.warn(`[${showTitle}] Reddit fetch failed: ${err.message}`);
    return { mentions: [], rawCount: 0 };
  }
}

// ---------- Orchestrator ----------

/**
 * Fetches mentions from ALL FOUR platforms for a single show and returns
 * the combined list plus cost estimate.
 *
 * Returns:
 *   {
 *     mentions: NormalizedMention[],
 *     costUsd: number,        // Apify portion only — Reddit is free
 *     rawCounts: { reddit, twitter, tiktok, instagram },
 *     errors: [{ platform, error }],
 *   }
 *
 * Failures on ONE platform do not block the others — partial data is
 * better than none. Per-platform errors are logged and the affected
 * platform's mentions array is empty.
 */
async function fetchAllSocialMentions({ showTitle, marketQualifier, twitterMax, tiktokMax, instagramMax, redditMax, token, logger = console }) {
  const result = {
    mentions: [],
    costUsd: 0,
    rawCounts: { reddit: 0, twitter: 0, tiktok: 0, instagram: 0 },
    errors: [],
  };

  // Run all four fetches in parallel for speed. Reddit is fastest
  // (direct JSON API), so adding it doesn't extend the slowest-wins
  // wall-clock time of the batch.
  const [redditRes, twitterRes, tiktokRes, instagramRes] = await Promise.allSettled([
    fetchRedditForShow({ showTitle, marketQualifier, maxItems: redditMax, logger }),
    fetchTweets({ showTitle, marketQualifier, maxItems: twitterMax, token }),
    fetchTikToks({ showTitle, marketQualifier, maxItems: tiktokMax, token }),
    fetchInstagramPosts({ showTitle, marketQualifier, maxItems: instagramMax, token }),
  ]);

  if (redditRes.status === 'fulfilled') {
    result.mentions.push(...redditRes.value.mentions);
    result.rawCounts.reddit = redditRes.value.rawCount;
  } else {
    logger.warn(`[${showTitle}] Reddit fetch failed: ${redditRes.reason.message}`);
    result.errors.push({ platform: 'reddit', error: redditRes.reason.message });
  }

  if (twitterRes.status === 'fulfilled') {
    result.mentions.push(...twitterRes.value.mentions);
    result.rawCounts.twitter = twitterRes.value.rawCount;
  } else {
    logger.warn(`[${showTitle}] Twitter fetch failed: ${twitterRes.reason.message}`);
    result.errors.push({ platform: 'x', error: twitterRes.reason.message });
  }

  if (tiktokRes.status === 'fulfilled') {
    result.mentions.push(...tiktokRes.value.mentions);
    result.rawCounts.tiktok = tiktokRes.value.rawCount;
  } else {
    logger.warn(`[${showTitle}] TikTok fetch failed: ${tiktokRes.reason.message}`);
    result.errors.push({ platform: 'tiktok', error: tiktokRes.reason.message });
  }

  if (instagramRes.status === 'fulfilled') {
    result.mentions.push(...instagramRes.value.mentions);
    result.rawCounts.instagram = instagramRes.value.rawCount;
  } else {
    logger.warn(`[${showTitle}] Instagram fetch failed: ${instagramRes.reason.message}`);
    result.errors.push({ platform: 'instagram', error: instagramRes.reason.message });
  }

  // Fetch usage for the three Apify actors only. Reddit is free. This is
  // a best-effort cost estimate; the cumulative-budget check in the
  // workflow is the hard gate.
  try {
    const [twitterUsage, tiktokUsage, instagramUsage] = await Promise.all([
      fetchLatestRunUsage({ actorId: 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest', token }),
      fetchLatestRunUsage({ actorId: 'clockworks~tiktok-scraper', token }),
      fetchLatestRunUsage({ actorId: 'apify~instagram-scraper', token }),
    ]);
    result.costUsd =
      (twitterUsage?.usageTotalUsd || 0) +
      (tiktokUsage?.usageTotalUsd || 0) +
      (instagramUsage?.usageTotalUsd || 0);
  } catch (err) {
    logger.warn(`[${showTitle}] Could not fetch run usage: ${err.message}`);
  }

  return result;
}

module.exports = {
  fetchAllSocialMentions,
  fetchTweets,
  fetchTikToks,
  fetchInstagramPosts,
  fetchRedditForShow,
  normalizeTweet,
  normalizeTikTok,
  normalizeInstagramPost,
  normalizeRedditPost,
  runApifyActor,
  fetchLatestRunUsage,
};
