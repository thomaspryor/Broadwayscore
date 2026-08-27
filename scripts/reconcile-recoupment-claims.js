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
 *      count), and the pending claim's own recoupedDate (if any) doesn't
 *      name a different year — see recoupment-reconcile-gate.js. Deletes the
 *      pending entry with no new verification; some prior pipeline already
 *      resolved and cited this. A year mismatch is NOT auto-closed (could be
 *      a correction) — it falls through to independent SERP verification.
 *   2. VERIFY — SERP-search restricted to TRUSTED_RECOUPMENT_HOSTS (generic
 *      + site-restricted BWW/Playbill queries, mirroring
 *      scrape-recoupment-announcements.js since neither publishes a
 *      working RSS feed), fetchPage() the top candidates, classify with the
 *      shared LLM verdict lib (title disambiguated with the show's opening
 *      year to help reject same-title revivals). An exact + high-confidence
 *      match with a clean parseable date from a trusted host applies
 *      recouped:true + date + source via the same commercial-apply-gate
 *      merge logic the Friday scraper uses, then clears the pending entry.
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
 *   node scripts/reconcile-recoupment-claims.js --time-budget-min=25
 */

const fs = require('fs');
const path = require('path');

const { serpQuery } = require('./lib/url-discovery');
const { fetchPage, cleanup } = require('./lib/scraper');
const { classifyArticle } = require('./lib/recoupment-classify');
const { TRUSTED_RECOUPMENT_HOSTS } = require('./lib/trusted-recoupment-domains');
const gate = require('./lib/commercial-apply-gate');
const { normalizeSources } = require('./lib/commercial-sources');
const { isCommercialScope, resolveScopeShow } = require('./lib/commercial-scope');
const {
  MAX_VERIFY_ATTEMPTS,
  isStaleDuplicate,
  shouldAttemptVerification,
  isConfirmingVerdict,
  buildVerifiedOverlay,
} = require('./lib/recoupment-reconcile-gate');
const { createCommercialWriteGuard } = require('./lib/commercial-write-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

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
// dataPath('commercial.json', {writable:true}) always resolves to the local
// (worktree/CI-checked-out) path, never the main-repo fallback — bind the
// guard there so load/save target the exact same file the old
// loadJSON/writeJSON pair did.
const { loadCommercial, saveCommercial } = createCommercialWriteGuard(COMMERCIAL_PATH);

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
const timeBudget = createRunBudget(parseTimeBudgetMin(args));

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
// entry.slug. When slug is absent, resolve it from shows.json — the bare
// `entry.slug || key` fallback created ID-keyed duplicate entries next to
// the slug-keyed ones (13 hand-merged 2026-07-19).
let _showsByIdOrSlug = null;
function _lookupShow(key) {
  if (_showsByIdOrSlug === null) {
    _showsByIdOrSlug = {};
    try {
      const allShows = (loadJSON(path.join(__dirname, '..', 'data', 'shows.json'), {}).shows) || [];
      for (const s of allShows) {
        if (s.slug) _showsByIdOrSlug[s.slug] = s;
        if (s.id) _showsByIdOrSlug[s.id] = s;
      }
    } catch { /* shows.json unavailable — degrade to bare fallback */ }
  }
  return _showsByIdOrSlug[key];
}
function resolveSlug(key, entry) {
  if (entry.slug) return entry.slug;
  const show = _lookupShow(key);
  if (show && show.slug) return show.slug;
  console.warn(`  ⚠️ "${key}" — no slug resolvable from shows.json; keying by pending key (validate-data will flag if it's an ID)`);
  return key;
}

// Mirrors scrape-recoupment-announcements.js's buildQueries: generic queries
// rank by whatever Google surfaces highest (usually NYT/Deadline/Variety).
// BroadwayWorld and Playbill are both in TRUSTED_RECOUPMENT_HOSTS but have no
// working RSS feed, so site-restricted queries are the only way to guarantee
// their coverage independent of generic-query ranking.
function buildQueries(title) {
  return [
    `"${title}" Broadway recoups`,
    `"${title}" recoupment announcement`,
    `"${title}" earned back investment`,
    `"${title}" recoups site:broadwayworld.com`,
    `"${title}" recoups site:playbill.com`,
  ];
}

async function verifyClaim(title, disambiguatedTitle, existingUrls) {
  const seen = new Set();
  const candidates = [];
  for (const query of buildQueries(title)) {
    let results;
    try {
      results = await serpQuery(query, { nbResults: 8, preferSpeed: true });
    } catch (e) {
      log(`      ✗ SERP error (${query}): ${e.message}`);
      continue;
    }
    if (!results) continue;
    for (const r of results) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      const host = hostnameOf(r.url);
      if (host && TRUSTED_RECOUPMENT_HOSTS.has(host) && !existingUrls.has(r.url)) {
        candidates.push(r);
      }
    }
  }

  for (const c of candidates.slice(0, 4)) {
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
    // disambiguatedTitle folds in the show's opening year (e.g. "Wicked
    // (2003 Broadway production)") to help the classifier reject same-title
    // revivals — classifyArticle's productionMatch check otherwise has no
    // year/venue context to work from (feedback_same_title_disambiguation.md).
    const verdict = await classifyArticle(disambiguatedTitle, c.url, html);
    log(`        → recouped=${verdict.recouped} match=${verdict.productionMatch} conf=${verdict.confidence}`);
    if (isConfirmingVerdict(verdict, host)) {
      return { verdict, url: c.url, host };
    }
  }
  return null;
}

async function main() {
  const pending = loadJSON(PENDING_PATH, { shows: {} });
  // loadCommercial() throws on a missing file (unlike loadJSON's silent
  // fallback) — guard with existsSync so a worktree without the gitignored
  // core-data file still degrades to an empty {shows:{}} like before.
  const commercial = fs.existsSync(COMMERCIAL_PATH) ? loadCommercial() : { shows: {} };
  const allShows = loadJSON(SHOWS_PATH, { shows: [] });
  const showsArr = allShows.shows || allShows;
  const showsBySlug = {};
  for (const s of showsArr) {
    if (s.slug) showsBySlug[s.slug] = s;
    if (s.id) showsBySlug[s.id] = s;
  }

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
  let skippedError = 0;
  let verifyCallsUsed = 0;
  const calibrationAnchors = [];
  const staleDupSlugs = [];
  const verifiedSlugs = [];
  // Guard against two pending keys resolving to the same slug in one run: if
  // slug A was already closed/applied this run, a second entry for the same
  // slug must not be evaluated against the just-mutated in-memory
  // commercial.shows[slug] (it would look like a trivially-confirmed stale
  // duplicate of our OWN write, with no independent verification). Defer it
  // to the next run instead.
  const touchedSlugsThisRun = new Set();

  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    if (timeBudget.exceeded()) {
      log(`⏱ Time budget (${timeBudget.minutes} min) reached — ${entries.length - entryIdx} entries deferred to next run.`);
      break;
    }
    const [key, entry] = entries[entryIdx];
    const slug = resolveSlug(key, entry);
    const title = entry.title || showsBySlug[slug]?.title || slug;
    log(`— ${key} (slug: ${slug}) —`);

    // Scope guard — this path writes commercial.json directly, bypassing
    // apply-commercial-pending's guard. Off-Broadway/West End entries must
    // never land (Broadway-only feature); the Sunday sweep archives them.
    const scopeShow = resolveScopeShow(showsBySlug, key, entry);
    if (scopeShow && !isCommercialScope(scopeShow)) {
      log(`  ⛔ out of commercial scope (${scopeShow.category}) — skipping; sweep will archive.`);
      continue;
    }

    if (touchedSlugsThisRun.has(slug)) {
      log(`  ⏭️  slug "${slug}" already touched by another pending entry this run — deferring to next run.`);
      continue;
    }

    try {
      const existing = commercial.shows[slug];

      if (isStaleDuplicate(existing, entry)) {
        log(`  ✅ stale duplicate — commercial.json already has recouped:true, cited. Closing pending entry.`);
        closedStale++;
        staleDupSlugs.push(slug);
        touchedSlugsThisRun.add(slug);
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
      const openingYear = showsBySlug[slug]?.openingDate?.slice(0, 4);
      const disambiguatedTitle = openingYear ? `${title} (${openingYear} Broadway production)` : title;
      const result = await verifyClaim(title, disambiguatedTitle, existingUrls);

      if (result) {
        log(`  ✅ verified via ${result.host} — applying recouped:true.`);
        verifiedApplied++;
        verifiedSlugs.push(slug);
        touchedSlugsThisRun.add(slug);
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
    } catch (e) {
      // Isolate per-entry failures: this workflow step is deliberately NOT
      // continue-on-error (a silently-swallowed run would be worse), but one
      // malformed LLM overlay or unexpected shape must not crash the whole
      // pass and abort every other entry's progress. Leave this entry
      // untouched — it retries next run.
      log(`  ⚠️  entry errored, skipping: ${e.message}`);
      skippedError++;
    }
  }

  log('');
  log('========== SUMMARY ==========');
  log(`Closed as stale duplicates: ${closedStale}${staleDupSlugs.length ? ' (' + staleDupSlugs.join(', ') + ')' : ''}`);
  log(`Verified + applied:         ${verifiedApplied}${verifiedSlugs.length ? ' (' + verifiedSlugs.join(', ') + ')' : ''}`);
  log(`Still unverifiable:         ${stillUnverifiable}`);
  log(`Skipped (error):            ${skippedError}`);
  log(`SERP verify calls used:     ${verifyCallsUsed}/${MAX_VERIFY_CALLS}`);

  if (DRY_RUN) {
    log('\n[dry-run] no writes.');
    return;
  }

  // Write commercial.json BEFORE pending — a kill/timeout between the two
  // writes then leaves the pending entry present (worst case: closed as a
  // stale duplicate on the next run, since commercial.json already reflects
  // the applied claim) rather than the reverse order, where a kill drops the
  // claim from the queue without ever having applied it (ship-check finding).
  if (verifiedApplied > 0) saveCommercial(commercial);
  if (closedStale > 0 || verifiedApplied > 0 || stillUnverifiable > 0) {
    pending.lastUpdated = new Date().toISOString();
    writeJSON(PENDING_PATH, pending);
  }

  // Seed from ALL existing verified recoupments in commercial.json first,
  // then overlay this run's fresher reconciler-verified/stale-dup anchors —
  // every (recoupedDate, capitalization) pair already sitting in
  // commercial.json is the same free calibration anchor the card describes,
  // and there's no reason to wait for each one to cycle through the pending
  // queue to pick it up. Only write if the anchor set actually changed, so
  // a no-op run doesn't churn a commit every Friday/Saturday.
  const bySlug = new Map();
  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.recouped === true && data.recoupedDate && data.capitalization != null) {
      bySlug.set(slug, { slug, recoupedDate: data.recoupedDate, capitalization: data.capitalization, source: 'commercial-json-backfill' });
    }
  }
  for (const a of calibrationAnchors) bySlug.set(a.slug, a);
  const newAnchors = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  const existingCalibration = loadJSON(CALIBRATION_PATH, { anchors: [] });
  const changed = JSON.stringify(existingCalibration.anchors || []) !== JSON.stringify(newAnchors);
  if (changed) {
    writeJSON(CALIBRATION_PATH, { updatedAt: new Date().toISOString(), anchors: newAnchors });
    log(`Wrote ${newAnchors.length} calibration anchor(s) → ${path.relative(process.cwd(), CALIBRATION_PATH)}`);
  } else {
    log(`Calibration anchors unchanged (${newAnchors.length}) — skipping write.`);
  }
}

module.exports = { resolveSlug, buildQueries };

if (require.main === module) {
  main()
    .catch(e => { console.error('FATAL', e); process.exitCode = 1; })
    .finally(() => {
      // A successful Playwright fetch leaves Chromium open — cleanup() closes
      // it with a timeout guard (#438/#914 class).
      cleanup().catch(() => {}).finally(() => process.exit(process.exitCode || 0));
    });
}
