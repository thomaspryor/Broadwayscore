#!/usr/bin/env node
/**
 * Audit text quality across all reviews
 *
 * Two threshold bands:
 *   - MONITOR (default): tight bands. Flaps as the corpus drifts every ~30 min
 *     via the rebuild bots, so this is MONITORING — it runs in the non-blocking
 *     check-corpus-drift.yml workflow and surfaces in the daily digest. It must
 *     NOT live in the blocking test.yml gate (that's what made main red every
 *     couple hours for non-code reasons).
 *   - GATE (--gate): wide catastrophe bands (~5x looser). Trips ONLY on a
 *     genuine quality collapse — e.g. a scraper-cookie expiry that floods the
 *     corpus with truncated/unknown bodies (the failure the row-count floors in
 *     test.yml structurally cannot catch, since they count rows not quality).
 *     This is the one quality check that STAYS blocking in test.yml.
 *
 * Usage:
 *   node scripts/audit-text-quality.js           # MONITOR band (digest)
 *   node scripts/audit-text-quality.js --gate    # GATE band (blocking catastrophe floor)
 *
 * Exit codes:
 *   0 = Pass (active band's thresholds met)
 *   1 = Fail (active band's thresholds not met)
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = 'data/review-texts';

// MONITOR band — tight, drift-sensitive. Surfaced via digest, never blocks main.
const THRESHOLDS = {
  minFullPercent: 25,       // At least 25% should be "full" quality (lowered for historical expansion)
  maxTruncatedPercent: 65,  // No more than 65% should be truncated (raised for historical expansion)
  maxUnknownPercent: 5,     // No more than 5% should have unknown quality
};

// GATE band — wide catastrophe floor. Stays blocking in test.yml. Drift-tolerant
// (won't flap on normal corpus movement) but trips on a real collapse: a
// truncation/unknown flood from a broken scraper. Numbers are ~5x looser than
// MONITOR so normal drift never reds the trunk.
const GATE_THRESHOLDS = {
  minFullPercent: 10,       // catastrophe if <10% full (monitor warns at 25%)
  maxTruncatedPercent: 85,  // catastrophe if >85% truncated (monitor warns at 65%)
  maxUnknownPercent: 25,    // catastrophe if >25% unknown (monitor warns at 5%)
};

const GATE_MODE = process.argv.includes('--gate');
const ACTIVE = GATE_MODE ? GATE_THRESHOLDS : THRESHOLDS;

// Map contentTier values to textQuality equivalents
function resolveQuality(data) {
  // Prefer textQuality (more granular, set by collect-review-texts.js)
  if (data.textQuality) return data.textQuality;
  // Fall back to contentTier (set by classifyContentTier/backfill)
  if (data.contentTier) {
    switch (data.contentTier) {
      case 'complete': return 'full';
      case 'full': return 'full';
      case 'truncated': case 'needs-rescrape': case 'invalid': return 'truncated';
      case 'excerpt': return 'excerpt';
      case 'stub': return 'excerpt';
      default: return 'unknown';
    }
  }
  return 'unknown';
}

function auditTextQuality() {
  const stats = {
    total: 0,
    hasFullText: 0,
    byQuality: {},
    truncationSignals: {},
  };

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const stat = fs.lstatSync(path.join(REVIEW_TEXTS_DIR, f));
      return stat.isDirectory() && !stat.isSymbolicLink();
    });

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        stats.total++;

        if (data.fullText) {
          stats.hasFullText++;
          const quality = resolveQuality(data);
          stats.byQuality[quality] = (stats.byQuality[quality] || 0) + 1;

          if (data.truncationSignals) {
            for (const signal of data.truncationSignals) {
              stats.truncationSignals[signal] = (stats.truncationSignals[signal] || 0) + 1;
            }
          }
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  // Calculate percentages
  const fullCount = stats.byQuality.full || 0;
  const truncatedCount = stats.byQuality.truncated || 0;
  const unknownCount = stats.byQuality.unknown || 0;
  const total = stats.hasFullText || 1;

  const fullPercent = (fullCount / total * 100).toFixed(1);
  const truncatedPercent = (truncatedCount / total * 100).toFixed(1);
  const unknownPercent = (unknownCount / total * 100).toFixed(1);

  // Output results
  console.log('=== TEXT QUALITY AUDIT ===\n');
  console.log(`Total reviews: ${stats.total}`);
  console.log(`Has fullText: ${stats.hasFullText}\n`);

  console.log('--- Quality Breakdown ---');
  Object.entries(stats.byQuality)
    .sort((a, b) => b[1] - a[1])
    .forEach(([quality, count]) => {
      const pct = (count / total * 100).toFixed(1);
      console.log(`  ${quality}: ${count} (${pct}%)`);
    });

  console.log('\n--- Truncation Signals ---');
  Object.entries(stats.truncationSignals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([signal, count]) => {
      console.log(`  ${signal}: ${count}`);
    });

  // Check thresholds
  console.log(`\n--- Threshold Checks (${GATE_MODE ? 'GATE / catastrophe floor' : 'MONITOR / drift'} band) ---`);
  const failures = [];

  if (parseFloat(fullPercent) < ACTIVE.minFullPercent) {
    failures.push(`Full reviews ${fullPercent}% < ${ACTIVE.minFullPercent}% threshold`);
    console.log(`  ❌ Full: ${fullPercent}% (min: ${ACTIVE.minFullPercent}%)`);
  } else {
    console.log(`  ✅ Full: ${fullPercent}% (min: ${ACTIVE.minFullPercent}%)`);
  }

  if (parseFloat(truncatedPercent) > ACTIVE.maxTruncatedPercent) {
    failures.push(`Truncated reviews ${truncatedPercent}% > ${ACTIVE.maxTruncatedPercent}% threshold`);
    console.log(`  ❌ Truncated: ${truncatedPercent}% (max: ${ACTIVE.maxTruncatedPercent}%)`);
  } else {
    console.log(`  ✅ Truncated: ${truncatedPercent}% (max: ${ACTIVE.maxTruncatedPercent}%)`);
  }

  if (parseFloat(unknownPercent) > ACTIVE.maxUnknownPercent) {
    failures.push(`Unknown quality ${unknownPercent}% > ${ACTIVE.maxUnknownPercent}% threshold`);
    console.log(`  ❌ Unknown: ${unknownPercent}% (max: ${ACTIVE.maxUnknownPercent}%)`);
  } else {
    console.log(`  ✅ Unknown: ${unknownPercent}% (max: ${ACTIVE.maxUnknownPercent}%)`);
  }

  // Exit with appropriate code
  if (failures.length > 0) {
    console.log('\n❌ AUDIT FAILED:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('\n✅ AUDIT PASSED');
    process.exit(0);
  }
}

auditTextQuality();
