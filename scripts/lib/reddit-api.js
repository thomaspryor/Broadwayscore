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
const RATE_LIMIT_DELAY = 1000; // 1 second between requests
const MAX_RETRIES = 3;

// Track if direct API is working or if we should use ScrapingBee
let useScrapingBeeByDefault = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        } else {
          reject(new Error(`ScrapingBee HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch URL with direct Reddit access, fallback to ScrapingBee
 */
async function fetchWithFallback(url, retryCount = 0) {
  // If direct API has been failing, go straight to ScrapingBee
  if (useScrapingBeeByDefault && process.env.SCRAPINGBEE_API_KEY) {
    return fetchViaScrapingBee(url);
  }

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
      res.on('end', async () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            // Got HTML instead of JSON - Reddit is blocking
            if (data.includes('<html') || data.includes('<!DOCTYPE')) {
              console.warn('  Reddit returned HTML instead of JSON, switching to ScrapingBee');
              useScrapingBeeByDefault = true;
              if (process.env.SCRAPINGBEE_API_KEY) {
                resolve(fetchViaScrapingBee(url));
              } else {
                reject(new Error('Reddit blocked and no ScrapingBee key'));
              }
            } else {
              reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`));
            }
          }
        } else if (res.statusCode === 429) {
          // Rate limited - exponential backoff
          const delay = Math.min(60000, 5000 * Math.pow(2, retryCount));
          console.warn(`  Rate limited (429), waiting ${delay / 1000}s...`);
          if (retryCount < MAX_RETRIES) {
            sleep(delay).then(() => {
              fetchWithFallback(url, retryCount + 1).then(resolve).catch(reject);
            });
          } else {
            // Switch to ScrapingBee after max retries
            console.warn('  Max retries reached, switching to ScrapingBee');
            useScrapingBeeByDefault = true;
            if (process.env.SCRAPINGBEE_API_KEY) {
              resolve(fetchViaScrapingBee(url));
            } else {
              reject(new Error('Rate limited and no ScrapingBee key'));
            }
          }
        } else if (res.statusCode === 403) {
          // Forbidden - Reddit is blocking
          console.warn('  Reddit returned 403, switching to ScrapingBee');
          useScrapingBeeByDefault = true;
          if (process.env.SCRAPINGBEE_API_KEY) {
            resolve(fetchViaScrapingBee(url));
          } else {
            reject(new Error('Reddit blocked (403) and no ScrapingBee key'));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
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

  await sleep(RATE_LIMIT_DELAY);
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

  await sleep(RATE_LIMIT_DELAY);
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
}

module.exports = {
  searchSubreddit,
  getPostComments,
  flattenComments,
  searchAllPosts,
  collectCommentsFromPosts,
  resetFallbackState,
  // Expose for testing
  fetchWithFallback,
  fetchViaScrapingBee
};
