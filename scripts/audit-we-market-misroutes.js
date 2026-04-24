#!/usr/bin/env node
/**
 * audit-we-market-misroutes.js — Replay the gather-time market-routing classifier
 * against every wrongProduction=true file in WE/OWE show directories. Reroute
 * files the classifier identifies as misrouted Broadway reviews to the correct
 * Broadway show dir.
 *
 * This is the historical companion to the gather-time guard introduced via
 * scripts/lib/market-routing.js (card 34c637c5-416f-81cf). Closes the backlog
 * of ~1636 WE-dir wrongProduction files (October 2025 audit).
 *
 * Behavior per file:
 *   reroute → move file to target show dir, stamp routedFromShowId, clear
 *             wrongProduction flag (the flag was correct for the source dir
 *             but the file is now in the right place). Uses safeWriteReview
 *             to preserve PROTECTED_FIELDS.
 *   reject  → leave in place (classifier says clearly wrong market, no target)
 *   accept  → log "cv-disagreement" — CV flagged wrongProduction but routing
 *             says the file belongs where it is. Manual review recommended.
 *
 * Collision handling: if the target show dir already has a file from the same
 * outlet+critic, the file is left in place and the collision is logged. The
 * operator resolves collisions manually (usually they're duplicates).
 *
 * Usage:
 *   node scripts/audit-we-market-misroutes.js                # dry-run (report)
 *   node scripts/audit-we-market-misroutes.js --execute       # actually move files
 *   node scripts/audit-we-market-misroutes.js --show=ID       # limit to one show
 *   node scripts/audit-we-market-misroutes.js --limit=N       # cap move count
 */

const fs = require('fs');
const path = require('path');
const { classifyMarketRouting, buildSiblingIndex } = require('./lib/market-routing');
const { isLondonMarket } = require('./lib/venue-classification');
const { safeWriteReview } = require('./lib/review-write-guard');

const ROOT = path.join(__dirname, '..');
const DEFAULT_REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const AUDIT_OUT = path.join(ROOT, 'data', 'audit', 'market-misroutes-migration.json');

function parseFlag(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  return arg.slice(name.length + 3);
}
const execute = process.argv.includes('--execute');
const showFilter = parseFlag('show', null);
const limitArg = parseFlag('limit', null);
const LIMIT = limitArg ? parseInt(limitArg, 10) : Infinity;
const REVIEW_TEXTS_DIR = parseFlag('reviewTextsDir', DEFAULT_REVIEW_TEXTS_DIR);

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return raw.shows || raw;
}

function findExistingInTarget(targetDir, outletId, criticSlug) {
  if (!fs.existsSync(targetDir)) return null;
  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  // Match by "outletid--criticslug.json" prefix (the standard generateReviewFilename output).
  for (const f of files) {
    const base = f.replace(/\.json$/i, '');
    const [fileOutlet, fileCritic] = base.split('--');
    if (!fileOutlet) continue;
    if (fileOutlet === outletId && (!criticSlug || criticSlug === 'unknown' || fileCritic === criticSlug)) {
      return f;
    }
  }
  return null;
}

function main() {
  const shows = loadShows();
  const showMap = new Map(shows.map(s => [s.id, s]));
  const siblingIndex = buildSiblingIndex(shows);

  // Discover WE/OWE show directories we care about.
  const dirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map(d => d.name);

  const targets = showFilter ? [showFilter] : dirs.filter(id => {
    const s = showMap.get(id);
    return s && isLondonMarket(s.category);
  });

  const summary = {
    startedAt: new Date().toISOString(),
    mode: execute ? 'execute' : 'dry-run',
    reviewTextsDir: REVIEW_TEXTS_DIR,
    scanned: 0,
    rerouted: 0,
    rejected: 0,
    cvDisagreement: 0,
    targetCollision: 0,
    errors: 0,
    byFromShow: {},
    byToShow: {},
    samples: { rerouted: [], rejected: [], cvDisagreement: [], collision: [] },
  };

  for (const showId of targets) {
    const show = showMap.get(showId);
    if (!show) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    if (!fs.existsSync(showDir)) continue;

    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    for (const f of files) {
      if (summary.rerouted >= LIMIT) break;
      const filepath = path.join(showDir, f);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      } catch {
        continue;
      }
      if (data.wrongProduction !== true) continue;
      if (data.routedFromShowId) continue; // already migrated
      summary.scanned++;

      const decision = classifyMarketRouting({
        showId,
        url: data.url,
        outletId: data.outletId,
        publishDate: data.publishDate,
        category: show.category,
        siblingIndex,
      });

      if (decision.action === 'accept') {
        summary.cvDisagreement++;
        if (summary.samples.cvDisagreement.length < 10) {
          summary.samples.cvDisagreement.push({ showId, file: f, url: data.url, publishDate: data.publishDate, outletId: data.outletId });
        }
        continue;
      }

      if (decision.action === 'reject') {
        summary.rejected++;
        if (summary.samples.rejected.length < 10) {
          summary.samples.rejected.push({ showId, file: f, url: data.url, reason: decision.reason });
        }
        continue;
      }

      // Reroute
      const targetShowId = decision.targetShowId;
      const targetDir = path.join(REVIEW_TEXTS_DIR, targetShowId);
      const outletId = data.outletId || f.split('--')[0] || '';
      const criticPart = f.replace(/\.json$/i, '').split('--')[1] || '';

      const existing = findExistingInTarget(targetDir, outletId, criticPart);
      if (existing) {
        summary.targetCollision++;
        if (summary.samples.collision.length < 10) {
          summary.samples.collision.push({ fromShowId: showId, toShowId: targetShowId, file: f, existingInTarget: existing });
        }
        continue;
      }

      summary.rerouted++;
      summary.byFromShow[showId] = (summary.byFromShow[showId] || 0) + 1;
      summary.byToShow[targetShowId] = (summary.byToShow[targetShowId] || 0) + 1;
      if (summary.samples.rerouted.length < 10) {
        summary.samples.rerouted.push({ fromShowId: showId, toShowId: targetShowId, file: f, reason: decision.reason });
      }

      if (!execute) continue;

      try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        // Stamp provenance, clear wrongProduction (flag was correct for prior dir).
        const migrated = {
          ...data,
          showId: targetShowId,
          routedFromShowId: showId,
          routedReason: decision.reason,
          routedAt: new Date().toISOString(),
          wrongProduction: false,
          wrongProductionReason: undefined,
          wrongProductionNote: undefined,
        };
        const targetPath = path.join(targetDir, f);
        safeWriteReview(targetPath, migrated, { merge: false });
        fs.unlinkSync(filepath);
      } catch (e) {
        summary.errors++;
        console.error(`ERROR moving ${showId}/${f} → ${targetShowId}: ${e.message}`);
      }
    }
    if (summary.rerouted >= LIMIT) break;
  }

  summary.finishedAt = new Date().toISOString();

  // Write audit file
  try {
    const auditDir = path.dirname(AUDIT_OUT);
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(AUDIT_OUT, JSON.stringify(summary, null, 2));
  } catch (e) {
    console.error(`Failed to write audit file ${AUDIT_OUT}: ${e.message}`);
  }

  // Console report
  console.log('');
  console.log(`WE Market Misroute Migration — ${summary.mode.toUpperCase()}`);
  console.log(`  scanned (wrongProduction=true): ${summary.scanned}`);
  console.log(`  rerouted: ${summary.rerouted}`);
  console.log(`  rejected (no target): ${summary.rejected}`);
  console.log(`  cv-disagreement (kept): ${summary.cvDisagreement}`);
  console.log(`  target-collisions (skipped): ${summary.targetCollision}`);
  console.log(`  errors: ${summary.errors}`);
  console.log('');
  const topFrom = Object.entries(summary.byFromShow).sort((a,b)=>b[1]-a[1]).slice(0, 15);
  if (topFrom.length) {
    console.log('  Top source shows:');
    for (const [k, v] of topFrom) console.log(`    ${String(v).padStart(4)}  ${k}`);
  }
  const topTo = Object.entries(summary.byToShow).sort((a,b)=>b[1]-a[1]).slice(0, 15);
  if (topTo.length) {
    console.log('  Top target shows:');
    for (const [k, v] of topTo) console.log(`    ${String(v).padStart(4)}  ${k}`);
  }
  console.log('');
  console.log(`  audit written: ${AUDIT_OUT}`);
  if (!execute) {
    console.log('');
    console.log('  Re-run with --execute to actually move files.');
  }
}

main();
