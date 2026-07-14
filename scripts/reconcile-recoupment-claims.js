#!/usr/bin/env node
/**
 * Recoupment Claim Reconciler
 *
 * The manual pending-review queue (commercial-pending-review.json) never
 * clears because (a) it never checks whether commercial.json already has the
 * claim, cited, from a prior pipeline run — so resolved claims sit as stale
 * duplicates — and (b) unverifiable prose-only claims route straight to
 * human review with no attempt at machine verification.
 *
 * For every pending entry with a recouped claim (recouped:true ||
 * _recoupedClaim:true, excluding _reviewHold entries — those are review
 * REQUESTS about existing commercial.json data, never appliable):
 *
 *   1. STALE DUPLICATE — commercial.json already has recouped:true with a
 *      real sources[].url citation (prose-only recoupedSource doesn't
 *      count — see recoupment-reconcile-gate.js) for this slug → delete the
 *      pending entry. No new verification needed; some prior pipeline
 *      already resolved and cited this.
 *   2. VERIFY — SERP-search "<title> Broadway recoups" restricted to
 *      TRUSTED_RECOUPMENT_HOSTS, fetchPage() the top candidate(s), classify
 *      with the shared LLM verdict lib. An exact + high-confidence match from
 *      a trusted host applies recouped:true + date + source via the same
 *      commercial-apply-gate merge logic the Friday scraper uses, then
 *      clears the pending entry.
 *   3. UNVERIFIABLE — after MAX_VERIFY_ATTEMPTS (2) failed verification
 *      passes, stamp verifyAttempts and leave for human review. The manual
 *      queue then contains only genuinely unverifiable claims.
 *
 * Also emits verified (recoupedDate, capitalization) pairs to
 * data/recoupment-calibration-anchors.json — free calibration data for the
 * recoupment model (weekly operating cost back-solved from cumulative
 * profit ≈ capitalization at the recoupment week). Consuming this file in
 * the model itself is a follow-up (see Notion card).
 *
 * Usage:
 *   node scripts/reconcile-recoupment-claims.js                # live run
 *   node scripts/reconcile-recoupment-claims.js --dry-run       # plan only
 *   node scripts/reconcile-recoupment-claims.js --show=SLUG     # single entry
 *   node scripts/reconcile-recoupment-claims.js --max-verify=5  # SERP-call cap
 */

const fs = require('fs');
const path = require('path');

const { serpQuery } = require('./lib/url-discovery');
const { fetchPage } = require('./lib/scraper');
const { classifyArticle } = require('./lib/recoupment-classify');
const { TRUSTED_RECOUPMENT_HOSTS } = require('./lib/trusted-recoupment-domains');
const gate = require('./lib/commercial-apply-gate');
const { normalizeSources } = require('./lib/commercial-sources');
const {
  MAX_VERIFY_ATTEMPTS,
  isStaleDuplicate,
  shouldAttemptVerification,
  isConfirmingVerdict,
  buildVerifiedOverlay,
} = require('./lib/recoupment-reconcile-gate');

// Worktrees don't ship the gitignored core-data files (commercial.json,
// shows.json live in the private repo). Fall back to the main repo's data
// dir for reads; writes always target the local (CI-checked-out, or main
// repo when run outside a worktree) copy — mirrors scrape-recoupment-
// announcements.js's dataPath().
function dataPath(filename, { writable = false } = {}) {
  const local = path.join(__dirname, '..', 'data', filename);
  if (fs.existsSync(local)) return local;
  if (writable) return local;
  const mainRepo = path.join('/Users/tompryor/Broadwayscore/data', filename);
  if (fs.existsSync(mainRepo)) return mainRepo;
  return local;
}

const SHOWS_PATH = dataPath('shows.json');
const COMMERCIAL_PATH = dataPath('commercial.json', { writable: true });
const PENDING_PATH = dataPath('commercial-pending-review.json', { writable: true });
const CALIBRATION_PATH = dataPath('recoupment-calibration-anchors.json', { writable: true });

const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}
const DRY_RUN = flags['dry-run'] === true;
const SINGLE_SHOW = flags['show'] || null;
const MAX_VERIFY_CALLS = parseInt(flags['max-verify'], 10) || 27; // bounded by pending-queue size

function log(...a) { console.log(...a); }
function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n'); }
function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Resolve the commercial.json key for a pending entry. commercial.json is
// keyed by slug (memory: feedback_commercial_slug_keys); pending entries are
// keyed by year-suffixed show ID (e.g. giant-2026) but usually carry
// entry.slug. Fall back to the pending key itself if slug is absent.
function resolveSlug(key, entry) {
  return entry.slug || key;
}

async function verifyClaim(title, existingUrls) {
  const query = `"${title}" Broadway recoups`;
  let results;
  try {
    results = await serpQuery(query, { nbResults: 8, preferSpeed: true });
  } catch (e) {
    log(`      ✗ SERP error: ${e.message}`);
    return null;
  }
  if (!results) return null;

  const candidates = results.filter(r => {
    const host = hostnameOf(r.url);
    return host && TRUSTED_RECOUPMENT_HOSTS.has(host) && !existingUrls.has(r.url);
  });

  for (const c of candidates.slice(0, 3)) {
    const host = hostnameOf(c.url);
    log(`      📰 ${host} :: ${(c.title || '').slice(0, 80)}`);
    let html;
    try {
      const fetched = await fetchPage(c.url, { timeout: 25_000 });
      html = typeof fetched === 'string' ? fetched : (fetched?.content || '');
    } catch (e) {
      log(`        ✗ fetch failed: ${e.message}`);
      continue;
    }
    const verdict = await classifyArticle(title, c.url, html);
    log(`        → recouped=${verdict.recouped} match=${verdict.productionMatch} conf=${verdict.confidence}`);
    if (isConfirmingVerdict(verdict, host)) {
      return { verdict, url: c.url, host };
    }
  }
  return null;
}

async function main() {
  const pending = loadJSON(PENDING_PATH, { shows: {} });
  const commercial = loadJSON(COMMERCIAL_PATH, { shows: {} });
  const allShows = loadJSON(SHOWS_PATH, { shows: [] });
  const showsArr = allShows.shows || allShows;
  const showsBySlug = {};
  for (const s of showsArr) showsBySlug[s.slug] = s;

  pending.shows = pending.shows || {};
  commercial.shows = commercial.shows || {};

  let entries = Object.entries(pending.shows).filter(([, e]) => gate.hasRecoupedClaim(e) && !gate.isReviewHold(e));
  if (SINGLE_SHOW) {
    entries = entries.filter(([key, e]) => key === SINGLE_SHOW || resolveSlug(key, e) === SINGLE_SHOW);
  }

  log(`Recoupment reconciler — ${entries.length} recouped-claim pending entr${entries.length === 1 ? 'y' : 'ies'} (dry-run=${DRY_RUN})`);
  log('');

  let closedStale = 0;
  let verifiedApplied = 0;
  let stillUnverifiable = 0;
  let verifyCallsUsed = 0;
  const calibrationAnchors = [];
  const staleDupSlugs = [];
  const verifiedSlugs = [];

  for (const [key, entry] of entries) {
    const slug = resolveSlug(key, entry);
    const title = entry.title || showsBySlug[slug]?.title || slug;
    const existing = commercial.shows[slug];
    log(`— ${key} (slug: ${slug}) —`);

    if (isStaleDuplicate(existing)) {
      log(`  ✅ stale duplicate — commercial.json already has recouped:true, cited. Closing pending entry.`);
      closedStale++;
      staleDupSlugs.push(slug);
      if (!DRY_RUN) delete pending.shows[key];
      if (existing.recoupedDate && existing.capitalization != null) {
        calibrationAnchors.push({
          slug,
          recoupedDate: existing.recoupedDate,
          capitalization: existing.capitalization,
          source: 'stale-duplicate-reconcile',
        });
      }
      continue;
    }

    if (!shouldAttemptVerification(entry)) {
      log(`  🛑 verifyAttempts=${entry.verifyAttempts || 0} — at cap (${MAX_VERIFY_ATTEMPTS}), leaving for human review.`);
      stillUnverifiable++;
      continue;
    }

    if (verifyCallsUsed >= MAX_VERIFY_CALLS) {
      log(`  ⏭️  verify-call budget (${MAX_VERIFY_CALLS}) exhausted this run — deferring to next run.`);
      continue;
    }
    verifyCallsUsed++;

    const existingUrls = new Set(
      (Array.isArray(entry.sources) ? entry.sources.map(s => s.url) : []).filter(Boolean)
    );
    const result = await verifyClaim(title, existingUrls);

    if (result) {
      log(`  ✅ verified via ${result.host} — applying recouped:true.`);
      verifiedApplied++;
      verifiedSlugs.push(slug);
      const overlay = buildVerifiedOverlay(entry, result.verdict, result.url, result.host);
      const built = gate.buildCommercialEntry(overlay, existing, { isClaimAutoApply: true, normalizeSources });
      built.lastUpdated = new Date().toISOString();
      built.firstAdded = existing?.firstAdded || new Date().toISOString();
      if (!DRY_RUN) {
        commercial.shows[slug] = built;
        delete pending.shows[key];
      }
      if (built.recoupedDate && built.capitalization != null) {
        calibrationAnchors.push({
          slug,
          recoupedDate: built.recoupedDate,
          capitalization: built.capitalization,
          source: 'reconciler-verified',
        });
      }
    } else {
      const attempts = (entry.verifyAttempts || 0) + 1;
      log(`  ❌ no trusted-host exact+high-confidence match found (attempt ${attempts}/${MAX_VERIFY_ATTEMPTS}).`);
      stillUnverifiable++;
      if (!DRY_RUN) {
        pending.shows[key] = { ...entry, verifyAttempts: attempts, lastVerifyAttemptAt: new Date().toISOString() };
      }
    }
  }

  log('');
  log('========== SUMMARY ==========');
  log(`Closed as stale duplicates: ${closedStale}${staleDupSlugs.length ? ' (' + staleDupSlugs.join(', ') + ')' : ''}`);
  log(`Verified + applied:         ${verifiedApplied}${verifiedSlugs.length ? ' (' + verifiedSlugs.join(', ') + ')' : ''}`);
  log(`Still unverifiable:         ${stillUnverifiable}`);
  log(`SERP verify calls used:     ${verifyCallsUsed}/${MAX_VERIFY_CALLS}`);

  if (DRY_RUN) {
    log('\n[dry-run] no writes.');
    return;
  }

  if (closedStale > 0 || verifiedApplied > 0) {
    pending.lastUpdated = new Date().toISOString();
    writeJSON(PENDING_PATH, pending);
    if (verifiedApplied > 0) writeJSON(COMMERCIAL_PATH, commercial);
  } else if (stillUnverifiable > 0) {
    // verifyAttempts bump still needs to persist even with 0 applies/closes.
    pending.lastUpdated = new Date().toISOString();
    writeJSON(PENDING_PATH, pending);
  }

  if (!DRY_RUN) {
    // Seed from ALL existing verified recoupments in commercial.json first,
    // then overlay this run's fresher reconciler-verified/stale-dup anchors —
    // every (recoupedDate, capitalization) pair already sitting in
    // commercial.json is the same free calibration anchor the card
    // describes, and there's no reason to wait for each one to cycle through
    // the pending queue to pick it up.
    const bySlug = new Map();
    for (const [slug, data] of Object.entries(commercial.shows)) {
      if (data.recouped === true && data.recoupedDate && data.capitalization != null) {
        bySlug.set(slug, { slug, recoupedDate: data.recoupedDate, capitalization: data.capitalization, source: 'commercial-json-backfill' });
      }
    }
    for (const a of calibrationAnchors) bySlug.set(a.slug, a);
    writeJSON(CALIBRATION_PATH, { updatedAt: new Date().toISOString(), anchors: [...bySlug.values()] });
    log(`Wrote ${bySlug.size} calibration anchor(s) → ${path.relative(process.cwd(), CALIBRATION_PATH)}`);
  }
}

module.exports = { resolveSlug };

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
