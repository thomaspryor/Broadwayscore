#!/usr/bin/env node
/**
 * audit-critic-outlets.js
 *
 * Scans all review-texts/ files to build a critic-outlet frequency map.
 * Generates:
 *   - data/critic-registry.json (consumed by validateCriticOutlet)
 *   - data/audit/critic-outlet-affinity.json (detailed report with flags)
 *
 * Usage:
 *   node scripts/audit-critic-outlets.js              # Generate both files
 *   node scripts/audit-critic-outlets.js --report-only # Print report, no file writes
 *   node scripts/audit-critic-outlets.js --json        # Output JSON to stdout
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const REGISTRY_OUTPUT = path.join(__dirname, '..', 'data', 'critic-registry.json');
const AUDIT_OUTPUT = path.join(__dirname, '..', 'data', 'audit', 'critic-outlet-affinity.json');

// Critics known to work at multiple outlets (not misattributions)
const KNOWN_FREELANCERS = [
  'charles-isherwood',  // NYT -> WSJ -> Variety
  'adam-feldman',       // Time Out -> TheaterMania -> Variety
  'frank-scheck',      // Hollywood Reporter -> Newsday -> NYSR
  'david-gordon',      // TheaterMania -> NYTG
  'jeremy-gerard',     // Deadline -> Bloomberg -> Variety
  'chris-jones',       // Chicago Tribune -> NY Daily News
];

const MIN_REVIEWS_FOR_REGISTRY = 3;
const FREELANCER_OUTLET_THRESHOLD = 3;     // 3+ outlets = freelancer
const FREELANCER_DOMINANCE_THRESHOLD = 0.7; // No outlet >70% = freelancer
const SUSPICIOUS_SHARE_THRESHOLD = 0.10;    // <10% share at an outlet = suspicious
const SUSPICIOUS_MIN_REVIEWS = 10;          // Need 10+ total reviews to flag

function slugifyCritic(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function scanReviewTexts() {
  const critics = {};
  let totalFiles = 0;
  let skippedFiles = 0;

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error('No review-texts directory found');
    process.exit(1);
  }

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
  );

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );

    for (const file of files) {
      totalFiles++;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));

        // Skip flagged reviews
        if (data.wrongAttribution || data.wrongProduction || data.wrongShow) {
          skippedFiles++;
          continue;
        }

        const outletId = data.outletId || data.outlet || 'unknown';
        const criticName = data.criticName || 'unknown';

        if (outletId === 'unknown' || criticName === 'unknown') {
          continue;
        }

        const criticSlug = slugifyCritic(criticName);
        if (!criticSlug) continue;

        if (!critics[criticSlug]) {
          critics[criticSlug] = {
            displayName: criticName,
            outletCounts: {},
            totalReviews: 0,
            reviews: [], // For audit report
          };
        }

        // Keep the most "proper" display name (longest, most capitalized)
        if (criticName.length > critics[criticSlug].displayName.length) {
          critics[criticSlug].displayName = criticName;
        }

        const normalizedOutlet = outletId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        critics[criticSlug].outletCounts[normalizedOutlet] = (critics[criticSlug].outletCounts[normalizedOutlet] || 0) + 1;
        critics[criticSlug].totalReviews++;
        critics[criticSlug].reviews.push({
          showId,
          outlet: normalizedOutlet,
          file,
        });
      } catch (e) {
        // Skip unparseable files
      }
    }
  }

  return { critics, totalFiles, skippedFiles };
}

function buildRegistry(rawCritics) {
  const registry = {};
  const flaggedReviews = [];

  for (const [criticSlug, data] of Object.entries(rawCritics)) {
    // Only include critics with enough reviews
    if (data.totalReviews < MIN_REVIEWS_FOR_REGISTRY) continue;

    const outlets = Object.keys(data.outletCounts);
    const sortedOutlets = outlets.sort((a, b) => data.outletCounts[b] - data.outletCounts[a]);
    const primaryOutlet = sortedOutlets[0];
    const primaryShare = data.outletCounts[primaryOutlet] / data.totalReviews;

    // Determine if freelancer
    const isKnownFreelancer = KNOWN_FREELANCERS.includes(criticSlug);
    const isFreelancer = isKnownFreelancer ||
      outlets.length >= FREELANCER_OUTLET_THRESHOLD ||
      primaryShare <= FREELANCER_DOMINANCE_THRESHOLD;

    registry[criticSlug] = {
      displayName: data.displayName,
      primaryOutlet,
      knownOutlets: sortedOutlets,
      totalReviews: data.totalReviews,
      outletCounts: data.outletCounts,
      isFreelancer,
    };

    // Flag suspicious reviews: critic at outlet with <10% share and 10+ total reviews
    if (data.totalReviews >= SUSPICIOUS_MIN_REVIEWS && !isFreelancer) {
      for (const review of data.reviews) {
        const outletShare = data.outletCounts[review.outlet] / data.totalReviews;
        if (outletShare < SUSPICIOUS_SHARE_THRESHOLD) {
          flaggedReviews.push({
            critic: data.displayName,
            criticSlug,
            outlet: review.outlet,
            showId: review.showId,
            file: review.file,
            outletShare: Math.round(outletShare * 100),
            primaryOutlet,
            primaryShare: Math.round(primaryShare * 100),
            totalReviews: data.totalReviews,
          });
        }
      }
    }
  }

  return { registry, flaggedReviews };
}

function main() {
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report-only');
  const jsonOutput = args.includes('--json');

  console.log('Scanning review-texts for critic-outlet affinities...');
  const { critics, totalFiles, skippedFiles } = scanReviewTexts();

  const criticCount = Object.keys(critics).length;
  console.log(`Scanned ${totalFiles} review files (${skippedFiles} skipped)`);
  console.log(`Found ${criticCount} unique critics`);

  const { registry, flaggedReviews } = buildRegistry(critics);
  const registryCount = Object.keys(registry).length;

  console.log(`Registry: ${registryCount} critics with ${MIN_REVIEWS_FOR_REGISTRY}+ reviews`);
  console.log(`Freelancers: ${Object.values(registry).filter(c => c.isFreelancer).length}`);
  console.log(`Flagged reviews: ${flaggedReviews.length}`);

  if (flaggedReviews.length > 0) {
    console.log('\nSuspicious reviews (critic at unexpected outlet):');
    for (const flag of flaggedReviews) {
      console.log(`  ${flag.critic} at ${flag.outlet} (${flag.outletShare}% share) for ${flag.showId}`);
      console.log(`    Primary: ${flag.primaryOutlet} (${flag.primaryShare}%), total: ${flag.totalReviews} reviews`);
    }
  }

  const registryOutput = {
    _meta: {
      description: 'Auto-generated critic-outlet affinity registry',
      lastUpdated: new Date().toISOString().split('T')[0],
      generatedBy: 'scripts/audit-critic-outlets.js',
      totalCritics: registryCount,
      totalReviews: Object.values(registry).reduce((sum, c) => sum + c.totalReviews, 0),
    },
    critics: registry,
  };

  const auditOutput = {
    _meta: {
      description: 'Critic-outlet affinity audit report',
      lastUpdated: new Date().toISOString().split('T')[0],
      generatedBy: 'scripts/audit-critic-outlets.js',
      totalFilesScanned: totalFiles,
      skippedFiles,
      totalCritics: criticCount,
      registryCritics: registryCount,
      flaggedReviews: flaggedReviews.length,
    },
    flaggedReviews,
    freelancers: Object.entries(registry)
      .filter(([, c]) => c.isFreelancer)
      .map(([slug, c]) => ({
        critic: c.displayName,
        slug,
        outlets: c.knownOutlets,
        totalReviews: c.totalReviews,
      })),
  };

  if (jsonOutput) {
    console.log(JSON.stringify({ registry: registryOutput, audit: auditOutput }, null, 2));
    return;
  }

  if (reportOnly) {
    console.log('\n--report-only: No files written');
    return;
  }

  // Write registry
  fs.writeFileSync(REGISTRY_OUTPUT, JSON.stringify(registryOutput, null, 2));
  console.log(`\nWrote ${REGISTRY_OUTPUT}`);

  // Write audit report
  const auditDir = path.dirname(AUDIT_OUTPUT);
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }
  fs.writeFileSync(AUDIT_OUTPUT, JSON.stringify(auditOutput, null, 2));
  console.log(`Wrote ${AUDIT_OUTPUT}`);
}

main();
