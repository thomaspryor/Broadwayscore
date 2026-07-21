/**
 * brand-mention-sources.js
 *
 * Source adapters for the brand mention monitor. Each adapter fetches
 * recent mentions of the configured keywords from a specific platform
 * and returns a normalized mention array.
 *
 * Normalized mention shape:
 *   {
 *     id: 'reddit:t3_abc',
 *     source: 'reddit' | 'hn' | 'bluesky' | 'x' | 'google' | 'news',
 *     url: 'https://...',
 *     title: '...',
 *     excerpt: '...',
 *     author: 'username',
 *     subreddit: 'Broadway',    // reddit only
 *     publishedAt: '2026-04-10T...',
 *     detectedAt: '2026-04-10T...',
 *     raw: { ... }              // original platform payload, for debugging
 *   }
 *
 * All adapters must be idempotent and graceful-on-error — a failure in
 * one source should never crash the overall run.
 */

const https = require('https');
const { fetchWithFallback, flattenComments } = require('./reddit-api');

// NOTE: we intentionally use only the single-word form "broadwayscorecard"
// plus the domain form. The 2-word phrase "broadway scorecard" is too noisy —
// it matches random 2012 blog posts, Google Books results, and BWW forum
// threads that happen to contain the phrase without being about us.
// F5Bot runs the 2-word form in parallel as an independent safety net.
const DEFAULT_KEYWORDS = ['broadwayscorecard', 'broadwayscorecard.com'];

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────

function iso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': opts.userAgent || 'BroadwayScorecard-BrandMonitor/1.0',
          'Accept': 'application/json',
          ...(opts.headers || {}),
        },
        timeout: opts.timeout || 15000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow one redirect
          return fetchJson(res.headers.location, opts).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout for ${url}`));
    });
  });
}

function postJson(url, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'User-Agent': opts.userAgent || 'BroadwayScorecard-BrandMonitor/1.0',
          ...(opts.headers || {}),
        },
        timeout: opts.timeout || 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${url}: ${data.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout for ${url}`));
    });
    req.write(payload);
    req.end();
  });
}

function containsKeyword(text, keywords) {
  if (!text) return false;
  const haystack = String(text).toLowerCase();
  return keywords.some((kw) => haystack.includes(kw.toLowerCase()));
}

// ──────────────────────────────────────────────────────────────────────────
// Reddit (cross-subreddit search via /search.json)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Search ALL of Reddit for keyword. Uses the existing fetchWithFallback
 * (which handles rate limiting, proxy fallback, etc.). Returns normalized
 * mentions for both threads (t3) and comments (t1).
 *
 * Note: Reddit's web search is flaky for comments. Threads are reliable.
 * For comment coverage we'll also search Pushshift-alternative services
 * in a future revision.
 *
 * Options:
 *   - limit: max results per keyword (Reddit caps at 100). Default 50.
 *   - timeWindow: Reddit's `t=` param ('hour'|'day'|'week'|'month'|'year'|'all').
 *     Default 'month' for backwards compat with brand-mention-monitor. The
 *     Socials Scorecard pipeline passes 'week' for rolling 7-day volume.
 */
async function fetchRedditMentions(keywords = DEFAULT_KEYWORDS, { limit = 50, timeWindow = 'month', searchQualifier } = {}) {
  const mentions = [];
  const detected = nowIso();

  for (const keyword of keywords) {
    // searchQualifier appends to the Reddit search query for disambiguation
    // (e.g., "broadway" or "west end") but does NOT affect the containsKeyword
    // check — we still verify the show title itself appears in the post text.
    const searchQuery = searchQualifier ? `"${keyword}" ${searchQualifier}` : keyword;
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(searchQuery)}&sort=new&restrict_sr=off&limit=${limit}&t=${encodeURIComponent(timeWindow)}&raw_json=1`;
    let data;
    try {
      data = await fetchWithFallback(url);
    } catch (e) {
      console.warn(`[reddit] search failed for "${keyword}": ${e.message}`);
      continue;
    }

    const children = (data && data.data && data.data.children) || [];
    for (const child of children) {
      if (child.kind !== 't3') continue;
      const p = child.data || {};

      // Tombstone filter
      if (p.author === '[deleted]' || p.selftext === '[removed]') continue;

      // Posts from known theater subreddits are inherently relevant —
      // a post in r/Broadway mentioning "Hamilton" is about the musical,
      // even if the post text doesn't repeat the word "broadway."
      const THEATER_SUBREDDITS = new Set([
        'broadway', 'musicals', 'theater', 'theatre', 'thewestend',
        'westend', 'offbroadway', 'broadwaymusicals',
      ]);
      const isTheaterSub = THEATER_SUBREDDITS.has((p.subreddit || '').toLowerCase());

      // Verify keyword appears in title + body. Skip this check for
      // theater subreddits where the context is already theatrical.
      if (!isTheaterSub) {
        const blob = `${p.title || ''} ${p.selftext || ''}`;
        if (!containsKeyword(blob, keywords)) continue;
      }

      mentions.push({
        id: `reddit:${p.name || `t3_${p.id}`}`,
        source: 'reddit',
        subreddit: p.subreddit,
        url: `https://www.reddit.com${p.permalink}`,
        title: p.title,
        excerpt: (p.selftext || '').slice(0, 500),
        author: p.author,
        publishedAt: p.created_utc ? iso(new Date(p.created_utc * 1000)) : null,
        detectedAt: detected,
        score: p.score,
        numComments: p.num_comments,
        raw: { matchedKeyword: keyword },
      });
    }
  }

  // Dedup within the adapter (same post may match multiple keywords)
  const seen = new Set();
  return mentions.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Hacker News (Algolia)
// ──────────────────────────────────────────────────────────────────────────

/**
 * HN Algolia: https://hn.algolia.com/api/v1/search_by_date
 *   ?query=broadwayscorecard
 *   &tags=(story,comment)
 *   &numericFilters=created_at_i>SINCE_TS
 * Free, no auth. Returns stories + comments mixed.
 */
async function fetchHackerNewsMentions(keywords = DEFAULT_KEYWORDS, { sinceTs = null } = {}) {
  const mentions = [];
  const detected = nowIso();
  const since = sinceTs || Math.floor(Date.now() / 1000) - 30 * 86400; // 30 days

  for (const keyword of keywords) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&tags=(story,comment)&numericFilters=created_at_i>${since}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      console.warn(`[hn] search failed for "${keyword}": ${e.message}`);
      continue;
    }

    const hits = (data && data.hits) || [];
    for (const hit of hits) {
      // hit has: objectID, title, url, author, story_text, comment_text, created_at, points, num_comments, story_id
      const text = `${hit.title || ''} ${hit.story_text || ''} ${hit.comment_text || ''}`;
      if (!containsKeyword(text, keywords)) continue;

      const isComment = !!hit.comment_text;
      const hnUrl = isComment
        ? `https://news.ycombinator.com/item?id=${hit.objectID}`
        : hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;

      mentions.push({
        id: `hn:${hit.objectID}`,
        source: 'hn',
        url: hnUrl,
        title: hit.title || (isComment ? `Comment on HN thread ${hit.story_id}` : 'HN item'),
        excerpt: (hit.story_text || hit.comment_text || '').slice(0, 500),
        author: hit.author,
        publishedAt: hit.created_at,
        detectedAt: detected,
        score: hit.points || null,
        numComments: hit.num_comments || null,
        raw: { isComment, matchedKeyword: keyword },
      });
    }
  }

  const seen = new Set();
  return mentions.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Bluesky (public searchPosts API)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Cached AT Protocol session token for authenticated Bluesky calls. One
 * session per process is plenty — access JWTs live ~2h and our batch runs
 * finish well inside that.
 */
let _bskySessionJwt = null;

async function getBlueskySessionJwt() {
  if (_bskySessionJwt) return _bskySessionJwt;
  const handle = process.env.BSKY_HANDLE;
  const appPassword = process.env.BSKY_APP_PASSWORD;
  if (!handle || !appPassword) return null;
  const session = await postJson(
    'https://bsky.social/xrpc/com.atproto.server.createSession',
    { identifier: handle, password: appPassword }
  );
  if (!session.accessJwt) throw new Error('no accessJwt in session response');
  _bskySessionJwt = session.accessJwt;
  return _bskySessionJwt;
}

/**
 * Low-level Bluesky post search. Returns { posts, hitsTotal } where
 * hitsTotal is Bluesky's own total match count for the query — a TRUE
 * uncapped volume number (0 when the field is absent, which Bluesky does
 * for zero-hit queries).
 *
 * IMPORTANT: hitsTotal without a time window is an ALL-TIME count and
 * measures catalog age, not current buzz. Callers wanting weekly volume
 * MUST pass since/until (verified 2026-07-14: "maybe happy ending" broadway
 * all-time=1015 vs 7-day window=2).
 *
 * Endpoint strategy: try the public unauthenticated AppView first
 * (api.bsky.app — works from residential/proxy IPs), fall back to an
 * authenticated bsky.social session when BSKY_HANDLE/BSKY_APP_PASSWORD are
 * set. Datacenter IPs (GitHub Actions runners) have been observed to get
 * 403 from the public endpoint since Bluesky's 2025 WAF tightening, so CI
 * callers should treat the auth secrets as REQUIRED, not optional.
 */
async function searchBlueskyPosts({ query, limit = 100, since = null, until = null, sort = 'latest' }) {
  const params = new URLSearchParams({ q: query, limit: String(limit), sort });
  if (since) params.set('since', since);
  if (until) params.set('until', until);

  // Bluesky omits hitsTotal on zero-hit responses (0 is correct there),
  // but if it were ever omitted alongside a non-empty posts array, 0 would
  // silently undercount — fall back to the sample size instead.
  const shape = (data) => ({
    posts: data.posts || [],
    hitsTotal: data.hitsTotal ?? (data.posts && data.posts.length ? data.posts.length : 0),
  });

  // 1) Public AppView, no auth
  try {
    const data = await fetchJson(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?${params}`);
    return shape(data);
  } catch (publicErr) {
    // 2) Authenticated fallback (required path on datacenter IPs)
    const jwt = await getBlueskySessionJwt().catch((e) => {
      throw new Error(`public endpoint failed (${publicErr.message}) and session creation failed (${e.message})`);
    });
    if (!jwt) {
      throw new Error(`public endpoint failed (${publicErr.message}) and BSKY_HANDLE/BSKY_APP_PASSWORD not set for auth fallback`);
    }
    const data = await fetchJson(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?${params}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    return shape(data);
  }
}

/**
 * Bluesky brand-mention adapter. Thin wrapper over searchBlueskyPosts that
 * preserves the historical contract: keyword array in, flat normalized
 * mention array out, containsKeyword post-filter, never throws.
 *
 * Unlike the pre-2026-07 version this no longer hard-requires BSKY_HANDLE/
 * BSKY_APP_PASSWORD — the unauthenticated public AppView is tried first and
 * creds are only needed where that 403s (datacenter IPs).
 */
async function fetchBlueskyMentions(keywords = DEFAULT_KEYWORDS, { limit = 25 } = {}) {
  const mentions = [];
  const detected = nowIso();

  for (const keyword of keywords) {
    let posts;
    try {
      ({ posts } = await searchBlueskyPosts({ query: keyword, limit }));
    } catch (e) {
      console.warn(`[bluesky] search failed for "${keyword}": ${e.message}`);
      continue;
    }
    for (const post of posts) {
      // Filter blocked / deleted posts
      if (post.viewer && (post.viewer.blocked || post.viewer.blockedBy)) continue;
      const record = post.record || {};
      const text = record.text || '';
      if (!containsKeyword(text, keywords)) continue;

      // Extract post ID from at:// URI for stable dedup key
      // uri format: at://did:plc:XXX/app.bsky.feed.post/POST_ID
      const uri = post.uri || '';
      const postId = uri.split('/').pop() || post.cid;

      // Construct public URL via the author's handle
      const handle = (post.author && post.author.handle) || 'unknown.bsky.social';
      const webUrl = `https://bsky.app/profile/${handle}/post/${postId}`;

      mentions.push({
        id: `bluesky:${postId}`,
        source: 'bluesky',
        url: webUrl,
        title: text.slice(0, 100),
        excerpt: text.slice(0, 500),
        author: handle,
        publishedAt: record.createdAt || null,
        detectedAt: detected,
        score: (post.likeCount || 0) + (post.repostCount || 0) * 2,
        numComments: post.replyCount || 0,
        raw: { matchedKeyword: keyword, uri },
      });
    }
  }

  const seen = new Set();
  return mentions.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestrator: fetch all free sources in parallel
// ──────────────────────────────────────────────────────────────────────────

/**
 * Runs all free-tier source adapters in parallel. Returns a flat array of
 * normalized mentions. Source failures are swallowed (logged to stderr).
 *
 * Paid sources (X via BrightData SERP, Google SERP, Google News) are NOT
 * included here — they live in a separate module because they need
 * different rate-limiting, retries, and secret handling.
 */
async function fetchFreeSources(keywords = DEFAULT_KEYWORDS, opts = {}) {
  const results = await Promise.allSettled([
    fetchRedditMentions(keywords, opts.reddit || {}),
    fetchHackerNewsMentions(keywords, opts.hn || {}),
    fetchBlueskyMentions(keywords, opts.bluesky || {}),
  ]);

  const labels = ['reddit', 'hn', 'bluesky'];
  const out = [];
  const counts = {};

  results.forEach((r, idx) => {
    const label = labels[idx];
    if (r.status === 'fulfilled') {
      counts[label] = r.value.length;
      out.push(...r.value);
    } else {
      counts[label] = `ERROR: ${r.reason && r.reason.message}`;
      console.warn(`[${label}] fatal: ${r.reason && r.reason.message}`);
    }
  });

  return { mentions: out, counts };
}

module.exports = {
  DEFAULT_KEYWORDS,
  fetchRedditMentions,
  fetchHackerNewsMentions,
  fetchBlueskyMentions,
  searchBlueskyPosts,
  fetchFreeSources,
  // exported for unit tests
  _internal: { containsKeyword, fetchJson },
};
