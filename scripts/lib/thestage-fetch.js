/**
 * The Stage roundups: browser-free discovery + fetch (BRO-6101).
 *
 * scrape-thestage-roundups.js used to open a Browserbase session, load the
 * saved cookies and walk the "Load more" listing. That failed twice over: the
 * account-wide Browserbase cap refused the one session it needs (recovery
 * reserve held, 200/185), and the cookie check navigated with
 * waitUntil:'networkidle' and timed out. Its last success was 2026-06-09.
 *
 * Neither is needed. The roundups are server-rendered, the saved login works
 * over plain HTTPS (check-cookie-health.yml proves it daily via the same
 * fetchWithCookiesPlain), and every roundup URL is in the public sitemap, so
 * the 20-newest listing page no longer caps discovery. Pure parsing lives
 * here so it is unit-tested on real sitemap and archived HTML.
 */

const SITE = 'https://www.thestage.co.uk';
const SITEMAP_INDEX = `${SITE}/SiteMap_TheStage_index.xml`;
const LISTING_URL = `${SITE}/review-round-ups/review-round-ups`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Logged-out registration gate (same marker as scripts/lib/cookie-probes.js).
const GATE_RE = /utm_source=Reggate|create a free account|Subscribe to continue/i;
const CHALLENGE_RE = /captcha-delivery\.com|<title>\s*(?:Verifying Device|Just a moment\.\.\.)\s*<\/title>|Access is temporarily restricted/i;

// Newer pages carry a venue suffix after the marker (...-review-round-up-old-vic-london).
const ROUNDUP_PATH_RE = /^\/review-round-ups\/([a-z0-9-]+)-review-round-up(?:-[a-z0-9-]+)?\/?$/i;

function locs(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

/** Absolute roundup URLs found in a sitemap or listing body, in first-seen order, de-duplicated. */
function parseRoundupUrls(body) {
  const out = [];
  const seen = new Set();
  const candidates = [
    ...locs(body),
    ...[...String(body || '').matchAll(/href="([^"]*-review-round-up(?:-[a-z0-9-]+)?\/?)"/g)].map((m) => m[1]),
  ];
  for (const raw of candidates) {
    let u;
    try { u = new URL(raw, SITE); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== 'thestage.co.uk') continue;
    if (!ROUNDUP_PATH_RE.test(u.pathname)) continue;
    const href = `${SITE}${u.pathname.replace(/\/$/, '')}`;
    if (!seen.has(href)) { seen.add(href); out.push(href); }
  }
  return out;
}

/** Child sitemaps worth reading: the article ones (roundups live in Articles1). */
function parseArticleSitemaps(indexXml) {
  return locs(indexXml).filter((u) => /SiteMap_TheStage_Articles\d*_v\d+\.xml$/i.test(u));
}

/**
 * Classify a fetched roundup page.
 * 'ok'        rows extracted
 * 'gated'     the registration gate is served: the saved login is dead
 * 'challenge' bot interstitial: says nothing about the login
 * 'empty'     a real page with no extractable rows (template drift)
 */
function classifyRoundupPage(html, rowCount) {
  if (rowCount > 0) return 'ok';
  const h = String(html || '');
  if (CHALLENGE_RE.test(h)) return 'challenge';
  if (GATE_RE.test(h)) return 'gated';
  return 'empty';
}

const LOGIN_EXPIRED_MESSAGE =
  'THE STAGE LOGIN EXPIRED: The Stage served its registration gate with the saved cookies. '
  + 'Only the Mac can renew it (scripts/renew-cookies.js --outlet=thestage, launchd job com.broadwayscore.cookie-renew; '
  + 'manual: --manual). CI never logs in. Stopping without spending any Browserbase session.';

async function fetchPublic(url, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Every roundup URL The Stage publishes: public sitemaps first, the 20-newest listing as a cross-check. */
async function discoverRoundupUrlsPlain({ fetchImpl = fetch, log = console.log } = {}) {
  const urls = [];
  const seen = new Set();
  const add = (list) => { for (const u of list) if (!seen.has(u)) { seen.add(u); urls.push(u); } };

  try {
    const idx = await fetchPublic(SITEMAP_INDEX, { fetchImpl });
    for (const sm of parseArticleSitemaps(idx)) {
      try { add(parseRoundupUrls(await fetchPublic(sm, { fetchImpl }))); }
      catch (err) { log(`  sitemap ${sm} failed: ${err.message}`); }
    }
  } catch (err) {
    log(`  sitemap index failed: ${err.message}`);
  }
  const fromSitemap = urls.length;
  try { add(parseRoundupUrls(await fetchPublic(LISTING_URL, { fetchImpl }))); }
  catch (err) { log(`  listing page failed: ${err.message}`); }
  log(`  Discovered ${urls.length} roundup URLs (${fromSitemap} from sitemaps, ${urls.length - fromSitemap} extra from the listing)`);
  return urls;
}

module.exports = {
  SITE,
  SITEMAP_INDEX,
  LISTING_URL,
  GATE_RE,
  parseRoundupUrls,
  parseArticleSitemaps,
  classifyRoundupPage,
  discoverRoundupUrlsPlain,
  fetchPublic,
  LOGIN_EXPIRED_MESSAGE,
};
