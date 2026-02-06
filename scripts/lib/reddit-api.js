/**
 * Reddit API Client Module
 *
 * Direct Reddit API access with ScrapingBee fallback.
 * Adaptive rate limiting: starts conservative, backs off on 429s,
 * periodically retries direct access after ScrapingBee cooldown.
 *
 * Usage:
 *   const { searchAllPosts, collectCommentsFromPosts, getStats } = require('./reddit-api');
 *   const posts = await searchAllPosts('broadway', '"Wicked"', 100);
 *   console.log(getStats());
 */

const https = require('https');

const USER_AGENT = 'BroadwayScorecard/1.0 (broadway buzz aggregator)';
const MAX_RETRIES = 3;

// Adaptive rate limiting
const DELAY_NORMAL = 7000;    // 7s between requests (~8.5 req/min, well under 10/min limit)
const DELAY_CAUTIOUS = 12000; // 12s after 2+ rate limits
const DELAY_SLOW = 20000;     // 20s after 5+ rate limits

// ScrapingBee recovery
const SCRAPINGBEE_COOLDOWN = 5 * 60 * 1000; // 5 min — then retry Reddit direct

// State
let useScrapingBee = false;
let scrapingBeeDown = false; // Set true on 401 (credits exhausted) — stops retrying
let scrapingBeeSwitchTime = 0;
let rateLimitCount = 0;
let lastRequestTime = 0;

// Proxy state
let brightDataDown = false;

// Session stats
const stats = {
  redditDirect: 0,
  brightData: 0,
  scrapingBee: 0,
  rateLimits: 0,
  backoffRetries: 0,
  errors: 0
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get current adaptive delay based on rate limit history
 */
function getAdaptiveDelay() {
  if (rateLimitCount >= 5) return DELAY_SLOW;
  if (rateLimitCount >= 2) return DELAY_CAUTIOUS;
  return DELAY_NORMAL;
}

/**
 * Enforce rate limit — wait until enough time has passed since last request
 */
async function enforceRateLimit() {
  const delay = getAdaptiveDelay();
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < delay) {
    await sleep(delay - elapsed);
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

  stats.scrapingBee++;

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
          reject(new Error('ScrapingBee credits exhausted (401) — disabling ScrapingBee'));
        } else {
          reject(new Error(`ScrapingBee HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch via Bright Data (primary proxy fallback)
 * Uses web_unlocker zone for simple HTTP proxying (not scraping_browser which renders pages).
 * Reddit JSON API needs a proxy, not a browser.
 */
async function fetchViaBrightData(url) {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) return null; // Not available

  stats.brightData++;

  const apiUrl = `https://api.brightdata.com/request?zone=web_unlocker&url=${encodeURIComponent(url)}&format=raw`;

  return new Promise((resolve, reject) => {
    const req = https.request(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            // Bright Data may return HTML wrapper — try to extract JSON
            const jsonMatch = data.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            if (jsonMatch) {
              try {
                resolve(JSON.parse(jsonMatch[0]));
              } catch (_) {
                reject(new Error(`Bright Data response not JSON: ${data.slice(0, 200)}`));
              }
            } else {
              reject(new Error(`Bright Data response not JSON: ${data.slice(0, 200)}`));
            }
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          brightDataDown = true;
          reject(new Error(`Bright Data ${res.statusCode} — auth/quota issue`));
        } else if (res.statusCode === 400) {
          // 400 likely means zone not configured — disable to avoid repeated failures
          brightDataDown = true;
          reject(new Error(`Bright Data 400 (zone may not be configured) — disabling: ${data.slice(0, 200)}`));
        } else {
          reject(new Error(`Bright Data HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch URL directly from Reddit
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
            const parsed = JSON.parse(data);
            stats.redditDirect++;
            resolve(parsed);
          } catch (e) {
            // Got HTML instead of JSON - Reddit is blocking
            if (data.includes('<html') || data.includes('<!DOCTYPE')) {
              reject({ code: 'HTML_RESPONSE', message: 'Reddit returned HTML instead of JSON' });
            } else {
              reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`));
            }
          }
        } else if (res.statusCode === 429) {
          reject({ code: 'RATE_LIMITED', statusCode: 429 });
        } else if (res.statusCode === 403) {
          reject({ code: 'FORBIDDEN', statusCode: 403 });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch URL with direct Reddit access, fallback to ScrapingBee
 */
async function fetchWithFallback(url, retryCount = 0) {
  // Check if we should try Reddit direct again after cooldown
  if (useScrapingBee && (Date.now() - scrapingBeeSwitchTime) > SCRAPINGBEE_COOLDOWN) {
    console.log('  Cooldown elapsed, retrying Reddit direct...');
    useScrapingBee = false;
  }

  // If in proxy mode, try proxies first
  if (useScrapingBee) {
    // Try Bright Data (primary proxy)
    if (process.env.BRIGHTDATA_TOKEN && !brightDataDown) {
      try {
        return await fetchViaBrightData(url);
      } catch (e) {
        console.warn(`  Bright Data failed: ${e.message}`);
      }
    }
    // Try ScrapingBee (secondary proxy)
    if (process.env.SCRAPINGBEE_API_KEY && !scrapingBeeDown) {
      try {
        return await fetchViaScrapingBee(url);
      } catch (e) {
        console.warn(`  ScrapingBee failed: ${e.message}. Trying Reddit direct...`);
        useScrapingBee = false;
      }
    }
  }

  // All proxy sources down — fail fast instead of looping
  if (useScrapingBee && scrapingBeeDown && brightDataDown) {
    stats.errors++;
    throw new Error('All sources unavailable: Reddit (403), Bright Data (down), ScrapingBee (credits exhausted)');
  }

  // Try Reddit direct
  await enforceRateLimit();

  try {
    return await fetchRedditDirect(url);
  } catch (e) {
    if (e.code === 'RATE_LIMITED') {
      rateLimitCount++;
      stats.rateLimits++;
      const delay = Math.min(120000, 30000 * Math.pow(2, retryCount)); // 30s → 60s → 120s
      console.warn(`  Rate limited (429), count: ${rateLimitCount}, waiting ${delay / 1000}s (delay now ${getAdaptiveDelay() / 1000}s)...`);

      if (retryCount < MAX_RETRIES) {
        stats.backoffRetries++;
        await sleep(delay);
        return fetchWithFallback(url, retryCount + 1);
      }
      // Max retries — try proxies
      return switchToProxy(url);
    }

    if (e.code === 'FORBIDDEN' || e.code === 'HTML_RESPONSE') {
      console.warn(`  Reddit ${e.code}, switching to proxy`);
      return switchToProxy(url);
    }

    // Other errors
    stats.errors++;
    throw e;
  }
}

/**
 * Switch to proxy fallback chain: Bright Data → ScrapingBee
 */
async function switchToProxy(url) {
  useScrapingBee = true;
  scrapingBeeSwitchTime = Date.now();

  // Try Bright Data first (cheaper, no credit limit concerns)
  if (process.env.BRIGHTDATA_TOKEN && !brightDataDown) {
    try {
      console.warn('  Switching to Bright Data proxy (will retry Reddit direct after 5 min cooldown)');
      return await fetchViaBrightData(url);
    } catch (e) {
      console.warn(`  Bright Data failed: ${e.message}`);
    }
  }

  // Try ScrapingBee
  if (process.env.SCRAPINGBEE_API_KEY && !scrapingBeeDown) {
    console.warn('  Falling back to ScrapingBee');
    return fetchViaScrapingBee(url);
  }

  // All proxies down
  stats.errors++;
  const reasons = [];
  if (brightDataDown) reasons.push('Bright Data (auth/quota)');
  if (scrapingBeeDown) reasons.push('ScrapingBee (credits exhausted)');
  if (!process.env.BRIGHTDATA_TOKEN) reasons.push('Bright Data (no token)');
  if (!process.env.SCRAPINGBEE_API_KEY) reasons.push('ScrapingBee (no key)');
  throw new Error(`Reddit blocked and all proxies unavailable: ${reasons.join(', ')}`);
}

/**
 * Search subreddit for posts matching query
 */
async function searchSubreddit(subreddit, query, options = {}) {
  const { sort = 'relevance', time = 'all', limit = 100, after = null } = options;

  const params = new URLSearchParams({
    q: query,
    restrict_sr: 'on',
    sort,
    t: time,
    limit: String(Math.min(limit, 100)),
    raw_json: '1'
  });

  if (after) params.set('after', after);

  const url = `https://old.reddit.com/r/${subreddit}/search.json?${params}`;
  return fetchWithFallback(url);
}

/**
 * Get comments from a specific post
 */
async function getPostComments(subreddit, postId, options = {}) {
  const { limit = 500, depth = 10 } = options;
  const url = `https://old.reddit.com/r/${subreddit}/comments/${postId}.json?limit=${limit}&depth=${depth}&raw_json=1`;
  return fetchWithFallback(url);
}

/**
 * Flatten nested comment tree into array
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
        if (child.data.replies?.data?.children) {
          extractComments(child.data.replies.data.children);
        }
      }
    }
  }

  if (Array.isArray(response) && response[1]?.data?.children) {
    extractComments(response[1].data.children);
  }
  return comments;
}

/**
 * Search for all posts matching query with pagination
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

    if (!after) break;

    if (allPosts.length % 100 === 0) {
      console.log(`    Fetched ${allPosts.length} posts...`);
    }
  }

  return allPosts.slice(0, maxResults);
}

/**
 * Collect comments from multiple posts
 */
async function collectCommentsFromPosts(subreddit, posts, maxComments = 1000) {
  const allComments = [];

  for (const post of posts) {
    if (allComments.length >= maxComments) break;

    try {
      const response = await getPostComments(subreddit, post.id);
      const comments = flattenComments(response);
      allComments.push(...comments);

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
 * Get session stats
 */
function getStats() {
  return { ...stats, rateLimitCount, usingScrapingBee: useScrapingBee };
}

/**
 * Reset state (for testing)
 */
function resetFallbackState() {
  useScrapingBee = false;
  scrapingBeeDown = false;
  brightDataDown = false;
  scrapingBeeSwitchTime = 0;
  rateLimitCount = 0;
  lastRequestTime = 0;
  Object.keys(stats).forEach(k => stats[k] = 0);
}

module.exports = {
  searchSubreddit,
  getPostComments,
  flattenComments,
  searchAllPosts,
  collectCommentsFromPosts,
  getStats,
  resetFallbackState,
  fetchWithFallback,
  fetchViaScrapingBee
};
