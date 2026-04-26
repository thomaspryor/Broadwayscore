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
const { normalizeOutlet } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const REGISTRY_OUTPUT = path.join(__dirname, '..', 'data', 'critic-registry.json');
const AUDIT_OUTPUT = path.join(__dirname, '..', 'data', 'audit', 'critic-outlet-affinity.json');

// Critics known to work at multiple outlets (not misattributions)
// Verified 2026-04-12: URL domains match secondary outlets for all entries
const KNOWN_FREELANCERS = [
  'charles-isherwood',  // NYT -> WSJ -> Variety
  'adam-feldman',       // Time Out -> TheaterMania -> Variety
  'frank-scheck',      // Hollywood Reporter -> Newsday -> NYSR
  'david-gordon',      // TheaterMania -> NYTG
  'jeremy-gerard',     // Deadline -> Bloomberg -> Variety
  'chris-jones',       // Chicago Tribune -> NY Daily News
  'howard-miller',     // TalkinBroadway + Upstage Downstage blog
  'david-roberts',     // Theatre Reviews Limited + NYTG
  'rex-reed',          // Observer + HuffPost
  'roger-friedman',    // Showbiz411 + Forbes
  'scott-brown',       // Vulture + AMNY
  'robert-gore-langton', // Daily Mail + Express UK (Theatre Record)
  'donna-herman',      // Front Row Center + NYTG
  'joel-benjamin',     // Theater Scene + Stage and Cinema
  'victor-gluck',      // Theater Scene + Stage and Cinema
  'juan-a-ramirez',    // Theatrely + Stage and Cinema
  'steven-ross',       // FrontMezzJunkies + OutBuzz
  'loren-noveck',      // Exeunt Magazine + The Stage
  'amelia-merrill',    // NYTG + Vulture
  'austin-fimmano',    // NYTG + Plays to See
  'joey-sims',         // Theatrely + Broadway Blog
  'andy-propst',       // TheaterMania + American Theater Web
  'jonathan-warman',   // Drama Queen NYC + Gay Socialites
  'kyle-turner',       // NYTG + Medium
  'martin-denton',     // NYTheatre + TheaterMania
];

// Critic-outlet pairs that are legitimate sister-publication or syndication
// affiliations the audit can't infer from data alone (because most reviews of
// the secondary outlet are also wrongProduction-flagged stubs and get skipped
// by the audit). Adding a pair here unions the outletId into the critic's
// `knownOutlets` durably across nightly regenerations, which prevents Guard G
// in scripts/lib/review-file-writer.js from re-flagging new files at that pair.
//
// Format: { criticSlug: ['additional-outlet-id', ...] }
//
// Added 2026-04-26 (Notion 34e637c5-416f-81b8) to fix the operational churn
// where Guard G kept re-flagging Cavendish/sunday-telegraph etc. on every new
// gather, requiring a manual sweep to clear. Verified against the URL domains:
//   sunday-telegraph URLs all on telegraph.co.uk (same publisher)
//   sunday-express URLs all on express.co.uk (same publisher)
//   times-uk URLs on thetimes.com (Cavendish guest pieces verified)
//   timeout-london URLs on timeout.com/london (Saville's longtime employer)
//   thestage URLs on thestage.co.uk (Benedict freelance)
//   standard URLs on standard.co.uk (Tripney freelance)
//   wsj URLs on wsj.com (Anderson — different John Anderson? URL evidence is real)
const KNOWN_MULTI_OUTLET_PAIRS = {
  'dominic-cavendish': ['sunday-telegraph', 'times-uk'],
  'stefan-kyriazis': ['sunday-express'],
  'alice-saville': ['timeout-london'],
  'david-benedict': ['thestage'],
  'natasha-tripney': ['standard'],
  'john-anderson': ['wsj'],
};

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

        const normalizedOutlet = normalizeOutlet(outletId);
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

    // Union manually-curated sister-publication pairs into knownOutlets so Guard G
    // doesn't re-flag legitimate outlet attributions on every new gather.
    const manualPairs = KNOWN_MULTI_OUTLET_PAIRS[criticSlug] || [];
    const augmentedOutlets = [...sortedOutlets];
    for (const extra of manualPairs) {
      if (!augmentedOutlets.includes(extra)) augmentedOutlets.push(extra);
    }

    registry[criticSlug] = {
      displayName: data.displayName,
      primaryOutlet,
      knownOutlets: augmentedOutlets,
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
      lastUpdated: new Date().toISOString(),
      generatedBy: 'scripts/audit-critic-outlets.js',
      totalCritics: registryCount,
      totalReviews: Object.values(registry).reduce((sum, c) => sum + c.totalReviews, 0),
    },
    critics: registry,
  };

  const auditOutput = {
    _meta: {
      description: 'Critic-outlet affinity audit report',
      lastUpdated: new Date().toISOString(),
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
