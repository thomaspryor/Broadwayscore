#!/usr/bin/env node
/**
 * audit-review-url-clusters.js
 *
 * Detects AND remediates byline-explosion clusters (see
 * scripts/lib/review-url-clusters.js): one review URL scraped into 5+ files under
 * different critic names. These slip past criticName-keyed dup audits and usually
 * leave the real review unscored (invalid tier + circular duplicateOf).
 *
 * Report (default): raw clusters, split into RESOLVED (already collapsed to one
 * primary) vs UNRESOLVED (still harmful). --gate exits 1 only on UNRESOLVED.
 *
 * --fix: for each cluster, decide (scripts/lib/cluster-canonical.js) whether a
 * real review can be recovered. RECOVER → clear the canonical's suppression with
 * the manual-protection field set (buildManualReviewFields, incl protectedFields
 * so push-review-texts won't revert it) and point every sibling's duplicateOf at
 * it. SKIP → collapse siblings onto a tombstone and report the URL for manual
 * re-gather (empty extractions of the right URL) or leave-as-wrong (tour/roundup/
 * wrong-show). Non-destructive: no file deletion, fully git reversible. Reuses
 * contentMatchesFiledUnderVenue + verifyAggregatorUrl for the per-file venue/
 * show-match signals (never a date window — see Notion 394637c5).
 *
 * Usage:
 *   node scripts/audit-review-url-clusters.js                 # report
 *   node scripts/audit-review-url-clusters.js --gate          # exit 1 on unresolved
 *   node scripts/audit-review-url-clusters.js --fix --dry-run # show planned changes
 *   node scripts/audit-review-url-clusters.js --fix           # apply
 *   node scripts/audit-review-url-clusters.js --fix --show=ID # scope to one show
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findUrlClusters } = require('./lib/review-url-clusters');
const { decideClusterAction } = require('./lib/cluster-canonical');
const { contentMatchesFiledUnderVenue } = require('./lib/cross-production-guards');
const { verifyAggregatorUrl } = require('./lib/show-match-verifier');
const { GENERIC_VENUE_SLUGS } = require('./lib/venue-classification');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
let isIncludableForRebuild = () => false;
try { ({ isIncludableForRebuild } = require('./lib/review-guards')); } catch { /* optional */ }

const args = process.argv.slice(2);
const gate = args.includes('--gate');
const doFix = args.includes('--fix');
const dryRun = args.includes('--dry-run');
const showFilter = (args.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const threshold = Number((args.find((a) => a.startsWith('--threshold=')) || '').split('=')[1]) || 5;
const maxRecover = Number((args.find((a) => a.startsWith('--max-recover=')) || '').split('=')[1]) || 8;

const RT = process.env.REVIEW_TEXTS_DIR || path.join(os.homedir(), 'broadway-review-texts');
const SHOWS_JSON = process.env.SHOWS_JSON
  || path.join(os.homedir(), 'broadway-scorecard-data', 'shows.json');

// verifyAggregatorUrl rejectReasons that mean the URL belongs to a DIFFERENT
// show/production (recovery is impossible). url-token-mismatch is deliberately
// NOT here — it soft-fails on apostrophe/hash URLs ("Ain't No Mo'") that ARE the
// right show, and cluster-canonical treats those as recoverable.
const HARD_REJECT = new Set(['date-out-of-window', 'page-title-mismatch']);

// One-time, driver-owned canonical overrides for clusters whose identical bodies
// carry invented bylines and the genuine critic is externally known. Keyed
// `${showId}|${canonicalUrl}`. Kept out of the pure lib (design review 2026-07-05).
const PREFERRED_CANONICAL = {
  'aint-no-mo-2022|https://variety.com/2022/legit/reviews/aint-no-mo-review-broadway-1235448778':
    'variety--aramide-tinubu.json',
};

// Clusters where every byline is an invented WhatsOnStage-staff name (the true
// author is unrecoverable): credit the outlet, not a hallucinated critic.
const NEUTRALIZE_CRITIC = {
  'a-midsummer-nights-dream-west-end-2026|https://www.whatsonstage.com/news/a-midsummer-nights-dream-at-regents-park-open-air-theatre-review_1726521':
    'WhatsOnStage',
};

const STAMP = process.env.FIX_STAMP || 'byline-cluster-cleanup';

function venueSlug(venue) {
  if (!venue || typeof venue !== 'string') return null;
  const cleaned = venue.toLowerCase()
    .replace(/\btheatre\b|\btheater\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned.length < 5) return null;
  if (GENERIC_VENUE_SLUGS.has(cleaned)) return null;
  return cleaned;
}

function loadShows() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.shows;
    const map = new Map();
    for (const s of list) map.set(s.id, s);
    return map;
  } catch {
    return new Map();
  }
}

function writePlain(p, json) {
  // Plain write — NOT safeWriteReview: its URL-collision detector would re-set
  // duplicateOf on the canonical we are deliberately clearing (the very bug that
  // created these clusters). Matches cascade-clear-duplicate-refs's rationale.
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
}

if (!fs.existsSync(RT)) {
  console.error(`review-texts dir not found: ${RT}`);
  process.exit(0);
}

const showDirs = fs.readdirSync(RT).filter((d) => {
  const p = path.join(RT, d);
  return !d.startsWith('_') && !d.startsWith('.') && fs.statSync(p).isDirectory();
}).filter((d) => !showFilter || d === showFilter);

const shows = loadShows();

// ---- Gather clusters + per-file signals ------------------------------------
function gatherClusters() {
  const out = [];
  for (const show of showDirs) {
    const dir = path.join(RT, show);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const parsed = {};
    const reviews = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        parsed[f] = r;
        reviews.push({
          file: f, url: r.url, outlet: r.outlet, criticName: r.criticName || r.critic,
          contentTier: r.contentTier, duplicateOf: r.duplicateOf,
        });
      } catch { /* skip unreadable */ }
    }
    const clusters = findUrlClusters(reviews, threshold);
    if (clusters.length) out.push({ show, dir, parsed, clusters });
  }
  return out;
}

/** Build the ClusterFileSignal[] cluster-canonical.js consumes, from parsed files. */
function signalsFor(cluster, dir, parsed, show) {
  const vSlug = show ? venueSlug(show.venue) : null;
  return cluster.files.map((f) => {
    const r = parsed[f] || {};
    const body = r.fullText || '';
    let includable = false;
    try { includable = isIncludableForRebuild(r, show, path.join(dir, f)); } catch { includable = false; }
    return {
      file: f,
      contentTier: r.contentTier,
      fullTextLen: body.length,
      fullTextHead: body.slice(0, 400),
      wrongProduction: r.wrongProduction === true,
      wrongShow: r.wrongShow === true,
      aggregatorStars: r.aggregatorStars,
      originalScore: r.originalScore,
      venueMatch: vSlug ? contentMatchesFiledUnderVenue({ fullText: body }, vSlug) : false,
      includable,
      humanReviewScore: r.humanReviewScore,
      criticName: r.criticName || r.critic,
      duplicateOf: r.duplicateOf,
    };
  });
}

function decideFor(clusterCtx) {
  const { show: showId, dir, parsed, cluster } = clusterCtx;
  const show = shows.get(showId);
  const files = signalsFor(cluster, dir, parsed, show);
  const rawUrl = (parsed[cluster.files[0]] || {}).url || cluster.url;
  let hardReject = false;
  if (show) {
    const v = verifyAggregatorUrl({
      url: rawUrl,
      show: { id: show.id, title: show.title, venue: show.venue, openingDate: show.openingDate },
    });
    hardReject = !v.isValid && HARD_REJECT.has(v.rejectReason);
  }
  const key = `${showId}|${cluster.url}`;
  const preferredCanonical = PREFERRED_CANONICAL[key] || null;
  // A show missing from shows.json gives us NO venue/URL validation (venueMatch
  // and hardReject both default false) — never recover blind; only collapse.
  if (!show) return { decision: { action: 'skip', reason: 'show-not-in-catalog', canonical: null }, hardReject: false };
  const decision = decideClusterAction(files, { hardReject, preferredCanonical });
  return { decision, hardReject };
}

// ---- Apply -----------------------------------------------------------------
function applyRecover(clusterCtx, decision) {
  const { show: showId, dir, parsed, cluster } = clusterCtx;
  const canonical = decision.canonical;
  const canonData = parsed[canonical];
  const key = `${showId}|${cluster.url}`;
  const show = shows.get(showId);
  const vSlug = show ? venueSlug(show.venue) : null;
  const venueMatch = !!(vSlug && contentMatchesFiledUnderVenue({ fullText: canonData.fullText || '' }, vSlug));

  // NARROW recovery — assert ONLY what un-suppresses this specific byline
  // explosion. Deliberately NOT buildManualReviewFields({operatorTrust:true}):
  // that stamps allowCrossMarket / allowTourSignal / allowFilmSignal /
  // wrongProductionOverride — the blanket immunity manual-review-fields.js:57-62
  // warns automated callers must never grant (it re-admitted prior-production /
  // cross-market contamination, 2026-06-21, 335 reviews). A machine-picked
  // canonical must stay subject to every production guard except the ones this
  // review demonstrably clears (a venue-body-matched stale wrongShow).
  const merged = {
    ...canonData,
    duplicateOf: null,
    duplicateReason: null,
    duplicateClearReason: `byline-explosion-canonical (${STAMP})`,
  };
  const prot = new Set(canonData.protectedFields || []);
  // Clear a stale wrongShow ONLY when the body named the venue (decideClusterAction
  // already required venueMatch to keep a wrongShow file as a candidate).
  if (canonData.wrongShow === true) {
    clearWrongProductionFlags(merged, {
      source: 'audit-review-url-clusters.js',
      reason: `byline-explosion-canonical, venue-body-matched (${STAMP})`,
      wrongShowOnly: true,
    });
    merged.wrongShowManualClear = true;
    prot.add('wrongShow'); prot.add('wrongShowManualClear');
  }
  // Rescue scoreability of a real body the classifier marked invalid. The
  // invalid-tier guard (review-guards.js:2433) only defers to a wrongProduction
  // clear, so a venue-body-matched review needs wrongProductionManualClear to
  // pass — this asserts ONLY "not wrong production" (which the venue-body match
  // proves), NOT the tour/film/cross-market immunity operatorTrust would grant.
  // Require positive venue evidence so a machine pick can't self-exempt blindly.
  if (canonData.contentTier === 'invalid') {
    merged.manualContentTier = 'complete';
    prot.add('manualContentTier');
    if (venueMatch) {
      merged.wrongProductionManualClear = true;
      prot.add('wrongProductionManualClear');
    }
  }
  merged.protectedFields = [...prot];
  if (NEUTRALIZE_CRITIC[key]) merged.criticName = NEUTRALIZE_CRITIC[key];
  writePlain(path.join(dir, canonical), merged);

  for (const f of cluster.files) {
    if (f === canonical) continue;
    const d = parsed[f];
    // Never bury a human-vouched review under a machine canonical.
    if (d.humanReviewScore != null) continue;
    d.duplicateOf = canonical;
    d.duplicateReason = 'byline-explosion-collapse';
    d.duplicateClearReason = null;
    d.contentTier = 'invalid';
    writePlain(path.join(dir, f), d);
  }
}

function applySkip(clusterCtx) {
  const { dir, parsed, cluster } = clusterCtx;
  // Tombstone = a member kept as the sole primary. Prefer one already flagged
  // wrongProduction (a genuine wrong-production marker) so nothing new scores;
  // else the first file. Its OWN duplicateOf must be cleared — these clusters
  // often contain a circular duplicateOf pair (arifa<->chris), which would leave
  // primaryCount=0 and the cluster "unresolved" (2026-07-05).
  // Never tombstone under, or collapse away, a human-vouched review.
  const tombstone = cluster.files.find((f) => (parsed[f] || {}).wrongProduction === true
      && (parsed[f] || {}).humanReviewScore == null)
    || cluster.files.find((f) => (parsed[f] || {}).humanReviewScore == null)
    || cluster.files[0];
  const t = parsed[tombstone];
  if (t.duplicateOf) {
    t.duplicateOf = null;
    t.duplicateReason = null;
    t.duplicateClearReason = `byline-explosion-tombstone (${STAMP})`;
    writePlain(path.join(dir, tombstone), t);
  }
  for (const f of cluster.files) {
    if (f === tombstone) continue;
    const d = parsed[f];
    if (d.humanReviewScore != null) continue; // preserve human work as its own primary
    d.duplicateOf = tombstone;
    d.duplicateReason = 'byline-explosion-collapse';
    d.duplicateClearReason = null;
    writePlain(path.join(dir, f), d);
  }
  return tombstone;
}

// ---- Main ------------------------------------------------------------------
const groups = gatherClusters();

if (doFix) {
  const plans = [];
  let skippedResolved = 0;
  for (const g of groups) {
    for (const cluster of g.clusters) {
      // Idempotency + scoping: a cluster already collapsed to a single primary is
      // resolved — do not re-tombstone/re-recover it (a rerun would otherwise
      // churn tombstone choice on already-fixed data). Force reprocessing with
      // --force if a canonical genuinely needs re-selecting.
      if (cluster.primaryCount === 1 && !args.includes('--force')) { skippedResolved++; continue; }
      const ctx = { show: g.show, dir: g.dir, parsed: g.parsed, cluster };
      const { decision, hardReject } = decideFor(ctx);
      plans.push({ ctx, decision, hardReject });
    }
  }
  if (skippedResolved) console.log(`[audit-review-url-clusters] ${skippedResolved} already-resolved cluster(s) skipped (use --force to reprocess)\n`);
  const recovers = plans.filter((p) => p.decision.action === 'recover');
  if (recovers.length > maxRecover) {
    console.error(`::error:: refusing --fix: ${recovers.length} recover actions exceed --max-recover=${maxRecover}. ` +
      `The audited set was ~4; a larger number means the corpus drifted — re-review before applying (raise with --max-recover=N).`);
    process.exit(1);
  }

  console.log(`[audit-review-url-clusters] --fix ${dryRun ? '(dry-run)' : ''} — ${plans.length} cluster(s), ${recovers.length} recover / ${plans.length - recovers.length} skip\n`);
  for (const { ctx, decision, hardReject } of plans) {
    const tag = decision.action === 'recover' ? 'RECOVER' : 'SKIP';
    console.log(`  [${tag}] ${ctx.show}`);
    console.log(`    url: ${ctx.cluster.url}`);
    console.log(`    reason: ${decision.reason}${hardReject ? ' (hardReject)' : ''}`);
    if (decision.action === 'recover') {
      console.log(`    canonical: ${decision.canonical}`);
      if (!dryRun) applyRecover(ctx, decision);
    } else {
      const empty = ctx.cluster.files.every((f) => !((ctx.parsed[f] || {}).fullText || '').length);
      console.log(`    disposition: ${decision.reason === 'no-recoverable-review' && empty ? 'EMPTY — needs manual re-gather of this URL' : 'wrong-production/roundup/wrong-show — leave suppressed'}`);
      if (!dryRun) { const tomb = applySkip(ctx); console.log(`    tombstone: ${tomb}`); }
    }
    console.log('');
  }
  if (dryRun) console.log('(dry-run — no files written)');
  else console.log('Applied. Re-run without --fix to confirm 0 unresolved clusters, then rebuild + scoring-delta.');
  process.exit(0);
}

// ---- Report (default) ------------------------------------------------------
const resolved = [];
const unresolved = [];
for (const g of groups) {
  for (const c of g.clusters) {
    (c.primaryCount === 1 ? resolved : unresolved).push({ show: g.show, c });
  }
}

if (unresolved.length === 0 && resolved.length === 0) {
  console.log(`[audit-review-url-clusters] OK — no URL clusters >= ${threshold} across ${showDirs.length} shows.`);
  process.exit(0);
}

if (unresolved.length === 0) {
  console.log(`[audit-review-url-clusters] OK — ${resolved.length} cluster(s) all RESOLVED (1 primary each); 0 unresolved.`);
  process.exit(0);
}

console.log(`[audit-review-url-clusters] ${unresolved.length} UNRESOLVED byline-explosion cluster(s) (threshold ${threshold}; ${resolved.length} resolved):\n`);
let lastShow = null;
for (const { show, c } of unresolved) {
  if (show !== lastShow) { console.log(`  ${show}`); lastShow = show; }
  console.log(`    ${c.count}x same URL (${c.invalidCount} invalid, ${c.primaryCount} primary): ${c.url}`);
  console.log(`      bylines: ${c.bylines.join(', ')}`);
}
console.log(`\nFix: node scripts/audit-review-url-clusters.js --fix --dry-run  (then --fix). ` +
  `RECOVER collapses to the venue/body-validated canonical; SKIP tombstones wrong-production/empty clusters.`);

process.exit(gate ? 1 : 0);
