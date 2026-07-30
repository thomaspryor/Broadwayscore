'use strict';

/**
 * review-census.js — build the canonical "who reviewed this show" list by unioning
 * the West End aggregator roundups, which list every critic. This is the TARGET
 * for the completeness audit (audit-opening-night-coverage.js): the broad SERP
 * discovery is the ingestion ENGINE; the census tells us what "all" is so the
 * audit can be honest about gaps and never depend on a single slow aggregator.
 *
 * MULTI-SOURCE by design (operator: "can't rely on one slow aggregator"):
 *   - theatre.reviews   (best-structured; extractReviews)
 *   - London Box Office (extractReviewsFromLBO)
 *   - The Stage roundups (lib/thestage-extract — pure cheerio, no playwright)
 *   - WestEndTheatre    (archives are pre-extracted JSON already in census shape)
 *
 * ARCHIVE-FIRST: reads data/aggregator-archive/{source}/{showId}.{ext} if present
 * (cheap, no network) — ext is per-source (.html for HTML roundups, .json for the
 * pre-extracted WestEndTheatre archive); the workflow refreshes archives by running
 * the existing roundup scrapers. A show with NO archived roundup yields hadAnySource=false →
 * the audit must read this as `no-census-yet`, NEVER `complete` (the vacuous-truth
 * trap: empty census ∧ "all present" = falsely green exactly when coverage is
 * worst — Sinatra/Much Ado/Misanthrope, June 2026).
 *
 * Pure union + verdict helpers are exported for unit testing without archives.
 */
const fs = require('fs');
const path = require('path');
const { normalizeOutlet, resolveOutletFromUrl, isJunkOutlet } = require('./review-normalization');
const { verifyAggregatorUrl } = require('./show-match-verifier');
const { parseArticleBodyReviews } = require('./bww-roundup-parser');
const { standingOutletsSource } = require('./standing-outlets');

// Pull the canonical/og URL out of an archived roundup page so verifyAggregatorUrl
// can score the slug. Falls back to '' (it then relies on the page <title> + venue).
function archiveCanonicalUrl(html) {
  const m = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html || '')
    || /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(html || '');
  return m ? m[1] : '';
}

const ROOT = path.join(__dirname, '..', '..');
const ARCHIVE = path.join(ROOT, 'data', 'aggregator-archive');

// Outlets a WE roundup may list but that we can NEVER full-text-collect from a CI
// runner (datacenter-IP blocks defeat cookies — see memory/feedback_wsj_newyorker_ci_ip_block).
// Without this, such an outlet sits in `missing` forever → the show is `incomplete`
// forever → a FULL gather re-fires every run. Passed as the default `suppressed`
// set so these stay VISIBLE (block `complete`) but do NOT drive re-dispatch.
// Recoverable paywalls (Times/FT/Telegraph — collectable via cookies/Browserbase)
// are deliberately NOT here; we want to keep trying them.
const CI_UNFETCHABLE_OUTLETS = new Set(['wsj', 'newyorker']);

// Parse a WestEndTheatre archive. Two shapes ship in the wild (~48 vs ~27 of 79):
//   { reviews:[{outlet,outletId,critic,stars,url,...}] }  — rich, already census shape
//   { ratings:[{outlet,stars,critic?,reviewUrl?}] }       — star-table only, no outletId/url
// We MUST read both: reading only `reviews` silently drops a third of WET archives
// to zero — the exact silent-gate trap the census exists to prevent. Kept here (not
// a scraper) because the WET scraper requires a rendered-page browser path we don't
// want in the audit; the archive is the stable contract.
//
// outletId is ALWAYS re-derived from the outlet NAME via normalizeOutlet, never
// trusted from the archive's baked `outletId`. Unlike the live extractors
// (theatre.reviews / The Stage) which normalize at census time, WET archives are
// pre-extracted and frozen on disk — their baked ids reflect an OLD normalizeOutlet
// (e.g. Daily Express→"the-express", The Sunday Times→"the-sun") and no longer
// reconcile with reviews.json's current ids ("express-uk"/"times-uk"). Trusting them
// split the same outlet into two census entries → a present, scored outlet read as
// `missing` → false-incomplete → needless re-dispatch (caught running the real audit
// on hercules-west-end-2025; 18/441 rows were stale). Re-normalizing makes WET behave
// like the live sources. See [[feedback_includability_predicates_must_be_canonical]].
function normalizeWetRow(r) {
  return { ...r, outletId: r.outlet ? normalizeOutlet(r.outlet) : r.outletId };
}
function parseWetArchive(content /*, showId */) {
  const data = JSON.parse(content);
  if (Array.isArray(data)) return data.filter((r) => r && (r.outletId || r.outlet)).map(normalizeWetRow);
  const reviews = (data && data.reviews) || [];
  const rich = reviews.filter((r) => r && (r.outletId || r.outlet));
  if (rich.length) return rich.map(normalizeWetRow);
  // Fall back to the star-table format.
  const ratings = (data && data.ratings) || [];
  return ratings
    .filter((r) => r && r.outlet)
    .map((r) => ({
      outlet: r.outlet,
      outletId: normalizeOutlet(r.outlet),
      critic: r.critic || 'Unknown',
      stars: r.stars != null ? r.stars : null,
      url: r.url || r.reviewUrl || '',
    }));
}

// ── NYC (Broadway / Off-Broadway) census readers ─────────────────────────────
// The NYC roundups list every critic, the same way the WE roundups do. Each
// reader is a pure fn(content, showId) -> [{outlet, critic, stars, url, outletId?}]
// and is playwright-FREE. We REUSE the existing per-source extractors rather than
// re-implement parsing (the drift trap). Two of them (Show Score, Playbill Verdict)
// run their real script bodies at require-time (no `require.main` guard) or ship
// as pure libs — so we pull the PURE lib extractors, never the scraper scripts.
//
// outletId: unlike the WET archives (which carry a FROZEN baked id from an old
// normalizeOutlet — see normalizeWetRow), these readers derive outletId LIVE at
// census time (normalizeOutlet(name) or resolveOutletFromUrl(url)). Live derivation
// is exactly what the WET lesson asks for, so it's safe to carry outletId through.

// BroadwayWorld "Review Roundup" article. Newer articles embed one JSON-LD
// BlogPosting per critic (author = "Outlet - Critic" or "Outlet"); older ones
// only have a single article with an articleBody of "Critic, Outlet: quote"
// pairs. Mirror extract-bww-reviews.js's extractReviewsFromFile precedence
// (BlogPosting first, articleBody fallback) so the census matches ingestion.
function parseBwwRoundup(content, showId) { // eslint-disable-line no-unused-vars
  const rows = [];
  const scripts = content.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const m of scripts) {
    let json;
    try { json = JSON.parse(m[1].replace(/[\x00-\x1F\x7F]/g, ' ')); } catch (_) { continue; }
    const arr = Array.isArray(json) ? json : [json];
    for (const j of arr) {
      if (!j || j['@type'] !== 'BlogPosting' || !j.author) continue;
      const authorName = Array.isArray(j.author) ? j.author[0] && j.author[0].name : j.author.name;
      if (!authorName) continue;
      let outlet = authorName, critic = '';
      if (authorName.includes(' - ')) {
        const parts = authorName.split(' - ');
        outlet = parts[0].trim();
        critic = (parts[1] || '').trim();
      }
      if (!outlet || isJunkOutlet(outlet)) continue;  // drop sentence-fragment "authors"
      rows.push({ outlet, critic: critic || 'Unknown', stars: null, url: j.url || '' });
    }
  }
  if (rows.length) return rows;
  // Fallback: single-article articleBody "Critic, Outlet:" pairs (older roundups).
  const jm = content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jm) {
    try {
      const j = JSON.parse(jm[1].replace(/[\x00-\x1F\x7F]/g, ' '));
      if (j.articleBody) {
        for (const p of parseArticleBodyReviews(j.articleBody)) {
          if (isJunkOutlet(p.outletRaw)) continue;
          rows.push({ outlet: p.outletRaw, critic: p.criticName || 'Unknown', stars: null, url: '' });
        }
      }
    } catch (_) { /* no fallback */ }
  }
  return rows;
}

// Did They Like It — extractReviewsFromDTLI is already exported + content-based
// (has a require.main guard, so requiring it is side-effect-free).
function parseDtli(content, showId) {
  let fn = null;
  try { ({ extractReviewsFromDTLI: fn } = require('../extract-dtli-reviews')); } catch (_) { return []; }
  if (!fn) return [];
  const raw = fn(content, showId) || [];
  return raw
    .filter((r) => r && r.outlet && !isJunkOutlet(r.outlet))
    .map((r) => ({ outlet: r.outlet, critic: r.criticName || r.critic || 'Unknown', stars: null, url: r.url || '' }));
}

// Playbill "Verdict" article — the pure lib extractor returns
// {url, outlet, outletDomain, critic}. Resolve the canonical outletId off the
// review URL when possible (the anchor text can be a display name or a bare host).
function parsePlaybillVerdict(content, showId) {
  let fn = null;
  try { ({ extractReviewLinksFromArticle: fn } = require('./playbill-verdict-discover')); } catch (_) { return []; }
  if (!fn) return [];
  const raw = fn(content, showId) || [];
  const rows = [];
  for (const r of raw) {
    const resolved = r.url ? resolveOutletFromUrl(r.url) : null;
    const outletId = resolved && resolved.outletId ? resolved.outletId : (r.outlet ? normalizeOutlet(r.outlet) : null);
    if (!outletId) continue;
    rows.push({ outlet: r.outlet || outletId, critic: r.critic || 'Unknown', stars: null, url: r.url || '', outletId });
  }
  return rows;
}

// Show Score — SUPPLEMENTARY, soft-fail. Show Score server-renders only the first
// handful of critic tiles and the rest paginate via JS, so an archived page often
// captures ZERO review tiles (an asset-shell of CDN/font URLs). We resolve only
// URLs that map to a registry outlet; a 0-row result is NORMAL here (softFail),
// never a "broken extractor" alarm. Defensive because Show Score's own
// show-score-discover.js documents the SSR-partial behavior.
function parseShowScore(content, showId) { // eslint-disable-line no-unused-vars
  let fn = null;
  try { ({ extractShowScoreReviewUrls: fn } = require('./show-score-discover')); } catch (_) { return []; }
  if (!fn) return [];
  const urls = fn(content) || [];
  const rows = [];
  const seen = new Set();
  for (const u of urls) {
    let resolved = null;
    try { resolved = resolveOutletFromUrl(u); } catch (_) { resolved = null; }
    if (!resolved || !resolved.outletId || seen.has(resolved.outletId)) continue;
    seen.add(resolved.outletId);
    rows.push({ outlet: resolved.outletId, critic: 'Unknown', stars: null, url: u, outletId: resolved.outletId });
  }
  return rows;
}

// Each source: archive subdir, file ext (default 'html'), and a reader
// fn(content, showId) -> [{outlet, critic, stars, url}]. Every source loaded here
// is playwright-FREE — the census runs inside the coverage audit, which must not
// spin up a browser. (The Stage scraper imports playwright, so we pull its pure
// extractor from lib/thestage-extract instead of requiring the scraper.)
//
// `market` selects the roundup set: London roundups for the West End, NYC roundups
// (BWW / DTLI / Playbill Verdict / Show Score) otherwise. Defaults to 'west-end'
// for backward compatibility with the original WE-only census callers.
function sourceExtractors(market = 'west-end') {
  if (market === 'nyc' || market === 'broadway' || market === 'off-broadway') {
    return [
      // validate:true → page-level cross-show guard (a roundup mis-saved under the
      // wrong show's id). Fails OPEN on unjudgeable titles, same as the WE sources.
      { name: 'bww-roundup', dir: 'bww-roundups', fn: parseBwwRoundup, validate: true },
      { name: 'dtli', dir: 'dtli', fn: parseDtli, validate: true },
      { name: 'playbill-verdict', dir: 'playbill-verdict', fn: parsePlaybillVerdict, validate: true },
      // softFail: an archived Show Score page routinely captures 0 tiles (SPA
      // pagination) — that is not a broken parser, so it must not trip zeroExtract.
      { name: 'show-score', dir: 'show-score', fn: parseShowScore, validate: false, softFail: true },
    ];
  }
  const { extractReviews } = require('../scrape-theatre-reviews');
  const sources = [
    // validate:true → page-level cross-show check before extracting. theatre.reviews
    // sometimes archives a DIFFERENT show's roundup under this show's id (War Horse →
    // Equus, 2026-06): the poller's verifyAggregatorUrl guard was added after some
    // archives were already cached, and the census reads cached archives without
    // re-checking. Re-validating here closes that gap.
    { name: 'theatre-reviews', dir: 'theatre-reviews', fn: extractReviews, validate: true },
  ];
  let extractLbo = null;
  try { ({ extractReviewsFromLBO: extractLbo } = require('../scrape-london-box-office-roundups')); } catch (_) {}
  if (extractLbo) sources.push({ name: 'lbo', dir: 'lbo-roundups', fn: extractLbo });

  let extractStage = null;
  try { ({ extractReviews: extractStage } = require('./thestage-extract')); } catch (_) {}
  if (extractStage) sources.push({ name: 'thestage', dir: 'thestage-roundups', fn: extractStage });

  sources.push({ name: 'westendtheatre', dir: 'westendtheatre', ext: 'json', fn: parseWetArchive });
  return sources;
}

/**
 * Union per-source review arrays into a deduped census keyed by normalized outlet.
 * Keeps the entry with a URL; merges the source list. Pure — testable.
 * @param {Array<{source:string, reviews:Array}>} perSource
 * @returns {{entries:Array, count:number, sourcesPresent:string[], hadAnySource:boolean}}
 */
function unionCensus(perSource) {
  const byOutlet = new Map();
  const sourcesPresent = [];
  for (const { source, reviews } of perSource) {
    if (!Array.isArray(reviews) || reviews.length === 0) continue;
    sourcesPresent.push(source);
    for (const r of reviews) {
      const outletId = r.outletId || normalizeOutlet(r.outlet || '');
      if (!outletId) continue;
      const existing = byOutlet.get(outletId);
      const entry = {
        outletId,
        outlet: r.outlet || outletId,
        critic: r.critic && r.critic !== 'Unknown' ? r.critic : (existing && existing.critic) || 'Unknown',
        stars: r.stars != null ? r.stars : (existing && existing.stars) ?? null,
        url: r.url || (existing && existing.url) || '',
        sources: existing ? [...new Set([...existing.sources, source])] : [source],
      };
      byOutlet.set(outletId, entry);
    }
  }
  const entries = [...byOutlet.values()];
  return { entries, count: entries.length, sourcesPresent, hadAnySource: sourcesPresent.length > 0 };
}

/**
 * Build the census for a show from archived roundups (archive-first, no network).
 * @param {string} showId
 * @param {object} [opts] { archiveDir, sources } injectable for tests
 */
function buildCensusFromArchives(showId, opts = {}) {
  const archiveDir = opts.archiveDir || ARCHIVE;
  // Market routing: WE shows read London roundups; everything else reads the NYC
  // roundup set. Callers pass `market` ('nyc'|'broadway'|'off-broadway'|'west-end')
  // or an injected `sources` array (tests). Defaults to WE for legacy callers.
  const sources = opts.sources || sourceExtractors(opts.market || 'west-end');
  // B1 (standingOutlets): a PSEUDO-source, appended only when the caller passes
  // an outlet registry — no archive file, so it's kept out of sourceExtractors()
  // to leave that function pure/archive-only for its existing tests. See
  // lib/standing-outlets.js for why this makes outlet silence a visible gap.
  const allSources = opts.outlets
    ? [...sources, { name: 'standing-outlets', pseudo: true, fn: standingOutletsSource }]
    : sources;
  const perSource = [];
  // Track which archives EXISTED vs which yielded 0 reviews. A file present but
  // extracting 0 (DOM drift / parser break) is otherwise indistinguishable from
  // "no roundup archived" — both collapse to no-census-yet, so a silently-broken
  // extractor masks itself as "still collecting" forever. zeroExtract lets the
  // audit alert on its own blindness (feedback_monitor_must_cover_own_output).
  const archivesPresent = [];
  const zeroExtract = [];
  const wrongRoundup = [];
  for (const s of allSources) {
    if (s.pseudo) {
      // No archive file, no network — computed directly from opts (e.g. the
      // outlet registry). Never counted in archivesPresent/zeroExtract: an
      // empty result here is a legitimate "no standing outlets configured
      // for this market", not a broken parser.
      let reviews = [];
      try { reviews = s.fn(showId, opts) || []; } catch (_) { reviews = []; }
      if (Array.isArray(reviews) && reviews.length) perSource.push({ source: s.name, reviews });
      continue;
    }
    const p = path.join(archiveDir, s.dir, `${showId}.${s.ext || 'html'}`);
    if (!fs.existsSync(p)) continue;
    archivesPresent.push(s.name);
    const html = fs.readFileSync(p, 'utf8');
    // Cross-show guard (theatre.reviews): the archived roundup is sometimes a
    // DIFFERENT show's page mis-saved under this id (War Horse → Equus). Validate the
    // PAGE (its <title>/canonical-slug/venue) against the show, NOT per review URL —
    // a roundup page names its own show, so this never false-drops a star/headline
    // slug the way per-entry token matching would (Cabaret → 'redmayne-kit-kat').
    // Reuses the exact guard the poller uses at fetch time (show-match-verifier).
    if (s.validate && opts.show && opts.show.title) {
      const v = verifyAggregatorUrl({ url: archiveCanonicalUrl(html), html, show: opts.show, openingDate: opts.show.openingDate });
      // Reject ONLY on a positive wrong-show verdict. 'no-significant-title-tokens'
      // means the guard couldn't judge (zero-token titles like "2:22") — fail OPEN
      // and let extraction + outlet-union be the safety net, rather than nuking a
      // genuine roundup we simply can't verify.
      if (!v.isValid && v.rejectReason !== 'no-significant-title-tokens') { wrongRoundup.push(s.name); continue; }
    }
    let reviews = [];
    try { reviews = s.fn(html, showId) || []; } catch (_) { reviews = []; }
    // softFail sources (e.g. Show Score SPA shells) legitimately extract 0 from a
    // present archive — that is NOT a broken parser, so don't flag zeroExtract.
    if ((!Array.isArray(reviews) || reviews.length === 0) && !s.softFail) zeroExtract.push(s.name);
    perSource.push({ source: s.name, reviews });
  }
  return { ...unionCensus(perSource), archivesPresent, zeroExtract, wrongRoundup };
}

/**
 * Three-state completeness verdict. The audit owns "present-and-scored"; this
 * helper folds in the no-census-yet rule so empty/failed census is NEVER complete.
 *
 * @param {object} census  result of unionCensus / buildCensusFromArchives
 * @param {Set<string>} coveredScoredOutlets  outletIds present in reviews.json WITH assignedScore != null
 * @param {object} [opts] { suppressed: Set<string> — known-unfetchable censused outlets }
 * @returns {{verdict:'complete'|'incomplete'|'no-census-yet', missing:Array, suppressedMissing:Array}}
 */
function censusVerdict(census, coveredScoredOutlets, opts = {}) {
  if (!census || !census.hadAnySource || census.count === 0) {
    return { verdict: 'no-census-yet', missing: [], suppressedMissing: [] };
  }
  const suppressed = opts.suppressed || new Set();
  const missing = [];
  const suppressedMissing = [];
  // Market-suffix tolerance: a roundup may label an outlet "Time Out"
  // (normalizeOutlet → "timeout") while reviews.json carries the London variant
  // "timeout-london" (and vice versa). Treat the bare id and its "-london"
  // variant as the same outlet, else Time Out (et al.) would read missing on
  // EVERY WE show → false-incomplete + dispatch storm. Codex ship-check #3.
  const variants = (id) => {
    const out = new Set([id]);
    if (id.endsWith('-london')) out.add(id.slice(0, -'-london'.length));
    else out.add(`${id}-london`);
    return [...out];
  };
  const inSet = (set, id) => variants(id).some((v) => set.has(v));
  for (const e of census.entries) {
    if (inSet(coveredScoredOutlets, e.outletId)) continue;       // present AND scored — good
    if (inSet(suppressed, e.outletId)) { suppressedMissing.push(e); continue; } // known-unfetchable: stays visible, blocks complete
    missing.push(e);
  }
  // Suppressed-but-missing still means we don't have everything → never "complete".
  const verdict = (missing.length === 0 && suppressedMissing.length === 0) ? 'complete' : 'incomplete';
  return { verdict, missing, suppressedMissing };
}

module.exports = {
  buildCensusFromArchives, unionCensus, censusVerdict, CI_UNFETCHABLE_OUTLETS,
  sourceExtractors, parseBwwRoundup, parseDtli, parsePlaybillVerdict, parseShowScore,
  standingOutletsSource,
};
