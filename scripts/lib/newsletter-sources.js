/**
 * Source readers for the weekly theater-newsletter job (BRO-6265).
 *
 * Chromolume and Abroad/Way are read from their public web pages (the emails link
 * nowhere citable). Broadway Briefing stays an email, but every fact is extracted from
 * and cited to the ORIGINAL article its bway.ly short link points at.
 *
 * Network access is injected (`fetchImpl`) so everything here is unit-testable; plain
 * `fetch` is used on purpose: these are known public endpoints, the newsletters job has
 * no scraping-provider secrets, and a scraping-provider call would drag in the spend
 * ledger (see finance-ingest.yml `newsletters`).
 */
'use strict';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UA = 'Mozilla/5.0 (compatible; BroadwayScorecardBot/1.0; +https://broadwayscorecard.com)';
const MIN_ARTICLE_CHARS = 600; // shorter than this is a paywall stub or a teaser, not an article
const MAX_BRIEFING_ITEMS = 12;
const MAX_HTML_BYTES = 2_000_000;
const CHROMOLUME_INDEX = 'https://chromolume.io/blog';
const ABROADWAY_FEED = 'https://gordoncox.substack.com/feed';

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', mdash: '-', ndash: '-', hellip: '...', middot: '.', copy: '', trade: '', divide: '/' };

function codePointChar(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePointChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePointChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

/** HTML to plain text; link targets stay visible as "anchor (url)". */
function htmlToText(html) {
  const noise = String(html || '').replace(/<(style|script|nav|footer|aside|form|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const withLinks = noise.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, ' $2 ($1) ');
  return decodeEntities(withLinks.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Chromolume blog index -> composite posts, newest first. Date comes from the slug. */
function parseChromolumeIndex(html) {
  const seen = new Map();
  const re = /href=["'](?:https?:\/\/(?:www\.)?chromolume\.io)?(\/blog\/composite-([a-z]+)-(\d{1,2})-(\d{4}))\/?["']/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const month = MONTHS.indexOf(m[2].toLowerCase());
    if (month < 0) continue;
    const date = `${m[4]}-${String(month + 1).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    seen.set(`https://chromolume.io${m[1].toLowerCase()}`, date);
  }
  return [...seen].map(([url, date]) => ({ url, date })).sort((a, b) => b.date.localeCompare(a.date));
}

function cdata(s) { return String(s || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim(); }
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? cdata(m[1]) : '';
}

/** Substack RSS -> [{ url, title, date, text }] newest first. */
function parseFeedItems(xml) {
  const items = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const time = Date.parse(tag(block, 'pubDate'));
    items.push({
      url: tag(block, 'link'),
      title: decodeEntities(tag(block, 'title')),
      date: Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '',
      text: htmlToText(tag(block, 'content:encoded') || tag(block, 'description')),
    });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

const BUSINESS_RE = /recoup|capitaliz|running cost|weekly cost|operating (?:cost|budget)|\bnut\b|investors?\b|\bprofit|\bloss(?:es)?\b|deficit|\braised\b|budget|financ|\bto close\b|closing|shutter|final performance|\$\s?\d[\d.,]*\s?(?:m\b|million|k\b|thousand)/i;

/**
 * Briefing email -> candidate items: each bway.ly link whose surrounding text mentions money
 * or a closing. Extraction happens on the destination article, not here; this only keeps
 * the number of fetches down.
 */
function splitBriefingItems(html, text) {
  const body = html ? htmlToText(html) : String(text || '');
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/bway\.ly\/[A-Za-z0-9_-]+/g;
  let m;
  while ((m = re.exec(body))) {
    const link = m[0].replace(/^http:/, 'https:');
    if (seen.has(link)) continue;
    seen.add(link);
    out.push({ link, context: body.slice(Math.max(0, m.index - 600), m.index + 600) });
  }
  const candidates = out.filter((i) => BUSINESS_RE.test(i.context)).slice(0, MAX_BRIEFING_ITEMS);
  return { linksFound: out.length, candidates };
}

const TRACKING_PARAM_RE = /^(utm_|fbclid|gclid|mc_|mkt_tok|ref$|ref_src)/i;
function stripTracking(u) {
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM_RE.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

/**
 * Resolve a bway.ly short link WITHOUT following it: one request to bway.ly itself,
 * read the Location header, accept only https destinations on a registered outlet.
 * That bounds SSRF (we never request an unvetted host) and keeps citations to real outlets.
 */
async function resolveBwayLink(raw, { fetchImpl = fetch, resolveOutlet }) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'bad-link' }; }
  if (u.hostname.toLowerCase() !== 'bway.ly' || !/^\/[A-Za-z0-9_-]+$/.test(u.pathname)) return { ok: false, reason: 'not-bway-ly' };
  let res;
  try {
    res = await fetchImpl(`https://bway.ly${u.pathname}`, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  } catch { return { ok: false, reason: 'link-unreachable' }; }
  const loc = res.headers && res.headers.get('location');
  if (!(res.status >= 300 && res.status < 400) || !loc) return { ok: false, reason: 'link-did-not-redirect' };
  let dest;
  try { dest = new URL(loc, 'https://bway.ly'); } catch { return { ok: false, reason: 'bad-destination' }; }
  if (dest.protocol !== 'https:') return { ok: false, reason: 'destination-not-https' };
  if (!resolveOutlet(dest.toString())) return { ok: false, reason: 'destination-not-registered-outlet' };
  return { ok: true, url: stripTracking(dest) };
}

/**
 * Fetch one public page as text. `isAllowed(url)` is checked on the request AND the final
 * URL after redirects. Reasons: fetch-blocked (401/402/403/429: paywall or bot wall),
 * http-<n>, body-too-short, not-html, fetch-failed.
 */
async function fetchPublicText(url, { fetchImpl = fetch, isAllowed, types = /html|xml|text/i }) {
  if (!isAllowed(url)) return { ok: false, reason: 'host-not-allowed' };
  let res;
  let cur = url;
  try {
    // Follow redirects by hand so every hop is checked before it is requested.
    for (let hop = 0; hop < 4; hop++) {
      res = await fetchImpl(cur, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,application/json' }, signal: AbortSignal.timeout(20000) });
      const loc = res.status >= 300 && res.status < 400 && res.headers && res.headers.get('location');
      if (!loc) break;
      cur = new URL(loc, cur).toString();
      if (!isAllowed(cur)) return { ok: false, reason: 'redirected-off-allowlist' };
      res = null;
    }
  } catch { return { ok: false, reason: 'fetch-failed' }; }
  if (!res) return { ok: false, reason: 'too-many-redirects' };
  if (res.url && !isAllowed(res.url)) return { ok: false, reason: 'redirected-off-allowlist' };
  if (!res.ok) return { ok: false, reason: [401, 402, 403, 429].includes(res.status) ? 'fetch-blocked' : `http-${res.status}` };
  const type = (res.headers && res.headers.get('content-type')) || '';
  if (type && !types.test(type)) return { ok: false, reason: 'not-html' };
  const body = (await res.text()).slice(0, MAX_HTML_BYTES);
  return { ok: true, body };
}

/**
 * Substack archive JSON (the /feed fallback, since GitHub runner IPs get 403 on /feed).
 * Public posts only, newest first.
 */
function parseArchiveJson(raw) {
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p) => p && p.slug && p.canonical_url && (!p.audience || p.audience === 'everyone'))
    .map((p) => ({ url: p.canonical_url, slug: p.slug, title: p.title || p.slug, date: String(p.post_date || '').slice(0, 10) }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function postBodyFromJson(raw) {
  try { const j = JSON.parse(raw); return j && j.body_html ? htmlToText(j.body_html) : ''; } catch { return ''; }
}

function articleText(html) {
  const main = String(html || '').match(/<article[\s\S]*?<\/article>/i);
  return htmlToText(main ? main[0] : html);
}

/** Posts to read this run. Dry runs always take the newest N so a person can see the reader work. */
function pickPosts(listing, processedUrls, { maxNew, dryRun }) {
  const done = new Set(processedUrls || []);
  const fresh = dryRun ? listing : listing.filter((p) => !done.has(p.url));
  return { toRead: fresh.slice(0, maxNew), unreadOlder: Math.max(0, fresh.length - maxNew) };
}

const IGNORED_FOR_RATIO = new Set(['older-than-window', 'sender-not-allowlisted']);

/**
 * Skip-ratio health check (BRO-6265 PREVENTION). `per` maps source key to
 * { label, found, read, skipped:{reason:n}, listingEmpty }. Alerts when more than half of
 * the issues found were not read, or when a source had nothing readable on 2 runs in a row.
 * Returns { alerts, zeroRuns } where zeroRuns is the new consecutive-zero counter per key.
 * Alerts are advisory routeAlert cards; they never fail the job.
 */
function evaluateSkipHealth(per, prevZeroRuns = {}) {
  const alerts = [];
  const zeroRuns = {};
  for (const [key, s] of Object.entries(per)) {
    const found = s.found || 0;
    const read = s.read || 0;
    const reasons = Object.entries(s.skipped || {}).filter(([r]) => !IGNORED_FOR_RATIO.has(r)).sort((a, b) => b[1] - a[1]);
    const detail = reasons.map(([r, n]) => `${r} x${n}`).join(', ') || 'none';
    if (found > 0 && (found - read) / found > 0.5) {
      alerts.push({
        conditionKey: `theater-newsletter-skip-ratio:${key}`,
        title: `Theater newsletter reader skipped ${found - read} of ${found} ${s.label} issues`,
        description: `The weekly reader could not read more than half of the ${s.label} issues it found (read ${read}, skipped ${found - read}). Skip reasons: ${detail}. Facts from this source are being missed.`,
        hint: 'Open the newsletters job log of the latest finance-ingest run: the per-issue lines show which step failed (source page layout, redirect, paywall). Fix the reader in scripts/lib/newsletter-sources.js.',
        disposition: 'auto',
        severity: 'warning',
      });
    }
    const zero = !!s.listingEmpty || (found > 0 && read === 0);
    zeroRuns[key] = zero ? (prevZeroRuns[key] || 0) + 1 : 0;
    if (zeroRuns[key] >= 2) {
      alerts.push({
        conditionKey: `theater-newsletter-zero-readable:${key}`,
        title: `Theater newsletter reader read nothing from ${s.label} for ${zeroRuns[key]} runs`,
        description: `Nothing from ${s.label} was readable on ${zeroRuns[key]} consecutive weekly runs (found ${found}, read ${read}${s.listingEmpty ? ', source listing empty or unreachable' : ''}). Skip reasons: ${detail}.`,
        hint: 'The source page, feed or email shape probably changed. Check the newsletters job log and update scripts/lib/newsletter-sources.js.',
        disposition: 'auto',
        severity: 'warning',
      });
    }
  }
  return { alerts, zeroRuns };
}

module.exports = {
  MIN_ARTICLE_CHARS,
  CHROMOLUME_INDEX,
  ABROADWAY_FEED,
  decodeEntities,
  htmlToText,
  articleText,
  parseChromolumeIndex,
  parseFeedItems,
  splitBriefingItems,
  stripTracking,
  resolveBwayLink,
  fetchPublicText,
  parseArchiveJson,
  postBodyFromJson,
  pickPosts,
  evaluateSkipHealth,
  BUSINESS_RE,
};
