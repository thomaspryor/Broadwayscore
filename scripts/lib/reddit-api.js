/**
 * Reddit API Client Module
 *
 * Direct Reddit API access with ScrapingBee fallback.
 * Reddit allows ~100 requests/min for unauthenticated read-only access.
 *
 * Usage:
 *   const { searchSubreddit, getPostComments, searchAllPosts } = require('./reddit-api');
 *   const posts = await searchAllPosts('broadway', '"Wicked"', 100);
 */

const https = require('https');

const USER_AGENT = 'BroadwayScorecard/1.0 (broadway buzz aggregator)';
const MAX_RETRIES = 3;

// Adaptive rate limiting — starts conservative, slows down after rate limits
const DELAY_NORMAL = 7000;    // 7s = ~8.5 req/min (safe under 10 req/min limit)
const DELAY_CAUTIOUS = 12000; // 12s after 2+ rate limits
const DELAY_SLOW = 20000;     // 20s after 5+ rate limits

let currentDelay = DELAY_NORMAL;
let lastRequestTime = 0;

// Track if direct API is working or if we should use ScrapingBee
let useScrapingBeeByDefault = false;
let scrapingBeeDown = false; // True on 401 (credits exhausted) — stops retrying
let scrapingBeeSwitchTime = 0; // When we switched to ScrapingBee
const SCRAPINGBEE_COOLDOWN = 5 * 60 * 1000; // Try Reddit again after 5 min

// Session-level stats (exposed via getStats())
const stats = {
  redditDirect: 0,
  scrapingBee: 0,
  rateLimits: 0,
  backoffRetries: 0,
  errors: 0,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Adapt delay based on cumulative rate limit count
 */
function adaptDelay() {
  if (stats.rateLimits >= 5) {
    currentDelay = DELAY_SLOW;
  } else if (stats.rateLimits >= 2) {
    currentDelay = DELAY_CAUTIOUS;
  }
}

/**
 * Enforce minimum delay between Reddit requests
 */
async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < currentDelay) {
    await sleep(currentDelay - elapsed);
  }
  lastRequestTime = Date.now();
}

/**
 * Fetch via ScrapingBee (fallback)
 */
async function fetchViaScrapingBee(url) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    throw new Error('SCRAPINGBEE_API_KEY not set and direct Reddit access failed');
  }

  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(url)}&render_js=false&premium_proxy=true`;

  return new Promise((resolve, reject) => {
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`ScrapingBee JSON parse failed: ${data.slice(0, 100)}`));
          }
        } else if (res.statusCode === 401) {
          scrapingBeeDown = true;
          reject(new Error('ScrapingBee credits exhausted (401)'));
        } else {
          reject(new Error(`ScrapingBee HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Make a single direct Reddit API request (no retries)
 */
function fetchRedditDirect(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            if (data.includes('<html') || data.includes('<!DOCTYPE')) {
              reject(new Error('BLOCKED: Reddit returned HTML'));
            } else {
              reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`));
            }
          }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMITED'));
        } else if (res.statusCode === 403) {
          reject(new Error('BLOCKED: Reddit returned 403'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch URL with direct Reddit access + adaptive backoff, ScrapingBee as last resort
 *
 * Strategy:
 * - Try Reddit direct with rate limiting
 * - On 429: exponential backoff (30s → 60s → 120s) then retry Reddit
 * - Only fall to ScrapingBee after ALL backoff retries exhausted
 * - Periodically retry Reddit even after switching to ScrapingBee (5 min cooldown)
 */
async function fetchWithFallback(url) {
  // Check if we should try Reddit again after cooldown
  if (useScrapingBeeByDefault && Date.now() - scrapingBeeSwitchTime > SCRAPINGBEE_COOLDOWN) {
    console.log('    Cooldown elapsed, retrying Reddit direct...');
    useScrapingBeeByDefault = false;
  }

  // If recently blocked, use ScrapingBee (unless it's also down)
  if (useScrapingBeeByDefault && process.env.SCRAPINGBEE_API_KEY && !scrapingBeeDown) {
    stats.scrapingBee++;
    return fetchViaScrapingBee(url);
  }

  // Both sources down — fail fast
  if (useScrapingBeeByDefault && scrapingBeeDown) {
    stats.errors++;
    throw new Error('Both Reddit (403) and ScrapingBee (credits exhausted) are unavailable');
  }

  // Try Reddit direct with exponential backoff on rate limits
  const BACKOFF_DELAYS = [30000, 60000, 120000]; // 30s, 60s, 120s

  for (let attempt = 0; attempt <= BACKOFF_DELAYS.length; attempt++) {
    try {
      await enforceRateLimit();
      const result = await fetchRedditDirect(url);
      stats.redditDirect++;
      return result;
    } catch (e) {
      if (e.message === 'RATE_LIMITED' && attempt < BACKOFF_DELAYS.length) {
        stats.rateLimits++;
        stats.backoffRetries++;
        adaptDelay();
        const backoff = BACKOFF_DELAYS[attempt];
        console.warn(`    Rate limited (${stats.rateLimits} total). Backing off ${backoff / 1000}s...`);
        await sleep(backoff);
        // Continue loop to retry
      } else if (e.message.startsWith('BLOCKED')) {
        console.warn(`    ${e.message}, switching to ScrapingBee`);
        useScrapingBeeByDefault = true;
        scrapingBeeSwitchTime = Date.now();
        break;
      } else if (e.message === 'RATE_LIMITED') {
        // Exhausted all backoff retries
        console.warn('    All backoff retries exhausted, switching to ScrapingBee');
        useScrapingBeeByDefault = true;
        scrapingBeeSwitchTime = Date.now();
        break;
      } else {
        stats.errors++;
        throw e;
      }
    }
  }

  // ScrapingBee as last resort (unless credits exhausted)
  if (process.env.SCRAPINGBEE_API_KEY && !scrapingBeeDown) {
    stats.scrapingBee++;
    return fetchViaScrapingBee(url);
  }

  stats.errors++;
  throw new Error('Reddit blocked and no ScrapingBee key');
}

/**
 * Search subreddit for posts matching query
 *
 * @param {string} subreddit - Subreddit name (e.g., 'broadway')
 * @param {string} query - Search query (use quotes for exact match)
 * @param {object} options - { sort, time, limit, after }
 * @returns {Promise<object>} Reddit API response
 */
async function searchSubreddit(subreddit, query, options = {}) {
  const { sort = 'relevance', time = 'all', limit = 100, after = null } = options;

  const params = new URLSearchParams({
    q: query,
    restrict_sr: 'on',
    sort,
    t: time,
    limit: String(Math.min(limit, 100)), // Reddit max is 100
    raw_json: '1'
  });

  if (after) params.set('after', after);

  const url = `https://old.reddit.com/r/${subreddit}/search.json?${params}`;

  return fetchWithFallback(url);
}

/**
 * Get comments from a specific post
 *
 * @param {string} subreddit - Subreddit name
 * @param {string} postId - Reddit post ID (e.g., '1abc123')
 * @param {object} options - { limit, depth }
 * @returns {Promise<object>} Reddit API response with comments
 */
async function getPostComments(subreddit, postId, options = {}) {
  const { limit = 500, depth = 10 } = options;

  const url = `https://old.reddit.com/r/${subreddit}/comments/${postId}.json?limit=${limit}&depth=${depth}&raw_json=1`;

  return fetchWithFallback(url);
}

/**
 * Flatten nested comment tree into array
 *
 * @param {object} response - Reddit API comments response
 * @returns {Array} Flat array of comment objects with { id, body, score }
 */
function flattenComments(response) {
  const comments = [];

  function extractComments(children) {
    if (!children) return;

    for (const child of children) {
      if (child.kind === 't1' && child.data) {
        const { id, body, score } = child.data;
        if (body && body !== '[deleted]' && body !== '[removed]') {
          comments.push({ id, body, score: score || 0 });
        }

        // Recursively extract replies
        if (child.data.replies?.data?.children) {
          extractComments(child.data.replies.data.children);
        }
      }
    }
  }

  // Comments are in the second element of the response array
  if (Array.isArray(response) && response[1]?.data?.children) {
    extractComments(response[1].data.children);
  }

  return comments;
}

/**
 * Search for all posts matching query with pagination
 *
 * @param {string} subreddit - Subreddit name
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum posts to fetch (default 500)
 * @returns {Promise<Array>} Array of post objects
 */
async function searchAllPosts(subreddit, query, maxResults = 500) {
  const allPosts = [];
  let after = null;

  while (allPosts.length < maxResults) {
    const response = await searchSubreddit(subreddit, query, { after, limit: 100 });
    const posts = response.data?.children || [];

    if (posts.length === 0) break;

    allPosts.push(...posts.map(p => p.data));
    after = response.data?.after;

    if (!after) break; // No more pages

    // Log progress for long fetches
    if (allPosts.length % 100 === 0) {
      console.log(`    Fetched ${allPosts.length} posts...`);
    }
  }

  return allPosts.slice(0, maxResults);
}

/**
 * Collect comments from multiple posts
 *
 * @param {string} subreddit - Subreddit name
 * @param {Array} posts - Array of post objects with 'id' field
 * @param {number} maxComments - Maximum total comments to collect
 * @returns {Promise<Array>} Flat array of comment objects
 */
async function collectCommentsFromPosts(subreddit, posts, maxComments = 1000) {
  const allComments = [];

  for (const post of posts) {
    if (allComments.length >= maxComments) break;

    try {
      const response = await getPostComments(subreddit, post.id);
      const comments = flattenComments(response);
      allComments.push(...comments);

      // Log progress
      if (allComments.length % 200 === 0) {
        console.log(`    Collected ${allComments.length} comments...`);
      }
    } catch (e) {
      console.warn(`    Failed to get comments for post ${post.id}: ${e.message}`);
    }
  }

  return allComments.slice(0, maxComments);
}

/**
 * Reset the ScrapingBee fallback flag (for testing)
 */
function resetFallbackState() {
  useScrapingBeeByDefault = false;
  scrapingBeeDown = false;
  scrapingBeeSwitchTime = 0;
  currentDelay = DELAY_NORMAL;
  stats.redditDirect = 0;
  stats.scrapingBee = 0;
  stats.rateLimits = 0;
  stats.backoffRetries = 0;
  stats.errors = 0;
}

/**
 * Get session stats for end-of-run reporting
 */
function getStats() {
  return {
    ...stats,
    currentDelay,
    usingScrapingBee: useScrapingBeeByDefault,
  };
}

module.exports = {
  searchSubreddit,
  getPostComments,
  flattenComments,
  searchAllPosts,
  collectCommentsFromPosts,
  resetFallbackState,
  getStats,
  // Expose for testing
  fetchWithFallback,
  fetchViaScrapingBee
};
