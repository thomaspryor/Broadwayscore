#!/usr/bin/env node
/**
 * audit-multiauthor-attributions.js
 *
 * For each outlet now flagged `multiAuthor: true`, scan reviews.json for
 * reviews currently attributed to the registry's `defaultCritic`. Those
 * attributions are SUSPECT — at the moment the rebuild ran, the source
 * file had `criticName: "Unknown"`/missing and the registry's defaultCritic
 * got applied. With the new `shouldFillDefaultCritic` predicate honoring
 * `multiAuthor: true` (Broadwayscore 35f3b5a142, broadway-scorecard-data
 * c407a88b), this no longer happens for NEW scoring. But existing reviews
 * still carry the wrong critic name until each is reviewed.
 *
 * Output: data/audit/multiauthor-attribution-candidates.jsonl
 * One line per suspect review. NOT auto-applied — humans (or follow-up
 * scripts gated on per-row verification) decide whether to:
 *   - Reset criticName to "Unknown" (true byline lost, can't recover)
 *   - Replace with the actual byline (look up source file / re-scrape)
 *   - Keep the default (false positive — the review really is by them)
 *
 * Usage:
 *   node scripts/audit-multiauthor-attributions.js
 *   node scripts/audit-multiauthor-attributions.js --json  (machine-readable to stdout)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'audit', 'multiauthor-attribution-candidates.jsonl');

function normalize(s) {
  return (s || '').toLowerCase().trim();
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')).outlets;
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf-8')).reviews;

  // Build the multi-author outlet map: { outletId: defaultCritic }
  const multiAuthorOutlets = new Map();
  for (const [outletId, entry] of Object.entries(registry)) {
    if (entry.multiAuthor === true && entry.defaultCritic) {
      multiAuthorOutlets.set(outletId, entry.defaultCritic);
    }
  }

  if (multiAuthorOutlets.size === 0) {
    console.log('No outlets have multiAuthor:true set. Nothing to audit.');
    return;
  }

  const suspects = [];
  for (const r of reviews) {
    if (!r.outletId) continue;
    const expectedDefault = multiAuthorOutlets.get(r.outletId);
    if (!expectedDefault) continue;
    if (normalize(r.criticName) !== normalize(expectedDefault)) continue;
    suspects.push({
      showId: r.showId,
      outletId: r.outletId,
      outlet: r.outlet,
      criticName: r.criticName,
      url: r.url || null,
      publishDate: r.publishDate || null,
      assignedScore: r.assignedScore,
      bucket: r.bucket,
      scoreSource: r.scoreSource,
      reason: `outlet now multiAuthor:true; default critic "${expectedDefault}" likely auto-filled by old rebuild path`,
    });
  }

  // Sort by outletId then by showId for predictable diff
  suspects.sort((a, b) => {
    if (a.outletId !== b.outletId) return a.outletId.localeCompare(b.outletId);
    return a.showId.localeCompare(b.showId);
  });

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, suspects.map((s) => JSON.stringify(s)).join('\n') + '\n');

  if (asJson) {
    console.log(JSON.stringify({ count: suspects.length, suspects }, null, 2));
    return;
  }

  console.log(`Multi-author outlets: ${multiAuthorOutlets.size}`);
  console.log(`Suspect attributions: ${suspects.length}\n`);

  const byOutlet = new Map();
  for (const s of suspects) {
    if (!byOutlet.has(s.outletId)) byOutlet.set(s.outletId, []);
    byOutlet.get(s.outletId).push(s);
  }
  for (const [outletId, list] of byOutlet) {
    console.log(`${outletId} (default="${multiAuthorOutlets.get(outletId)}") — ${list.length} suspects`);
    for (const s of list) {
      console.log(`  ${s.showId} | ${s.publishDate || 'no-date'} | score=${s.assignedScore} | ${s.url || 'no-url'}`);
    }
    console.log('');
  }

  console.log(`Output: ${path.relative(ROOT, OUTPUT_PATH)}`);
  console.log('\nNOT auto-applied. Manual triage required:');
  console.log('  - Reset to "Unknown" if true byline is unrecoverable');
  console.log('  - Replace with actual byline (look up source file / re-scrape)');
  console.log('  - Keep default if it really is that critic (false positive)');
}

main();
