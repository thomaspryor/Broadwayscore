/**
 * Plain-HTTPS fetch with subscriber Cookie header.
 *
 * Extracted from scraper.js so lightweight callers (check-cookie-health.js,
 * small utilities) can use the paywalled-fetch path without requiring the
 * full scraper module graph (Playwright, Bright Data, ScrapingBee).
 *
 * Rationale: paywalled outlets (WSJ, FT, Telegraph, NYT, etc.) gate reviews
 * behind subscriber cookies. For WSJ specifically, BD/Playwright trigger
 * DataDome bot detection even WITH cookies — plain HTTP with cookies
 * bypasses detection entirely (proven by scripts/recover-wsj-subscriber.js).
 */

const https = require('https');
const { buildCookieHeaderForUrl } = require('./cookie-loader');

async function fetchWithCookiesPlain(url) {
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (!cookieHeader) return null;

  // Build Referer from article origin — WSJ's DataDome and Condé Nast both
  // reject cookie-authenticated requests without Referer + Sec-Fetch-* signals,
  // even with a full subscriber cookie jar (verified 2026-04-23 via CI live
  // check: HTTP 401 without these, HTTP 200 with them).
  // Pattern proven by scripts/recover-wsj-subscriber.js.
  let referer;
  try {
    referer = new URL(url).origin + '/';
  } catch {
    return null;
  }

  try {
    const response = await new Promise((resolve, reject) => {
      const opts = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': cookieHeader,
          'Referer': referer,
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 20000,
      };

      const doRequest = (targetUrl, redirectCount = 0) => {
        if (redirectCount > 3) {
          reject(new Error('Too many redirects'));
          return;
        }
        const req = https.get(targetUrl, opts, (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, targetUrl).toString();
            doRequest(nextUrl, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('request timeout'));
        });
      };

      doRequest(url);
    });

    return {
      content: response,
      format: 'html',
      source: 'cookies-plain',
    };
  } catch (error) {
    console.error(`⚠️  Cookie-plain fetch failed: ${error.message}`);
    return null;
  }
}

module.exports = { fetchWithCookiesPlain };
