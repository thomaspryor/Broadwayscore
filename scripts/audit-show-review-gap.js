#!/usr/bin/env node
/**
 * audit-show-review-gap.js
 *
 * Show-centric review gap audit. For each open show in the opening-night
 * window, find its Playbill Verdict + BWW Review Roundup aggregator
 * articles, extract the outlet review URLs those articles list, and diff
 * against what we have in data/review-texts/{showId}/ + reviews.json.
 *
 * Why this exists:
 *   The opening-night poller/gather already finds reviews via SERP +
 *   outlet RSS + dedicated aggregator scrapers, but its discovery is
 *   per-outlet and per-URL-pattern. Aggregator articles are the canonical
 *   "here are the reviews for THIS show" lists curated by Playbill/BWW
 *   editors — using them as a gap reference catches the long tail of
 *   reviews from blogs/niche outlets that aren't in our outlet-registry.
 *
 *   Surfaced concrete gaps 2026-05-27 (Notion 36d637c5-416f-81d4):
 *     - Animal Wisdom: 9 reviews on Playbill Verdict, 3 in reviews.json
 *     - The Maids: 6 listed, 5 ours (NYT URL discovered but mis-routed)
 *     - Heated Rivalry: 4 listed, 3 ours
 *
 * Modes:
 *   --show=ID             one show only
 *   --window=14           every open show opened within N days (default 21)
 *   --fail-on-gap         exit 1 when any in-window show has missing URLs
 *   --dispatch-gather     gh workflow run gather-reviews.yml for each show
 *                         that has a gap > 0 (rate-limited at 1 dispatch/show)
 *   --ingest-missing      run scripts/ingest-review-from-url.js directly for
 *                         each missing aggregator URL whose outlet is in the
 *                         registry. Targets the specific URL rather than re-
 *                         running gather's SERP+RSS discovery (which already
 *                         failed). Cap of 5 URLs/show via --ingest-cap=N.
 *   --ingest-cap=N        per-show ingest cap (default 5)
 *   --dry-run             don't write audit file
 *   --verbose             log per-show details to stdout
 *
 * Output: data/audit/show-review-gap.json
 *
 * Usage:
 *   node scripts/audit-show-review-gap.js --show=the-maids-off-broadway-2026
 *   node scripts/audit-show-review-gap.js --window=21 --dispatch-gather
 *   node scripts/audit-show-review-gap.js --window=21 --fail-on-gap   # CI
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { execSync, execFileSync } = require('child_process');

const { fetchPage, cleanup: scraperCleanup } = require('./lib/scraper');
const { serpQuery, calculateDateWindow, getShowInfo, isGenericShowTitle, hasDisambiguator, canDisambiguateGenericTitle } = require('./lib/url-discovery');
const { buildCensusQueries, shouldRunSerpCensus, DEFAULT_COOLDOWN_HOURS: SERP_CENSUS_DEFAULT_COOLDOWN_HOURS } = require('./lib/serp-review-census');
const { provisionalOutletIdFromHost } = require('./lib/outlet-canonicalize');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');
const { execErrorDetail } = require('./lib/exec-error-detail');
const { hasHelpFlag } = require('./lib/cli-help.js');

// Same incident class as scripts/autonomous-run.js / autonomous-probe.js /
// autonomous-merge.js (tasks #260/#264): this script spawns real `gh`
// subprocesses (workflow dispatch at dispatchGatherFor, repo-variable
// read/write in the self-proving auto-enable block) with no --help guard.
// USAGE / hasHelpFlag(argv) is checked as the FIRST line of main(), before
// loadShows() or anything else runs, so `--help` combined with a real action
// flag (--dispatch-gather, --ingest-missing) can never fall through.
const USAGE = `audit-show-review-gap.js — show-centric review gap audit vs Playbill Verdict / BWW Review Roundup.

Usage:
  node scripts/audit-show-review-gap.js --show=ID
  node scripts/audit-show-review-gap.js --window=21 --dispatch-gather
  node scripts/audit-show-review-gap.js --window=21 --fail-on-gap   # CI

Modes:
  --show=ID             one show only
  --window=14            every open show opened within N days (default 21)
  --fail-on-gap          exit 1 when any in-window show has missing URLs
  --dispatch-gather      gh workflow run gather-reviews.yml for each show
                         that has a gap > 0 (rate-limited at 1 dispatch/show)
  --ingest-missing       run scripts/ingest-review-from-url.js directly for
                         each missing aggregator URL whose outlet is in the
                         registry
  --ingest-cap=N         per-show ingest cap (default 5)
  --checkpoint           process least-recently-audited shows first, skip
                         shows audited within a freshness window
  --include-closed       also audit closed shows (back-catalogue backfill)
  --time-budget-min=N    soft time budget for --checkpoint runs (default 20)
  --freshness-hours=N    checkpoint freshness window (default 12)
  --dry-run              don't write audit file
  --verbose              log per-show details to stdout
  --help, -h             print this usage and exit

Output: data/audit/show-review-gap.json`;
const {
  FLAGGED_RECOVERY_CAP,
  isEmptyBodyFile,
  isRecoverableFlaggedFile,
  isRecoverableUncitedStub,
  STAR_SOURCE_BY_REFERENCE,
  decideEmptyBodyRecovery,
  nextRecoveryCount,
} = require('./lib/flagged-recovery');
// Same set the rebuild's aggregatorStars-fallback scores from (P5.7) — the
// star fallback below must not write stars the rebuild would then ignore.
const { KNOWN_STAR_OUTLETS } = require('./lib/score-extractors');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const OUTLET_REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
// REVIEW_TEXTS_DIR can be overridden via env so local runs can point at the
// user's master ~/broadway-review-texts checkout (which is fresher than a
// worktree's stale copy). CI's checkout-core-data action populates
// data/review-texts directly so the default works there.
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  || path.join(ROOT, 'data', 'review-texts');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'show-review-gap.json');
const UNKNOWN_OUTLETS_PATH = path.join(ROOT, 'data', 'audit', 'unknown-aggregator-outlets.json');

const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const windowDays = parseInt(args.find(a => a.startsWith('--window='))?.split('=')[1] || '21', 10);
const failOnGap = args.includes('--fail-on-gap');
const dispatchGather = args.includes('--dispatch-gather');
const ingestMissing = args.includes('--ingest-missing');
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
// Cap how many URLs we ingest per show to avoid runaway loops on a noisy
// aggregator article. Each missing URL hits fetchPage which costs Bright Data
// credits — 5 per show per cron run is a sane budget.
const INGEST_PER_SHOW_CAP = parseInt(args.find(a => a.startsWith('--ingest-cap='))?.split('=')[1] || '5', 10);

// Checkpointing (added 2026-06-06): the CI job has timeout-minutes:25 and every
// hourly run was being CANCELLED at the cap — so a single run never finished a
// full sweep and later shows were never audited. With --checkpoint the run
// processes the LEAST-recently-audited shows first, skips shows audited within a
// freshness window, and stops cleanly under a soft time budget — so successive
// hourly runs grind through the whole eligible set (and, with --include-closed,
// the back catalogue) instead of re-auditing the same first shows forever.
const useCheckpoint = args.includes('--checkpoint');
const includeClosed = args.includes('--include-closed');
const TIME_BUDGET_MS = parseInt(args.find(a => a.startsWith('--time-budget-min='))?.split('=')[1] || '20', 10) * 60 * 1000;
const FRESHNESS_HOURS = parseInt(args.find(a => a.startsWith('--freshness-hours='))?.split('=')[1] || '12', 10);
const CHECKPOINT_PATH = path.join(ROOT, 'data', 'audit', 'gap-audit-checkpoint.json');
// WE completeness gate (2026-07-10): reference rows from WE roundup aggregators.
const { getWeReferenceRows, isWeShow, inOpeningWindow, missingSetHash } = require('./lib/gap-reference-sources');
const { recordGateObservation, evaluateProving, emptyTracker, aggregatorAccuracy, lowTrustSources } = require('./lib/we-gate-proving');
const WE_PROVING_PATH = path.join(ROOT, 'data', 'audit', 'we-gate-proving.json');
function loadWeProving() {
  try { return JSON.parse(fs.readFileSync(WE_PROVING_PATH, 'utf8')) || emptyTracker(); } catch { return emptyTracker(); }
}
function saveWeProving(t) {
  try { fs.writeFileSync(WE_PROVING_PATH, JSON.stringify(t, null, 2) + '\n'); } catch { /* non-fatal */ }
}
const { normalizeOutlet: normalizeOutletId } = require('./lib/review-normalization');
// Production-identity + ingest-eligibility policy (2026-07-11): Broadway-path
// aggregator articles are date-gated against the show's opening window, and
// prior-run URLs are ingest-blocked on EVERY path (see lib/gap-ingest-policy.js).
const { articleRunIdentity, ingestBlockReason } = require('./lib/gap-ingest-policy');
// WE reference schema version — bump to invalidate WE checkpoint entries (59 shows
// recorded gaps:0 from vacuous Broadway-only-reference runs and closed-clean shows
// get a 365d skip; without invalidation the WE reference would never run on them).
const WE_REF_VERSION = 2;
function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')) || {}; } catch { return {}; }
}
function saveCheckpoint(cp) {
  try { fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2)); } catch { /* non-fatal */ }
}
// Freshness + ordering policy (extracted 2026-07-14 — opening-week shows must
// re-audit every hourly run and sort ahead of the back-catalogue grind; The
// Whoopi Monologues' missing NYT review sat 3 days behind the backlog).
const { freshnessMsFor, compareAuditPriority, checkpointTs } = require('./lib/gap-audit-freshness');

// Non-review domains we ignore inside aggregator articles (platform widgets,
// social, navigation, store links, internal Playbill/BWW article navigation).
const NON_REVIEW_HOST_PATTERNS = [
  /^facebook\.com$/, /^instagram\.com$/, /^twitter\.com$/, /^x\.com$/,
  /^youtube\.com$/, /^tiktok\.com$/, /^threads\.net$/, /^linkedin\.com$/,
  /^pinterest\./, /^reddit\.com$/, /^t\.me$/, /^whatsapp\./,
  /^playbillder\.com$/, /^playbillstore\.com$/, /^playbilltravel\.com$/,
  /^stagemag\.broadwayworld\.com$/, /^broadwayworldshop\.com$/,
  /^forum\.broadwayworld\.com$/, /^data\.broadwayworld\.com$/,
  /^wisdomdigital\.com$/, /^cur8\.com$/, /^jt-pr-dot-yamm-track\.appspot\.com$/,
  // venue & box-office (not reviews)
  /\.org$/, // catches many venue domains; allow-list known critic .orgs below
  /^ci\.ovationtix\.com$/,
  // ticketing / box-office hosts — aggregator "Get Tickets" links, never reviews.
  // Before 2026-06-05 these were skipped only because their unknown outlet was
  // skipped; with auto-onboard they would be ingested as bogus "telecharge" /
  // "todaytix" provisional outlets, so they must be filtered at the source.
  /^telecharge\.com$/, /^ticketmaster\.com$/, /(^|\.)todaytix\.com$/,
  /^seatgeek\.com$/, /^stubhub\.com$/, /^broadwaydirect\.com$/,
  /(^|\.)ticketmaster\./, /^ovationtix\.com$/, /^web\.ovationtix\.com$/,
  /^tickets\./, /^boxoffice\./,
];

const ALLOWED_ORG_HOSTS = new Set([
  'artsfuse.org', 'npr.org', 'exeuntnyc.org', // edge cases that ARE review outlets
]);

const NON_REVIEW_PATH_PATTERNS = [
  /^\/article(\/|$)/, // playbill article nav
  /^\/reviews\/?$/,   // BWW landing
  /^\/industry-/, /^\/theatre-auditions/, /^\/youth-theater/,
  /^\/newsroom/, /^\/newsletter/,
  /\/tickets?(\/|$|-)/i, // "Get Tickets" / box-office links, not reviews
];

// Mirror/format subdomains that are never a distinct outlet — a publisher's AMP
// or mobile host is the same outlet as its bare domain. Strip so amp.theguardian.com
// and m.nytimes.com resolve to guardian / nytimes instead of provisional-onboarding
// as duplicate outlets.
const MIRROR_SUBDOMAIN_PREFIX = /^(amp|m|mobile)\./;
// Blog/newsletter platforms where the publication identity IS the subdomain
// (pub.substack.com). These must NOT collapse — the registrable domain is the
// platform, not the outlet. Mirrors PROVISIONAL_BLOG_PLATFORMS in
// outlet-canonicalize.js so provisionalOutletIdFromHost still extracts "pub".
const COLLAPSE_BLOG_PLATFORMS = [
  'substack.com', 'wordpress.com', 'blogspot.com', 'medium.com',
  'tumblr.com', 'squarespace.com', 'wixsite.com', 'ghost.io',
];
// Multi-part public suffixes — registrable domain keeps 3 labels (foo.co.uk),
// not 2 (co.uk). Mirrors PROVISIONAL_MULTIPART_SUFFIXES in outlet-canonicalize.js.
const COLLAPSE_MULTIPART_SUFFIXES = [
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br',
];

// Collapse a hostname to its registrable domain so section subdomains
// (theater.nytimes.com) and mirror hosts (amp.theguardian.com) look up the same
// registry entry as the bare domain. Leaves blog-platform publication subdomains
// intact so they keep their per-publication provisional identity.
function registrableHost(host) {
  if (!host || typeof host !== 'string') return host;
  let h = host.replace(/^www\./, '').toLowerCase();
  while (MIRROR_SUBDOMAIN_PREFIX.test(h)) h = h.replace(MIRROR_SUBDOMAIN_PREFIX, '');
  if (COLLAPSE_BLOG_PLATFORMS.some(p => h.endsWith('.' + p))) return h;
  const parts = h.split('.').filter(Boolean);
  const keep = COLLAPSE_MULTIPART_SUFFIXES.some(s => h.endsWith('.' + s)) ? 3 : 2;
  return parts.length > keep ? parts.slice(-keep).join('.') : h;
}

function hostOf(u) {
  try { return registrableHost(new URL(u).hostname); }
  catch { return null; }
}

// provisionalOutletIdFromHost lives in scripts/lib/outlet-canonicalize.js so the
// gap audit and its unit test share one implementation (CLAUDE.md §15).

// Normalize an aggregator review URL for dedupe/storage: drop tracking query +
// fragment. EXCEPTION: Lighting & Sound America's per-review identity lives
// entirely in story.asp?ID=… (the path carries no title). Blanket-stripping the
// query collapses every LSA link to the bare /news/story.asp, which then looks
// like the SAME uncaptured URL in every show AND feeds --ingest-missing an
// un-ingestable bare URL — so genuine LSA reviews were never recovered across
// the whole catalogue (2026-06-21). Preserve the ID so a real LSA review keeps a
// distinct, ingestable URL. Discovery-layer cousin of the LSA extractor fix.
function normalizeReviewUrl(href) {
  try {
    const u = new URL(href);
    // Registrable-host equality (matches the isReviewUrl LSA guard) so a lookalike
    // like notlightingandsoundamerica.com can't trip the special-case.
    if (hostOf(href) === 'lightingandsoundamerica.com') {
      const id = u.searchParams.get('ID');
      if (id) return `${u.origin}${u.pathname}?ID=${id}`;
    }
  } catch { /* fall through to plain strip */ }
  return href.split('?')[0].split('#')[0];
}

function isReviewUrl(href) {
  if (!href || !href.startsWith('http')) return false;
  const h = hostOf(href);
  if (!h) return false;
  if (NON_REVIEW_HOST_PATTERNS.some(rx => rx.test(h)) && !ALLOWED_ORG_HOSTS.has(h)) return false;
  // Lighting & Sound America: the bare /news/story.asp (no ?ID=) is the news
  // index, not a review. Show Score links it as a generic "more from LSA" promo
  // on many show pages; without this guard it surfaces as an uncaptured gap in
  // every audited show (2026-06-21). A real LSA review always carries ?ID=.
  if (h === 'lightingandsoundamerica.com') {
    try {
      const u = new URL(href);
      if (/\/news\/story\.asp$/i.test(u.pathname) && !u.searchParams.get('ID')) return false;
    } catch { return false; }
  }
  // Skip Playbill/BWW internal navigation (we WANT outlet URLs, not aggregator URLs)
  if ((h === 'playbill.com' || h === 'broadwayworld.com') && !/\/(review|reviews|theater|theatre|news|stage|culture|arts)/i.test(href)) return false;
  try {
    const p = new URL(href).pathname;
    if (NON_REVIEW_PATH_PATTERNS.some(rx => rx.test(p))) return false;
    // Static assets: Show Score pages link CDN stylesheets/scripts (e.g.
    // maxcdn.bootstrapcdn.com/bootstrap.min.css) which surfaced as "missing
    // reviews" and, under --ingest-missing, would ingest as a provisional
    // "bootstrapcdn" outlet (spamalot-off-broadway-2026, 2026-07-11).
    if (/\.(css|js|json|xml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|pdf)$/i.test(p)) return false;
  } catch { return false; }
  return true;
}

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

// Domain → outletId map from outlet-registry.json. Used to detect aggregator-
// listed URLs whose outlet isn't in our registry (the gay-city-news /
// theknockturnal class — gather rejects them with "Could not resolve outlet"
// and the review never lands). Surfacing these in data/audit/unknown-
// aggregator-outlets.json closes the loop between gap detection and outlet
// onboarding.
let _knownDomainMap = null;
function getKnownDomainMap() {
  if (_knownDomainMap) return _knownDomainMap;
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
    const outlets = raw.outlets || raw;
    for (const [id, o] of Object.entries(outlets || {})) {
      if (!o || typeof o !== 'object') continue;
      const domains = [];
      if (typeof o.domain === 'string') domains.push(o.domain);
      // domainAliases is the canonical alternate-domain field in outlet-registry.json
      // (50 outlets, e.g. huffpost→huffingtonpost.com, guardian→guardian.co.uk).
      // The legacy domains/alternateDomains keys survive on 1 outlet each; keep
      // reading them so no entry silently drops out.
      if (Array.isArray(o.domainAliases)) domains.push(...o.domainAliases);
      if (Array.isArray(o.domains)) domains.push(...o.domains);
      if (Array.isArray(o.alternateDomains)) domains.push(...o.alternateDomains);
      for (const d of domains) {
        if (typeof d === 'string' && d) map.set(registrableHost(d), id);
      }
    }
  } catch (e) {
    if (verbose) console.error(`  outlet-registry load failed: ${e.message}`);
  }
  _knownDomainMap = map;
  return map;
}

// Curated show → Show Score page URL map (data/show-score-urls.json), loaded once.
// Used by the Show Score reconciliation source; missing entries fall back to
// slug construction in showScoreUrlForShow.
let _showScoreUrlMap = null;
function getShowScoreUrlMap() {
  if (_showScoreUrlMap) return _showScoreUrlMap;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'show-score-urls.json'), 'utf8'));
    _showScoreUrlMap = raw.shows || raw || {};
  } catch {
    _showScoreUrlMap = {};
  }
  return _showScoreUrlMap;
}

function loadReviews() {
  const data = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.reviews || []);
}

function loadDirFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try { return Object.assign({ _file: f }, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
    catch { return null; }
  }).filter(Boolean);
}

async function findAggregatorArticles(show) {
  const title = show.title;
  const id = show.id;
  const tokens = titleTokens(title);
  const queries = [
    `site:playbill.com/article "${title}" reviews`,
    `site:broadwayworld.com "Review Roundup" "${title}"`,
  ];
  const urls = new Set();
  for (const q of queries) {
    _serpStats.attempts++;
    try {
      const results = await serpQuery(q, { num: 5 });
      for (const r of (results || [])) {
        const u = r.link || r.url;
        if (!u) continue;
        // The SERP routinely returns OTHER shows' verdict/roundup articles for a
        // show's query (cold-start ranking). Require the show's title tokens in the
        // article slug so we don't fetch + extract a wrong-show roundup (e.g. the
        // "weather-girl" Playbill verdict for a "Girl, Interrupted" query —
        // girl-interrupted 2026-06-06). Verdict slugs embed the title, so a real
        // match passes; "weather-girl" matches only "girl" and is rejected.
        const clean = u.split('?')[0].split('#')[0];
        if (!urlMatchesShow(clean, tokens)) continue;
        // Playbill Verdict article patterns
        if (/playbill\.com\/article\/(read|what|reviews|critics)/i.test(u) && /\.html?$|article\//.test(u)) {
          urls.add(clean);
        }
        // BWW Review Roundup article patterns
        if (/broadwayworld\.com\/article\/Review-Roundup-/i.test(u)) {
          urls.add(clean);
        }
      }
    } catch (e) {
      _serpStats.errors++;
      if (verbose) console.error(`  SERP error for ${id}: ${e.message}`);
    }
  }
  // Deterministic BWW Review Roundup discovery via the market section page
  // (/off-broadway/ etc.) — does NOT depend on Google SERP, which ranks fresh
  // opening-night roundups poorly and missed the BWW RR for A Woman Among Women
  // (2026-06). Cheap ScrapingBee scan; falls back internally to reviews.php.
  try {
    const { discoverBwwRoundupUrl } = require('./lib/bww-rr-discover');
    // For closed shows skip the PAID Browserbase reviews.php fallback — it only
    // lists recent roundups, so it can't help an old show and would burn ~$0.10/show
    // across the back-catalogue grind. The cheap section scan and the cheap
    // fetchPage reviews.php scan both still run.
    //
    // This is OR'd with the lib's shouldSkipReviewsPhp(show) default (2026-07-31):
    // previously `show.status === 'closed'` evaluated to an explicit `false` for
    // every OPEN show, which counted as "caller supplied a value" and disabled the
    // category default entirely — so this hourly audit was the one caller that
    // bypassed T4 completely.
    const bww = await discoverBwwRoundupUrl(show, { skipReviewsPhp: show.status === 'closed' });
    if (bww && bww.url) urls.add(bww.url.split('?')[0].split('#')[0]);
  } catch (e) {
    if (verbose) console.error(`  BWW section discovery error for ${id}: ${e.message}`);
  }
  return [...urls];
}

function titleTokens(title) {
  // Significant tokens (3+ chars, not stopwords) from the show title.
  // Used to filter aggregator-article links to URLs actually about THIS show
  // (vs sidebar/related-article links).
  const STOPWORDS = new Set([
    'the','and','for','off','broadway','musical','play','theater','theatre',
    'review','reviews','what','are','is','of','to','in','on','at','a','an',
    'with','by','from','presents','starring','new','york','nyc','show',
  ]);
  // Fold diacritics BEFORE stripping non-alphanumerics. Without the NFD
  // decomposition the `[^a-z0-9 ]` strip turns each accented letter into a
  // SPACE, shredding one word into fragments that can never match an ASCII URL
  // slug: "Les Misérables" became ["les","mis","rables"] instead of
  // ["les","miserables"]. Because urlMatchesShow requires n-1 of n tokens, the
  // two phantom fragments made every real review URL for that show unmatchable
  // — the census reported "0 gaps" for Les Misérables: The Arena Concert
  // Spectacular on 2026-07-30 while amNewYork and New York Theatre Guide were
  // both live and missing. 28 corpus shows are affected; the worst are operas
  // where the fragment count collapses to 1-2 tokens and the `tokens.length<=2`
  // branch then demands a 100% match: "La Bohème" → ["boh"], "Jenůfa" → ["jen"].
  // Same fold as title-normalization.js:29 / show-matching.js:1078.
  return (title || '').toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function urlMatchesShow(href, tokens) {
  if (tokens.length === 0) return true; // no tokens → accept everything
  try {
    const p = new URL(href).pathname.toLowerCase();
    // Token must match a full path SEGMENT (split on / - _ . space), not a
    // substring. P1 fix 2026-05-27 (ship-check): substring matching let
    // `maids` slip into `/the-handmaids-tale-revival` because "maids"
    // appears inside "handmaids". Segment match catches the actual show
    // slug while rejecting accidental substring overlap.
    const segments = new Set(p.split(/[\/\-_.\s]+/).filter(Boolean));
    const matched = tokens.filter(t => segments.has(t)).length;
    // Require enough DISTINCTIVE overlap so a different show that merely shares a
    // common word isn't accepted — "Weather Girl" matched "Girl, Interrupted" on
    // "girl" alone (girl-interrupted 2026-06-06), the same title-token class as the
    // original wrong-show leak. Short titles (1-2 tokens) must match ALL tokens;
    // longer titles tolerate one missing token (slug truncation / subtitle drop).
    if (tokens.length <= 2) return matched === tokens.length;
    return matched >= tokens.length - 1;
  } catch { return false; }
}

// Pure per-result acceptance decision for the SERP review census (#371 —
// Soundsphere/JonathanBaz class). Given one raw SERP hit, decides whether it
// counts as a discovered review URL for this show, applying the SAME
// review/show-match filters as the aggregator-article path above plus the
// generic-title disambiguation guard url-discovery.js uses for outlet-scoped
// discovery (a bare "<title> review" query has no site: restriction, so it's
// more exposed to wrong-show contamination on ambiguous titles). Extracted as
// a standalone function (CLAUDE.md §15) so the acceptance logic is unit-
// testable with fabricated SERP results, independent of live BD/SB/SERP
// availability (which, unlike this decision, is not something a test controls).
// @param {{url?: string, link?: string, title?: string, snippet?: string}} sr raw SERP result
// @param {{show: object, showInfo: object}} ctx show ({id,title}) + url-discovery's getShowInfo(show.id) shape
// @returns {string|null} normalized review URL if accepted, else null
function acceptSerpCensusResult(sr, { show, showInfo }) {
  const u = sr && (sr.url || sr.link);
  if (!u || !isReviewUrl(u)) return null;
  const tokens = titleTokens(show.title);
  if (!urlMatchesShow(u, tokens)) return null;
  // Weak-specificity gate (ship-check 2026-07-24): isGenericShowTitle's raw
  // word-count test misses titles that are 2+ words on paper but reduce to a
  // SINGLE significant token once titleTokens() strips stopwords/short words
  // — e.g. "Oh, Mary!" -> ['mary'], "Life of Pi" -> ['life'], even
  // "Trainspotting the Musical" -> ['trainspotting']. urlMatchesShow (just
  // above) actually matches on THAT token set, so the real acceptance bar for
  // those titles is a single generic word — an un-scoped SERP query (no
  // site: restriction, unlike the aggregator-article queries above) is more
  // exposed to wrong-show contamination on exactly these titles. Gate on
  // tokens.length, not just isGenericShowTitle's word count, so the
  // disambiguation check actually fires when it needs to.
  if ((isGenericShowTitle(show.title) || tokens.length <= 1) && canDisambiguateGenericTitle(showInfo)) {
    const hay = `${(sr.title || '')} ${u} ${(sr.snippet || '')}`.toLowerCase();
    if (!hasDisambiguator(hay, showInfo)) return null;
  }
  return normalizeReviewUrl(u);
}

// Within-run cache of fetched aggregator articles. Playbill Verdict often
// covers multiple shows in one article (e.g. a "Best of Off-Broadway" recap
// linked from 3-5 different shows' Verdict permalinks). Without this cache,
// the hourly cron fetches the same URL N times. P1 fix 2026-05-27
// (ship-check): cap BD credit burn at ~1 fetch per unique article per run.
const _articleCache = new Map();

// Run-level fetch health. A single un-scrapeable article is tolerated (logged
// + skipped) so the hourly audit doesn't crash on one bad URL — e.g. a BWW
// `/westend/` redirect that all providers fail. But if EVERY attempted article
// fetch throws, the scraper stack itself is down (dead Bright Data zone /
// exhausted ScrapingBee / no Playwright) — the run must still redden CI so the
// outage is visible. See plan-review 2026-05-31. `errors` counts hard throws
// (all providers failed); `empty` counts 200-but-no-content (can be a legit
// page with no matching links, so it does NOT count toward the outage floor).
const _fetchStats = { attempts: 0, errors: 0, empty: 0 };

// Discovery (SERP) health — companion to _fetchStats for the OTHER outage class.
// findAggregatorArticles swallows SERP errors (returns [] on failure,
// indistinguishable from "no coverage"). Without this counter, a total SERP/key
// outage makes every show report 0 articles → extractAggregatorReviewUrls is
// never called → _fetchStats.attempts stays 0 → the article-fetch floor can't
// fire, and the audit silently reports "no gaps" during a real blackout
// (ship-check 2026-06-01, both reviewers). Count SERP calls + errors so the
// floor below catches discovery outage too.
const _serpStats = { attempts: 0, errors: 0 };

async function extractAggregatorReviewUrls(articleUrl, show) {
  let html;
  if (_articleCache.has(articleUrl)) {
    html = _articleCache.get(articleUrl);
  } else {
    _fetchStats.attempts++;
    let r;
    try {
      r = await fetchPage(articleUrl);
    } catch (e) {
      // Per-URL scrape failure. Mirror audit-url-validation.js:392 — record the
      // throw, warn, continue. The run-level floor below still reddens CI if
      // the WHOLE collector is down (every attempted fetch threw).
      _fetchStats.errors++;
      console.log(`::warning::aggregator fetch failed (${hostOf(articleUrl) || articleUrl}): ${e.message.split('\n')[0].slice(0, 120)}`);
      // Do NOT cache null on a THROW: a transient failure shouldn't poison the
      // URL for other shows that share this article, and re-attempting on each
      // show keeps _fetchStats accurate so the outage floor fires on a real
      // blackout (ship-check 2026-06-01). Only legit empty-content is cached.
      return null;
    }
    if (!r?.content) {
      _fetchStats.empty++;
      _articleCache.set(articleUrl, null);
      return null;
    }
    html = r.content;
    _articleCache.set(articleUrl, html);
  }
  if (html == null) return null;
  const $ = cheerio.load(html);
  const tokens = titleTokens(show.title);
  const urls = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!isReviewUrl(href)) return;
    if (!urlMatchesShow(href, tokens)) return;
    urls.add(normalizeReviewUrl(href));
  });
  // Production identity (2026-07-11): urlMatchesShow filters wrong SHOWS, not
  // wrong PRODUCTIONS — a same-title prior production's roundup passes it (the
  // 2018 TKAM Broadway RR → 77 "missing" 2018 URLs class). Date the ARTICLE
  // against this show's opening window; the caller marks out-of-window
  // articles' URLs priorRun (report-only, never auto-ingested). Computed per
  // (article, show) pair — a multi-show recap can be current for one show and
  // prior for another — so it lives outside the shared HTML cache.
  const identity = articleRunIdentity(html, show, articleUrl);
  return { urls: [...urls], priorRun: identity.priorRun, publishDate: identity.publishDate };
}

// Coarse label for reporting WHY a file is excluded (shown in flaggedMisses detail).
function classifyShowFile(d) {
  if (d.wrongProduction) return 'wrongProduction';
  if (d.wrongShow) return 'wrongShow';
  if (d.isNonReview) return 'nonReview';
  if (d.duplicateOf) return 'duplicate';
  if (d.isRoundupArticle) return 'roundup';
  if (!(d.fullText && d.fullText.length >= 400) && !d.aggregatorStars && d.assignedScore == null) {
    return 'emptyBody';
  }
  return 'clean';
}

// Canonical coverage test: a dir file "covers" an aggregator-listed review only if
// the rebuild would actually INCLUDE it. classifyShowFile()==='clean' previously
// counted empty-body / url_content_mismatch / stub files as covered (they carry no
// wrong* flag) even though rebuild drops them for low content-tier — that blind spot
// let Glengarry WE's empty Times review read as "covered" while it was excluded from
// reviews.json. Delegating to isIncludableForRebuild keeps the gap audit's notion of
// "covered" identical to the rebuild's notion of "included" by definition.
function isCoveredFile(d, show) {
  try {
    const filePath = d._file ? path.join(REVIEW_TEXTS_DIR, show.id, d._file) : null;
    return isIncludableForRebuild(d, show, filePath) === true;
  } catch (_) {
    return classifyShowFile(d) === 'clean';
  }
}

// FLAGGED_RECOVERY_CAP + isRecoverableFlaggedFile moved to scripts/lib/flagged-recovery.js
// (CLAUDE.md §15) so the self-healing write-loop below and its unit test share one
// implementation. A flagged-out file is auto-recoverable ONLY in the merge-safe
// empty-body case (no usable fullText/stars/score, no wrong-production/wrong-show
// flag, not human-protected, under the cap). Re-fetching the aggregator's
// current-production URL then just FILLS the missing text (createOrMergeReviewFile
// merges, never clobbers). Stale-slug wrongProduction recovery is deliberately NOT
// automated — see the deferral note on the recovery loop in main().

function isShowEligible(show) {
  if (!show.openingDate) return false;
  // --include-closed: also audit closed shows (one-time back-catalogue backfill).
  // Without it, only currently open/previews shows are checked (the default cron).
  if (!includeClosed && !['open', 'previews'].includes(show.status)) return false;
  const opened = new Date(show.openingDate);
  const today = new Date();
  const diffDays = (today - opened) / 86400000;
  // Eligible if opened within window OR in pre-opening (<=3 days from now)
  return diffDays >= -3 && diffDays <= windowDays;
}

async function auditShow(show, opts = {}) {
  const result = {
    showId: show.id,
    title: show.title,
    openingDate: show.openingDate,
    status: show.status,
    category: show.category,
    aggregatorArticles: [],
    aggregatorListedUrls: [],
    dirFiles: 0,
    dirClean: 0,
    inReviewsJson: 0,
    missing: [],         // urls listed by aggregator but not in dir
    dirOnly: [],         // urls in dir but not on aggregator (FYI, not necessarily bad)
    flaggedMisses: [],   // urls listed by aggregator that ARE in dir but flagged out
    citedNoUrl: [],      // WE reference rows with no URL (WET tables) whose outlet has no covered file — alert-only, never auto-ingestable
    weReference: null,   // WE reference source health ({sources, rowCount, allSourcesFailed})
    serpCensus: null,    // SERP review census health ({ran, query, resultCount, urlsFound} or {ran:false, reason})
  };

  const articles = await findAggregatorArticles(show);
  result.aggregatorArticles = articles;

  const aggUrls = new Set();
  // Broadway-path production identity: URLs cited ONLY by out-of-window
  // (prior-production) articles are priorRun → ingest-blocked. A URL also cited
  // by a current-run article stays ingestable (the current citation vouches).
  const bwCurrentUrls = new Set();
  const bwPriorCandidateUrls = new Set();
  for (const art of articles) {
    const extracted = await extractAggregatorReviewUrls(art, show);
    if (!extracted) continue;
    for (const u of extracted.urls) {
      aggUrls.add(u);
      (extracted.priorRun ? bwPriorCandidateUrls : bwCurrentUrls).add(u);
    }
    if (extracted.priorRun) {
      result.priorRunArticles = result.priorRunArticles || [];
      result.priorRunArticles.push({ url: art, publishDate: extracted.publishDate });
      console.log(`  ⏮  prior-production article (published ${extracted.publishDate || '?'}, opening ${show.openingDate}): ${art} — its ${extracted.urls.length} URL(s) are report-only`);
    } else if (!extracted.publishDate && extracted.urls.length > 0) {
      // Fail-open observability (codex review 2026-07-11): Playbill/BWW roundup
      // articles reliably carry OpenGraph/JSON-LD dates, so a dateless one means
      // metadata drift — and the production-identity gate is silently OFF for it.
      console.log(`::warning::no publish date extracted from aggregator article ${art} (${show.id}) — production-identity gate fails open for its ${extracted.urls.length} URL(s)`);
    }
  }
  const bwPriorRunUrls = new Set([...bwPriorCandidateUrls].filter(u => !bwCurrentUrls.has(u)));

  // Show Score per-show page → direct outlet review URLs. Show Score covers
  // off-Broadway (unlike DTLI, which is Broadway-only) — it lands later and lists
  // fewer reviews than Playbill/BWW, but the hourly audit eventually reconciles a
  // review that surfaced only there. We PAGINATE (Show Score renders only the
  // first 8; the rest come from /paginate_critic_reviews — The Receptionist has
  // 13). The "Read more" links are show-page-vouched, so we do NOT title-match
  // them — that lets opaque outlet URLs through (Lighting & Sound America uses
  // story.asp?ID=… with no title in the path, which title-matching rejected, so
  // L&SA was systematically missed across shows, 2026-06-06). isReviewUrl still
  // strips ticketing/maps/form links.
  try {
    const { showScoreUrlForShow, fetchAllShowScoreReviewUrls } = require('./lib/show-score-discover');
    const ssUrl = showScoreUrlForShow(show, getShowScoreUrlMap());
    if (ssUrl) {
      const fetchHtml = async (u) => {
        const r = await fetchPage(u, { timeout: 45000 });
        return (typeof r === 'string') ? r : ((r && (r.content || r.html || r.body)) || '');
      };
      for (const u of await fetchAllShowScoreReviewUrls(ssUrl, fetchHtml)) {
        if (isReviewUrl(u)) aggUrls.add(normalizeReviewUrl(u));
      }
    }
  } catch (e) {
    if (verbose) console.error(`  Show Score discovery error for ${show.id}: ${e.message}`);
  }

  // ---- SERP review census (completeness reference, 2026-07-23) ----
  // Playbill/BWW/WET/TR/LBO/Show Score above are all EDITOR-CURATED references —
  // they only see outlets those editors chose to cite. Trainspotting WE
  // (2026-07-23): a manual "<title> review" Google sweep surfaced 2 published
  // reviews (soundspheremag.com, jonathanbaz.com) NO aggregator cited —
  // invisible to every reference above by construction. This runs the SAME
  // search a human does, through the existing BD/SB/Scrapingdog chain, scoped
  // to the opening window and cooldown-gated (checkpoint) to bound SERP spend
  // (SB has hit its monthly cap before — #224). Kill switch: SERP_GAP_CENSUS_DISABLED=1.
  const serpCensusUrls = new Set();
  if (process.env.SERP_GAP_CENSUS_DISABLED !== '1') {
    const inWindowNow = inOpeningWindow(show);
    const cooldownRaw = parseInt(process.env.SERP_CENSUS_COOLDOWN_HOURS || '', 10);
    const cooldownHours = Number.isFinite(cooldownRaw) ? cooldownRaw : SERP_CENSUS_DEFAULT_COOLDOWN_HOURS;
    if (shouldRunSerpCensus({ inWindow: inWindowNow, lastRunAt: opts.lastCensusAt || null, cooldownHours })) {
      const showInfo = getShowInfo(show.id);
      // Every show gets whatever scoped follow-up queries its metadata
      // supports (venue token, creative surname) — no title-ambiguity
      // trigger. Rationale + rejected alternatives documented on
      // buildCensusQueries (serp-review-census.js).
      const queries = buildCensusQueries(show, { creativeNames: showInfo.creativeNames || [] });
      if (queries.length) {
        const dateRange = calculateDateWindow(show);
        const queryStatus = [];
        for (const query of queries) {
          try {
            // preferSpeed:false (BD-first) — this is a background completeness
            // sweep, not a user-waiting flow, and BD is the cheaper provider
            // (matches brand-mention-serp.js's SB-conservation posture).
            const serpResults = await serpQuery(query, { dateRange, preferSpeed: false });
            queryStatus.push({ query, ok: true, results: (serpResults || []).length, error: null });
            for (const sr of (serpResults || [])) {
              const accepted = acceptSerpCensusResult(sr, { show, showInfo });
              if (accepted) serpCensusUrls.add(accepted);
            }
          } catch (e) {
            const err = (e.message || '').slice(0, 120);
            queryStatus.push({ query, ok: false, results: 0, error: err });
            console.error(`::error::SERP census query failed for ${show.id} (${query}): ${err}`);
          }
        }
        const okCount = queryStatus.filter(q => q.ok).length;
        // `complete` (ALL queries executed) gates the checkpoint cooldown in
        // main(): a partial or total provider outage must NOT burn the
        // cooldown, or a dead/flaky provider silently sleeps the census
        // through the whole opening window (ship-check 2026-07-25 — the
        // first cut stamped off "any query ran", which let one surviving
        // low-value query mask a failed primary for 6h). `ran` stays "did
        // any census work happen" for reporting.
        result.serpCensus = {
          ran: okCount > 0,
          complete: okCount === queries.length,
          query: queries[0],
          queryStatus,
          queriesOk: okCount,
          resultCount: serpCensusUrls.size,
          error: okCount === queries.length ? null : (queryStatus.filter(q => !q.ok).map(q => q.error)[0] || null),
        };
      }
    } else {
      result.serpCensus = { ran: false, reason: inWindowNow ? 'cooldown' : 'out-of-window' };
    }
  }
  for (const u of serpCensusUrls) aggUrls.add(u);

  // ---- West End reference (completeness gate, 2026-07-10) ----
  // Playbill/BWW above are Broadway aggregators; for WE shows they find ~nothing,
  // which made "no gaps" vacuous (TKAM 2026: 6 live, 15 recoverable, zero alarms).
  // Reference = union of outlets cited by WET / theatre.reviews / LBO roundups,
  // via the same discovery libs the opening-night poller uses. Scoped to the
  // opening window so the 1095d back-catalogue grind doesn't fetch 4 aggregators
  // for all 362 WE shows every cycle. Kill switch: WE_GAP_REFERENCE_DISABLED=1.
  const weRefUrls = new Set();
  const weRefPriorRunUrls = new Set();
  const weRefUrlSources = new Map();  // normalized URL → Set of citing sources
  // normalized URL → {stars, source} from the first current-run citing row that
  // carries a star rating. Feeds the paywall star-fallback in recovery (The
  // Stage class): when the text can't be fetched, the citing roundup's stars
  // still make the review scoreable.
  const weRefUrlStars = new Map();
  const weRefNoUrlRows = [];
  let weRefData = null;
  // Per-source corroboration counts ({src: {cited, corroborated}}) — feeds the
  // proving tracker's aggregatorAccuracy (each source's citations vs reality).
  const weRefPerSource = {};
  const bumpPerSource = (src, corroborated) => {
    const e = weRefPerSource[src] = weRefPerSource[src] || { cited: 0, corroborated: 0 };
    e.cited++;
    if (corroborated) e.corroborated++;
  };
  if (process.env.WE_GAP_REFERENCE_DISABLED !== '1' && isWeShow(show) && inOpeningWindow(show)) {
    try {
      const weRef = await getWeReferenceRows(show, { log: (m) => { if (verbose) console.log(m); } });
      weRefData = weRef;
      result.weReference = { rowCount: weRef.rows.length, sources: weRef.sources, allSourcesFailed: weRef.allSourcesFailed };
      // Health floors (plan-review 2026-07-09): a broken detector must ALARM,
      // never read as "no gaps" — that vacuous green is the failure this gate exists to kill.
      if (weRef.allSourcesFailed) {
        console.error(`::error::WE reference blackout for ${show.id} — all WE aggregator discoveries errored; "no gaps" for this show is NOT meaningful this run.`);
      }
      for (const [src, st] of Object.entries(weRef.sources)) {
        if (!st.emptyParse) continue;
        // Passive (archive-only) sources are bonus coverage: a 0-row archive is
        // a stale paywall-stub artifact or parser drift — visible, but not a
        // detector failure of the live reference (QA review 2026-07-11).
        if (st.passive) console.log(`::warning::WE reference ${src} archive for ${show.id} parsed 0 rows (paywall-stub archive or parser drift) — source skipped this run.`);
        else console.error(`::error::WE reference empty-parse for ${show.id} — ${src} roundup was found but parsed 0 rows (parser drift?). Detector failure, not zero citations.`);
      }
      for (const row of weRef.rows) {
        if (row.url) {
          if (!isReviewUrl(row.url)) continue;
          const u = normalizeReviewUrl(row.url);
          aggUrls.add(u);
          weRefUrls.add(u);
          // Source attribution is CURRENT-RUN only (QA review 2026-07-11): a
          // source's prior-run citation must not earn corroboration credit for
          // (or vouch trust on) a URL its current roundup never cited.
          if (!row.priorRun) {
            if (!weRefUrlSources.has(u)) weRefUrlSources.set(u, new Set());
            weRefUrlSources.get(u).add(row.source);
            if (typeof row.stars === 'number' && row.stars > 0 && !weRefUrlStars.has(u)) {
              weRefUrlStars.set(u, { stars: row.stars, source: row.source });
            }
          }
          if (row.priorRun) weRefPriorRunUrls.add(u);
        } else {
          weRefNoUrlRows.push(row);
        }
      }
      // Current-run rows first (stable): the outlet-dedup loop below is
      // first-row-wins, and a prior-run citation must never shadow a current-run
      // citation of the same outlet (QA review 2026-07-11 — a shadowed current
      // gap would be mislabeled priorRun and lose its 24h alert re-ping).
      weRefNoUrlRows.sort((a, b) => (a.priorRun ? 1 : 0) - (b.priorRun ? 1 : 0));
    } catch (e) {
      console.error(`::error::WE reference failed for ${show.id}: ${(e.message || '').slice(0, 120)}`);
    }
  }

  result.aggregatorListedUrls = [...aggUrls];
  if (aggUrls.size === 0 && weRefNoUrlRows.length === 0) return result;

  const dirData = loadDirFiles(show.id);
  result.dirFiles = dirData.length;

  // Map dir files by hostname (multiple files per host possible)
  const dirByHost = new Map();
  for (const d of dirData) {
    const h = hostOf(d.url || '');
    if (!h) continue;
    if (!dirByHost.has(h)) dirByHost.set(h, []);
    dirByHost.get(h).push(d);
    if (isCoveredFile(d, show)) result.dirClean++;
  }

  const reviewsJson = loadReviews();
  result.inReviewsJson = reviewsJson.filter(r => r.showId === show.id).length;

  // For each aggregator-listed URL: is it covered locally?
  const knownDomains = getKnownDomainMap();
  for (const aggUrl of aggUrls) {
    const aggHost = hostOf(aggUrl);
    if (!aggHost) continue;
    const knownOutletId = knownDomains.get(aggHost) || null;
    const dirFiles = dirByHost.get(aggHost) || [];
    if (dirFiles.length === 0) {
      result.missing.push({ url: aggUrl, host: aggHost, knownOutletId });
    } else {
      const clean = dirFiles.filter(d => isCoveredFile(d, show));
      if (clean.length === 0) {
        // recoverable = at least one excluded file for this host is empty-body or
        // explicitly marked needsRefetch (Guardian stale-slug guard). Those can be
        // healed by re-fetching the aggregator's CURRENT-production URL. Genuine
        // wrong-show / manually-protected exclusions are NOT recoverable.
        const recoverableFile = dirFiles.find(d => isRecoverableFlaggedFile(d));
        result.flaggedMisses.push({
          url: aggUrl,
          host: aggHost,
          knownOutletId,
          recoverable: !!recoverableFile,
          recoverableFile: recoverableFile ? recoverableFile._file : null,
          // Carry the EXISTING file's outletId + criticName so the recovery
          // re-ingest writes back into the SAME slug (createOrMergeReviewFile
          // resolves by outletId+criticName) instead of spawning a sibling file.
          // Fall back to the aggregator-derived knownOutletId if the stored file
          // has no outletId.
          recoverableOutletId: recoverableFile ? (recoverableFile.outletId || knownOutletId) : null,
          recoverableCritic: recoverableFile ? (recoverableFile.criticName || null) : null,
          recoverableCount: recoverableFile ? (recoverableFile.aggUrlRecoveryCount || 0) : 0,
          dirFlags: dirFiles.map(d => ({ file: d._file, flag: classifyShowFile(d), urlInDir: d.url })),
        });
      }
    }
  }

  // dirOnly: hosts in dir clean but not on aggregator
  const aggHosts = new Set([...aggUrls].map(hostOf));
  for (const [h, files] of dirByHost) {
    if (aggHosts.has(h)) continue;
    const clean = files.filter(d => isCoveredFile(d, show));
    if (clean.length > 0) {
      result.dirOnly.push({ host: h, count: clean.length });
    }
  }

  // Tag WE-reference-derived missing URLs. Ingest for these is gated by
  // WE_GAP_INGEST=1 (absent = report-only — the SAFE default; a dropped env line
  // must fail closed), and prior-run roundup URLs are PERMANENTLY report-only
  // (auto-ingesting a prior production's URLs is the WET mass-ingestion class).
  if (weRefUrls.size > 0 || bwPriorRunUrls.size > 0 || serpCensusUrls.size > 0) {
    for (const m of [...result.missing, ...result.flaggedMisses]) {
      if (weRefUrls.has(m.url)) {
        m.weRef = true;
        m.weRefSources = [...(weRefUrlSources.get(m.url) || [])];
        const starRow = weRefUrlStars.get(m.url);
        if (starRow) {
          m.weRefStars = starRow.stars;
          m.weRefStarsSource = starRow.source;
        }
      }
      if (weRefPriorRunUrls.has(m.url)) m.priorRun = true;
      // Broadway-path production identity: cited only by a prior production's
      // dated aggregator article → permanently report-only (TKAM 2018 class).
      if (bwPriorRunUrls.has(m.url)) { m.priorRun = true; m.priorRunSource = 'aggregator-article-date'; }
      // SERP census provenance (report/debug only — ingest eligibility for
      // these follows the same rules as any other missing URL: blocked on WE
      // shows until WE_GAP_INGEST=1, per gap-ingest-policy.js).
      if (serpCensusUrls.has(m.url)) m.serpCensus = true;
    }
  }

  // Outlet-based coverage for URL-less WE citations (WET's dominant table format
  // cites outlet+stars with NO link — URL-only matching would silently drop the
  // biggest citation class; plan-review P0). Covered = any file for the outlet
  // that passes isIncludableForRebuild (this naturally covers paywalled star-stubs,
  // which ARE scoreable — memory: paywalled star outlets are not gaps), or a
  // _pending/ no-byline strand file (known, tracked elsewhere — not a NEW gap).
  let _weCoveredNoUrl = 0;
  if (weRefNoUrlRows.length > 0) {
    // Canonical outlet key: WET prints display variants that normalize to ids the
    // registry doesn't use ("Time Out London"→timeout-london vs registry timeout;
    // "Broadway World UK"→broadway-world-uk vs broadwayworld). Collapse hyphens and
    // strip a -london/-uk market suffix so a COVERED outlet is never reported
    // missing for 21 days over a naming variant (ship-check P1 2026-07-10).
    const outletKey = (oid) => String(oid || '').replace(/-(london|uk)$/,'').replace(/-/g, '');
    const dirByOutlet = new Map();
    for (const d of dirData) {
      const oid = outletKey(normalizeOutletId(d.outletId || (d._file || '').split('--')[0] || ''));
      if (!oid) continue;
      if (!dirByOutlet.has(oid)) dirByOutlet.set(oid, []);
      dirByOutlet.get(oid).push(d);
    }
    let pendingOutlets = new Set();
    try {
      const pendingDir = path.join(REVIEW_TEXTS_DIR, '_pending', show.id);
      if (fs.existsSync(pendingDir)) {
        pendingOutlets = new Set(fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).map(f => outletKey(normalizeOutletId(f.split('--')[0]))));
      }
    } catch { /* pending scan is best-effort */ }
    const seenOutlets = new Set();
    for (const row of weRefNoUrlRows) {
      const rawOid = normalizeOutletId(row.outletId || row.outletName);
      const oid = outletKey(rawOid);
      if (!oid || seenOutlets.has(oid)) continue;
      seenOutlets.add(oid);
      const files = dirByOutlet.get(oid) || [];
      if (files.some(d => isCoveredFile(d, show))) {
        if (!row.priorRun) { _weCoveredNoUrl++; bumpPerSource(row.source, true); }
        continue;
      }
      if (pendingOutlets.has(oid)) continue;
      // Accuracy counts only CHECKABLE citations (QA review 2026-07-11): an
      // outlet with NO files at all is merely un-gathered — unverifiable, not
      // contradicted — and must not count against the source's accuracy (a
      // fresh opening's first hours would otherwise flip sources low-trust).
      // Excluded-files-exist IS checkable: we hold independent data and it
      // doesn't corroborate the citation.
      if (!row.priorRun && files.length > 0) bumpPerSource(row.source, false);
      result.citedNoUrl.push({
        outletId: rawOid,
        outletName: row.outletName,
        stars: row.stars,
        source: row.source,
        sourceArticleUrl: row.sourceArticleUrl,
        priorRun: row.priorRun,
        hasExcludedFiles: files.length > 0,
      });
    }
  }

  // Corroboration stats for the self-proving gate (ship-check P0 2026-07-11):
  // proving must measure REFERENCE CORRECTNESS, not detector uptime. A citation is
  // corroborated when it names a review we independently have (covered file) —
  // CURRENT-RUN rows only; prior-run rows are permanently ingest-blocked and prove
  // nothing about ingest safety.
  if (result.weReference && weRefData) {
    const currentRunRows = weRefData.rows.filter(r => !r.priorRun);
    const missingUrls = new Set(result.missing.map(m => m.url));
    const flaggedUrls = new Set(result.flaggedMisses.map(m => m.url));
    let coveredUrlRows = 0;
    const seenUrls = new Set();
    for (const row of currentRunRows) {
      if (!row.url || !isReviewUrl(row.url)) continue;
      const u = normalizeReviewUrl(row.url);
      if (seenUrls.has(u)) continue;
      seenUrls.add(u);
      const covered = !missingUrls.has(u) && !flaggedUrls.has(u);
      if (covered) coveredUrlRows++;
      // Accuracy counts only CHECKABLE citations (QA review 2026-07-11): a URL
      // still in `missing` (no file for its host at all) is merely un-gathered —
      // unverifiable, not contradicted. covered = corroborated; flagged = we
      // hold files for the host and none corroborate = checkable blame.
      if (missingUrls.has(u)) continue;
      // Every current-run source that cited this URL earns the credit/blame —
      // per-source accuracy is about EACH source's citations matching reality.
      for (const src of (weRefUrlSources.get(u) || [])) bumpPerSource(src, covered);
    }
    result.weReference.currentRunRows = currentRunRows.length;
    result.weReference.corroborated = coveredUrlRows + _weCoveredNoUrl;
    result.weReference.perSource = weRefPerSource;
  }

  return result;
}

// Use execFileSync (no shell) so attacker-controllable URLs from aggregator
// pages can't smuggle backticks/$()/$VAR/newlines into a shell. P0 fix
// 2026-05-27 (ship-check). The earlier execSync apostrophe-only escape was
// insufficient — aggregator pages are third-party HTML that can include
// arbitrary anchor href values.
//
// P1 fix 2026-05-27 (ship-check): skip dispatch if gather-reviews already ran
// for this show within the last 2 hours. Without this, the hourly cron would
// re-dispatch the same failing-to-find show indefinitely (gather can't find
// what gather couldn't find an hour ago). Two-hour cooldown matches the
// orchestrator's poll cadence so we don't fight it.
const GATHER_DISPATCH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
function recentlyDispatched(showId) {
  try {
    const out = execFileSync('gh', [
      'run', 'list',
      '--workflow=gather-reviews.yml',
      '--limit=20',
      '--json=createdAt,displayTitle,event',
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString();
    const runs = JSON.parse(out);
    const now = Date.now();
    for (const run of runs) {
      const title = (run.displayTitle || '').toLowerCase();
      // gather-reviews dispatches with `shows=<id>` show up in displayTitle.
      // Fall through to any workflow_dispatch within window as a fail-safe.
      if (title.includes(showId.toLowerCase()) || run.event === 'workflow_dispatch') {
        const age = now - Date.parse(run.createdAt);
        if (age < GATHER_DISPATCH_COOLDOWN_MS && title.includes(showId.toLowerCase())) {
          return true;
        }
      }
    }
  } catch { /* fail-open: better to dispatch on uncertain history than block */ }
  return false;
}
async function dispatchGatherFor(showId) {
  if (recentlyDispatched(showId)) {
    console.log(`  ⏸  gather-reviews dispatched within last 2h for ${showId} — skipping`);
    return false;
  }
  try {
    execFileSync('gh', ['workflow', 'run', 'gather-reviews.yml', '-f', `shows=${showId}`], { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(`  dispatch failed for ${showId}: ${e.message}`);
    return false;
  }
}

// Direct ingest of a missing URL via scripts/ingest-review-from-url.js. Unlike
// dispatchGatherFor (which re-runs SERP discovery — the same pipeline that
// already failed to find this URL), this targets the specific aggregator-
// listed URL. Closes the systemic gap where Playbill Verdict / BWW RR lists a
// review URL but our outlet-registry or SERP cadence misses it.
//
// Returns { ok, reason } so the caller can log per-URL outcomes. Skips URLs
// whose host is unknown to the registry (those should be added to the registry
// first via the unknown-aggregator-outlets audit).
function ingestMissingUrl(showId, url, knownOutletId) {
  const args = ['scripts/ingest-review-from-url.js', `--show=${showId}`, `--url=${url}`];
  let provisional = false;
  if (knownOutletId) {
    args.push(`--outlet=${knownOutletId}`);
  } else {
    // Auto-onboard: capture the review under a domain-derived provisional slug
    // rather than skipping (the pre-2026-06-05 behavior, which lost the ctvoice /
    // New York Notebook class). The host is still recorded in
    // unknown-aggregator-outlets.json so it can be promoted to a real registry
    // entry; --provisional skips fuzzy alias resolution so the slug is written as-is.
    const provId = provisionalOutletIdFromHost(hostOf(url));
    if (!provId) return { ok: false, reason: 'unknown-outlet-no-host', provisional: true };
    args.push(`--outlet=${provId}`, '--provisional');
    provisional = true;
  }
  try {
    execFileSync('node', args, { stdio: 'pipe', timeout: 120000 });
    return { ok: true, reason: null, provisional };
  } catch (e) {
    return { ok: false, reason: execErrorDetail(e, 100), provisional };
  }
}

// Persist aggUrlRecoveryCount onto the existing dir file. Called after a recovery
// attempt that did NOT actually fill the file (fetch failure OR a no-op/misrouted
// ingest), so a dead / permanently-paywalled / misrouted URL stops after
// FLAGGED_RECOVERY_CAP tries instead of being re-fetched every hour forever (the
// credit-burn failure mode the cap exists to prevent). Writes to REVIEW_TEXTS_DIR
// (where the audit detected the file).
//
// Concurrency bound (known, accepted): the counter is NOT a PROTECTED_FIELD, and
// push-review-texts resolves same-file conflicts whole-file by fullText length —
// so if another workflow modifies this empty file in the same window and pushes
// first, this bump can be dropped on rebase. That is bounded, not unbounded: the
// audit cron is single-instance (queued), so it simply re-bumps next hour; the
// worst case is a few extra retries on one file, never an infinite loop. Adding it
// to PROTECTED_FIELDS would not help — the restore step only re-adds MISSING fields,
// it does not reconcile a stale-lower value. Best-effort: a write failure must not
// crash the run.
function bumpRecoveryCount(showId, file, value) {
  try {
    const fp = path.join(REVIEW_TEXTS_DIR, showId, file);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    data.aggUrlRecoveryCount = value;
    data.aggUrlRecoveryAt = new Date().toISOString();
    // Route through safeWriteReview so this metadata bump preserves protected
    // fields / manual clears (CI lint enforces all review-texts writes go through it).
    safeWriteReview(fp, data);
    return true;
  } catch (e) {
    console.log(`::warning::failed to persist aggUrlRecoveryCount for ${showId}/${file}: ${e.message.split('\n')[0].slice(0, 100)}`);
    return false;
  }
}

// Self-healing recovery for ONE empty-body flaggedMiss. Re-ingests the
// aggregator's current-production URL under the existing file's outletId +
// criticName so createOrMergeReviewFile MERGES the fetched text into the empty
// file (a fill, not a sibling). The retry counter is bumped regardless of fetch
// outcome (see bumpRecoveryCount) so the cap actually halts retries. Returns the
// per-flaggedMiss outcome for logging + the audit JSON.
function recoverEmptyBodyFlaggedMiss(showId, m, openingDate = null) {
  // Re-run the cap/url decision against the CURRENT on-disk file, not the
  // reconstructed flaggedMiss view. The audit JSON can be minutes stale, and a
  // parallel session/workflow may have FILLED the file since detection —
  // 2026-07-18 incident: heathers theatre-weekly was manually filled (3367
  // chars, scored 74) between audit detection and this recovery pass; the old
  // reconstructed view ({aggUrlRecoveryCount} with fullText absent) read as
  // empty-body, the recovery re-ingested an empty aggregator fetch, and the
  // workflow's stale checkout then pushed the husk over the real review.
  // decideEmptyBodyRecovery's isEmptyBodyFile check on the fresh read makes
  // this pass a no-op when the file is no longer empty. Fall back to the
  // reconstructed view only when the file is unreadable (deleted/renamed —
  // recovery would then recreate it, which is the intended fill behavior).
  let file;
  try {
    file = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, showId, m.recoverableFile), 'utf8'));
  } catch {
    file = { aggUrlRecoveryCount: m.recoverableCount || 0 };
  }
  const decision = decideEmptyBodyRecovery({
    file,
    outletId: m.recoverableOutletId || m.knownOutletId || null,
    critic: m.recoverableCritic || null,
    url: m.url,
  });
  if (decision.action !== 'recover') {
    return { url: m.url, host: m.host, file: m.recoverableFile, recovered: false, skipped: true, reason: decision.reason };
  }
  // Re-ingest under the existing slug. For a registry-known outlet pass --outlet
  // directly (canonical resolution); only fall back to provisional onboarding when
  // the host isn't in the registry. Force the critic so the slug matches the
  // empty file (else a re-extracted byline could spawn a sibling).
  const iargs = ['scripts/ingest-review-from-url.js', `--show=${showId}`, `--url=${m.url}`];
  let provisional = false;
  if (decision.outletId) {
    iargs.push(`--outlet=${decision.outletId}`);
  } else {
    const provId = provisionalOutletIdFromHost(m.host);
    if (provId) { iargs.push(`--outlet=${provId}`, '--provisional'); provisional = true; }
  }
  if (decision.critic && decision.critic.toLowerCase() !== 'unknown') {
    iargs.push(`--critic=${decision.critic}`);
  }
  let ingestExit = false; let reason = null;
  try {
    execFileSync('node', iargs, { stdio: 'pipe', timeout: 120000 });
    ingestExit = true;
  } catch (e) {
    reason = execErrorDetail(e, 100);
  }
  // "recovered" = the empty file is now ACTUALLY filled — NOT merely that the child
  // exited 0. ingest-review-from-url.js exits 0 on a no-op skip ("already exists",
  // "no-changes") too, and a URL-refined / cross-market merge can land the text in a
  // DIFFERENT file while THIS one stays empty (ship-check 2026-06-22, both reviewers).
  // Re-reading the file is the only honest signal: it keeps totalRecovered + the
  // residual-gap warning accurate and lets the counter keep climbing toward the cap
  // when the heal didn't actually land here.
  let recovered = false;
  try {
    const fp = path.join(REVIEW_TEXTS_DIR, showId, m.recoverableFile);
    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    recovered = !isEmptyBodyFile(after);
    // Post-fill production-window check (Tender/Sessions 2026-07-24): a
    // DATELESS stub passes the pre-fetch prior-run guard open; only the filled
    // text carries the real publishDate. If it lands outside the production
    // window, the URL was a different production/show SERP-mismatched onto
    // this entry — flag it here instead of shipping it to validate-data.js
    // (which went red on main when the sweep filled a 2021 'Sessions' review
    // into Tender's Times slot).
    if (recovered && filledDateOutsideWindow(after.publishDate, openingDate)) {
      after.wrongProduction = true;
      after.wrongProductionNote = `auto-flag: filled text dated ${after.publishDate}, outside the production window around opening ${openingDate} (post-fill recovery guard)`;
      safeWriteReview(fp, after, { force: true });
      recovered = false;
      reason = `filled text dated ${after.publishDate} — outside production window, flagged wrongProduction`;
    }
  } catch { /* file unreadable/missing → treat as not recovered */ }
  if (ingestExit && !recovered && !reason) reason = 'ingest no-op (text landed elsewhere or unchanged)';
  // Star fallback (The Stage class, 2026-07-23): the text fetch failed — usually
  // a paywall — but the citing WE roundup carries the outlet's star rating.
  // Writing aggregatorStars makes the review scoreable via the rebuild's
  // aggregator-star path, instead of retrying the paywall to the cap and going
  // silent. Only fires when the file (re-read post-ingest) is still empty-body.
  let starFallback = false;
  if (!recovered && typeof m.weRefStars === 'number' && m.weRefStars > 0
      && STAR_SOURCE_BY_REFERENCE[m.weRefStarsSource]) {
    try {
      const fp = path.join(REVIEW_TEXTS_DIR, showId, m.recoverableFile);
      const cur = JSON.parse(fs.readFileSync(fp, 'utf8'));
      // Rebuild's aggregatorStars fallback only scores KNOWN_STAR_OUTLETS
      // (rebuild-helpers.js P5.7) — an aggregator may have invented a rating
      // for an outlet that doesn't publish stars. Writing stars for an unknown
      // outlet would flip this audit green while the rebuild still excludes the
      // review (ship-check 2026-07-23, Codex finding). Gate on the same set.
      const outletForStars = cur.outletId || m.recoverableOutletId || m.knownOutletId;
      if (KNOWN_STAR_OUTLETS.has(outletForStars) && isEmptyBodyFile(cur) && !cur.aggregatorStars) {
        cur.aggregatorStars = `${m.weRefStars}/5`;
        cur.scoreSource = STAR_SOURCE_BY_REFERENCE[m.weRefStarsSource];
        safeWriteReview(fp, cur);
        const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
        recovered = !isEmptyBodyFile(after);
        starFallback = recovered;
        if (recovered) reason = null;
      }
    } catch (e) {
      console.log(`::warning::star fallback failed for ${showId}/${m.recoverableFile}: ${e.message.split('\n')[0].slice(0, 100)}`);
    }
  }
  // Bump the counter EVERY time the heal didn't land here (failure OR no-op) so a
  // dead/misrouted URL halts at the cap. A genuinely-healed file is no longer
  // empty-body, so it won't be re-selected and doesn't need the bump.
  let nextCount = m.recoverableCount || 0;
  if (!recovered) {
    nextCount = nextRecoveryCount(file);
    bumpRecoveryCount(showId, m.recoverableFile, nextCount);
  }
  return { url: m.url, host: m.host, file: m.recoverableFile, recovered, skipped: false, provisional, starFallback, reason, recoveryCount: nextCount };
}

// CLI entry — guarded so the module can be require()'d by unit tests without
// running the audit (CLAUDE.md §15: test the real urlMatchesShow/titleTokens).
// Extracted to a named, argv-taking function (rather than the previous bare
// IIFE) so --help can be proven, in-process, to return before loadShows() or
// any gh subprocess runs (task #266 — same pattern as autonomous-merge.js).
// NOTE: the argv param only feeds hasHelpFlag() — every other flag below
// (showFilter, dispatchGather, useCheckpoint, etc.) still reads the
// module-level consts parsed from real process.argv at require time. That's
// fine for the real CLI (argv defaults to the same process.argv) and for
// --help (which always returns before any flag is consulted); a
// programmatic caller passing a DIFFERENT argv would still route real
// actions off the module-level parse, not the passed argv.
async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const allShows = loadShows();
  let targets;
  if (showFilter) {
    targets = allShows.filter(s => s.id === showFilter);
    if (targets.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  } else {
    targets = allShows.filter(isShowEligible);
  }

  // Checkpoint ordering: process least-recently-audited shows first and skip
  // those still within their freshness window, so each time-boxed run makes
  // forward progress instead of re-auditing the same first shows every hour.
  const checkpoint = useCheckpoint ? loadCheckpoint() : {};
  if (useCheckpoint && !showFilter) {
    const now = Date.now();
    const before = targets.length;
    targets = targets
      .filter((s) => {
        const e = checkpoint[s.id];
        if (!e) return true; // never audited → always include
        // WE reference invalidation: entries written before the WE reference
        // existed recorded vacuous gaps:0 (59 shows) and closed-clean shows get a
        // 365d skip — force one re-audit under the new reference version.
        if (isWeShow(s) && e.refVersion !== WE_REF_VERSION) return true;
        // checkpointTs → 0 on malformed `at`, so a corrupt entry reads as
        // never-audited (always due) instead of NaN-skipped forever.
        return (now - checkpointTs(e)) >= freshnessMsFor(s, e, { freshnessHours: FRESHNESS_HOURS, now });
      })
      // Opening-window shows first (reviews landing NOW), then oldest-audited.
      .sort((a, b) => compareAuditPriority(a, b, checkpoint, now));
    console.log(`audit-show-review-gap: ${targets.length}/${before} due for audit (checkpoint, freshness skip applied)`);
  }

  console.log(`audit-show-review-gap: ${targets.length} target(s) (window=${windowDays}d${includeClosed ? ', incl. closed' : ''})`);

  const results = [];
  const dispatched = new Set();
  const runStart = Date.now();
  let budgetHit = false;
  // Per-aggregator trust, measured from accumulated corroboration (start-of-run
  // snapshot — this run's observations inform the NEXT run's trust decisions).
  // A source whose citations have measurably failed corroboration loses
  // auto-ingest privileges; its rows stay report-only (fail-open on thin samples).
  const lowTrust = lowTrustSources(loadWeProving());
  if (lowTrust.size > 0) {
    console.log(`⚠️  low-trust WE reference source(s) — rows report-only: ${[...lowTrust].join(', ')}`);
  }
  for (const s of targets) {
    // Soft time budget: stop taking on new shows before the CI hard timeout so
    // the checkpoint + ingested review-texts commit cleanly (the 25-min cancel
    // race). Next run resumes from the next least-recently-audited show.
    if (useCheckpoint && (Date.now() - runStart) > TIME_BUDGET_MS) {
      budgetHit = true;
      console.log(`⏱  time budget (${Math.round(TIME_BUDGET_MS / 60000)}m) reached — stopping after ${results.length} shows; checkpoint will resume the rest next run.`);
      break;
    }
    if (verbose) console.log(`\n${s.id} "${s.title}" (${s.openingDate} ${s.status})`);
    const r = await auditShow(s, { lastCensusAt: checkpoint[s.id] && checkpoint[s.id].serpCensusAt });
    if (useCheckpoint) {
      // serpCensusAt: only stamped when the census actually ran this pass
      // (cooldown gate consults it); otherwise carry forward whatever was
      // already recorded so the cooldown isn't reset by an unrelated skip.
      const prevCensusAt = checkpoint[s.id] && checkpoint[s.id].serpCensusAt;
      checkpoint[s.id] = {
        at: new Date().toISOString(),
        gaps: r.missing.length + r.flaggedMisses.length + r.citedNoUrl.length,
        ...(isWeShow(s) ? { refVersion: WE_REF_VERSION } : {}),
        ...(checkpoint[s.id] && checkpoint[s.id].weAlert ? { weAlert: checkpoint[s.id].weAlert } : {}),
        // Cooldown stamps ONLY on a fully-successful census (every query
        // executed). Partial provider outages keep the prior stamp so the
        // next hourly run retries — bounded: ≤3 BD queries/show/hour ≈
        // $0.005/hour worst case while a provider is down.
        ...((r.serpCensus && r.serpCensus.complete) ? { serpCensusAt: new Date().toISOString() } : (prevCensusAt ? { serpCensusAt: prevCensusAt } : {})),
      };
      saveCheckpoint(checkpoint);
    }
    results.push(r);

    // WE completeness alert: email the named missing outlets for opening-window
    // WE shows. Deduped on missing-SET change + 24h re-ping — the hourly cron
    // would otherwise re-alert ~240× per show over a 10-day window and the
    // channel gets muted (plan-review 2026-07-09; the ::warning:: digest failed
    // exactly this way). Delivered via email (discord-notify email:true) — the
    // log-only path is what kept months of gaps invisible.
    // Scope the alert STRICTLY to WE-reference-derived gaps (weRef missing +
    // citedNoUrl). The Broadway-path SERP finds same-title PRIOR-PRODUCTION
    // roundups for WE revivals (TKAM: the 2018 Broadway BWW RR → 77 'missing'
    // US URLs) — alerting on those is a noise blast that gets the channel muted
    // (verified in the 2026-07-10 e2e run). Those stay in the audit JSON and the
    // existing ::warning:: digest, as before.
    const weMissing = r.missing.filter(m => m.weRef);
    if (isWeShow(s) && r.weReference && (weMissing.length + r.citedNoUrl.length) > 0) {
      const missingIds = [
        ...weMissing.map(m => m.knownOutletId || m.host),
        ...r.citedNoUrl.map(c => c.outletId),
      ];
      const hash = missingSetHash(missingIds);
      const prevAlert = (checkpoint[s.id] && checkpoint[s.id].weAlert) || {};
      const rePingDue = !prevAlert.at || (Date.now() - new Date(prevAlert.at).getTime()) > 24 * 60 * 60 * 1000;
      // Prior-run-only sets are UNFIXABLE rows (report-only forever) — alert once
      // on set-change, never daily re-ping, or a returning production emails every
      // day of the 21-day window (ship-check P1 2026-07-10).
      const allPriorRun = [...weMissing, ...r.citedNoUrl].every(x => x.priorRun);
      // Manual runs (no --checkpoint) have no dedup state — the operator is
      // watching stdout; log instead of emailing on every invocation.
      if (useCheckpoint && (hash !== prevAlert.hash || (rePingDue && !allPriorRun))) {
        try {
          const { sendAlert } = require('./lib/discord-notify');
          const lines = [
            ...weMissing.map(m => `• ${m.knownOutletId || m.host} — ${m.url}${m.priorRun ? ' [prior-run roundup]' : ''}`),
            ...r.citedNoUrl.map(c => `• ${c.outletId} — cited by ${c.source}${c.stars ? ` (${c.stars}★)` : ''}, no URL${c.priorRun ? ' [prior-run roundup]' : ''}`),
          ];
          const delivered = await sendAlert({
            title: `WE review gap — ${s.title}: ${lines.length} outlet(s) missing`,
            description: `${r.inReviewsJson} review(s) in reviews.json; WE roundups cite ${weMissing.length + r.citedNoUrl.length} outlet(s) we don't have. Ingest a URL: node scripts/ingest-review-from-url.js --show=${s.id} --url=<url>`,
            severity: 'warning',
            fields: [{ name: 'Missing outlets', value: lines.slice(0, 20).join('\n') || '(none)' }],
            url: `https://github.com/${process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore'}/actions`,
            email: true,
          });
          // Record the hash when the alert was HANDLED: delivered, or
          // suppressed by the actionable-only email policy (warning-severity
          // alerts no longer email, 2026-07-11 — without this, `delivered`
          // stays false forever and the hourly cron re-attempts the same
          // alert indefinitely). Retry-on-false is preserved only for the
          // case it was built for: policy WOULD email but delivery failed
          // (missing RESEND/OWNER_EMAIL or Resend error).
          const { shouldEmailAlert } = require('./lib/discord-notify');
          if (delivered || !shouldEmailAlert('warning')) {
            checkpoint[s.id] = { ...(checkpoint[s.id] || {}), weAlert: { hash, at: new Date().toISOString(), delivered } };
            saveCheckpoint(checkpoint);
          }
        } catch (e) {
          console.error(`::error::WE gap alert failed for ${s.id}: ${(e.message || '').slice(0, 100)}`);
        }
      }
    }

    // Self-proving tracker: record this observation for WE in-window shows so the
    // gate can auto-enable ingest once it has proven itself (see lib/we-gate-proving.js).
    if (isWeShow(s) && inOpeningWindow(s) && process.env.WE_GAP_REFERENCE_DISABLED !== '1') {
      const proving = loadWeProving();
      recordGateObservation(proving, s, r.weReference);
      saveWeProving(proving);
    }

    const gapTotal = r.missing.length + r.flaggedMisses.length + r.citedNoUrl.length;
    const summary = `  ${r.inReviewsJson}/${r.aggregatorListedUrls.length || '?'} reviews | ${gapTotal} gap (missing=${r.missing.length} flagged=${r.flaggedMisses.length} citedNoUrl=${r.citedNoUrl.length})`;
    if (verbose || gapTotal > 0) console.log(`${r.showId}${verbose ? '' : ': ' + r.title}\n${summary}`);
    if (verbose && r.missing.length > 0) {
      for (const m of r.missing) console.log(`    ❌ ${m.url}`);
    }
    if (verbose && r.flaggedMisses.length > 0) {
      for (const m of r.flaggedMisses) console.log(`    ⚠️ ${m.url} (flagged: ${m.dirFlags.map(f => f.flag).join(',')})`);
    }
    if (dispatchGather && gapTotal > 0 && !dispatched.has(r.showId)) {
      const ok = await dispatchGatherFor(r.showId);
      if (ok) {
        dispatched.add(r.showId);
        console.log(`  ⤳ dispatched gather-reviews for ${r.showId}`);
      }
    }
    // --ingest-missing: directly ingest each missing aggregator URL whose host
    // is in our outlet-registry. Targets the specific URL rather than re-
    // running gather's SERP+RSS discovery (which already failed). Unknown
    // outlets are skipped (see data/audit/unknown-aggregator-outlets.json for
    // registry-onboarding queue).
    // Per-show fetch budget shared across missing-URL ingest AND empty-body
    // recovery, so a fresh opening with both kinds of gap can't burn 2×
    // INGEST_PER_SHOW_CAP scraper credits in a single hourly run.
    let perShowFetches = 0;
    if (ingestMissing && r.missing.length > 0) {
      // Auto-onboard 2026-06-05: ingest ALL missing URLs, not just registry-known
      // outlets. Unknown outlets are captured under a domain-derived provisional
      // slug (ingestMissingUrl) instead of being skipped — that skip lost the
      // ctvoice / New York Notebook class on the Girl, Interrupted opening. The
      // host is still recorded in unknown-aggregator-outlets.json for promotion
      // to a real registry entry.
      // WE ingest gate (default OFF — plan-review 2026-07-09): WE-reference URLs
      // ingest ONLY when WE_GAP_INGEST=1 is explicitly set (a dropped env line
      // fails closed to report-only), and prior-run roundup URLs NEVER ingest.
      const weGateOn = process.env.WE_GAP_INGEST === '1';
      // SERP census gate (#371, default OFF): an un-scoped SERP hit is weaker-
      // specificity than a site:-restricted aggregator query — start report-
      // only until proven, same posture as the WE gate before WE_GAP_INGEST.
      const serpCensusGateOn = process.env.SERP_CENSUS_INGEST === '1';
      // On WE shows, the gate covers ALL missing URLs — not just weRef rows. The
      // Broadway-path SERP/Show Score discovery finds same-title US/prior-production
      // roundups for WE shows and ingested their reviews (2026-07-10 first-run
      // incident: 2018 TKAM Broadway, 2013 Midsummer/Taymor, 2014 Last Ship, 2025
      // NYC JLP reviews all ingested onto WE entries → validate-data red).
      const showIsWe = isWeShow(s);
      // Canonical ingest-eligibility predicate (lib/gap-ingest-policy.js):
      // prior-run URLs block on EVERY market/path; WE gate blocks the rest on
      // WE shows + weRef rows until WE_GAP_INGEST=1; serpCensus rows wait for
      // SERP_CENSUS_INGEST=1 on every market.
      const blockedPred = (m) => ingestBlockReason(m, { showIsWe, weGateOn, lowTrustSources: lowTrust, serpCensusGateOn }) !== null;
      const weBlocked = r.missing.filter(blockedPred);
      const eligibleMissing = r.missing.filter(m => !blockedPred(m));
      if (weBlocked.length > 0) {
        r.weIngestBlocked = weBlocked.map(m => ({ url: m.url, host: m.host, priorRun: !!m.priorRun, reason: ingestBlockReason(m, { showIsWe, weGateOn, lowTrustSources: lowTrust, serpCensusGateOn }) }));
        const nPrior = weBlocked.filter(m => m.priorRun).length;
        console.log(`  ⛔ ${weBlocked.length} URL(s) not ingested (${nPrior} prior-production — permanently report-only${nPrior < weBlocked.length ? `; ${weBlocked.length - nPrior} WE_GAP_INGEST unset — report-only mode` : ''})`);
      }
      const ingestable = eligibleMissing.slice(0, INGEST_PER_SHOW_CAP);
      // P1 fix 2026-05-27 (ship-check): record cap-skipped URLs so future runs
      // (and operators) can see they exist and weren't silently dropped.
      const cappedSkipped = eligibleMissing.slice(INGEST_PER_SHOW_CAP);
      r.ingestResults = [];
      r.ingestSkippedByCap = cappedSkipped.map(m => ({ url: m.url, host: m.host, outletId: m.knownOutletId || provisionalOutletIdFromHost(m.host) }));
      for (const m of ingestable) {
        const res = ingestMissingUrl(r.showId, m.url, m.knownOutletId);
        perShowFetches++;
        const outletId = m.knownOutletId || provisionalOutletIdFromHost(m.host);
        r.ingestResults.push({ url: m.url, host: m.host, outletId, provisional: !!res.provisional, ok: res.ok, reason: res.reason });
        const tag = res.ok ? (res.provisional ? `✅ ingested (provisional outlet "${outletId}")` : '✅ ingested') : `✗ ingest failed (${res.reason || 'unknown'})`;
        console.log(`  ${tag}: ${m.url}`);
      }
      if (cappedSkipped.length > 0) {
        console.log(`  ⏸  skipped ${cappedSkipped.length} URL(s) over per-show cap (--ingest-cap=${INGEST_PER_SHOW_CAP}) — recorded in audit JSON for next run`);
      }
    }

    // --ingest-missing: ALSO self-heal recoverable flaggedMisses — reviews whose
    // file EXISTS but is empty-body (paywalled empty fetch, etc.). The block above
    // only handles URLs with NO file; this is the other half of the gap that made
    // new openings land "short" (Glengarry WE empty Times review). Re-ingest the
    // aggregator's current-production URL under the existing slug so the fetched
    // text MERGES into the empty file (a fill, never a clobber). isRecoverableFlaggedFile
    // already excluded wrong-production / wrong-show / human-protected / over-cap
    // files in auditShow, so only the merge-safe subset carries recoverable:true.
    //
    // STALE-SLUG wrongProduction recovery is deliberately NOT done here — no clean
    // unattended path exists yet (verified ship-check 2026-06-22):
    //   • --force-clear-stale-flag only bypasses detectIngestCollision's PRE-CHECK
    //     (manual-review-fields.js:210); it does NOT clear wrongProduction.
    //   • createOrMergeReviewFile merges only into FALSY fields (review-file-writer.js:503),
    //     so an existing wrongProduction:true (and any stale body) survives the merge —
    //     the re-ingested review stays excluded.
    //   • the generic ingest path has no Guardian-style date guard, so re-fetching a
    //     stale slug can re-store the prior-production body.
    // Net: an unattended force-clear would churn (re-flag every rebuild), not heal.
    // Those flaggedMisses stay visible for --dispatch-gather and manual
    // `ingest-review-from-url.js --force-clear-stale-flag` (operator clears the flag).
    if (ingestMissing) {
      // P0 (ship-check 2026-07-10): recovery must respect the WE ingest gate and
      // the prior-run block — an empty-body guardian file + a 2022 WET roundup
      // citing a Guardian URL would otherwise re-ingest PRIOR-PRODUCTION text
      // into the current show's file every hour (the WET mass-ingestion class).
      const weRecGateOn = process.env.WE_GAP_INGEST === '1';
      const serpCensusRecGateOn = process.env.SERP_CENSUS_INGEST === '1';
      // Same canonical predicate as the missing-URL ingest above — prior-run
      // (production-identity) blocks recovery on every market, not just weRef rows.
      const recBlockedPred = (m) => ingestBlockReason(m, { showIsWe: isWeShow(s), weGateOn: weRecGateOn, lowTrustSources: lowTrust, serpCensusGateOn: serpCensusRecGateOn }) !== null;
      const weRecBlocked = r.flaggedMisses.filter(m => m.recoverable && recBlockedPred(m));
      if (weRecBlocked.length > 0) {
        const nPrior = weRecBlocked.filter(m => m.priorRun).length;
        console.log(`  ⛔ ${weRecBlocked.length} recoverable(s) not recovered (${nPrior} prior-production — permanently report-only${nPrior < weRecBlocked.length ? `; ${weRecBlocked.length - nPrior} WE_GAP_INGEST unset — report-only mode` : ''})`);
      }
      const recoverables = r.flaggedMisses.filter(m => m.recoverable && !recBlockedPred(m));
      // Recovery draws from whatever the missing-URL ingest left of the shared
      // per-show fetch budget (INGEST_PER_SHOW_CAP). Anything beyond rolls to the
      // next hourly run via the audit JSON.
      const recBudget = Math.max(0, INGEST_PER_SHOW_CAP - perShowFetches);
      if (recoverables.length > 0) {
        const budget = recoverables.slice(0, recBudget);
        const recCapped = recoverables.slice(recBudget);
        r.recoveryResults = [];
        for (const m of budget) {
          const res = recoverEmptyBodyFlaggedMiss(r.showId, m, s.openingDate);
          if (!res.skipped) perShowFetches++;
          r.recoveryResults.push(res);
          if (res.skipped) {
            console.log(`  ⏭  recovery skip (${res.reason}): ${m.recoverableFile} ${m.url}`);
          } else if (res.recovered) {
            console.log(`  ♻️  recovered empty-body review → ${m.recoverableFile} from ${m.url}`);
          } else {
            console.log(`  ✗ recovery did not land (try ${res.recoveryCount}/${FLAGGED_RECOVERY_CAP}; ${res.reason || 'still empty body'}): ${m.recoverableFile} ${m.url}`);
          }
        }
        if (recCapped.length > 0) {
          r.recoverySkippedByCap = recCapped.map(m => ({ url: m.url, host: m.host, file: m.recoverableFile }));
          console.log(`  ⏸  ${recCapped.length} recoverable flaggedMiss(es) over shared per-show fetch budget (--ingest-cap=${INGEST_PER_SHOW_CAP}) — next run`);
        }
      }

      // UNCITED stub retry (The Upcoming class, 2026-07-23): empty-body files
      // whose outlets NO aggregator cites never enter flaggedMisses, so the
      // recovery above never touches them — a 0-byte stub of a real published
      // review sat inert until a human refetched it (the first retry succeeded
      // immediately). Retry each suspect file against its OWN url — that URL
      // was already accepted at collection time, so this is a refetch, not a
      // new aggregator-driven ingest (no weRef/prior-run gate applies). Same
      // per-show fetch budget and per-file retry cap as the cited path.
      try {
        const citedFiles = new Set(r.flaggedMisses.map(m => m.recoverableFile).filter(Boolean));
        const dirAll = loadDirFiles(r.showId);
        // Prior-run date guard (ship-check 2026-07-23, Codex finding): "accepted
        // at collection time" is not "safe forever" — unflagged prior-production
        // files exist in the corpus (task #275). A stub whose publishDate falls
        // before [opening - 30d] is a prior-run artifact; refetching it would
        // pull the earlier production's text. Dateless stubs fail open (same
        // posture as gap-ingest-policy's dateless-article warning).
        const openingMs = s.openingDate ? new Date(s.openingDate).getTime() : null;
        const notPriorRun = (d) => {
          if (!openingMs || !d.publishDate) return true;
          const pd = new Date(d.publishDate).getTime();
          if (Number.isNaN(pd)) return true;
          return pd >= openingMs - 30 * 86400000;
        };
        const uncited = dirAll.filter(d => d._file && !citedFiles.has(d._file) && isRecoverableUncitedStub(d) && notPriorRun(d));
        const uncitedBudget = Math.max(0, INGEST_PER_SHOW_CAP - perShowFetches);
        if (uncited.length > uncitedBudget) {
          console.log(`  ⏸  ${uncited.length - uncitedBudget} uncited stub(s) over shared per-show fetch budget — next run`);
        }
        for (const d of uncited.slice(0, uncitedBudget)) {
          const m = {
            url: d.url,
            host: hostOf(d.url),
            knownOutletId: d.outletId || null,
            recoverable: true,
            recoverableFile: d._file,
            recoverableOutletId: d.outletId || null,
            recoverableCritic: d.criticName || null,
            recoverableCount: d.aggUrlRecoveryCount || 0,
          };
          const res = recoverEmptyBodyFlaggedMiss(r.showId, m, s.openingDate);
          if (!res.skipped) perShowFetches++;
          r.recoveryResults = r.recoveryResults || [];
          r.recoveryResults.push({ ...res, uncited: true });
          if (res.skipped) {
            console.log(`  ⏭  uncited-stub skip (${res.reason}): ${d._file} ${d.url}`);
          } else if (res.recovered) {
            console.log(`  ♻️  recovered uncited stub → ${d._file} from ${d.url}`);
          } else {
            console.log(`  ✗ uncited-stub retry did not land (try ${res.recoveryCount}/${FLAGGED_RECOVERY_CAP}; ${res.reason || 'still empty body'}): ${d._file} ${d.url}`);
          }
        }
      } catch (e) {
        console.log(`::warning::uncited-stub sweep failed for ${r.showId}: ${(e.message || '').slice(0, 120)}`);
      }
    }
  }

  // ── Self-proving auto-enable (2026-07-11, hardened per ship-check) ─────────
  // "Enable ingest after the report proves itself" was a human-memory step;
  // nobody was going to remember it. When the proving criteria are met
  // (lib/we-gate-proving.js — corroboration-based, not uptime-based), the audit
  // enables ingest itself and emails the owner. Safety posture:
  //   - CI-only: a LOCAL --checkpoint run must never flip a prod variable via
  //     the operator's gh session (ship-check P1).
  //   - Create, never overwrite: if WE_GAP_INGEST already EXISTS as a repo
  //     variable (any value), an operator has expressed state — respect it.
  //     This also makes "owner emptied the variable" a durable off switch even
  //     if the tracker commit was lost (ship-check P1).
  //   - Crash-safe ordering: provenAt saved BEFORE the flip, enabledAt saved
  //     immediately AFTER; email-delivery failure sets notifyPending so later
  //     runs retry the notification until it lands (flip-but-owner-unaware is
  //     the "alert channel silently dead" incident — ship-check P1).
  //   - Attempt throttle: non-enabled outcomes retry at most every 24h.
  // Per-aggregator accuracy (measured corroboration, accumulated in the proving
  // tracker) — printed every run so the trust data is visible, not just consumed
  // by the low-trust ingest block above.
  {
    const acc = aggregatorAccuracy(loadWeProving());
    const { ACCURACY_DEFAULTS } = require('./lib/we-gate-proving');
    const srcs = Object.keys(acc).sort();
    if (srcs.length > 0) {
      console.log('\nWE reference source accuracy (citations corroborated against independently-held reviews):');
      for (const src of srcs) {
        const a = acc[src];
        const pct = a.accuracy === null ? `n/a (<${ACCURACY_DEFAULTS.minCited} cited)` : `${Math.round(a.accuracy * 100)}%`;
        console.log(`  ${src}: ${a.corroborated}/${a.cited} corroborated (${pct}) across ${a.shows} show(s)${lowTrust.has(src) ? '  ⛔ LOW TRUST — rows report-only' : ''}`);
      }
    }
  }

  if (useCheckpoint && process.env.GITHUB_ACTIONS === 'true'
      && process.env.WE_GAP_INGEST !== '1' && process.env.WE_GAP_REFERENCE_DISABLED !== '1') {
    const proving = loadWeProving();
    const { routeAlert } = require('./lib/owner-alert-router');
    // Routed through the owner-alert-router ledger (not just this file's own
    // lastEnableAttemptAt throttle) so repeat CI runs of the SAME unresolved
    // condition (e.g. workflow token still can't write the variable) collapse
    // to one email instead of one per run — email-noise Sprint 2 (2026-07-23):
    // two "PROVEN" emails landed ~1h apart because the local proving.json
    // state wasn't shared between overlapping hourly cron runs. The ledger is
    // a separately-committed file with its own conditionKey, so it survives
    // that race even when proving.json's own throttle doesn't.
    const DAY = 24 * 60 * 60 * 1000;
    const attemptDue = !proving.lastEnableAttemptAt || (Date.now() - new Date(proving.lastEnableAttemptAt).getTime()) > DAY;
    if (proving.enabledAt && proving.notifyPending) {
      // Flip already happened but the owner was never notified — retry until it lands.
      const result = await routeAlert({
        conditionKey: 'we-gate:enabled-delayed-notice',
        title: 'WE auto-ingest is ENABLED (delayed notice — earlier notification failed)',
        description: `Auto-ingest was enabled at ${proving.enabledAt} after the gate proved itself. Prior-run roundup URLs remain blocked; per-show caps apply. Kill switch: repo variable WE_GAP_REFERENCE_DISABLED=1.`,
        severity: 'error',
        disposition: 'human',
        cooldownHours: 24,
      });
      // action === 'digest' means routeAlert's page-worthy gate (card #611)
      // downgraded this from the requested 'human' — the owner WILL see it in
      // tomorrow's digest, so that counts as notified same as a delivered email.
      if ((result.action === 'human' && result.delivered) || result.action === 'digest') { proving.notifyPending = false; saveWeProving(proving); }
      else if (result.action === 'human') console.error('::error::WE auto-ingest is ON but the owner still could not be notified (email failing). Fix RESEND_API_KEY/OWNER_EMAIL.');
    } else if (!proving.enabledAt && attemptDue) {
      const verdict = evaluateProving(proving);
      if (verdict.enable) {
        proving.provenAt = proving.provenAt || new Date().toISOString();
        proving.lastEnableAttemptAt = new Date().toISOString();
        saveWeProving(proving); // persist proof BEFORE side effects (crash safety)
        // Respect operator state: only CREATE the variable if it does not exist.
        let varExists = true;
        try { execFileSync('gh', ['variable', 'get', 'WE_GAP_INGEST'], { stdio: 'pipe' }); }
        catch { varExists = false; }
        if (varExists) {
          console.log('WE gate proven, but WE_GAP_INGEST variable already exists (operator-set state) — not touching it.');
          const result = await routeAlert({
            conditionKey: 'we-gate:proven-variable-already-set',
            title: 'WE completeness gate PROVEN — variable already set, respecting your state',
            description: `Proving criteria met (${verdict.reason}) on: ${verdict.qualifying.join(', ')}. The WE_GAP_INGEST repo variable already exists, so nothing was changed. To enable: gh variable set WE_GAP_INGEST --body 1`,
            severity: 'error',
            disposition: 'human',
            cooldownHours: 24,
          });
          // notifyPending stays false when result.action === 'digest' too (the
          // page-worthy gate, card #611, downgraded this from 'human') — the
          // owner WILL see it in the next digest, so there's nothing pending.
          proving.notifyPending = result.action === 'human' && !result.delivered;
          proving.enabledAt = new Date().toISOString(); // terminal state: decision handed to operator, never re-fire
          saveWeProving(proving);
        } else {
          let flipped = false;
          try {
            execFileSync('gh', ['variable', 'set', 'WE_GAP_INGEST', '--body', '1'], { stdio: 'pipe' });
            flipped = true;
          } catch (e) {
            console.error(`::warning::WE gate PROVEN but variable write failed (${(e.message || '').slice(0, 80)}) — will email manual instructions.`);
          }
          if (flipped) { proving.enabledAt = new Date().toISOString(); saveWeProving(proving); }
          const result = await routeAlert({
            conditionKey: flipped ? 'we-gate:enabled' : 'we-gate:proven-flip-failed',
            title: flipped
              ? 'WE auto-ingest ENABLED — completeness gate proved itself'
              : 'WE completeness gate PROVEN — one command to enable auto-ingest',
            description: flipped
              ? `Proving criteria met (${verdict.reason}) on: ${verdict.qualifying.join(', ')}. Auto-ingest of WE-reference review URLs is now ON (prior-run roundup URLs remain permanently blocked; per-show ingest caps apply). Kill switch: repo variable WE_GAP_REFERENCE_DISABLED=1 (WE-only), or empty WE_GAP_INGEST.`
              : `Proving criteria met (${verdict.reason}) on: ${verdict.qualifying.join(', ')}, but the workflow token could not set the repo variable. Run: gh variable set WE_GAP_INGEST --body 1`,
            severity: 'error',
            disposition: 'human',
            cooldownHours: 24,
          });
          // Same as above: result.action === 'digest' (page-worthy gate, card
          // #611, downgraded 'human') is NOT a delivery failure — only a
          // genuinely undelivered 'human' result should retry hourly.
          if (flipped && result.action === 'human' && !result.delivered) {
            proving.notifyPending = true;
            saveWeProving(proving);
            console.error('::error::WE auto-ingest was ENABLED but the notification email failed — will retry notifying hourly. Fix RESEND_API_KEY/OWNER_EMAIL.');
          }
        }
      }
    }
  }

  const audit = {
    generatedAt: new Date().toISOString(),
    windowDays,
    targets: targets.length,
    counts: {
      withGap: results.filter(r => r.missing.length + r.flaggedMisses.length + (r.citedNoUrl || []).length > 0).length,
      totalMissing: results.reduce((a, r) => a + r.missing.length, 0),
      totalCitedNoUrl: results.reduce((a, r) => a + (r.citedNoUrl || []).length, 0),
      totalFlaggedMisses: results.reduce((a, r) => a + r.flaggedMisses.length, 0),
      totalRecoverable: results.reduce((a, r) => a + r.flaggedMisses.filter(m => m.recoverable).length, 0),
      totalRecovered: results.reduce((a, r) => a + (r.recoveryResults || []).filter(x => x.recovered).length, 0),
    },
    results,
  };

  // Roll up unknown outlet hosts: hosts that aggregator articles linked to
  // but our outlet-registry.json doesn't recognize. These are the gather
  // chain's blind spots — gather rejects them with "Could not resolve outlet
  // from URL" and the review never lands. (gaycitynews.com and theknockturnal.com
  // on 2026-05-27 — both registered after this audit surfaced them.)
  const unknownOutletHosts = new Map();
  for (const r of results) {
    for (const m of r.missing) {
      if (m.knownOutletId) continue;
      if (!unknownOutletHosts.has(m.host)) {
        unknownOutletHosts.set(m.host, { host: m.host, provisionalOutletId: provisionalOutletIdFromHost(m.host), occurrences: 0, sampleUrls: [], shows: new Set() });
      }
      const e = unknownOutletHosts.get(m.host);
      e.occurrences++;
      if (e.sampleUrls.length < 3) e.sampleUrls.push(m.url);
      e.shows.add(r.showId);
    }
  }
  const unknownOutlets = [...unknownOutletHosts.values()]
    .map(e => ({ ...e, shows: [...e.shows] }))
    .sort((a, b) => b.occurrences - a.occurrences);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(audit, null, 2));
    console.log(`\nWrote audit: ${AUDIT_PATH}`);
    fs.writeFileSync(UNKNOWN_OUTLETS_PATH, JSON.stringify({
      generatedAt: audit.generatedAt,
      count: unknownOutlets.length,
      outlets: unknownOutlets,
    }, null, 2));
    console.log(`Wrote unknown-outlets: ${UNKNOWN_OUTLETS_PATH} (${unknownOutlets.length} hosts)`);
  }
  console.log(`Summary: ${audit.counts.withGap}/${results.length} shows audited with gaps | ${audit.counts.totalMissing} URLs not in dir | ${audit.counts.totalFlaggedMisses} URLs in dir but flagged out (${audit.counts.totalRecoverable} recoverable, ${audit.counts.totalRecovered} self-healed this run) | ${unknownOutlets.length} unknown outlets`);
  if (useCheckpoint) {
    console.log(`Checkpoint: ${results.length} shows audited this run${budgetHit ? ' (time-budget partial — remaining shows resume next run)' : ' (full eligible set complete)'}. State: ${CHECKPOINT_PATH}`);
  }
  if (verbose && unknownOutlets.length > 0) {
    console.log('\nUnknown outlets (not in outlet-registry.json):');
    for (const u of unknownOutlets) {
      console.log(`  ${u.host} — ${u.occurrences} occurrence(s) across ${u.shows.length} show(s): ${u.sampleUrls[0]}`);
    }
  }

  // Collector-outage floor (plan-review 2026-05-31): tolerate one bad URL, but
  // if every attempted article fetch threw, the scraper stack is down — redden
  // CI so a dead Bright Data zone / exhausted SB doesn't masquerade as "no gaps
  // found" (which would silently miss reviews during opening night). Distinct
  // from --fail-on-gap: this fires on infrastructure failure, not on gaps.
  if (_fetchStats.attempts >= 3 && _fetchStats.errors === _fetchStats.attempts) {
    console.error(`::error::collector outage — all ${_fetchStats.errors}/${_fetchStats.attempts} aggregator article fetches threw (Bright Data / ScrapingBee / Playwright all failing). Check BRIGHTDATA_ZONE + ScrapingBee credits; this audit found nothing because nothing could be fetched.`);
    process.exit(1);
  }
  // Discovery-outage floor (ship-check 2026-06-01): the article-fetch floor
  // above only fires once we reach fetching. If SERP discovery itself is down,
  // 0 articles are found, fetching never happens, and the audit would otherwise
  // report "no gaps" during a total blackout. If every SERP query errored,
  // redden. Requires >=3 attempts so a tiny --show run can't false-trigger.
  if (_serpStats.attempts >= 3 && _serpStats.errors === _serpStats.attempts) {
    console.error(`::error::discovery outage — all ${_serpStats.errors}/${_serpStats.attempts} SERP queries errored (SCRAPINGBEE_API_KEY / SERP provider down). No aggregator articles could be discovered; "no gaps" here is meaningless.`);
    process.exit(1);
  }

  // Expected-vs-captured alert (girl-interrupted 2026-06-05): after auto-ingest,
  // surface any show that STILL has roundup-cited reviews we couldn't capture.
  // Unlike check-opening-night-completeness.js (which only detects DISAPPEARANCE
  // vs a prior snapshot), this catches reviews that were never captured at all —
  // absence at first sight. A cited URL is by definition already published, so no
  // settle window is needed. Fires on every run (not just --fail-on-gap) so the
  // hourly cron surfaces residual gaps in the daily digest via ::warning::.
  const residualShows = [];
  for (const r of results) {
    const failedIngest = (r.ingestResults || []).filter(x => !x.ok).length;
    const capped = (r.ingestSkippedByCap || []).length;
    // When --ingest-missing wasn't run, every missing URL is still residual.
    const uningested = ingestMissing ? 0 : r.missing.length;
    // flaggedMisses that the recovery loop just HEALED this run are no longer a
    // residual gap — count only the ones that stayed flagged out (recovery skipped,
    // fetch failed, or not recoverable in the first place). Uncited-stub
    // recoveries were never IN flaggedMisses, so they must not be subtracted —
    // one uncited heal would otherwise hide one still-flagged cited gap
    // (ship-check 2026-07-23, Codex finding).
    const recovered = (r.recoveryResults || []).filter(x => x.recovered && !x.uncited).length;
    const flaggedOut = Math.max(0, r.flaggedMisses.length - recovered);
    const residual = failedIngest + capped + uningested + flaggedOut;
    if (residual > 0) {
      residualShows.push({ showId: r.showId, title: r.title, residual, failedIngest, capped, uningested, flaggedOut, recovered });
    }
  }
  if (residualShows.length > 0) {
    for (const s of residualShows) {
      console.log(`::warning::review gap — ${s.showId} (${s.title}): ${s.residual} roundup-cited review(s) still uncaptured after auto-ingest (failed=${s.failedIngest} capped=${s.capped} uningested=${s.uningested} flaggedOut=${s.flaggedOut} recovered=${s.recovered})`);
    }
    console.log(`Expected-vs-captured: ${residualShows.length} show(s) with residual review gaps after auto-ingest.`);
  }

  // Force a clean exit. fetchPage can leave a Playwright/Browserbase browser or
  // socket handle open, so without an explicit exit Node lingers on the event loop
  // after the audit finishes (especially after a soft-budget break) until the
  // 40-min job HARD-cancel — which then starves the commit/push step of its window
  // and the run shows 'cancelled' with the checkpoint+ingests un-pushed (the
  // steady-state maintenance-cancel bug, 2026-06-16). Close the scraper and exit.
  const exitCode = (failOnGap && audit.counts.withGap > 0) ? 1 : 0;
  try { await scraperCleanup(); } catch { /* best-effort */ }
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error('Fatal:', e.message);
    try { await scraperCleanup(); } catch { /* best-effort */ }
    process.exit(1);
  });
}

// bumpRecoveryCount is exported for the integration test that proves the retry
// cap actually persists to disk (acceptance: "retry cap proven"). It writes to
// the module-level REVIEW_TEXTS_DIR captured at require time, so the test sets
// REVIEW_TEXTS_DIR before requiring this module.
// main + USAGE are exported so scripts/audit-show-review-gap.test.mjs can
// prove --help never falls through to a real gh call (task #266).
module.exports = { urlMatchesShow, titleTokens, provisionalOutletIdFromHost, freshnessMsFor, hostOf, registrableHost, getKnownDomainMap, isReviewUrl, normalizeReviewUrl, classifyShowFile, isCoveredFile, bumpRecoveryCount, acceptSerpCensusResult, main, USAGE };
