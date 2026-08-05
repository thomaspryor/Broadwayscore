#!/usr/bin/env node
/**
 * Systematic review-text contamination audit.
 *
 * Detects 8 classes of data-quality issues across all review-texts folders:
 *   A. Cross-market contamination — review dated near a sibling production's
 *      opening but filed under a different production of the same title.
 *      (Catches Broadway↔WE and Broadway↔OB folder mixups.)
 *   B. False-positive wrongProduction — wrongProduction=true but content
 *      verification says wrongProduction=false AND publishDate is within 30
 *      days of opening. These are reviews incorrectly excluded by automated
 *      guards. (Strict: catches new false positives from guard regressions.)
 *   C. Domain/outlet mismatch — URL domain doesn't match the filename outlet
 *      and the registry resolves the URL domain to a different outletId.
 *   C2. Same URL attributed to multiple critics at the same outlet, with
 *       identical fullText (byline scrape error). Excludes already-flagged
 *       wrongAttribution files. (Strict: catches new byline errors.)
 *   D. Pre-opening features masquerading as reviews — published >5 days before
 *      opening, URL slug lacks "review" marker, has substantial text. (Report-only;
 *      NOT included in strict mode — too many legitimate preview reviews.)
 *   E. Unflagged roundup pages — URL matches /article/Review-Roundup-... but
 *      isRoundupArticle != true.
 *   F. Empty --unknown junk files — filename contains --unknown, URL is null,
 *      and fullText is empty. Pure scrape garbage.
 *
 * Usage:
 *   node scripts/audit-review-contamination.js              # Report mode (exits 0 unless --strict)
 *   node scripts/audit-review-contamination.js --strict     # Exits 1 if ANY hits found
 *   node scripts/audit-review-contamination.js --classes A,E,F  # Only specified classes
 *   node scripts/audit-review-contamination.js --json > out.json # Machine-readable output
 *
 * Background: this script was built after the 2026-04-11 Oh, Mary! Broadway audit
 * found 18 contamination issues in a single 66-file folder. Systematic scan across
 * 1,639 shows / 34,737 files found 291 total instances of the same patterns.
 * The CI job runs this in --strict mode to prevent new contamination from landing.
 *
 * See: memory/feedback_review_audit_contamination.md (TBD)
 */

const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');

// Parse args
const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
// --gate: blocking CATASTROPHE FLOOR for the per-push trunk (test.yml), distinct
// from --strict (any strict-class hit fails — for the daily/manual full audit).
// The review-texts corpus (39k files in a separate private repo) is mutated by
// data bots every ~2min; --strict therefore reddened the trunk for EVERY unrelated
// code push whenever any single pre-existing/parallel-introduced C/E/F file existed
// (china-doll FT/Guardian, 2026-06-28). --gate blocks only on a genuine integrity
// catastrophe — a cross-market leak (class A: wrong show's reviews shown) or a mass
// spike past GATE_FLOOR — and lets single-file drift surface without blocking. The
// FULL --strict triage runs daily in check-corpus-drift.yml (review-contamination
// audit), surfaced non-blocking in the digest — the net for sub-floor E/F drift.
// Same split already applied to audit-text-quality --gate and check-corpus-drift.yml.
const GATE = args.includes('--gate');
const GATE_FLOOR = 25;
const JSON_OUT = args.includes('--json');
const classesIdx = args.findIndex(a => a.startsWith('--classes'));
let ONLY_CLASSES = null;
if (classesIdx >= 0) {
  // Support both --classes=A,E,F and --classes A,E,F
  const val = args[classesIdx].includes('=')
    ? args[classesIdx].split('=')[1]
    : args[classesIdx + 1];
  if (val) ONLY_CLASSES = new Set(val.split(','));
}
function shouldRunClass(c) { return !ONLY_CLASSES || ONLY_CLASSES.has(c); }

// ─────────────────────────────────────────────────
// Load data
// ─────────────────────────────────────────────────
const shows = require(SHOWS_PATH).shows;
const registry = require(REGISTRY_PATH);

function detectMarket(id) {
  if (/-off-off-broadway-/.test(id)) return 'off-off-broadway';
  if (/-off-broadway-/.test(id)) return 'off-broadway';
  if (/-off-west-end-/.test(id)) return 'off-west-end';
  if (/-west-end-/.test(id)) return 'west-end';
  return 'broadway';
}

const { parseDate } = require('./lib/date-utils');
const { normalizeOutlet } = require('./lib/review-normalization');
const { isOutletDomainMismatch } = require('./lib/aggregator-domains');
const { buildOutletMaps } = require('./lib/outlet-region-map');
const { classifyCrossMarketContamination } = require('./lib/cross-market-guard');
const {
  classifyClassAContamination,
  normalizeShowTitle: normalizeTitle,
} = require('./lib/cross-market-contamination');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');

// Shared outlet → region / dual-market lookups (single source of truth with validate-data.js).
const { outletRegionMap, dualMarket } = buildOutletMaps(registry);

// Coarse market for cross-market contamination: NYC productions are 'us', London 'uk'.
// Uses the authoritative shows.json `category` (not an id regex) — see plan-review #5.
function usUkMarket(show) {
  const c = show && show.category;
  if (c === 'west-end' || c === 'off-west-end') return 'uk';
  if (c === 'broadway' || c === 'off-broadway' || c === 'off-off-broadway' || c === 'opera') return 'us';
  return null; // regional / null / unknown — can't bucket; skip cross-market A2 (avoids mis-tagging a UK show 'us')
}

// Distinctive cast/venue slug tokens for a production, used to corroborate that a
// review URL is about THIS production (e.g. .../romeo-juliet-review-sadie-sink-noah-jupe).
const VENUE_STOPWORDS = new Set(['theatre', 'theater', 'the', 'at', 'club', 'playhouse', 'centre', 'center', 'company', 'kit', 'kat', 'and', 'park', 'royal', 'globe', 'lyric', 'palace', 'apollo', 'garden', 'gardens', 'music', 'hall', 'opera', 'house', 'arts', 'studio', 'stage', 'space', 'circle', 'square', 'bridge', 'court', 'gate', 'old', 'new', 'little']);
// Bare surnames that are also common English words / URL-slug fragments — never
// distinctive enough to corroborate on their own (the full-name slug is kept instead).
const COMMON_WORD_SURNAMES = new Set(['hall', 'park', 'wood', 'young', 'bell', 'hill', 'lane', 'page', 'best', 'love', 'white', 'brown', 'green', 'gray', 'grey', 'ford', 'king', 'hart', 'lake', 'reed', 'rose', 'snow', 'cook', 'fish', 'bird', 'wolf', 'gold', 'price', 'rich', 'cross', 'stone', 'fields', 'rivers', 'banks', 'moore', 'moon', 'star', 'castle', 'church', 'major', 'minor', 'sharp', 'short', 'long', 'small', 'noble', 'french', 'welsh', 'walker', 'baker', 'mason', 'carter', 'turner', 'cooper', 'fisher', 'porter', 'hunter', 'parker', 'taylor', 'wright', 'knight', 'frost', 'winter', 'summers']);
function slugify(s) { return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function productionTokens(show) {
  const tokens = new Set();
  // Venue: full slug + individual distinctive words (len>=4, not generic).
  const vslug = slugify(show.venue);
  if (vslug) {
    if (vslug.length >= 5 && vslug.includes('-')) tokens.add(vslug);
    for (const w of vslug.split('-')) if (w.length >= 4 && !VENUE_STOPWORDS.has(w)) tokens.add(w);
  }
  // Cast: full-name slug (always — distinctive, e.g. 'sadie-sink') + bare last name
  // only when it's long (len>=5) AND not a common word. Bare surnames are the FP risk;
  // the multi-part full-name slug is the reliable signal. Cap to first 8 to limit noise.
  for (const c of (show.cast || []).slice(0, 8)) {
    const nslug = slugify(c && c.name);
    if (nslug && nslug.includes('-')) {
      tokens.add(nslug);
      const last = nslug.split('-').pop();
      if (last && last.length >= 5 && !COMMON_WORD_SURNAMES.has(last)) tokens.add(last);
    }
  }
  return [...tokens];
}

function parseDomain(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/(?:www\.)?([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Build sibling map: title -> shows
const byTitle = {};
shows.forEach(s => {
  const t = normalizeTitle(s.title);
  if (!t) return;
  (byTitle[t] = byTitle[t] || []).push(s);
});
const siblingsOf = new Map();
shows.forEach(s => {
  const t = normalizeTitle(s.title);
  const sibs = (byTitle[t] || []).filter(x => x.id !== s.id);
  siblingsOf.set(s.id, sibs);
});
const showById = new Map();
shows.forEach(s => showById.set(s.id, { ...s, market: detectMarket(s.id) }));

// Registry domain reverse lookup + collision detection.
// A domain with multiple registered outlets is AMBIGUOUS — two outlets may legitimately
// share the same domain (e.g. express.co.uk serves both Daily Express and Sunday Express,
// telegraph.co.uk serves both Daily Telegraph and Sunday Telegraph, timeout.com serves
// both TimeOut NY and TimeOut London via path-based distinction). These cases can't be
// auto-resolved from the URL alone; the byline is the ground truth.
const domainToOutlets = {};
for (const [id, o] of Object.entries(registry.outlets)) {
  const domains = [];
  if (o.domain) domains.push(o.domain.toLowerCase());
  if (Array.isArray(o.domainAliases)) {
    o.domainAliases.forEach(d => domains.push(d.toLowerCase()));
  }
  for (const d of domains) {
    (domainToOutlets[d] = domainToOutlets[d] || new Set()).add(id);
  }
}
const domainToOutlet = {};      // unique-only reverse lookup
const AMBIGUOUS_DOMAINS = new Set();
for (const [d, ids] of Object.entries(domainToOutlets)) {
  if (ids.size === 1) domainToOutlet[d] = [...ids][0];
  else AMBIGUOUS_DOMAINS.add(d);
}
// Wire services — reviews legitimately show up under many outlets
const WIRE_OUTLETS = new Set(['ap', 'reuters', 'upi']);

// Archive-mirror domains — fan / memorial sites that republish reviews from
// many original outlets. The URL domain is the mirror, not the true outlet.
// Internal outletId is the ground truth; skip class-C domain-match on these.
// jasonraize.net: memorial site for Jason Raize (original Lion King Simba)
// that archives regional-critic reviews of the 1997–2000 touring and
// original Broadway productions.
// theatrevibe.co.uk: hosts archived UK newspaper reviews ingested via
// Theatre Record (source='theatre-record'), e.g. Metro London reviews.
// newspapers.com: digitized newspaper archive (Newsday, NY Daily News, NYT,
// LA Times, Chicago Tribune, Philadelphia Inquirer, …) used by the pre-2010
// vision-OCR pipeline (scripts/newspapers-com-extract.js). The URL domain is
// the archive; the internal outletId is ground truth. Rebuild already exempts
// it in EXEMPT_URL_DOMAINS (rebuild-all-reviews.js) — this gives the audit parity.
const ARCHIVE_MIRROR_DOMAINS = new Set(['jasonraize.net', 'theatrevibe.co.uk', 'newspapers.com']);

// Aggregator roundup domains — sites whose review/verdict ROUNDUP pages
// republish many *other* outlets' star ratings and excerpts. When we source a
// review's stars/excerpt from one of these roundups, the stored URL is the
// aggregator page while the internal outletId is the real reviewing outlet
// (e.g. a Telegraph review sourced from westendtheatre.com → outletId=telegraph,
// url=westendtheatre.com). The URL domain therefore maps to the aggregator's own
// outlet entry and tripped class C as a false positive (12 WET-sourced West End
// reviews, 2026-06-22). Same rationale as ARCHIVE_MIRROR_DOMAINS: the URL domain
// is the aggregator, not the true outlet; the internal outletId is ground truth.
// Only roundup aggregators that carry OTHER outlets' reviews belong here — NOT
// first-party outlets that merely happen to publish a roundup column. List is
// the documented roundup aggregators (CLAUDE.md §Web Scraping) whose domain
// resolves to a unique outlet entry: WET, BWW Roundups, Playbill Verdict, LBO,
// The Stage roundups.
const AGGREGATOR_ROUNDUP_DOMAINS = new Set([
  'westendtheatre.com',    // WET — West End star-rating roundups
  'broadwayworld.com',     // BWW Review Roundups
  'playbill.com',          // Playbill Verdict
  'londonboxoffice.co.uk', // LBO roundups
  'thestage.co.uk',        // The Stage roundups
]);

// ─────────────────────────────────────────────────
// Detectors
// ─────────────────────────────────────────────────
// Classes included in strict mode (CI gate).
// STRICT = "wrong data SHOWN to users" (integrity): A cross-market, C domain
// mismatch, E unflagged roundup, F empty junk. Report-only = "needs judgment
// or inherently flappy": B, C2, D.
//
// B (false-positive wrongProduction) is report-only as of 2026-06-22. It is a
// fundamentally different signal from A/C/E/F: it flags a review wrongly
// EXCLUDED (a coverage MISS), not wrong data shown on the site. And it is
// inherently flappy — it surfaces whenever ANY of the continuously-running
// guards (date, cross-market, cross-production-URL, venue) over-flags ANY of
// 39k files, so it never stays at 0. Empirically: clearing the 2 real
// les-liaisons-dangereuses-2016 false positives immediately surfaced a fresh
// one (my-neighbour-totoro-west-end-2025) in the next run — whack-a-mole that
// reddens the trunk for a non-integrity reason. It now joins C2/D as a
// report-only guard-regression MONITOR (triage the list, fix the data or the
// guard), not a trunk blocker. Genuine false positives are still fixed at the
// data layer (manual-clear protocol) — they just don't block ship.
// C2 and D are intentionally report-only:
//   - C2: multi-critic-at-same-URL cases. Reduced from 161 (2026-04-14) → ~7
//     after the cross-show URL cleanup. Remaining cases are ambiguous (same
//     outlet, different bylines, identical text length) where the correct
//     critic isn't recoverable from available signal. Promote to strict only
//     when we have a resolvable signal (e.g., scraped byline metadata).
//   - D: pre-opening feature heuristic. ~100+ hits are a mix of pre-opening
//     interviews/profiles AND legitimate embargoed preview reviews
//     (Broadway critics regularly publish 5-20 days before "official" opening).
//     Correct classification requires LLM read of the text — use
//     classify-non-reviews.js to flag genuine non-reviews; the D detector
//     surfaces candidates but cannot itself distinguish them. Already
//     excludes files flagged isNonReview/nonReviewFlag/nonReviewContent
//     via alreadyFlagged above, so the hit count trends down as the
//     classifier chews through the backlog.
const STRICT_CLASSES = new Set(['A', 'C', 'E', 'F']);

const hits = {
  A_cross_market: [],
  // A2: same-season cross-market contamination (relative date-cluster + region/url
  // corroboration). REPORT-ONLY for now (not in STRICT_CLASSES) — promote to strict
  // after one clean corpus cycle. Added 2026-06-26 after the #382 R&J incident, which
  // the absolute >180d Category-A threshold missed (siblings only ~72d apart).
  A2_cross_market_relative: [],
  B_false_positive_wp: [],
  C_domain_mismatch: [],
  C2_url_multi_critic: [],
  D_pre_opening_feature: [],
  E_unflagged_roundup: [],
  F_empty_unknown: [],
};

let filesScanned = 0;
let showsScanned = 0;

let showDirs = [];
try {
  showDirs = fs.readdirSync(REVIEW_DIR).filter(d => {
    try { return fs.statSync(path.join(REVIEW_DIR, d)).isDirectory(); }
    catch { return false; }
  });
} catch { /* missing checkout — showDirs stays [], corpus guard below catches it */ }

for (const showId of showDirs) {
  const show = showById.get(showId);
  if (!show) continue;
  showsScanned++;
  const sibs = (siblingsOf.get(showId) || []).map(s => ({
    id: s.id,
    market: detectMarket(s.id),
    opening: parseDate(s.openingDate),
  })).filter(s => s.opening);
  const showOpening = parseDate(show.openingDate);

  // A2 inputs: cross-market siblings (us↔uk) enriched with us/uk market + cast/venue tokens.
  // Skip entirely when this show's market is indeterminate (null/regional category) —
  // bucketing it would risk mis-tagging and either FP or a silent miss.
  const thisUsUk = usUkMarket(show);
  const xmarketSibs = !thisUsUk ? [] : (siblingsOf.get(showId) || [])
    .map(s => showById.get(s.id))
    .filter(Boolean)
    .map(s => ({ id: s.id, opening: parseDate(s.openingDate), market: usUkMarket(s), tokens: productionTokens(s) }))
    .filter(s => s.opening && s.market && s.market !== thisUsUk);

  const sDir = path.join(REVIEW_DIR, showId);
  let files;
  try { files = fs.readdirSync(sDir).filter(f => f.endsWith('.json')); }
  catch { continue; }

  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8')); }
    catch { continue; }
    filesScanned++;

    const alreadyFlagged = d.wrongProduction || d.wrongShow || d.isRoundupArticle
      || d.wrongAttribution || d.contentVerification?.wrongArticle
      || d.isNonReview || d.nonReviewFlag || d.nonReviewContent
      || d.duplicateOf; // duplicates are excluded from scoring pipeline

    // ─── A: Cross-market / cross-production contamination ────
    // `_auditAllowCrossMarket` is a manual allowlist for cases the detector can't
    // disambiguate automatically (typically when a review's publishDate coincides
    // with a sibling production's opening date but the URL + text confirm it
    // belongs to the current folder).
    if (shouldRunClass('A') && !alreadyFlagged && !d._auditAllowCrossMarket) {
      const pubDate = parseDate(d.publishDate);
      if (pubDate && showOpening && sibs.length) {
        // Shared strict Category-A predicate — single source of truth with
        // fix-circular-duplicate-pairs.js (which must never canonicalize a class-A
        // member). scripts/lib/cross-market-contamination.js.
        const v = classifyClassAContamination(pubDate, showOpening, sibs.map(s => s.opening));
        if (v.isClassA) {
          const best = sibs[v.sibIndex];
          hits.A_cross_market.push({
            showId, file: f, thisMarket: show.market, sibId: best.id, sibMarket: best.market,
            pubDate: d.publishDate, thisDiff: Math.round(v.thisDiff), sibDiff: Math.round(v.sibDiff),
          });
        }
      }
    }

    // ─── A2: Same-season cross-market contamination (relative + corroborated) ────
    // Catches the class the absolute >180d Category-A misses: a review clustering
    // with a near-in-time cross-market sibling's opening (e.g. West End R&J 03-31 vs
    // Delacorte R&J 06-11). Requires region OR url-token corroboration so legit
    // dual-market coverage (Guardian/Times-UK on the Broadway opening) is never
    // flagged. REPORT-ONLY (A2 not in STRICT_CLASSES) until promoted.
    if (shouldRunClass('A') && !alreadyFlagged && !d._auditAllowCrossMarket && xmarketSibs.length) {
      const pubDate = parseDate(d.publishDate);
      if (pubDate && showOpening) {
        const oid = normalizeOutlet(d.outletId || f.split('--')[0]).toLowerCase();
        const verdict = classifyCrossMarketContamination({
          reviewDate: pubDate,
          reviewUrl: d.url || null,
          thisShow: { opening: showOpening, market: thisUsUk },
          siblings: xmarketSibs,
          outletRegion: outletRegionMap[oid] || null,
          isDualMarket: dualMarket.has(oid),
        });
        // Only record the NEW relative band here (thisDiff <= 180); the legacy >180d
        // path is already handled by strict Category A above (no double-count).
        // Number.isFinite guards against a future 'clear'-with-null-thisDiff returning
        // here (null <= 180 would otherwise be true).
        if ((verdict.level === 'contamination' || verdict.level === 'review') && Number.isFinite(verdict.thisDiff) && verdict.thisDiff <= 180) {
          hits.A2_cross_market_relative.push({
            showId, file: f, thisMarket: thisUsUk, sibId: verdict.sibId,
            level: verdict.level, confidence: verdict.confidence, reason: verdict.reason,
            pubDate: d.publishDate, thisDiff: verdict.thisDiff, sibDiff: verdict.sibDiff,
            outlet: oid, url: d.url || null,
          });
        }
      }
    }

    // ─── C: Domain / outlet mismatch ────
    // Compare the INTERNAL outletId (used for scoring) against the URL domain.
    // Filename-outlet drift is cosmetic — rebuild's stale-outlet-mismatch pass will
    // rename files whose filename outlet doesn't match internal outletId, so we only
    // care about cases where the *internal* outletId is wrong.
    //
    // Canonicalize internalOutlet via normalizeOutlet so legacy IDs that exist as
    // aliases on a canonical entry (e.g. "the-associated-press" → "ap",
    // "ibj" → "indianapolis-business-journal") resolve correctly. Without this,
    // a single stranded file with a legacy outletId would re-trip the audit even
    // though the registry already knows the canonical mapping.
    if (shouldRunClass('C') && !alreadyFlagged && d.url) {
      const domain = parseDomain(d.url);
      if (domain && !AMBIGUOUS_DOMAINS.has(domain) && !ARCHIVE_MIRROR_DOMAINS.has(domain)
          && !AGGREGATOR_ROUNDUP_DOMAINS.has(domain)) {
        const expected = domainToOutlet[domain];
        const rawInternalOutlet = d.outletId || f.split('--')[0];
        const internalOutlet = normalizeOutlet(rawInternalOutlet);
        // isOutletDomainMismatch (lib/aggregator-domains.js) returns false for
        // wire-service syndication and aggregator ROUNDUP URLs (shared across every
        // real outlet the roundup covers — e.g. a Telegraph star-stub carrying the
        // westendtheatre.com WET roundup URL). See that helper for full rationale.
        if (isOutletDomainMismatch(expected, internalOutlet, { wireOutlets: WIRE_OUTLETS })) {
          hits.C_domain_mismatch.push({
            showId, file: f, internalOutlet, rawInternalOutlet, expected, domain,
          });
        }
      }
    }

    // ─── E: Unflagged roundup pages ────
    // Must match the same pattern as Guard E in review-file-writer.js
    if (shouldRunClass('E') && !d.isRoundupArticle && d.url) {
      if (/\/article\/Review-Roundup-/i.test(d.url)) {
        hits.E_unflagged_roundup.push({ showId, file: f, url: d.url });
      }
    }

    // ─── F: Empty --unknown junk ────
    // Skip legitimate aggregator stubs (stagedoor, show-score, NYSR/NYC Theatre
    // Roundups, Talkin' Broadway, etc.) that carry aggregator excerpts and await
    // SERP-based outlet URL discovery. NYSR in particular publishes roundups with
    // per-outlet excerpts that arrive with source='nyc-theatre' and url=null
    // until the per-outlet URL is later resolved.
    if (shouldRunClass('F') && f.includes('--unknown')) {
      const noUrl = !d.url;
      const noText = !(d.fullText || '').trim();
      const AGGREGATOR_SOURCES = new Set([
        'nyc-theatre', 'nyc-theatre-roundups', 'nysr',
        'stagedoor', 'show-score', 'showscore',
        'dtli', 'dont-tell-the-lovelies',
        'talkinbroadway', 'talkin-broadway',
        'west-end-theatre', 'theatre-reviews', 'the-stage',
        'bww-roundup', 'playbill-verdict',
      ]);
      const EXCERPT_FIELDS = [
        'aggregatorStars', 'scoreSource',
        'stagedoorUrl', 'stagedoorExcerpt',
        'dtliExcerpt', 'nycTheatreExcerpt', 'nysrExcerpt',
        'talkinbroadwayExcerpt', 'nyTheatreGuideExcerpt',
        'showScoreExcerpt', 'theatreReviewsExcerpt',
        'bwwExcerpt', 'playbillVerdict',
        'wetExcerpt', 'stageExcerpt',
      ];
      const hasAggregatorField = EXCERPT_FIELDS.some(k => d[k]);
      const hasAggregatorSource = AGGREGATOR_SOURCES.has(d.source)
        || (Array.isArray(d.sources) && d.sources.some(s => AGGREGATOR_SOURCES.has(s)));
      const hasAggregatorData = hasAggregatorField || hasAggregatorSource;
      if (noUrl && noText && !hasAggregatorData) {
        hits.F_empty_unknown.push({ showId, file: f });
      }
    }

    // ─── B: False-positive wrongProduction ────
    // Catches reviews where wrongProduction=true but LLM content verification
    // says the review IS correct, AND publishDate is within 30 days of opening.
    // These are reviews incorrectly excluded by automated guards (date guard,
    // cross-market guard, venue guard).
    //
    // Skip signals:
    // - wrongProductionManualClear / wrongProductionReason: canonical fields
    //   for "this is a deliberate suppression, not a guard regression."
    //   Manual flags MUST set wrongProductionManualClear=true. Deliberate
    //   guards (e.g. OB→Broadway transfer in rebuild-all-reviews.js) MUST
    //   set wrongProductionReason. The audit treats their absence as a
    //   guard regression worth surfacing.
    // - rejectedForOtherReason: when the file is excluded on grounds
    //   *unrelated* to wrongProduction (wrongShow, isNonReview, roundup,
    //   duplicate, etc), B is irrelevant — that's a different rejection
    //   path. NOTE: this is `alreadyFlagged` MINUS `wrongProduction`
    //   itself (B requires wrongProduction=true, so we can't gate on it).
    //
    // Note: `wrongProductionAutoCleared` is intentionally NOT used as a skip
    // signal. It's historical metadata (~448 files have it set AND were later
    // re-flagged); using it would silence real cross-market and date-guard
    // regressions. Same for non-empty `wrongProductionNote` — date guard,
    // cross-market guard, etc. all write Note text, and B is meant to police
    // those guards.
    const rejectedForOtherReason = d.wrongShow || d.isRoundupArticle
      || d.wrongAttribution || d.contentVerification?.wrongArticle
      || d.isNonReview || d.nonReviewFlag || d.nonReviewContent
      || d.duplicateOf;
    if (shouldRunClass('B') && d.wrongProduction === true
        && d.contentVerification?.wrongProduction === false
        && !rejectedForOtherReason
        && !d.wrongProductionManualClear && !d.wrongProductionReason) {
      const pubDate = parseDate(d.publishDate);
      if (pubDate && showOpening) {
        const daysFromOpening = Math.round((pubDate - showOpening) / 86400000);
        if (Math.abs(daysFromOpening) <= 30) {
          hits.B_false_positive_wp.push({
            showId, file: f, daysFromOpening,
            wrongProductionNote: (d.wrongProductionNote || '').substring(0, 60),
          });
        }
      }
    }

    // ─── D: Pre-opening features masquerading as reviews ────
    // Published 5-60 days before opening, URL slug lacks review marker,
    // substantial text. Many are legitimate preview reviews, so this is
    // report-only (not in strict mode).
    if (shouldRunClass('D') && showOpening && !alreadyFlagged) {
      const pubDate = parseDate(d.publishDate);
      if (pubDate) {
        const daysBefore = (showOpening - pubDate) / 86400000;
        if (daysBefore >= 5 && daysBefore <= 60) {
          const urlStr = (d.url || '').toLowerCase();
          const hasReviewMarker = /review|critic|rating|verdict/.test(urlStr);
          const textLen = (d.fullText || '').length;
          if (!hasReviewMarker && textLen > 500) {
            hits.D_pre_opening_feature.push({
              showId, file: f, daysBefore: Math.round(daysBefore), textLen,
            });
          }
        }
      }
    }
  }

  // ─── C2: Same URL attributed to multiple critics (per-show) ────
  // After scanning all files in this show folder, check for URL collisions
  // where two files at the same outlet share a URL with identical fullText.
  if (shouldRunClass('C2')) {
    const urlMap = new Map();
    for (const f of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8')); } catch { continue; }
      if (!d.url || !d.url.startsWith('http')) continue;
      if (d.wrongAttribution || d.duplicateOf) continue; // already flagged
      const critic = d.criticName || f.split('--')[1]?.replace('.json', '') || 'unknown';
      const outletId = d.outletId || f.split('--')[0];
      const textLen = (d.fullText || '').length;
      const existing = urlMap.get(d.url) || [];
      existing.push({ file: f, criticName: critic, outletId, textLen });
      urlMap.set(d.url, existing);
    }
    for (const [url, entries] of urlMap) {
      if (entries.length < 2) continue;
      // Same outlet, different critics, identical text length = byline error
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i], b = entries[j];
          if (a.outletId !== b.outletId) continue;
          if (a.criticName === b.criticName) continue;
          if (a.textLen !== b.textLen || a.textLen < 50) continue;
          hits.C2_url_multi_critic.push({
            showId, url: url.substring(0, 80),
            file1: a.file, critic1: a.criticName,
            file2: b.file, critic2: b.criticName,
          });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────
const totalHits = Object.values(hits).reduce((a, b) => a + b.length, 0);

if (JSON_OUT) {
  console.log(JSON.stringify({
    scannedShows: showsScanned,
    scannedFiles: filesScanned,
    totalHits,
    classCounts: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length])),
    hits,
  }, null, 2));
} else {
  console.log(`\n=== REVIEW-TEXT CONTAMINATION AUDIT ===`);
  console.log(`Scanned: ${showsScanned} shows, ${filesScanned} files`);
  console.log(`Total hits: ${totalHits}\n`);
  for (const [k, arr] of Object.entries(hits)) {
    console.log(`  ${k}: ${arr.length}`);
  }
  if (totalHits > 0) {
    console.log('\n=== SAMPLES (first 5 per class) ===');
    for (const [k, arr] of Object.entries(hits)) {
      if (!arr.length) continue;
      console.log(`\n--- ${k} ---`);
      arr.slice(0, 5).forEach(h => console.log('  ' + JSON.stringify(h)));
    }
  }
}

// In strict mode, only count classes that are in the strict set.
// Class D (pre-opening features) is report-only — too many legitimate preview reviews.
const strictHits = Object.entries(hits)
  .filter(([k]) => {
    const classLetter = k.split('_')[0];
    return STRICT_CLASSES.has(classLetter);
  })
  .reduce((sum, [, arr]) => sum + arr.length, 0);

// --gate: catastrophe floor only. A cross-market leak (class A — wrong show's
// reviews shown to users) ALWAYS blocks; otherwise block only on a mass spike past
// GATE_FLOOR. Single-file C/E/F drift is printed above but does NOT fail the trunk.
if (GATE) {
  // FAIL LOUD on an empty corpus (task #1067, sibling of #1063/#1065) — a missing
  // or empty data/review-texts checkout scans 0 files, leaving crossMarketLeaks
  // and strictHits at 0 and this live blocking gate would otherwise print
  // "0 cross-market leaks... Non-catastrophic" and exit 0, a vacuous PASS.
  try {
    assertCorpusScanned(filesScanned, { gate: GATE });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\n❌ GATE: ${e.message}`);
    process.exit(1);
  }

  const { shouldBlockContaminationGate } = require('./lib/contamination-gate');
  const crossMarketLeaks = hits.A_cross_market.length;
  if (shouldBlockContaminationGate({ crossMarketLeaks, strictHits, floor: GATE_FLOOR })) {
    console.error(`\n❌ GATE: ${crossMarketLeaks} cross-market leak(s) (class A, zero-tolerance) + ${strictHits} strict hit(s) vs floor ${GATE_FLOOR}. Failing.`);
    process.exit(1);
  }
  console.log(`\n✅ GATE: 0 cross-market leaks, ${strictHits} strict hit(s) ≤ floor ${GATE_FLOOR}. Non-catastrophic — surfaced above, not blocking the trunk. Full --strict triage runs daily in check-corpus-drift.yml (→ digest).`);
  process.exit(0);
}

if (STRICT && strictHits > 0) {
  console.error(`\n❌ STRICT mode: ${strictHits} contamination issue(s) in strict classes. Failing.`);
  process.exit(1);
}

process.exit(0);
