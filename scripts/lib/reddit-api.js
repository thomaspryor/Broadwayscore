/**
 * Reddit API Client Module
 *
 * Direct Reddit API access with proxy fallback chain:
 * Bright Data → Scrapingdog → ScrapingBee.
 * (2026-07-05: Bright Data now refuses reddit.com per robots.txt policy
 * ("bad_endpoint ... immediate access mode") and ScrapingBee credits run
 * low, so Scrapingdog — already funded and passed to the workflow via
 * SCRAPINGDOG_API_KEY — carries most proxy traffic.)
 * Adaptive rate limiting: starts conservative, backs off on 429s,
 * periodically retries direct access after proxy cooldown.
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
let scrapingBeeDown = false; // Set true on 401/402 (invalid key OR no credits) — stops retrying
let scrapingBeeSwitchTime = 0;
let rateLimitCount = 0;
let lastRequestTime = 0;

// Proxy state
let brightDataDown = false;
let scrapingDogDown = false; // Latched on 401/403 (bad key / no credits)

// Scrapingdog tier escalation for reddit: plain (1cr) 400s with "try enabling
// Stealth Mode" (2026-07-05 run: 41/41 plain requests refused). Escalate
// plain → premium → stealth on that 400 and LATCH the tier for the rest of
// the run so each request pays the working tier once, not 3 probe calls.
const SD_TIERS = [
  { name: 'plain', params: {} },
  { name: 'premium', params: { premium: 'true' } },
  { name: 'stealth', params: { stealth_mode: 'true' } },
];
let sdTierIndex = 0;

// Overridable for tests (points at a local mock server)
const SCRAPINGDOG_BASE_URL = process.env.SCRAPINGDOG_BASE_URL || 'https://api.scrapingdog.com/scrape';

// Circuit breaker: abort early if all sources are consistently failing
let consecutiveFailures = 0;
const CIRCUIT_BREAKER_THRESHOLD = 15; // After 15 consecutive failures across all sources, abort
let circuitBroken = false;

// Session stats
const stats = {
  redditDirect: 0,
  brightData: 0,
  scrapingDog: 0,
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
        } else if (res.statusCode === 401 || res.statusCode === 402) {
          // ScrapingBee uses these for auth/billing problems. DON'T guess which:
          // a 401 can mean an invalid/expired key ("Invalid api key: ...") OR a
          // depleted account, and we have more than one SB account/key. Echo the
          // literal SB message + point at BOTH checks so the cause is never
          // misdiagnosed again (2026-06-21: a "credits exhausted (401)" label
          // sent debugging toward top-ups/OAuth when CI just had a stale key).
          scrapingBeeDown = true;
          let sbMsg = data.slice(0, 200);
          try { sbMsg = JSON.parse(data).message || sbMsg; } catch (_) {}
          reject(new Error(
            `ScrapingBee ${res.statusCode}: ${sbMsg} — verify SCRAPINGBEE_API_KEY is current AND ` +
            `the account has credits (app.scrapingbee.com/api/v1/usage); disabling ScrapingBee`
          ));
        } else {
          reject(new Error(`ScrapingBee HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch via Scrapingdog (cheap proxy tier, tried before ScrapingBee to
 * conserve SB credits — mirrors scripts/lib/scraper.js cost ordering).
 * Reddit JSON endpoints need no JS rendering, so dynamic=false. Starts at
 * the plain tier and escalates to premium/stealth when Scrapingdog's 400
 * response asks for it (see SD_TIERS above).
 */
async function fetchViaScrapingDog(url) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) {
    throw new Error('SCRAPINGDOG_API_KEY not set');
  }

  while (true) {
    const tier = SD_TIERS[sdTierIndex];
    try {
      return await scrapingDogRequest(apiKey, url, tier);
    } catch (e) {
      if (e.escalate && sdTierIndex < SD_TIERS.length - 1) {
        sdTierIndex++;
        console.warn(`  Scrapingdog ${tier.name} tier refused (${e.message.slice(0, 80)}...) — escalating to ${SD_TIERS[sdTierIndex].name} tier for this run`);
        continue;
      }
      throw e;
    }
  }
}

/** Single Scrapingdog API request at a given tier. */
function scrapingDogRequest(apiKey, url, tier) {
  stats.scrapingDog++;

  const params = new URLSearchParams({ api_key: apiKey, url, dynamic: 'false', ...tier.params });
  const apiUrl = `${SCRAPINGDOG_BASE_URL}?${params}`;
  const client = apiUrl.startsWith('http:') ? require('http') : https;

  return new Promise((resolve, reject) => {
    client.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            // Reddit sometimes ships JSON inside an HTML wrapper via proxies
            const jsonMatch = data.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            if (jsonMatch) {
              try { resolve(JSON.parse(jsonMatch[0])); return; } catch (_) { /* fall through */ }
            }
            // Empty or HTML 200 = the plain tier got blocked by the target
            // (Reddit returns empty/interstitial bodies to datacenter proxies).
            // Escalate the tier ladder — same contract as the 400 stealth hint.
            const err = new Error(`Scrapingdog response not JSON: ${data.slice(0, 100)}`);
            err.escalate = true;
            reject(err);
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          scrapingDogDown = true;
          reject(new Error(
            `Scrapingdog ${res.statusCode}: ${data.slice(0, 200)} — verify SCRAPINGDOG_API_KEY ` +
            `is current and the account has credits; disabling Scrapingdog for this run`
          ));
        } else {
          const err = new Error(`Scrapingdog HTTP ${res.statusCode} (${tier.name}): ${data.slice(0, 120)}`);
          // 400 + "Stealth Mode" hint = target needs a higher proxy tier
          if (res.statusCode === 400 && /stealth/i.test(data)) err.escalate = true;
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch via Bright Data (primary proxy fallback)
 * Sends params in POST body (API validates body, not query params).
 * Uses BRIGHTDATA_ZONE (default web_unlocker2 — matches scraper.js; mcp_unlocker was deleted in the 2026 zone migration).
 */
async function fetchViaBrightData(url) {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) return null; // Not available

  stats.brightData++;

  // Try zone from env (default: web_unlocker2)
  const zones = [process.env.BRIGHTDATA_ZONE || 'web_unlocker2'];

  for (const zone of zones) {
    try {
      return await brightDataRequest(token, zone, url);
    } catch (e) {
      if (e.permanent) {
        brightDataDown = true;
        throw e;
      }
      console.warn(`  Bright Data ${zone}: ${e.message}`);
    }
  }

  brightDataDown = true;
  throw new Error('Bright Data: all zones failed');
}

/**
 * Single Bright Data API request — params in POST body
 */
function brightDataRequest(token, zone, url) {
  const body = JSON.stringify({ zone, url, format: 'raw' });

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Check for permanent zone errors in headers (zone disabled, trial exhausted, wrong type)
        const brdErrCode = res.headers['x-brd-err-code'];
        if (brdErrCode === 'client_10002' || brdErrCode === 'client_10090') {
          const brdErrMsg = res.headers['x-brd-err-msg'] || res.headers['x-brd-error'] || brdErrCode;
          const err = new Error(`Bright Data zone permanently unavailable: ${brdErrMsg}`);
          err.permanent = true;
          reject(err);
          return;
        }

        if (res.statusCode === 200) {
          if (!data) {
            // Empty body — zone error not caught by status code
            reject(new Error('response not JSON: (empty body)'));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            // Try to extract JSON from HTML wrapper
            const jsonMatch = data.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            if (jsonMatch) {
              try { resolve(JSON.parse(jsonMatch[0])); return; } catch (_) { /* fall through */ }
            }
            reject(new Error(`response not JSON: ${data.slice(0, 200)}`));
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error(`${res.statusCode} auth/quota issue`);
          err.permanent = true;
          reject(err);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Fetch URL directly from Reddit
 * Uses native fetch() (Node 18+) which has a different TLS fingerprint than
 * https.get() — Reddit blocks https.get() but allows fetch().
 */
async function fetchRedditDirect(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  });

  if (res.status === 200) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      stats.redditDirect++;
      return parsed;
    } catch (e) {
      if (text.includes('<html') || text.includes('<!DOCTYPE')) {
        throw { code: 'HTML_RESPONSE', message: 'Reddit returned HTML instead of JSON' };
      }
      throw new Error(`JSON parse failed: ${text.slice(0, 100)}`);
    }
  } else if (res.status === 429) {
    throw { code: 'RATE_LIMITED', statusCode: 429 };
  } else if (res.status === 403) {
    throw { code: 'FORBIDDEN', statusCode: 403 };
  } else {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
  }
}

/**
 * Fetch URL with direct Reddit access, fallback to ScrapingBee
 */
async function fetchWithFallback(url, retryCount = 0) {
  // Circuit breaker: if too many consecutive failures, stop wasting time
  if (circuitBroken) {
    throw new Error('Circuit breaker open: all Reddit sources failing consistently. Aborting to save time.');
  }

  try {
    const result = await _fetchWithFallbackInner(url, retryCount);
    // Success — reset circuit breaker counter
    consecutiveFailures = 0;
    return result;
  } catch (e) {
    consecutiveFailures++;
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !circuitBroken) {
      circuitBroken = true;
      console.error(`\n⚠ CIRCUIT BREAKER: ${consecutiveFailures} consecutive failures across all Reddit sources. Stopping further requests to avoid wasting the remaining timeout.`);
    }
    throw e;
  }
}

async function _fetchWithFallbackInner(url, retryCount = 0) {
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
    // Try Scrapingdog (cheap tier, before ScrapingBee to conserve SB credits)
    if (process.env.SCRAPINGDOG_API_KEY && !scrapingDogDown) {
      try {
        return await fetchViaScrapingDog(url);
      } catch (e) {
        console.warn(`  Scrapingdog failed: ${e.message}`);
      }
    }
    // Try ScrapingBee (last proxy resort)
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
  if (useScrapingBee && scrapingBeeDown && brightDataDown && scrapingDogDown) {
    stats.errors++;
    throw new Error('All sources unavailable: Reddit (403), Bright Data (down), Scrapingdog (down), ScrapingBee (down — see prior 401/402 reason)');
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
        return _fetchWithFallbackInner(url, retryCount + 1);
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
 * Switch to proxy fallback chain: Bright Data → Scrapingdog → ScrapingBee
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

  // Try Scrapingdog (cheap tier, before ScrapingBee to conserve SB credits)
  if (process.env.SCRAPINGDOG_API_KEY && !scrapingDogDown) {
    try {
      console.warn('  Falling back to Scrapingdog');
      return await fetchViaScrapingDog(url);
    } catch (e) {
      console.warn(`  Scrapingdog failed: ${e.message}`);
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
  if (scrapingDogDown) reasons.push('Scrapingdog (down — invalid key or credits; see prior 401/403)');
  if (scrapingBeeDown) reasons.push('ScrapingBee (down — invalid key or credits; see prior 401/402)');
  if (!process.env.BRIGHTDATA_TOKEN) reasons.push('Bright Data (no token)');
  if (!process.env.SCRAPINGDOG_API_KEY) reasons.push('Scrapingdog (no key)');
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

  const url = `https://www.reddit.com/r/${subreddit}/search.json?${params}`;
  return fetchWithFallback(url);
}

/**
 * Get comments from a specific post
 */
async function getPostComments(subreddit, postId, options = {}) {
  const { limit = 500, depth = 10 } = options;
  const url = `https://www.reddit.com/r/${subreddit}/comments/${postId}.json?limit=${limit}&depth=${depth}&raw_json=1`;
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
        const { id, author, body, score } = child.data;
        if (body && body !== '[deleted]' && body !== '[removed]') {
          comments.push({ id, author, body, score: score || 0 });
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
async function collectCommentsFromPosts(subreddit, posts, maxComments = 1000, perPostMax = Infinity) {
  const allComments = [];

  for (const post of posts) {
    if (allComments.length >= maxComments) break;

    try {
      const response = await getPostComments(subreddit, post.id);
      const comments = flattenComments(response);
      // Cap any single post's contribution — a high-comment roundup/megathread
      // that slips past the title guard can't dominate the sentiment sample.
      const kept = Number.isFinite(perPostMax) ? comments.slice(0, perPostMax) : comments;
      // Stamp each comment with the thread it came from. The relevance classifier
      // uses the post title to tell whether the thread is actually about the target
      // PRODUCTION (vs. a novel/film/common phrase that merely shares the show's
      // name), so an ambiguous "I saw it" in an off-topic thread is rejected instead
      // of blindly attributed. See buzz-classifier.buildPrompt.
      for (const c of kept) {
        c.postTitle = post.title || '';
        c.postId = post.id;
      }
      allComments.push(...kept);

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
  return { ...stats, rateLimitCount, usingScrapingBee: useScrapingBee, circuitBroken, consecutiveFailures };
}

/**
 * Reset state (for testing)
 */
function resetFallbackState() {
  useScrapingBee = false;
  scrapingBeeDown = false;
  brightDataDown = false;
  scrapingDogDown = false;
  sdTierIndex = 0;
  scrapingBeeSwitchTime = 0;
  rateLimitCount = 0;
  lastRequestTime = 0;
  circuitBroken = false;
  consecutiveFailures = 0;
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
  fetchViaScrapingBee,
  fetchViaScrapingDog
};
