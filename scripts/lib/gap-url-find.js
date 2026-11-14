'use strict';
/**
 * gap-url-find.js — find the original web address of a review we only know
 * from a quote (NO_URL), using free sources first (BRO-7171, owner challenge
 * 2026-11-09: 780 "not findable" reviews were written off after a 0/20 SERP
 * pilot on Daily Mail alone; no other method had been tried).
 *
 * Methods, in cost order (each returns candidate urls; none decides identity:
 * the gap-acceptance gate does that on the fetched text):
 *   AGG_LINK        outbound links to the outlet on the aggregator pages we
 *                   already archived for the show (data/aggregator-archive)
 *   OUTLET_SITEMAP  the outlet's own dated sitemap for the review's day
 *                   (adapters only where the outlet publishes one)
 *   WAYBACK_CDX     Wayback CDX: the outlet's host + review-section prefix
 *                   (learned from our own corpus), date window, show-title
 *                   keyword filter
 *   COMMON_CRAWL    Common Crawl url index, same filter (often overloaded)
 *   SERP            url-discovery.discoverCorrectUrl (paid)
 *   SLUG_GUESS      the outlet's url template learned from our corpus with
 *                   this show's slug put in, verified by fetch
 *
 * Pure helpers are exported for tests; IO goes through `deps`.
 */

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'our', 'a', 'an', 'of', 'to', 'at', 'in', 'on', 'is', 'it',
  'musical', 'play', 'new', 'review', 'theatre', 'theater', 'broadway', 'london', 'west', 'end', 'revival', 'tour']);

const METHODS = Object.freeze(['AGG_LINK', 'OUTLET_SITEMAP', 'WAYBACK_CDX', 'COMMON_CRAWL', 'SERP', 'SLUG_GUESS']);

function asciiFold(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, ''); }

/** Distinctive lowercase title words (>=3 chars, not stop words). */
function titleTokens(title) {
  const words = asciiFold(title).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const sig = words.filter((w) => w.length >= 3 && !STOP.has(w));
  return sig.length ? [...new Set(sig)] : [...new Set(words.filter((w) => w.length >= 2))];
}

/** The url path words (slug), lowercased. Never used as identity, only to rank candidates. */
function pathWords(url) {
  let p = '';
  try { p = decodeURIComponent(new URL(url).pathname); } catch { p = String(url || ''); }
  return asciiFold(p).toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Share of the title's tokens present as whole words in the url path (0..1). */
function slugTitleScore(url, title) {
  const toks = titleTokens(title);
  if (!toks.length) return 0;
  const words = new Set(pathWords(url));
  return toks.filter((t) => words.has(t)).length / toks.length;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const DAY = 86400000;

/** Fallback window from the show id's year (no date on file or show). */
function yearWindow(showId) {
  const y = (String(showId || '').match(/-(\d{4})$/) || [])[1];
  if (!y) return null;
  return { from: `${y}0101`, to: `${Number(y) + 1}0630`, anchor: `${y}0101`, anchorKind: 'showIdYear' };
}

/**
 * Wayback / sitemap date window for a review. A stored publishDate is the
 * strongest anchor; else the show's opening (press) date, else previews.
 * @returns {{from:string,to:string,anchor:string,anchorKind:string}|null} yyyymmdd
 */
function dateWindow(review, show, { wide = false } = {}) {
  const t = (v) => { const x = Date.parse(v || ''); return Number.isFinite(x) ? x : null; };
  const pd = t(review && review.publishDate);
  const od = t(show && show.openingDate);
  const pv = t(show && show.previewsStartDate);
  const anchor = pd || od || pv;
  if (!anchor) return null;
  const kind = pd ? 'publishDate' : od ? 'openingDate' : 'previewsStartDate';
  const before = pd ? 4 : 30;
  const after = wide ? 3 * 365 : (pd ? 21 : 75);
  return { from: ymd(anchor - before * DAY), to: ymd(anchor + after * DAY), anchor: ymd(anchor), anchorKind: kind };
}

/**
 * Where an outlet keeps its reviews, learned from urls already in our corpus
 * for that outlet. Pure.
 * @param {string[]} urls corpus urls of the outlet (any tier)
 * @returns {{hosts:string[], prefixes:string[]}} prefixes are "host/seg" (no scheme)
 */
function learnOutletProfile(urls) {
  const hostN = new Map();
  const preN = new Map();
  let n = 0;
  for (const u of urls) {
    let x; try { x = new URL(u); } catch { continue; }
    if (/web\.archive\.org|archive\.ph|archive\.today/.test(x.hostname)) continue;
    n++;
    const host = x.hostname.replace(/^www\./, '');
    hostN.set(host, (hostN.get(host) || 0) + 1);
    const seg = x.pathname.split('/').filter(Boolean)[0];
    // Date-first paths (/2018/06/...) and ids carry no section: use the host.
    if (seg && !/^\d+$/.test(seg) && !/\.(?:html?|asp|php)$/i.test(seg)) {
      const k = `${host}/${seg}`;
      preN.set(k, (preN.get(k) || 0) + 1);
    }
  }
  if (!n) return { hosts: [], prefixes: [] };
  const hosts = [...hostN.entries()].filter(([, c]) => c / n >= 0.1).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => h);
  const prefixes = [...preN.entries()].filter(([k, c]) => c / n >= 0.15 && hosts.includes(k.split('/')[0]))
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return { hosts, prefixes };
}

/**
 * Directories where the outlet's review slugs START with the show title,
 * learned from our corpus (e.g. telegraph.co.uk/theatre/what-to-see/,
 * thestage.co.uk/reviews/{year}/). A prefix query on <dir><title-slug> is the
 * cheapest Wayback lookup there is (no date scan). Pure.
 * @param {Array<{url:string,title:string}>} samples
 * @returns {string[]} "host/path/" dirs, {year} where a year segment varies
 */
function learnTitleStartDirs(samples) {
  const n = new Map();
  for (const { url, title } of samples) {
    if (!title) continue;
    let x; try { x = new URL(url); } catch { continue; }
    const segs = x.pathname.split('/').filter(Boolean);
    if (segs.length < 2) continue;
    const last = segs[segs.length - 1].toLowerCase();
    const slug = slugify(title);
    if (slug.length < 3 || !last.startsWith(slug)) continue;
    const dir = `${x.hostname.replace(/^www\./, '')}/${segs.slice(0, -1).map((s) => (/^(?:19|20)\d{2}$/.test(s) ? '{year}' : s)).join('/')}/`;
    n.set(dir, (n.get(dir) || 0) + 1);
  }
  return [...n.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
}

/** Cheap no-date Wayback prefix queries on title-start dirs (pure). */
function titleStartQueries({ dirs, title, years }) {
  const words = slugify(title).split('-').filter(Boolean);
  if (!words.length) return [];
  const stem = words.slice(0, Math.min(words.length, 3)).join('-');
  const out = [];
  for (const d of dirs) {
    const ys = d.includes('{year}') ? years : [null];
    for (const y of ys) {
      out.push('https://web.archive.org/cdx/search/cdx?' + new URLSearchParams({
        url: `${d.replace('{year}', y)}${stem}`, matchType: 'prefix', collapse: 'urlkey', fl: 'original,timestamp,statuscode', limit: '100',
      }).toString());
    }
  }
  return out;
}

/**
 * Outbound links from an aggregator page to the outlet's hosts. Pure.
 * @returns {Array<{url:string, anchor:string, context:string}>}
 */
function extractOutboundLinks(html, hosts) {
  if (!html || !hosts || !hosts.length) return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?href\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[2].replace(/&amp;/g, '&');
    const { unwrapArchiveSnapshotUrl } = require('./archive-snapshot-url');
    href = unwrapArchiveSnapshotUrl(href) || href;
    let host; try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    let p = ''; try { p = new URL(href).pathname; } catch { /* ignore */ }
    if (!p || p === '/' || p.split('/').filter(Boolean).length < 1) continue;
    const key = href.replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const ctxStart = Math.max(0, m.index - 600);
    const context = html.slice(ctxStart, m.index + m[0].length + 300).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    out.push({ url: href, anchor: m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), context });
  }
  return out;
}

/** Lower-cased, accent-folded surname; the acceptance gate's rule (camel-case joins split). */
function surnameOf(name) {
  return asciiFold(require('./gap-acceptance').surnameOf(name)).toLowerCase();
}

/**
 * Rank candidate urls for one review: critic surname near the link, title
 * words in the slug, inside the date window when a capture date is known.
 * Pure. Highest first; ties keep input order.
 */
function rankCandidates(cands, { title, criticName }) {
  const sur = surnameOf(criticName);
  const scored = cands.map((c, i) => {
    let s = slugTitleScore(c.url, title) * 2;
    if (sur && sur !== 'unknown' && asciiFold(`${c.anchor || ''} ${c.context || ''}`).toLowerCase().includes(sur)) s += 1.5;
    if (sur && sur !== 'unknown' && pathWords(c.url).includes(sur)) s += 0.5;
    if (/\b(?:review|reviews|theatre|theater|stage|culture|arts|entertainment)\b/.test(pathWords(c.url).join(' '))) s += 0.3;
    return { ...c, score: Math.round(s * 100) / 100, i };
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i);
}

/** CDX regex token: the longest title token (CDX filter is server-side). */
function cdxFilterToken(title) {
  const toks = titleTokens(title).sort((a, b) => b.length - a.length);
  return toks[0] || null;
}

/** Wayback CDX query urls for a review (pure; the caller fetches). */
function waybackQueries({ profile, title, window }) {
  const tok = cdxFilterToken(title);
  if (!tok || !window) return [];
  const roots = profile.prefixes.length ? profile.prefixes.map((p) => `${p}/`) : profile.hosts.map((h) => `${h}/`);
  return roots.map((root) => 'https://web.archive.org/cdx/search/cdx?' + new URLSearchParams({
    url: root, matchType: 'prefix', from: window.from, to: window.to,
    filter: `original:.*${tok}.*`, collapse: 'urlkey', fl: 'original,timestamp,statuscode', limit: '200',
  }).toString().replace(/filter=original%3A/, 'filter=original:'));
}

/** Parse CDX text lines into candidates whose slug matches the title. Pure. */
function parseCdxCandidates(text, title, { minScore = 0.5 } = {}) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    const [orig, ts, status] = line.trim().split(/\s+/);
    if (!orig || !/^https?:/.test(orig)) continue;
    if (/\/(?:amp|tmg\.build|window\.JSON|ak\.[a-z0-9]+)\/?$/i.test(orig) || /\.(?:jpg|png|gif|css|js|json|xml)(?:$|\?)/i.test(orig)) continue;
    const key = orig.replace(/^https?:\/\/(?:www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    if (slugTitleScore(orig, title) < minScore) continue;
    seen.add(key);
    out.push({ url: orig.replace(/^http:/, 'https:'), capturedAt: ts, status });
  }
  return out;
}

/**
 * Learn a fill-in url template for the outlet from corpus urls whose path
 * holds their own show's slug words verbatim. Pure.
 * @param {Array<{url:string,title:string}>} samples
 * @returns {string[]} templates with {slug}, most common first
 */
function learnSlugTemplates(samples) {
  const n = new Map();
  for (const { url, title } of samples) {
    const slug = titleTokens(title).length ? slugify(title) : null;
    if (!slug || !url || !url.includes(`/${slug}`)) continue;
    const t = url.replace(/^http:/, 'https:').replace(`/${slug}`, '/{slug}');
    // Only a segment that is the slug (optionally "-review") is guessable; a
    // slug followed by headline words is not.
    const seg = (t.split('/').find((x) => x.includes('{slug}')) || '').replace(/\.html?$/, '');
    if (!/^\{slug\}(?:-review)?$/.test(seg)) continue;
    if (/\d{3,}/.test(t.replace(/\/(?:19|20)\d{2}\//g, '/'))) continue; // ids: not guessable
    if (/\/(?:19|20)\d{2}\//.test(t)) continue; // dated paths: not guessable without the date
    n.set(t, (n.get(t) || 0) + 1);
  }
  return [...n.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t);
}

function slugify(title) {
  return asciiFold(title).toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Daily Mail / Mail on Sunday day sitemaps (free, one file per day). */
const SITEMAP_ADAPTERS = Object.freeze({
  'daily-mail': (day) => `https://www.dailymail.co.uk/sitemap-articles-day~${day}.xml`,
  'mail-on-sunday': (day) => `https://www.dailymail.co.uk/sitemap-articles-day~${day}.xml`,
});

/** Days to read for a sitemap adapter: the anchor day and the few after it. */
function sitemapDays(window, { span = 4 } = {}) {
  if (!window) return [];
  const a = Date.parse(`${window.anchor.slice(0, 4)}-${window.anchor.slice(4, 6)}-${window.anchor.slice(6, 8)}`);
  const days = [];
  const start = window.anchorKind === 'publishDate' ? -1 : 0;
  for (let i = start; i < span; i++) days.push(new Date(a + i * DAY).toISOString().slice(0, 10));
  return days;
}

function parseSitemapLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) out.push(m[1].replace(/&amp;/g, '&'));
  return out;
}

// ---------------------------------------------------------------- IO side

function defaultDeps() {
  return {
    fetchText: async (url, { timeoutMs = 90000 } = {}) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) BroadwayScorecard/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      return r.text();
    },
    readFile: (p) => require('fs').readFileSync(p, 'utf8'),
    exists: (p) => require('fs').existsSync(p),
    discoverCorrectUrl: (review, sb, opts) => require('./url-discovery').discoverCorrectUrl(review, sb, opts),
  };
}

const AGG_DIRS = ['bww-roundups', 'bww-reviews', 'dtli', 'show-score', 'nyc-theatre', 'playbill-verdict', 'westendtheatre',
  'theatre-reviews', 'lbo-roundups', 'thestage-roundups', 'stagedoor'];

/** Aggregator pages we hold for a show: archive files by show id + aliases. */
function aggregatorFilesFor(showId, archiveDir, deps) {
  const path = require('path');
  const out = [];
  const base = showId.replace(/-(?:west-end|off-broadway|off-west-end|tour|regional)?-?(\d{4})$/, '-$1');
  for (const d of AGG_DIRS) {
    for (const id of [...new Set([showId, base])]) {
      for (const ext of ['.html', '.json']) {
        const p = path.join(archiveDir, d, id + ext);
        if (deps.exists(p)) out.push(p);
      }
    }
  }
  return out;
}

/**
 * Run one method for one review. Returns {method, candidates[], error?, cost}.
 * `ctx` = { review, show, title, profile, hosts, archiveDir, templates, serpKeys, allowPaid }
 */
async function runMethod(method, ctx, deps = defaultDeps()) {
  const { review, show, title, profile } = ctx;
  const res = { method, candidates: [], tried: [], error: null, paid: 0 };
  try {
    if (method === 'AGG_LINK') {
      const files = aggregatorFilesFor(review.showId, ctx.archiveDir, deps);
      res.tried.push(`${files.length} archived aggregator page(s)`);
      for (const f of files) {
        const links = extractOutboundLinks(deps.readFile(f), ctx.hosts);
        // Site navigation (a BWW page links to BWW everywhere): keep links whose
        // slug names the show or whose surrounding text names the critic.
        const sur = surnameOf(review.criticName);
        const relevant = (l) => slugTitleScore(l.url, title) >= 0.5
          || (sur && sur !== 'unknown' && asciiFold(`${l.anchor} ${l.context}`).toLowerCase().includes(sur));
        for (const l of links.filter(relevant)) res.candidates.push({ ...l, from: require('path').basename(require('path').dirname(f)) });
      }
    } else if (method === 'OUTLET_SITEMAP') {
      const ad = SITEMAP_ADAPTERS[review.outletId];
      if (!ad) { res.tried.push('no sitemap adapter for outlet'); return res; }
      const w = dateWindow(review, show);
      for (const day of sitemapDays(w)) {
        const u = ad(day);
        res.tried.push(u);
        let xml; try { xml = await deps.fetchText(u, { timeoutMs: 60000 }); } catch (e) { res.error = `sitemap ${day}: ${e.message}`; continue; }
        for (const loc of parseSitemapLocs(xml)) if (slugTitleScore(loc, title) >= 0.5) res.candidates.push({ url: loc.replace('dailymail.com', 'dailymail.co.uk'), via: day });
      }
    } else if (method === 'WAYBACK_CDX' || method === 'COMMON_CRAWL') {
      if (!profile.hosts.length) { res.tried.push('no outlet host known'); return res; }
      const w = dateWindow(review, show) || yearWindow(review.showId);
      const stages = [];
      if (method === 'WAYBACK_CDX') {
        const y = Number(w ? w.anchor.slice(0, 4) : (String(review.showId).match(/(\d{4})$/) || [])[1]);
        if (ctx.titleDirs && ctx.titleDirs.length && y) stages.push(titleStartQueries({ dirs: ctx.titleDirs, title, years: [y, y + 1] }));
        if (w) stages.push(waybackQueries({ profile, title, window: w }));
      } else if (w) stages.push(commonCrawlQueries({ profile, title, window: w }));
      if (!stages.length) { res.tried.push('no date to anchor the search'); return res; }
      let errors = 0; let ran = 0;
      for (const qs of stages) {
        for (const q of qs) {
          res.tried.push(q);
          ran++;
          let txt;
          try { txt = await fetchIndexWithRetry(q, deps, deps.indexRetry || {}); } catch (e) {
            // The Common Crawl index answers 404 for "no captures": an empty result, not an outage.
            if (method === 'COMMON_CRAWL' && e.status === 404) { txt = ''; } else { errors++; res.error = `${method} ${e.message}`; continue; }
          }
          res.candidates.push(...(method === 'WAYBACK_CDX' ? parseCdxCandidates(txt, title) : parseCcCandidates(txt, title)));
        }
      }
      // Some queries answered: the method ran, the errors are reported but
      // the method only counts as done when every query answered.
      if (!ran) res.tried.push(method === 'COMMON_CRAWL' ? 'no crawl covers the review dates' : 'no date to anchor the search');
      if (errors && errors < ran) res.error = `${method} partial: ${errors}/${ran} queries failed`;
    } else if (method === 'SERP') {
      if (!ctx.allowPaid) { res.tried.push('paid search not allowed this run'); return res; }
      const { scrapingBeeKey = '', brightDataKey = '' } = ctx.serpKeys || {};
      if (!scrapingBeeKey && !brightDataKey) { res.error = 'no_serp_key'; return res; }
      res.paid++;
      const found = await deps.discoverCorrectUrl({ showId: review.showId, outletId: review.outletId, outlet: review.outlet, url: '', criticName: review.criticName, source: review.source }, scrapingBeeKey, { brightDataKey });
      res.tried.push('discoverCorrectUrl');
      if (found === '__SERP_UNAVAILABLE__') res.error = 'serp_unavailable';
      else if (found) res.candidates.push({ url: typeof found === 'string' ? found : found.url });
    } else if (method === 'SLUG_GUESS') {
      const slug = slugify(title);
      for (const t of ctx.templates || []) res.candidates.push({ url: t.replace('{slug}', slug), guessed: true });
      if (!(ctx.templates || []).length) res.tried.push('no fill-in url template for outlet (ids or dates in its urls)');
    }
  } catch (e) {
    res.error = `${method}: ${String(e.message).slice(0, 120)}`;
  }
  res.candidates = rankCandidates(res.candidates, { title, criticName: review.criticName });
  return res;
}

/**
 * The Wayback and Common Crawl indexes answer 503/429/504 under load. Retry
 * with backoff; a final failure is the caller's non-evidence `error`, never a
 * "nothing found".
 */
let lastIndexCallMs = 0;
const INDEX_MIN_GAP_MS = 4000;
async function fetchIndexWithRetry(q, deps, { tries = 2, baseMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    // Pace index calls: heavy prefix scans in a burst draw 503s.
    const wait = lastIndexCallMs + INDEX_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastIndexCallMs = Date.now();
    try { return await deps.fetchText(q, { timeoutMs: 90000 }); } catch (e) {
      last = e;
      const transient = !e.status || [429, 500, 502, 503, 504].includes(e.status);
      if (!transient) throw e;
      await sleep(baseMs * (i + 1) * (i + 1));
    }
  }
  throw last;
}

// Common Crawl: one index per crawl; pick the crawls covering the window.
let _ccCollections = null;
function setCcCollections(list) { _ccCollections = list; }
function commonCrawlQueries({ profile, title, window }) {
  const tok = cdxFilterToken(title);
  if (!tok || !window || !_ccCollections) return [];
  const from = Date.parse(`${window.from.slice(0, 4)}-${window.from.slice(4, 6)}-${window.from.slice(6, 8)}`);
  const to = Date.parse(`${window.to.slice(0, 4)}-${window.to.slice(4, 6)}-${window.to.slice(6, 8)}`);
  const cols = _ccCollections.filter((c) => Date.parse(c.to) >= from && Date.parse(c.from) <= to + 120 * DAY).slice(-3);
  const roots = profile.prefixes.length ? profile.prefixes : profile.hosts;
  const out = [];
  for (const c of cols) for (const r of roots.slice(0, 2)) out.push(`${c['cdx-api']}?url=${encodeURIComponent(`${r}/*`)}&output=json&filter=~url:.*${tok}.*&fl=url,timestamp,status&limit=200`);
  return out;
}
function parseCcCandidates(text, title) {
  const lines = String(text || '').split('\n').map((l) => { try { const j = JSON.parse(l); return `${j.url} ${j.timestamp} ${j.status}`; } catch { return ''; } });
  return parseCdxCandidates(lines.join('\n'), title);
}

// A method counts as tried only when it ran to the end: it found nothing, does
// not apply to the outlet (no sitemap adapter, no fill-in template), or every
// link it found was fetched and refused by the acceptance gate. 'error' (index
// down) and 'skipped_paid' (budget) do not count.
const METHOD_DONE = new Set(['no_candidates', 'not_applicable', 'candidates_refused']);
// The evidence rules a URL_FIND row was written under. Rows from older rules
// (2026-11-10 ship-check: timeouts counted as refusals, Wayback stopped after
// the first query, Common Crawl searched one crawl) never count as done; the
// next night re-runs those methods. Bump when what "done" means changes.
const URL_FIND_POLICY = 2;
// URL_FIND rows that carry method results (evidence or a refusal of the found link).
const URL_FIND_EVIDENCE = new Set(['no_evidence', 'rejected']);

/**
 * Which url-finding methods have run to the end for a review, from its LIVE
 * ledger rows (union across nights). Pure.
 * @returns {{done: Map<string,{status:string,ts:string,runId:string}>, missing: string[], evidence: string[]}}
 */
// A later night that FOUND a link through a method undoes that method's
// earlier "nothing found" (ship-check P1: the old union let night one's
// no_candidates outlive night two's found_unreadable). Errors undo nothing.
const METHOD_FOUND = new Set(['found', 'found_unreadable', 'more_candidates']);

function urlFindProgress(tries, methods = METHODS) {
  const done = new Map();
  for (const t of tries || []) {
    if (t.strategy !== 'URL_FIND') continue;
    const ms = (t.detail && t.detail.methods) || {};
    for (const [m, status] of Object.entries(ms)) {
      if (METHOD_FOUND.has(status)) done.delete(m);
      else if (METHOD_DONE.has(status) && URL_FIND_EVIDENCE.has(t.outcome) && (t.detail && t.detail.policy) === URL_FIND_POLICY) done.set(m, { status, ts: t.ts, runId: t.runId });
    }
  }
  const missing = methods.filter((m) => !done.has(m));
  const evidence = methods.filter((m) => done.has(m)).map((m) => `${m}: ${done.get(m).status} ${String(done.get(m).ts || '').slice(0, 10)} run ${done.get(m).runId || '?'}`);
  return { done, missing, evidence };
}

/**
 * Driver eligibility for URL_FIND. Pure.
 *   every method done                 -> url_find_exhausted (permanent)
 *   last attempt under cooldownH ago  -> url_find_cooldown (waiting)
 */
// A review whose last try found its link but could not read it (paywall, too
// short) waits a week, so the same few cannot take every nightly slot and
// re-buy Bright Data each night (ship-check P1).
const UNREADABLE_COOLDOWN_H = 7 * 24;

function urlFindEligibility(tries, { nowMs = Date.now(), cooldownH = 20 } = {}) {
  const prog = urlFindProgress(tries);
  if (!prog.missing.length) return { ok: false, reason: 'url_find_exhausted' };
  const uf = (tries || []).filter((t) => t.strategy === 'URL_FIND' && Number.isFinite(Date.parse(t.ts || '')));
  if (uf.length) {
    const latest = uf.reduce((a, b) => (Date.parse(b.ts) >= Date.parse(a.ts) ? b : a));
    const unreadable = ((latest.detail && latest.detail.foundUnreadable) || []).length > 0;
    const h = unreadable && cooldownH > 0 ? Math.max(cooldownH, UNREADABLE_COOLDOWN_H) : cooldownH; // 0 = manual override, no wait
    if (nowMs - Date.parse(latest.ts) < h * 3600000) return { ok: false, reason: unreadable ? 'url_find_unreadable_cooldown' : 'url_find_cooldown' };
  }
  return { ok: true, reason: `url_find_missing:${prog.missing.join('+')}` };
}

/**
 * Corpus index: per outlet, the urls we already hold and (url, show title)
 * pairs, to learn where the outlet keeps reviews. Reads every review file once.
 */
function buildCorpusIndex(dir, showTitleOf) {
  const fs = require('fs');
  const path = require('path');
  const idx = new Map();
  for (const showId of fs.readdirSync(dir)) {
    if (showId.startsWith('.') || showId.startsWith('_')) continue;
    let files; try { files = fs.readdirSync(path.join(dir, showId)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, showId, f), 'utf8')); } catch { continue; }
      if (!d || !d.url || !d.outletId || d.wrongShow || d.wrongProduction) continue;
      if (!idx.has(d.outletId)) idx.set(d.outletId, { urls: [], samples: [] });
      const e = idx.get(d.outletId);
      e.urls.push(d.url);
      e.samples.push({ url: d.url, title: showTitleOf(showId) || '' });
    }
  }
  return idx;
}

/** Hosts an outlet publishes on: corpus-learned + registry domain + aliases. */
function outletHosts(outletId, profile, registry) {
  const hosts = new Set(profile.hosts);
  const r = registry && registry[outletId];
  if (r && r.domain) hosts.add(String(r.domain).replace(/^www\./, ''));
  for (const a of (r && r.domainAliases) || []) hosts.add(String(a).replace(/^www\./, ''));
  try { const d = require('./url-discovery').OUTLET_DOMAINS[outletId]; if (d) hosts.add(d); } catch { /* none */ }
  return [...hosts];
}

/**
 * Fetch a found url's text: free fetchPage tiers, then the earliest Wayback
 * captures, then (only when allowed) Bright Data. Returns the longest text.
 * @returns {Promise<{ok:boolean, rawText?:string, html?:string, via?:string, url:string, tried:string[], paid:number}>}
 */
/**
 * Every fetch route answered with evidence about the PAGE: gone (404/410), no
 * archive capture, or fetched but nothing extractable. A timeout, 403, 402 or
 * fetch_error is a blocked route, not an answer (ship-check P1: those are
 * classed no_evidence by the fetch policy but say nothing about the link). Pure.
 */
const FETCH_EVIDENCE_RE = /^[a-z]+:(?:rejected\/|no_evidence\/(?:url_dead|url_not_found|archive_empty))/;
function fetchRefusedOnEvidence(tried) {
  return (tried || []).length > 0 && tried.every((t) => FETCH_EVIDENCE_RE.test(t));
}

/** A method that had nothing to search with (no host, no date, no crawl for the years). Pure. */
function methodNotApplicable(method, r, ctx) {
  const t = (r.tried || []).join(' | ');
  if (method === 'OUTLET_SITEMAP') return /no sitemap adapter/.test(t);
  if (method === 'SLUG_GUESS') return !(ctx.templates || []).length;
  if (method === 'WAYBACK_CDX' || method === 'COMMON_CRAWL') return /no outlet host known|no date to anchor the search|no crawl covers/.test(t);
  return false;
}

const DEAD_FREE_RE = /^free:no_evidence\/url_dead/;

async function fetchCandidateText(url, { allowBd = false, minChars = 1500, onPaid = null } = {}, deps = null) {
  const S = require('./gap-strategies');
  const d = deps || S.defaultDeps();
  const tried = [];
  let best = null;
  let paid = 0;
  const take = (r, label) => {
    tried.push(`${label}:${r.ok ? `ok ${r.rawText.length}` : `${r.outcome}/${r.reason}`}`);
    if (r.ok && (!best || r.rawText.length > best.rawText.length)) best = r;
  };
  take(await S.refetchFree({ url }, d), 'free');
  if (!best || best.rawText.length < minChars) take(await S.archive({ url }, d), 'wayback');
  // A free fetch that got a hard 404 and no capture: the link is dead, do not pay for it.
  const dead = !best && DEAD_FREE_RE.test(tried[0] || '') && /^wayback:no_evidence\//.test(tried[1] || '');
  if (allowBd && !dead && (!best || best.rawText.length < minChars)) {
    paid++;
    if (onPaid) onPaid();
    try {
      const res = await d.fetchPage(url, { tiers: ['brightdata'] });
      take(S.fromHtml(res && res.content, url, 'brightdata', d), 'brightdata');
    } catch (e) { tried.push(`brightdata:error ${String(e.message).slice(0, 60)}`); }
  }
  return best ? { ...best, url, tried, paid } : { ok: false, url, tried, paid };
}

/**
 * One attempts-ledger row for a read-only probe of one review (BRO-7171
 * 2026-11-10: a 30-file probe left no ledger trace). Strategy URL_FIND_PROBE
 * and outcome non_evidence, so it never cools down URL_FIND or counts as
 * write-off evidence; detail.methods carries each method's status. Pure.
 */
function probeMethodStatus(mr) {
  if (!mr) return 'not_run';
  if (mr.verified) return 'verified';
  if (mr.error) return 'error';
  if (mr.found > 0) return 'candidates_refused';
  if ((mr.tried || []).some((t) => /^no (sitemap|fill-in)|not applicable/i.test(String(t)))) return 'not_applicable';
  return 'no_candidates';
}

function probeLedgerRow(rec, { runId = null, ts = null } = {}) {
  const methods = {};
  let verifiedUrl = null;
  let foundAny = false;
  for (const [m, mr] of Object.entries(rec.methods || {})) {
    methods[m] = probeMethodStatus(mr);
    if (mr && mr.verified && !verifiedUrl) verifiedUrl = mr.verified;
    if (mr && mr.found > 0) foundAny = true;
  }
  return {
    ...(ts ? { ts } : {}),
    reviewKey: rec.reviewKey,
    gapClass: 'NO_URL',
    strategy: 'URL_FIND_PROBE',
    outcome: 'non_evidence',
    reason: verifiedUrl ? 'probe:verified' : foundAny ? 'probe:candidates_refused' : 'probe:none',
    url: verifiedUrl,
    runId,
    detail: { methods, foundBy: verifiedUrl ? Object.keys(methods).find((m) => methods[m] === 'verified') : null, readOnly: true },
  };
}

/**
 * URL_FIND order: recent shows first, then the highest-tier outlet (tier 1
 * best; unknown last), then the newest show, then a stable key. Pure.
 */
function urlFindPriority(tierOf) {
  const t = (c) => { const n = Number(tierOf(c.outletId)); return Number.isFinite(n) && n > 0 ? n : 9; };
  const d = (c) => { const x = Date.parse(c.showDate || ''); return Number.isFinite(x) ? x : 0; };
  return (a, b) => {
    if ((a.recency === 'recent') !== (b.recency === 'recent')) return a.recency === 'recent' ? -1 : 1;
    if (t(a) !== t(b)) return t(a) - t(b);
    if (d(a) !== d(b)) return d(b) - d(a);
    return String(a.reviewKey).localeCompare(String(b.reviewKey));
  };
}

/**
 * Which URL_FIND candidates run tonight, and how (BRO-7171 item c). The top
 * `paidSlots` by urlFindPriority take the places URL_FIND already held in the
 * run order (so they stay interleaved with the cheap re-fetches) and may use
 * every method; paid SERP and Bright Data stay inside their own per-run caps.
 * The next `freeSlots` run the free methods only (urlFindFreeOnly) and go to
 * the END of the run, after everything else. The rest wait. Pure: returns a
 * new array (with .skippedUrlFind), never mutates the input.
 */
function planUrlFindWork(work, { paidSlots, freeSlots = 0, tierOf }) {
  const uf = work.filter((c) => c.strategy === 'URL_FIND').sort(urlFindPriority(tierOf));
  const paid = uf.slice(0, Math.max(0, paidSlots));
  const free = uf.slice(paid.length, paid.length + Math.max(0, freeSlots));
  const out = [];
  let k = 0;
  for (const c of work) {
    if (c.strategy !== 'URL_FIND') { out.push(c); continue; }
    if (k < paid.length) out.push({ ...paid[k++], urlFindFreeOnly: false });
  }
  for (const c of free) out.push({ ...c, urlFindFreeOnly: true });
  out.skippedUrlFind = uf.length - paid.length - free.length;
  return out;
}

/**
 * A URL_FIND the driver reaches by falling back from another strategy (a
 * failed BROWSER_SESSION's reselect) was never planned, so it never took a
 * paid slot. It takes one while any are left, else it runs free-only. Pure.
 * @returns {{freeOnly:boolean, paidUsed:number}}
 */
function fallbackUrlFindSlot({ plannedStrategy, freeOnly, paidUsed, paidMax }) {
  if (freeOnly === true) return { freeOnly: true, paidUsed };
  if (plannedStrategy === 'URL_FIND') return { freeOnly: false, paidUsed }; // counted when planned
  if (paidUsed >= paidMax) return { freeOnly: true, paidUsed };
  return { freeOnly: false, paidUsed: paidUsed + 1 };
}

module.exports = {
  urlFindPriority,
  planUrlFindWork,
  fallbackUrlFindSlot,
  probeLedgerRow,
  buildCorpusIndex, outletHosts, fetchCandidateText, fetchRefusedOnEvidence, methodNotApplicable, urlFindProgress, urlFindEligibility, METHOD_DONE, URL_FIND_POLICY, fetchIndexWithRetry,
  METHODS, SITEMAP_ADAPTERS, titleTokens, pathWords, slugTitleScore, dateWindow, learnOutletProfile, extractOutboundLinks,
  rankCandidates, cdxFilterToken, waybackQueries, learnTitleStartDirs, titleStartQueries, yearWindow, parseCdxCandidates, learnSlugTemplates, slugify, sitemapDays,
  parseSitemapLocs, aggregatorFilesFor, runMethod, defaultDeps, commonCrawlQueries, parseCcCandidates, setCcCollections,
};
