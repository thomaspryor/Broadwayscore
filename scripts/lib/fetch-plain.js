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
 *
 * Uses global fetch (undici) instead of https.get because DataDome
 * fingerprints Node's https TLS handshake and returns HTTP 401 even with a
 * valid subscriber cookie jar. undici's HTTP/2 + TLS stack matches what
 * recover-wsj-subscriber.js uses and passes DataDome without a challenge.
 */

const { buildCookieHeaderForUrl } = require('./cookie-loader');

async function fetchWithCookiesPlain(url) {
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (!cookieHeader) return null;

  let referer;
  try {
    referer = new URL(url).origin + '/';
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch(url, {
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
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const content = await resp.text();
    return {
      content,
      format: 'html',
      source: 'cookies-plain',
    };
  } catch (error) {
    clearTimeout(timeout);
    console.error(`⚠️  Cookie-plain fetch failed: ${error.message}`);
    return null;
  }
}

module.exports = { fetchWithCookiesPlain };
