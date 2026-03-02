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
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeUrl,
  mergeReviews,
  getOutletTier,
  loadOutletRegistry,
} = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');

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
          // The outlet ID in the file is now stale — normalizeOutlet maps it to a different canonical
          realiasedCount++;
          if (realiasedCount <= 20) {
            console.log(`  [re-aliased] ${showId}/${file}: ${currentOutletId} → ${canonicalId}`);
          }
          if (apply) {
            data.outletId = canonicalId;
            data.outlet = data.outlet; // Keep display name as-is
            fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n');
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

run();
