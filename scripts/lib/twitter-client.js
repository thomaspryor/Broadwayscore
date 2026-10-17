/**
 * Twitter/X Client Module
 *
 * Posts tweets with optional images to Twitter/X via the v2 API.
 * Follows the same pattern as discord-notify.js: env-based config,
 * graceful failure if unconfigured, retry on transient errors.
 *
 * Environment variables:
 * - TWITTER_API_KEY - OAuth 1.0a API Key (Consumer Key)
 * - TWITTER_API_SECRET - OAuth 1.0a API Secret (Consumer Secret)
 * - TWITTER_ACCESS_TOKEN - OAuth 1.0a Access Token
 * - TWITTER_ACCESS_SECRET - OAuth 1.0a Access Token Secret
 *
 * Usage:
 *   const { postTweet, isConfigured } = require('./lib/twitter-client');
 *
 *   if (isConfigured()) {
 *     const result = await postTweet({ text: 'Hello!', imagePath: '/tmp/card.png' });
 *     console.log(result.tweetUrl);
 *   }
 */

const fs = require('fs');

let TwitterApi;
try {
  TwitterApi = require('twitter-api-v2').TwitterApi;
} catch {
  // Package not installed — isConfigured() will return false
  TwitterApi = null;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

/**
 * Check if Twitter credentials are configured
 */
function isConfigured() {
  if (!TwitterApi) return false;
  return !!(
    process.env.TWITTER_API_KEY &&
    process.env.TWITTER_API_SECRET &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_SECRET
  );
}

/**
 * Get an authenticated Twitter client
 */
function getClient() {
  return new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Post a tweet with optional image
 *
 * @param {Object} options
 * @param {string} options.text - Tweet text (max 280 chars)
 * @param {string} [options.imagePath] - Path to image file to attach
 * @returns {Promise<{success: boolean, tweetId?: string, tweetUrl?: string, error?: string}>}
 */
async function postTweet({ text, imagePath }) {
  if (!isConfigured()) {
    console.log('[Twitter] Not configured, skipping post');
    return { success: false, error: 'not_configured' };
  }

  const client = getClient();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let mediaId;

      // Upload image if provided
      if (imagePath && fs.existsSync(imagePath)) {
        console.log(`[Twitter] Uploading image: ${imagePath}`);
        mediaId = await client.v1.uploadMedia(imagePath);
      }

      // Post the tweet
      const tweetPayload = { text };
      if (mediaId) {
        tweetPayload.media = { media_ids: [mediaId] };
      }

      const result = await client.v2.tweet(tweetPayload);
      const tweetId = result.data.id;
      // Note: Twitter API doesn't return the username, so we construct a generic URL
      const tweetUrl = `https://x.com/i/status/${tweetId}`;

      console.log(`[Twitter] Posted successfully: ${tweetUrl}`);
      return { success: true, tweetId, tweetUrl };

    } catch (err) {
      const status = err.code || err.statusCode || 0;
      const isRetryable = status >= 500 || status === 429;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`[Twitter] Attempt ${attempt}/${MAX_RETRIES} failed (${status}), retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      console.error(`[Twitter] Failed to post (attempt ${attempt}/${MAX_RETRIES}):`, err.message || err);
      return { success: false, error: err.message || String(err) };
    }
  }

  return { success: false, error: 'max_retries_exceeded' };
}

module.exports = {
  postTweet,
  isConfigured,
};
