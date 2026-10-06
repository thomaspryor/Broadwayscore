'use strict';
/**
 * Discovery pass for the opening-night lane (BRO-4783, epic BRO-4210; design:
 * docs/opening-night-autonomy-review-2026-09-28.md section 6, "Discovery every 2 minutes, cheap first").
 *
 * One pass asks the cheap sources, in order of how fast they update: BWW homepage -> Review Roundup, DTLI
 * homepage -> show page, outlet RSS feeds, and plain-curl sweeps of T1 outlet section indexes (index pages beat
 * search for paywalled outlets). SERP only after +3 hours and only for T1/T2 outlets still missing.
 *
 * Everything that touches the network goes through an injected `fetchText(url)`, so the same code runs against
 * recorded pages in rehearsal and live in production, and tests need no network. Adapters are small and isolated:
 * one failing source is recorded in `errors` and never stops the pass.
 *
 * A pass returns what is NEW. "New" means not on disk and not already in the night's ledger (`seen`), so a URL is
 * emitted exactly once however many sources cite it and however many passes run. Whether a candidate is admitted
 * is the trust model's decision (trust-model.admitLaneCandidate), not this module's.
 *
 * Reuse over rewrite: the BWW, DTLI and feed parsers are the existing, battle-tested ones.
 */
const { normalizeReviewUrl } = require('../ingest-collision');
const { findBWWRoundupLinkOnHomepage } = require('../bww-homepage-scan');
const { findDTLIShowLinkOnHomepage } = require('../dtli-homepage-scan');
const { parseFeedItems, titleMatchesShow, urlSlugMatchesShow } = require('../rss-discovery');
const { admitLaneCandidate } = require('./trust-model');
const ledger = require('./ledger');

const SERP_AFTER_MS = 3 * 60 * 60 * 1000;
const DEFAULT_MAX_DATE_CHECKS = 10;

// Hosts an aggregator page links to that are never reviews: social, ticketing, search, the aggregators themselves.
const NON_REVIEW_HOSTS = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'linkedin.com',
  'pinterest.com', 'threads.net', 'bsky.app', 'reddit.com', 'google.com', 'apple.com', 'spotify.com', 'amazon.com',
  'ticketmaster.com', 'telecharge.com', 'todaytix.com', 'ticketweb.com', 'seatgeek.com', 'stubhub.com',
  'broadwayworld.com', 'didtheylikeit.com', 'playbill.com', 'showscore.com', 'wikipedia.org', 'ibdb.com',
];

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const hostMatches = (host, list) => !!host && list.some((h) => host === h || host.endsWith(`.${h}`));

function resolveUrl(href, base) {
  try {
    const u = new URL(String(href).replace(/&amp;/g, '&').trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

/** Every <a href> in `html`, resolved against `pageUrl`, with its visible text. */
function extractAnchors(html, pageUrl) {
  const out = [];
  const re = /<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const url = resolveUrl(m[1], pageUrl);
    if (url) out.push({ url, text: m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/**
 * The outbound links an aggregator page cites: other hosts only, no social/ticketing/aggregator hosts, no bare
 * homepages. Order kept, duplicates removed.
 */
function extractCitedLinks(html, pageUrl, { excludeHosts = [] } = {}) {
  const pageHost = hostOf(pageUrl);
  const seen = new Set();
  const out = [];
  for (const a of extractAnchors(html, pageUrl)) {
    const host = hostOf(a.url);
    if (!host || host === pageHost || hostMatches(host, NON_REVIEW_HOSTS) || hostMatches(host, excludeHosts)) continue;
    const u = new URL(a.url);
    if (u.pathname === '/' || u.pathname === '') continue;
    const key = normalizeReviewUrl(a.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: a.url, text: a.text });
  }
  return out;
}

/** The article's publish time as an ISO string, from JSON-LD, article:published_time, itemprop or <time datetime>. */
function extractPublishDate(html) {
  const s = String(html || '');
  const tries = [
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<meta[^>]+(?:property|name)=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']article:published_time["']/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i,
    /<time\b[^>]*\bdatetime=["']([^"']+)["']/i,
  ];
  for (const re of tries) {
    const m = s.match(re);
    if (!m) continue;
    const raw = m[1].trim();
    // A date-only value is a calendar date; a date-time needs a zone or offset to mean one instant.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw) && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  }
  return null;
}

// ---- adapters: { name, kind, phase, discover({ show, night, fetchText }) -> candidates[] } ---------------------
// candidate: { url, source: 'aggregator'|'outlet-index', aggregatorCited?, publishDate?, needsDate?, via, outletId? }

function bwwRoundupAdapter({ homeUrl = 'https://www.broadwayworld.com/' } = {}) {
  return {
    name: 'bww-roundup', kind: 'aggregator', phase: 'cheap',
    async discover({ show, fetchText }) {
      const roundup = findBWWRoundupLinkOnHomepage(await fetchText(homeUrl), show.title);
      if (!roundup) return [];
      return extractCitedLinks(await fetchText(roundup), roundup).map((l) => ({ url: l.url, source: 'aggregator', aggregatorCited: true, via: roundup }));
    },
  };
}

function dtliAdapter({ homeUrl = 'https://didtheylikeit.com/' } = {}) {
  return {
    name: 'dtli', kind: 'aggregator', phase: 'cheap',
    async discover({ show, fetchText }) {
      const page = findDTLIShowLinkOnHomepage(await fetchText(homeUrl), show);
      if (!page) return [];
      return extractCitedLinks(await fetchText(page), page).map((l) => ({ url: l.url, source: 'aggregator', aggregatorCited: true, via: page }));
    },
  };
}

// The shared feed parser returns pubDate as a Date; the trust model wants an ISO string with a zone.
function toIso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function rssAdapter({ feeds }) {
  return {
    name: 'rss', kind: 'feed', phase: 'cheap',
    async discover({ show, fetchText }) {
      const out = [];
      for (const feed of feeds || []) {
        let items;
        try { items = parseFeedItems(await fetchText(feed.url)); } catch { continue; } // one dead feed never hides the others
        for (const it of items) {
          if (!it.link) continue;
          if (!titleMatchesShow(it.title, show.title) && !urlSlugMatchesShow(it.link, show.title)) continue;
          out.push({ url: it.link, source: 'outlet-index', publishDate: toIso(it.pubDate), via: feed.name || feed.url, outletId: feed.outletId });
        }
      }
      return out;
    },
  };
}

/** Plain sweep of an outlet's own section index page(s): same-host links that name the show. Dates are confirmed per article. */
function sectionIndexAdapter({ outlets }) {
  return {
    name: 'section-index', kind: 'outlet-index', phase: 'cheap',
    async discover({ show, fetchText }) {
      const out = [];
      for (const o of outlets || []) {
        let html;
        try { html = await fetchText(o.indexUrl); } catch { continue; }
        const host = hostOf(o.indexUrl);
        for (const a of extractAnchors(html, o.indexUrl)) {
          if (hostOf(a.url) !== host || new URL(a.url).pathname === new URL(o.indexUrl).pathname) continue;
          if (!titleMatchesShow(a.text, show.title) && !urlSlugMatchesShow(a.url, show.title)) continue;
          out.push({ url: a.url, source: 'outlet-index', publishDate: null, needsDate: true, via: o.indexUrl, outletId: o.outletId });
        }
      }
      return out;
    },
  };
}

// ---- the pass --------------------------------------------------------------------------------------------------

/** SERP runs only once the lane has been up for 3 hours AND at least one T1/T2 outlet is still missing. */
function serpAllowed({ startedAt, now, missingOutlets = [], afterMs = SERP_AFTER_MS }) {
  const elapsed = new Date(now).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= afterMs && missingOutlets.length > 0;
}

/**
 * @param {object} args
 *   show {id,title,...}, night 'YYYY-MM-DD', now, startedAt (lane start), fetchText(url)->string,
 *   adapters[], seen Set<normalized url> (on disk + ledger), timeZone,
 *   missingOutlets [] (T1/T2 outlets not yet captured), serpMax
 * @returns {{admitted, rejected, errors, deferredDateChecks, serpRan}}
 */
async function runDiscoveryPass({
  show, night, now = Date.now(), startedAt, fetchText, adapters = [], seen = new Set(), timeZone,
  missingOutlets = [], serpMax = 5, maxDateChecks = DEFAULT_MAX_DATE_CHECKS,
} = {}) {
  if (!show || !show.title) throw new Error('runDiscoveryPass: show.title is required');
  if (typeof fetchText !== 'function') throw new Error('runDiscoveryPass: fetchText is required');
  const errors = [];
  const byKey = new Map();
  const collect = (candidates, adapterName) => {
    for (const c of candidates || []) {
      if (!c || !c.url) continue;
      const key = normalizeReviewUrl(c.url);
      const prior = byKey.get(key);
      const next = { ...c, adapter: adapterName };
      // The same URL from several sources keeps the strongest claim: an aggregator citation beats an index sighting.
      if (!prior || (!prior.aggregatorCited && c.aggregatorCited)) byKey.set(key, next);
    }
  };

  const cheap = adapters.filter((a) => a.phase !== 'serp');
  for (const a of cheap) {
    try { collect(await a.discover({ show, night, fetchText }), a.name); } catch (e) {
      errors.push({ adapter: a.name, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  let serpRan = false;
  if (serpAllowed({ startedAt, now, missingOutlets })) {
    for (const a of adapters.filter((x) => x.phase === 'serp')) {
      try {
        const found = await a.discover({ show, night, fetchText, missingOutlets });
        collect((found || []).slice(0, serpMax), a.name);
        serpRan = true;
      } catch (e) { errors.push({ adapter: a.name, error: String((e && e.message) || e).slice(0, 200) }); }
    }
  }

  const admitted = [];
  const rejected = [];
  const deferredDateChecks = [];
  let dateChecks = 0;
  for (const [key, c] of byKey) {
    if (seen.has(key)) continue; // already on disk or already in tonight's ledger: never emitted twice
    let publishDate = c.publishDate || null;
    if (c.source === 'outlet-index' && !publishDate && c.needsDate) {
      if (dateChecks >= maxDateChecks) { deferredDateChecks.push(c.url); continue; } // retried next pass, not dropped
      dateChecks++;
      try { publishDate = extractPublishDate(await fetchText(c.url)); } catch (e) {
        errors.push({ adapter: c.adapter, error: `date check ${c.url}: ${String((e && e.message) || e).slice(0, 150)}` });
        deferredDateChecks.push(c.url);
        continue;
      }
    }
    const verdict = admitLaneCandidate({ source: c.source, aggregatorCited: c.aggregatorCited === true, publishDate, night, ...(timeZone ? { timeZone } : {}) });
    if (verdict.admit) admitted.push({ url: c.url, key, source: c.source, adapter: c.adapter, via: c.via, publishDate, outletId: c.outletId || null, reason: verdict.reason });
    else rejected.push({ url: c.url, adapter: c.adapter, reason: verdict.reason });
  }
  return { admitted, rejected, errors, deferredDateChecks, serpRan };
}

/** The set of review keys the lane must not emit again: the night's ledger plus URLs already on disk. */
function loadSeen(ledgerDir, show, night, onDiskUrls = []) {
  const seen = new Set((onDiskUrls || []).map((u) => normalizeReviewUrl(u)));
  for (const ev of ledger.readLedger(ledgerDir, show, night).events) seen.add(ev.reviewKey);
  return seen;
}

/** Log each admitted URL as `discovered`. Ledger keys are normalized URLs so loadSeen sees them next pass. */
function recordDiscovered(ledgerDir, { show, night, admitted, now = Date.now() }) {
  for (const a of admitted) {
    ledger.appendEvent(ledgerDir, { show, night, reviewKey: a.key || normalizeReviewUrl(a.url), stage: 'discovered', at: now, meta: { adapter: a.adapter, via: a.via || null, source: a.source, url: a.url } });
  }
  return admitted.length;
}

module.exports = {
  SERP_AFTER_MS, NON_REVIEW_HOSTS, extractAnchors, extractCitedLinks, extractPublishDate,
  bwwRoundupAdapter, dtliAdapter, rssAdapter, sectionIndexAdapter, serpAllowed, runDiscoveryPass, loadSeen, recordDiscovered,
};
