/**
 * Read one page in a Browserbase (or any Playwright) page, waiting out a Cloudflare managed challenge (BRO-6073).
 *
 * Shared by collect-talkinbroadway-index.js and the opening-night lane's Browserbase fetch, so the challenge test and
 * the wait live in one place. It never throws on a challenge or a short page: it reports `challenge` and the page as it
 * stands, and each caller decides (the collector refuses anything under 500 chars; the lane hands a 404 back as content
 * so a missing Talkin' Broadway page is the normal "not filed yet" answer, not a fetch failure).
 */
'use strict';

const CHALLENGE = /just a moment|checking your browser|cf-chl|attention required|enable javascript and cookies/i;

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{ timeoutMs?: number, waits?: number, waitMs?: number }} [opts] - goto timeout, then up to `waits` pauses of
 *   `waitMs` for the challenge to resolve itself
 * @returns {Promise<{ status: number|null, finalUrl: string, title: string, text: string, html: string,
 *   anchors: Array<{href: string, text: string}>, canonical: string|null, challenge: boolean }>}
 */
async function readBrowserPage(page, url, { timeoutMs = 45000, waits = 6, waitMs = 2500 } = {}) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const status = resp ? resp.status() : null;
  const bodyText = () => page.evaluate(() => (document.body && document.body.innerText) || '');
  for (let i = 0; i < waits; i++) {
    const title = await page.title();
    const body = await bodyText();
    const challenged = CHALLENGE.test(title) || CHALLENGE.test(body.slice(0, 400));
    // A real 404/410 is short by nature: stop waiting for it to grow.
    if (!challenged && (body.length > 200 || status === 404 || status === 410)) break;
    await page.waitForTimeout(waitMs);
  }
  const title = await page.title();
  const text = await bodyText();
  const anchors = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 120) })));
  const canonical = await page.evaluate(() => {
    const el = document.querySelector('link[rel="canonical"]') || document.querySelector('meta[property="og:url"]');
    return el ? (el.getAttribute('href') || el.getAttribute('content')) : null;
  });
  const html = await page.content();
  return { status, finalUrl: page.url(), title, text, html, anchors, canonical, challenge: CHALLENGE.test(title) || CHALLENGE.test(text.slice(0, 400)) };
}

module.exports = { CHALLENGE, readBrowserPage };
