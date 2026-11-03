'use strict';

/**
 * Multi-source review finder for city hubs that have no Theatre-In-X roundup site
 * (BRO-6854: San Diego, Boston). Two jobs:
 *
 *   enumerateProductions(cfg, ctx)      BroadwayWorld regional show listing -> productions
 *   findReviews(prod, cfg, ctx)         per production: outlet adapters -> candidate links
 *                                       -> article verification -> reviews with byline + date
 *
 * Every network call goes through ctx.fetch (scripts/city-finder.js passes fetchPage()),
 * so tests run on fixtures. Pure functions are exported for tests.
 *
 * Lessons carried from the Chicago audit: the article byline beats a listing's critic
 * name; "wrong production" is decided from the article's own title + theatre, never from
 * our dates; an article reviewing two productions is not a roundup.
 */

const { foldDiacritics } = require('./title-match');
const { extractPublishDate } = require('./article-extractor');

const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const decode = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&[lr]squo;/g, "'").replace(/&[lr]dquo;/g, '"').replace(/&[nm]dash;/g, '-');
const stripTags = (s) => decode(String(s || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Lowercase, diacritics folded, punctuation to spaces, articles dropped ("The Cher Show" -> "cher show"). */
function norm(t) {
  return foldDiacritics(decode(t)).toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when `needle` (a title or theatre phrase) appears in `hay` on token boundaries. */
function hasPhrase(hay, needle) {
  const n = norm(needle);
  if (!n) return false;
  return ` ${norm(hay)} `.includes(` ${n} `);
}

/** Title variants an article may use: full, before a colon, without a trailing "the musical". */
function titleVariants(title) {
  const out = new Set([title]);
  const colon = title.split(/\s*[:–—]\s+/)[0];
  if (colon && colon !== title) out.add(colon);
  const bare = title.replace(/\s+(the musical|a new musical|the play)$/i, '');
  if (bare !== title) out.add(bare);
  return [...out].filter((v) => norm(v).length >= 3);
}

const GENERIC_THEATRE_WORDS = new Set(['theatre', 'theater', 'company', 'stage', 'playhouse', 'productions', 'production', 'rep', 'repertory', 'players', 'group', 'collective', 'co', 'inc', 'llc', 'center', 'centre', 'co op']);

/** Distinctive phrases that identify a producing theatre in an article ("The Old Globe" -> "old globe"). */
function theatreAliases(theatre, extra = []) {
  const base = String(theatre || '').replace(/\([^)]*\)/g, ' ').replace(/\s+at\s+.*$/i, '').replace(/\s*\/\s*.*$/, '').trim();
  const out = new Set([norm(base)]);
  const toks = norm(base).split(' ').filter(Boolean);
  const stripped = toks.filter((t) => !GENERIC_THEATRE_WORDS.has(t)).join(' ');
  const PLACE = new Set(['san', 'diego', 'north', 'coast', 'scripps', 'ranch', 'la', 'jolla', 'old', 'town']);
  if (stripped && stripped.split(' ').length >= 2 && !stripped.split(' ').every((t) => PLACE.has(t))) out.add(stripped);
  for (const e of extra) out.add(norm(e));
  return [...out].filter((a) => a.length >= 4);
}

const NON_REVIEW_RE = /\b(interview|spotlight|casting|cast announced|announces?|to open|to premiere|to make|tickets?|on sale|season (?:announcement|lineup)|auditions?|podcast|obituary|in memoriam|photos?|video|preview|holiday guide|things to do|what to see|gala|fundraiser|hires?|appoints?|names?|confirms?|presents?|premieres?|welcomes?|inicio|season will)\b/i;

/** Reject obvious non-review pages from their title + url alone. */
function looksLikeNonReview(title, url) {
  const t = `${title || ''} ${decodeURIComponent(String(url || '')).replace(/[-_/]+/g, ' ')}`;
  if (/\breview\b/i.test(t)) return false;
  return NON_REVIEW_RE.test(t);
}

// ---------------------------------------------------------------- BroadwayWorld regional listing

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

/** "Oct 28 – Nov 22, 2026" / "May 3, 2026" / "Dec 30, 2026 – Jan 3, 2027" -> { start, end } ISO. */
function parseBwwDates(s) {
  const text = decode(s).replace(/\s+/g, ' ').trim();
  const re = /([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/g;
  const found = [];
  let m;
  while ((m = re.exec(text))) if (MONTHS[m[1].toLowerCase()]) found.push({ mo: MONTHS[m[1].toLowerCase()], d: Number(m[2]), y: m[3] ? Number(m[3]) : null });
  if (!found.length) return null;
  const last = found[found.length - 1];
  if (last.y == null) return null;
  const first = found[0];
  const y1 = first.y != null ? first.y : (first.mo > last.mo ? last.y - 1 : last.y);
  return { start: `${y1}-${pad(first.mo)}-${pad(first.d)}`, end: `${last.y}-${pad(last.mo)}-${pad(last.d)}` };
}

/** Parse /<region>/regionalshows/ cards. */
function parseBwwRegionalShows(html, region, base = 'https://www.broadwayworld.com') {
  const out = [];
  const cardRe = /<article class="bww-card[^"]*">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = cardRe.exec(html))) {
    const card = m[1];
    const link = new RegExp(`<a href="(/${region}/regional/[^"]+)"[^>]*>([^<]+)</a>\\s*</h2>`).exec(card);
    const meta = /<p class="bww-card__meta">([\s\S]*?)<\/p>/.exec(card);
    if (!link || !meta) continue;
    const dates = parseBwwDates(meta[1].split('·')[0]);
    const theatreM = /<a href="\/[a-z-]+\/regionalshows\/[^"]*">([^<]+)<\/a>\s*,?\s*([^<]*)/.exec(meta[1]);
    const img = /<img src="([^"]+)"/.exec(card);
    out.push({
      title: decode(link[2]).trim(),
      bwwUrl: base + link[1],
      theatre: theatreM ? decode(theatreM[1]).trim() : '',
      city: theatreM ? decode(theatreM[2]).replace(/[.,\s]+$/, '').trim() : '',
      start: dates && dates.start,
      end: dates && dates.end,
      image: img ? img[1] : null,
    });
  }
  return out;
}

/** BWW review article links: ".../<region>/article/Review-TITLE-at-THEATRE-YYYYMMDD". */
function parseBwwReviewLinks(html, region) {
  const seen = new Map();
  const re = new RegExp(`href="((?:https://www\\.broadwayworld\\.com)?/${region}/article/([^"]+?)-(\\d{8}))"`, 'g');
  let m;
  while ((m = re.exec(html))) {
    const slug = m[2];
    if (!/^Review-/i.test(slug)) continue;
    const url = m[1].startsWith('http') ? m[1] : `https://www.broadwayworld.com${m[1]}`;
    const d = m[3];
    seen.set(url, { url, title: slug.replace(/-/g, ' '), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- outlet adapters

const jsonOf = (r) => { try { return JSON.parse((r && r.content) || 'null'); } catch { return null; } };

/** Candidates from a candidate list where the title phrase appears in the candidate's title/slug. */
function filterCandidates(cands, prod, window) {
  const variants = titleVariants(prod.title);
  return cands.filter((c) => {
    if (c.date && (c.date < window.from || c.date > window.to)) return false;
    if (looksLikeNonReview(c.title, c.url)) return false;
    const hay = `${c.title || ''} ${decodeURIComponent(c.url || '').replace(/[-_/]+/g, ' ')}`;
    return variants.some((v) => hasPhrase(hay, v));
  });
}

const ADAPTERS = {
  /** WordPress REST search. */
  async wp(site, prod, ctx, window) {
    const q = encodeURIComponent(norm(prod.title).split(' ').slice(0, 6).join(' '));
    const url = `${site.base}/wp-json/wp/v2/posts?search=${q}&per_page=50&orderby=date&after=${window.from}T00:00:00&before=${window.to}T23:59:59&_fields=link,title,date,excerpt`;
    const rows = jsonOf(await ctx.getPage(url)) || [];
    if (!Array.isArray(rows)) return [];
    return filterCandidates(rows.map((r) => ({ url: r.link, title: stripTags(r.title && r.title.rendered), date: (r.date || '').slice(0, 10), excerpt: stripTags(r.excerpt && r.excerpt.rendered) })), prod, window);
  },
  /** WordPress.com hosted blogs use the public API. */
  async wpcom(site, prod, ctx, window) {
    const q = encodeURIComponent(norm(prod.title));
    const url = `https://public-api.wordpress.com/rest/v1.1/sites/${site.host}/posts/?search=${q}&number=20&after=${window.from}&before=${addDays(window.to, 1)}&fields=URL,title,date,excerpt`;
    const rows = (jsonOf(await ctx.getPage(url)) || {}).posts || [];
    return filterCandidates(rows.map((r) => ({ url: r.URL, title: stripTags(r.title), date: (r.date || '').slice(0, 10), excerpt: stripTags(r.excerpt) })), prod, window);
  },
  /** Daily XML sitemaps whose slugs start with "review-" (San Diego Union-Tribune). */
  async sitemap(site, prod, ctx, window) {
    const out = [];
    for (let d = window.from; d <= window.to; d = addDays(d, 1)) {
      if (d > ctx.today) break;
      const urls = await ctx.dayUrls(site, d);
      for (const u of urls) {
        const slug = u.split('/').filter(Boolean).pop() || '';
        if (site.slugPrefix && !slug.startsWith(site.slugPrefix)) continue;
        out.push({ url: u, title: slug.replace(/-/g, ' '), date: d });
      }
    }
    return filterCandidates(out, prod, window);
  },
  /** BroadwayWorld "local reviews" feed pages (cached for the run). */
  async bww(site, prod, ctx, window) {
    return filterCandidates(await ctx.bwwReviews(site.region, window), prod, window);
  },
  /** Index pages (monthly archives, a latest-reviews page): anchors whose text or href carries the title. */
  async index(site, prod, ctx, window) {
    const out = [];
    for (const page of site.pages(window, prod)) {
      const links = await ctx.indexLinks(page, site.base);
      for (const l of links) out.push({ ...l, date: l.date || null });
    }
    return filterCandidates(out, prod, window);
  },
};

/** <a href> + text pairs on a page, absolute, same-site only. */
function parseAnchors(html, base) {
  const host = new URL(base).host.replace(/^www\./, '');
  const out = new Map();
  const re = /<a\b[^>]*?href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = decode(m[1]);
    try { href = new URL(href, base).href; } catch { continue; }
    if (new URL(href).host.replace(/^www\./, '') !== host) continue;
    const text = stripTags(m[2]);
    const prev = out.get(href);
    if (!prev || text.length > prev.title.length) out.set(href, { url: href, title: text });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- article verification

/** Byline from the article's own markup: JSON-LD author, meta author, then a "By X" line. */
function extractByline(html) {
  const names = [];
  const ld = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.author) {
      const a = Array.isArray(n.author) ? n.author : [n.author];
      for (const x of a) { const nm = typeof x === 'string' ? x : x && x.name; if (nm) names.push(String(nm)); }
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  while ((m = ld.exec(html))) { try { walk(JSON.parse(m[1])); } catch { /* ignore */ } }
  if (!names.length) {
    const meta = /<meta[^>]+name="author"[^>]+content="([^"]+)"/i.exec(html) || /<meta[^>]+content="([^"]+)"[^>]+name="author"/i.exec(html);
    if (meta) names.push(meta[1]);
  }
  if (!names.length) {
    const rel = /rel="author"[^>]*>([^<]{3,60})</i.exec(html);
    if (rel) names.push(rel[1]);
  }
  if (!names.length) {
    const by = /(?:^|>|\n)\s*(?:By|Review by|Reviewed by|Written by)[:\s]+([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,3})/m.exec(stripTags(html).slice(0, 6000).replace(/ (By |Review by |Reviewed by )/g, '\n$1'));
    if (by) names.push(by[1]);
  }
  const bad = /^(staff|admin|editor|editors|team|newsroom|site|bww|broadwayworld|the .*|.* staff|.* team|.* desk)$/i;
  const clean = names.map((n) => decode(n).replace(/\s+/g, ' ').trim()).filter((n) => n && !bad.test(n) && n.split(' ').length >= 2);
  return clean[0] || null;
}

function extractTitleTag(html) {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return stripTags((og && og[1]) || (t && t[1]) || '');
}

/**
 * Decide whether a fetched page is a review of `prod`. Needs the title phrase in the
 * headline or the opening of the article and a theatre alias anywhere in the text.
 * Returns { ok, reason?, critic, date, headline }.
 */
function verifyArticle(html, url, prod, window, extra = {}) {
  const headline = extractTitleTag(html);
  const text = stripTags(html);
  const variants = titleVariants(prod.title);
  const inHead = variants.some((v) => hasPhrase(`${headline} ${decodeURIComponent(url).replace(/[-_/]+/g, ' ')}`, v));
  const inBody = variants.some((v) => hasPhrase(text.slice(0, 4000), v));
  if (!inHead && !inBody) return { ok: false, reason: 'title-not-found' };
  const aliases = theatreAliases(prod.theatre, prod.aliases || []);
  const lede = `${headline} ${text.slice(0, 6000)}`;
  if (!aliases.some((a) => hasPhrase(lede, a))) return { ok: false, reason: 'theatre-not-found' };
  if (looksLikeNonReview(headline, url) && !/\breview\b/i.test(text.slice(0, 3000))) return { ok: false, reason: 'not-a-review' };
  let date = null;
  try { date = extractPublishDate(html, url) || null; } catch { /* fall through */ }
  date = (date && String(date).slice(0, 10)) || extra.date || null;
  if (date && (date < window.from || date > window.to)) return { ok: false, reason: `date-outside-window:${date}` };
  if (!date) {
    // Undated page: a year baked into the slug (Squarespace "...6252022") must fall inside the window.
    const yr = /(?:^|\D)\d{0,4}(20[12]\d)$/.exec(decodeURIComponent(String(url)).replace(/\/+$/, ''));
    if (yr && (yr[1] < window.from.slice(0, 4) || yr[1] > window.to.slice(0, 4))) return { ok: false, reason: `url-year-outside-window:${yr[1]}` };
  }
  // Review verbs are a weak signal; a headline-only match with no theatre in the headline or lede is flagged low.
  const confidence = inHead ? 'high' : 'medium';
  return { ok: true, critic: extractByline(html), date, headline, confidence };
}

// ---------------------------------------------------------------- orchestration

/** Review window for a production: from a week before opening to three weeks after closing (or +60d if running). */
function windowFor(prod, today) {
  const from = addDays(prod.start || prod.openingDate || today, -10);
  const closeBase = prod.end || prod.closingDate;
  const to = closeBase ? addDays(closeBase, 21) : addDays(today, 0);
  return { from, to: to > today ? today : to };
}

/**
 * Find verified reviews for one production. `cfg.outlets` lists adapter sites; each is
 * { id, name, kind, ...adapter fields }. Failures of one outlet never stop the others.
 */
async function findReviews(prod, cfg, ctx) {
  const window = windowFor(prod, ctx.today);
  const cands = new Map();
  const log = [];
  for (const site of cfg.outlets) {
    const run = ADAPTERS[site.kind];
    if (!run) continue;
    try {
      const rows = await run(site, prod, ctx, window);
      for (const r of rows) { const k = r.url.replace(/[?#].*$/, '').replace(/\/$/, ''); if (!cands.has(k)) cands.set(k, { ...r, site }); }
      log.push(`${site.id}:${rows.length}`);
    } catch (e) {
      log.push(`${site.id}:ERR(${String(e.message).slice(0, 40)})`);
    }
  }
  const reviews = [];
  const rejected = [];
  for (const c of cands.values()) {
    try {
      const res = await ctx.article(c.url);
      if (!res || !res.html) { rejected.push({ url: c.url, reason: 'fetch-failed' }); continue; }
      const v = verifyArticle(res.html, res.finalUrl || c.url, prod, window, { date: c.date });
      if (!v.ok) { rejected.push({ url: c.url, reason: v.reason }); continue; }
      reviews.push({ url: c.url, outlet: c.site.name, outletId: c.site.id, critic: v.critic, date: v.date, headline: v.headline, confidence: v.confidence });
    } catch (e) {
      rejected.push({ url: c.url, reason: `error:${String(e.message).slice(0, 40)}` });
    }
  }
  return { reviews, rejected, log };
}

/** Run-scoped caches + the fetch wiring around one fetch function. */
function makeContext({ getPage, today, dayCache = {}, saveDayCache = () => {} }) {
  const dayIndexCache = {};
  const bwwPages = new Map();
  const anchors = new Map();
  const ctx = {
    getPage, today,
    async article(url) {
      const r = await getPage(url);
      return r && r.content ? { html: r.content, finalUrl: r.finalUrl || r.url || url } : null;
    },
    async dayUrls(site, day) {
      const key = `${site.id}|${day}`;
      if (dayCache[key]) return dayCache[key];
      const [y, m, d] = day.split('-');
      const locs = (pg) => [...String((pg && pg.content) || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => decode(x[1]));
      let r = null;
      let urls;
      if (site.dayIndex) {
        // Arc-style outbound feed: an index lists one child sitemap per day.
        if (!dayIndexCache[site.id]) dayIndexCache[site.id] = locs(await getPage(site.dayIndex));
        const kids = dayIndexCache[site.id].filter((u) => u.includes(`/${day}/`));
        urls = [];
        for (const k of kids) { r = await getPage(k); urls.push(...locs(r)); }
        if (site.pathIncludes) urls = urls.filter((u) => u.includes(site.pathIncludes));
      } else {
        r = await getPage(`${site.base}/sitemap.xml?yyyy=${y}&mm=${m}&dd=${d}`);
        urls = locs(r);
      }
      if (r && day < today) { dayCache[key] = urls.filter((u) => !site.slugPrefix || (u.split('/').filter(Boolean).pop() || '').startsWith(site.slugPrefix)); saveDayCache(dayCache); return dayCache[key]; }
      return urls;
    },
    async bwwReviews(region, window) {
      const out = new Map();
      for (let page = 1; page <= 25; page++) {
        const key = `${region}|${page}`;
        if (!bwwPages.has(key)) {
          const r = await getPage(`https://www.broadwayworld.com/${region}/local-reviews/${page > 1 ? `?page=${page}` : ''}`);
          bwwPages.set(key, parseBwwReviewLinks((r && r.content) || '', region));
        }
        const links = bwwPages.get(key);
        if (!links.length) break;
        for (const l of links) out.set(l.url, l);
        if (links.every((l) => l.date < window.from)) break;
      }
      return [...out.values()];
    },
    async indexLinks(pageUrl, base) {
      if (!anchors.has(pageUrl)) {
        const r = await getPage(pageUrl);
        anchors.set(pageUrl, r && r.content ? parseAnchors(r.content, base) : []);
      }
      return anchors.get(pageUrl);
    },
  };
  return ctx;
}

module.exports = {
  norm, hasPhrase, titleVariants, theatreAliases, looksLikeNonReview, parseBwwDates, parseBwwRegionalShows, parseBwwReviewLinks,
  parseAnchors, extractByline, verifyArticle, windowFor, findReviews, makeContext, filterCandidates, ADAPTERS, addDays,
};
