#!/usr/bin/env node
/**
 * Cleanup Phantom Outlet Duplicates
 *
 * Finds and merges review files that have the same URL but different outlet IDs
 * within the same show directory. This happens when aggregators (BWW, Show Score)
 * use variant outlet names that don't match our canonical IDs.
 *
 * Examples:
 *   mandell-new-york-theater--unknown.json  →  nyt-theater--jonathan-mandell.json
 *   new-york--sara-holdren.json             →  vulture--sara-holdren.json
 *   bergen-record--robert-kahn.json         →  northjerseycom--robert-kahn.json
 *
 * Usage:
 *   node scripts/cleanup-phantom-outlets.js          # Dry run (default)
 *   node scripts/cleanup-phantom-outlets.js --apply   # Actually merge and delete
 *   node scripts/cleanup-phantom-outlets.js --audit-phantoms  # Audit all non-registry outlets
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeUrl,
  mergeReviews,
  getOutletTier,
  loadOutletRegistry,
  levenshteinDistance,
} = require('./lib/review-normalization');
const { safeWriteReview, shouldSkipLockedEnrichment } = require('./lib/review-write-guard');

let lockedSkipCount = 0;

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit');
const apply = process.argv.includes('--apply');
const auditPhantoms = process.argv.includes('--audit-phantoms');

function isCanonicalOutlet(outletId) {
  const registry = loadOutletRegistry();
  return !!(registry && registry.outlets && registry.outlets[outletId]);
}

function run() {
  console.log(`\n=== Phantom Outlet Cleanup ${apply ? '(APPLY MODE)' : '(DRY RUN)'} ===\n`);

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
  });

  let totalDuplicates = 0;
  let totalMerged = 0;
  let totalDeleted = 0;
  const phantomOutlets = new Map(); // phantom outletId → count

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    // Group files by normalized URL
    const urlGroups = new Map();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        if (!data.url) continue;
        const normUrl = normalizeUrl(data.url);
        if (!normUrl) continue;
        if (!urlGroups.has(normUrl)) urlGroups.set(normUrl, []);
        urlGroups.get(normUrl).push({ file, data });
      } catch {
        // Skip unparseable files
      }
    }

    // Process groups with duplicates — only merge when outlet IDs differ (phantom outlets)
    for (const [url, group] of urlGroups) {
      if (group.length < 2) continue;

      // Group by normalized outlet ID to find cross-outlet duplicates
      const byOutlet = new Map();
      for (const entry of group) {
        const outletId = normalizeOutlet(entry.data.outlet || entry.data.outletId);
        if (!byOutlet.has(outletId)) byOutlet.set(outletId, []);
        byOutlet.get(outletId).push(entry);
      }

      // Only process if there are 2+ different outlet IDs sharing the same URL
      if (byOutlet.size < 2) continue;

      // Sort outlet groups: canonical outlets first, then by content richness
      const outletGroups = [...byOutlet.entries()].sort((a, b) => {
        const aCanonical = isCanonicalOutlet(a[0]) ? 1 : 0;
        const bCanonical = isCanonicalOutlet(b[0]) ? 1 : 0;
        if (bCanonical !== aCanonical) return bCanonical - aCanonical;

        // Prefer group with fullText
        const aHasText = a[1].some(e => e.data.fullText) ? 1 : 0;
        const bHasText = b[1].some(e => e.data.fullText) ? 1 : 0;
        if (bHasText !== aHasText) return bHasText - aHasText;

        // Prefer higher tier outlet
        const aTier = getOutletTier(a[0]) || 4;
        const bTier = getOutletTier(b[0]) || 4;
        return aTier - bTier;
      });

      // First outlet group is canonical; all others are phantoms to merge/delete
      const canonicalEntries = outletGroups[0][1];
      // Pick the best file from the canonical outlet group
      canonicalEntries.sort((a, b) => {
        const aHasText = a.data.fullText ? 1 : 0;
        const bHasText = b.data.fullText ? 1 : 0;
        if (bHasText !== aHasText) return bHasText - aHasText;
        const aHasScore = a.data.assignedScore ? 1 : 0;
        const bHasScore = b.data.assignedScore ? 1 : 0;
        return bHasScore - aHasScore;
      });
      const canonical = canonicalEntries[0];

      for (let i = 1; i < outletGroups.length; i++) {
        for (const phantom of outletGroups[i][1]) {
          totalDuplicates++;
          const phantomOutletId = normalizeOutlet(phantom.data.outlet || phantom.data.outletId);
          phantomOutlets.set(phantomOutletId, (phantomOutlets.get(phantomOutletId) || 0) + 1);

          console.log(`  ${showId}: ${phantom.file} → ${canonical.file}`);
          console.log(`    Phantom: ${phantomOutletId} | Canonical: ${normalizeOutlet(canonical.data.outlet || canonical.data.outletId)}`);

          if (apply) {
            // TOPOLOGY: merge-then-unlink does not honor _locked — see S1-T5.
            // Stop-gap (ship-check P0 2026-04-26): refuse the merge if EITHER side
            // is locked. mergeReviews would otherwise blend phantom into a locked
            // canonical via raw write, bypassing lockedOverride. Real fix lands
            // with safeRenameReview/safeUnlinkReview in the topology follow-up card.
            if (canonical.data._locked === true || phantom.data._locked === true) {
              lockedSkipCount++;
              console.log(`  [LOCKED-SKIP] ${showId}: refusing merge — ${canonical.data._locked ? 'canonical' : 'phantom'} is locked`);
            } else {
              const merged = mergeReviews(canonical.data, phantom.data);
              fs.writeFileSync(path.join(showDir, canonical.file), JSON.stringify(merged, null, 2) + '\n');
              fs.unlinkSync(path.join(showDir, phantom.file));
              totalMerged++;
              totalDeleted++;
            }
          }
        }
      }
    }
  }

  // Also find files where the outlet has been re-aliased but no URL overlap exists
  // These are phantom outlet files that normalizeOutlet() NOW maps to a different canonical ID
  let realiasedCount = 0;
  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        const currentOutletId = data.outletId;
        if (!currentOutletId) continue;
        const canonicalId = normalizeOutlet(currentOutletId);
        if (canonicalId !== currentOutletId) {
          // outletId is non-PROTECTED — lockedOverride alone won't block it.
          // Skip the entire re-aliasing on locked files: a manually-canonical
          // record's outlet must not be silently rewritten by a registry
          // alias change.
          const skip = shouldSkipLockedEnrichment(data);
          if (skip.skip) { lockedSkipCount++; continue; }

          // The outlet ID in the file is now stale — normalizeOutlet maps it to a different canonical
          realiasedCount++;
          if (realiasedCount <= 20) {
            console.log(`  [re-aliased] ${showId}/${file}: ${currentOutletId} → ${canonicalId}`);
          }
          if (apply) {
            data.outletId = canonicalId;
            data.outlet = data.outlet; // Keep display name as-is
            const r = safeWriteReview(path.join(showDir, file), data);
            if (r.lockedSkipped) lockedSkipCount++;
          }
        }
      } catch {
        // Skip
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`URL-duplicate groups found: ${totalDuplicates}`);
  if (apply) {
    console.log(`Files merged: ${totalMerged}`);
    console.log(`Files deleted: ${totalDeleted}`);
  }
  console.log(`Re-aliased outlet IDs: ${realiasedCount}`);

  if (phantomOutlets.size > 0) {
    console.log(`\nTop phantom outlet IDs:`);
    const sorted = [...phantomOutlets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [id, count] of sorted) {
      console.log(`  ${id}: ${count} duplicates`);
    }
  }

  if (!apply && (totalDuplicates > 0 || realiasedCount > 0)) {
    console.log(`\nRun with --apply to execute changes.`);
  }
}

function auditPhantomOutlets() {
  console.log('\n=== Phantom Outlet Audit ===\n');

  const registry = loadOutletRegistry();
  if (!registry || !registry.outlets) {
    console.error('ERROR: outlet-registry.json not found');
    process.exit(1);
  }

  const registryNames = new Map(); // lowercase displayName → outletId
  for (const [id, data] of Object.entries(registry.outlets)) {
    registryNames.set((data.displayName || id).toLowerCase(), id);
  }

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
  });

  // Scan all files, build outlet map
  const outletMap = new Map(); // outletId → { count, showIds, hasFullText }
  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        const outletId = data.outletId;
        if (!outletId) continue;
        if (!outletMap.has(outletId)) {
          outletMap.set(outletId, { count: 0, showIds: new Set(), hasFullText: false });
        }
        const entry = outletMap.get(outletId);
        entry.count++;
        entry.showIds.add(showId);
        if (data.fullText) entry.hasFullText = true;
      } catch { /* skip */ }
    }
  }

  // Classify each outlet
  const classifications = { registered: [], staleAlias: [], probablePhantom: [], legitimateSmall: [] };
  for (const [outletId, info] of outletMap) {
    if (registry.outlets[outletId]) {
      classifications.registered.push({ outletId, ...info });
    } else if (normalizeOutlet(outletId) !== outletId) {
      classifications.staleAlias.push({ outletId, canonicalId: normalizeOutlet(outletId), ...info });
    } else if (info.count <= 2) {
      // Try fuzzy match
      let bestMatch = null;
      let bestDist = Infinity;
      for (const [name, id] of registryNames) {
        const dist = levenshteinDistance(outletId, name);
        if (dist < bestDist && dist <= 3) {
          bestDist = dist;
          bestMatch = { id, name, dist };
        }
      }
      classifications.probablePhantom.push({ outletId, ...info, fuzzyMatch: bestMatch });
    } else {
      classifications.legitimateSmall.push({ outletId, ...info });
    }
  }

  // Output summary
  console.log(`Total unique outlet IDs: ${outletMap.size}`);
  console.log(`  Registered: ${classifications.registered.length}`);
  console.log(`  Stale aliases (re-aliasable): ${classifications.staleAlias.length}`);
  console.log(`  Probable phantoms (≤2 reviews): ${classifications.probablePhantom.length}`);
  console.log(`  Legitimate small (3+ reviews, not in registry): ${classifications.legitimateSmall.length}`);

  if (classifications.staleAlias.length > 0) {
    console.log('\n--- Stale Aliases (fixable by existing cleanup) ---');
    for (const e of classifications.staleAlias.slice(0, 20)) {
      console.log(`  ${e.outletId} → ${e.canonicalId} (${e.count} files, ${e.showIds.size} shows)`);
    }
    if (classifications.staleAlias.length > 20) console.log(`  ... and ${classifications.staleAlias.length - 20} more`);
  }

  if (classifications.probablePhantom.length > 0) {
    console.log('\n--- Probable Phantoms (≤2 reviews) ---');
    const sorted = classifications.probablePhantom.sort((a, b) => b.count - a.count);
    for (const e of sorted.slice(0, 30)) {
      const match = e.fuzzyMatch ? ` ~> ${e.fuzzyMatch.id} (dist=${e.fuzzyMatch.dist})` : '';
      console.log(`  ${e.outletId}: ${e.count} files, ${e.showIds.size} shows${match}`);
    }
    if (sorted.length > 30) console.log(`  ... and ${sorted.length - 30} more`);
  }

  if (classifications.legitimateSmall.length > 0) {
    console.log('\n--- Legitimate Small (3+ reviews, consider adding to registry) ---');
    const sorted = classifications.legitimateSmall.sort((a, b) => b.count - a.count);
    for (const e of sorted.slice(0, 20)) {
      console.log(`  ${e.outletId}: ${e.count} files, ${e.showIds.size} shows${e.hasFullText ? ' [has fullText]' : ''}`);
    }
    if (sorted.length > 20) console.log(`  ... and ${sorted.length - 20} more`);
  }

  // Save report
  const report = {
    _meta: { generatedAt: new Date().toISOString(), totalOutlets: outletMap.size },
    registered: classifications.registered.length,
    staleAliases: classifications.staleAlias.map(e => ({ outletId: e.outletId, canonicalId: e.canonicalId, count: e.count })),
    probablePhantoms: classifications.probablePhantom.map(e => ({
      outletId: e.outletId, count: e.count, shows: e.showIds.size,
      fuzzyMatch: e.fuzzyMatch ? e.fuzzyMatch.id : null,
    })),
    legitimateSmall: classifications.legitimateSmall.map(e => ({
      outletId: e.outletId, count: e.count, shows: e.showIds.size, hasFullText: e.hasFullText,
    })),
  };
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIT_DIR, 'phantom-outlets-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\nReport saved to data/audit/phantom-outlets-report.json`);
}

if (auditPhantoms) {
  auditPhantomOutlets();
} else {
  run();
}

console.log(`[LOCKED-SKIP-COUNT] cleanup-phantom-outlets: ${lockedSkipCount}`);
