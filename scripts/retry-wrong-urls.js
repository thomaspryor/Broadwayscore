#!/usr/bin/env node
/**
 * Targeted wrongUrl SERP retry — one-off script.
 *
 * Scans review-texts for wrongUrl: true reviews, filters to T1/T2 outlets,
 * and re-SERPs each one using discoverCorrectUrl(). Updates files in-place
 * on success.
 *
 * Usage:
 *   node scripts/retry-wrong-urls.js [--dry-run] [--max-tier 3] [--limit 50]
 *
 * Env: SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN (at least one required)
 */

const fs = require('fs');
const path = require('path');
const { discoverCorrectUrl, OUTLET_DOMAINS } = require('./lib/url-discovery');
const { shouldRetryUrlDiscovery, recordSerpAttempt } = require('./lib/review-guards');
const { normalizeOutlet } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, maxTier: 2, limit: 200 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    if (args[i] === '--max-tier') opts.maxTier = parseInt(args[++i]);
    if (args[i] === '--limit') opts.limit = parseInt(args[++i]);
  }
  return opts;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const opts = parseArgs();
  const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY || '';
  const brightDataKey = process.env.BRIGHTDATA_TOKEN || '';

  if (!scrapingBeeKey && !brightDataKey) {
    console.error('Need SCRAPINGBEE_API_KEY or BRIGHTDATA_TOKEN');
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;

  // Load shows.json for lifecycle SERP gate
  let showsById = null;
  try {
    const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    showsById = {};
    for (const s of showsData.shows) showsById[s.id] = s;
  } catch (e) { /* fall through — gate treats as 'unknown' */ }

  // Find all wrongUrl reviews at T1/T2 outlets
  const candidates = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    const p = path.join(REVIEW_TEXTS_DIR, d);
    return fs.statSync(p).isDirectory();
  });

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        if (data.wrongUrl !== true) continue;
        if (data.wrongShow || data.wrongProduction || data.duplicateOf) continue;
        const outletId = (data.outletId || '').toLowerCase();
        const outletInfo = outlets[outletId] || {};
        const tier = outletInfo.tier || 99;
        if (tier > opts.maxTier) continue;
        candidates.push({ showId, file, data, outletId, tier, outletName: data.outlet || outletId });
      } catch {}
    }
  }

  // Sort by tier (T1 first)
  candidates.sort((a, b) => a.tier - b.tier);

  console.log(`Found ${candidates.length} wrongUrl reviews at T1-T${opts.maxTier} outlets`);
  if (opts.dryRun) console.log('DRY RUN — no files will be modified\n');

  let retried = 0, fixed = 0, failed = 0;

  for (const c of candidates.slice(0, opts.limit)) {
    retried++;
    process.stdout.write(`[${retried}/${Math.min(candidates.length, opts.limit)}] T${c.tier} ${c.outletName} @ ${c.showId}... `);

    const filePath = path.join(REVIEW_TEXTS_DIR, c.showId, c.file);
    const reviewObj = {
      ...c.data,
      showId: c.showId,
      outletId: c.outletId,
      outlet: c.outletName,
      criticName: (c.data.criticName && c.data.criticName !== 'Unknown') ? c.data.criticName : 'Unknown',
      source: 'wrongUrl-retry',
      url: c.data.url || '',
      filePath,
    };

    // Lifecycle SERP gate (defense-in-depth — the wrongUrl filter at L64
    // excludes wrongShow/wrongProduction, so gated files don't reach here
    // today, but defends against future flag-setting changes).
    const showMeta = showsById ? showsById[c.showId] : null;
    const gate = shouldRetryUrlDiscovery(showMeta, reviewObj);
    if (!gate.shouldRetry) {
      console.log(`gated: ${gate.reason}`);
      if (gate.updates && !opts.dryRun) {
        try {
          Object.assign(c.data, gate.updates);
          fs.writeFileSync(filePath, JSON.stringify(c.data, null, 2) + '\n');
        } catch (e) { /* non-fatal */ }
      }
      continue;
    }

    const result = await discoverCorrectUrl(reviewObj, scrapingBeeKey, {
      brightDataKey,
      log: () => {}, // quiet
    });

    // Advance SERP attempt state even on failure
    if (!opts.dryRun && result !== '__SERP_UNAVAILABLE__') {
      try {
        const attemptUpdates = recordSerpAttempt(showMeta, c.data);
        if (Object.keys(attemptUpdates).length > 0) {
          Object.assign(c.data, attemptUpdates);
          fs.writeFileSync(filePath, JSON.stringify(c.data, null, 2) + '\n');
        }
      } catch (e) { /* non-fatal */ }
    }

    if (result && result !== '__SERP_UNAVAILABLE__' && result !== c.data.url) {
      console.log(`✓ ${result}`);
      fixed++;

      if (!opts.dryRun) {
        const filePath = path.join(REVIEW_TEXTS_DIR, c.showId, c.file);
        c.data.urlCorrectedFrom = c.data.url;
        c.data.urlCorrectedReason = 'wrongUrl targeted SERP retry';
        c.data.url = result;
        c.data.urlDiscoveredAt = new Date().toISOString();
        c.data.urlDiscoveryMethod = 'wrongUrl-serp-retry';
        delete c.data.wrongUrl;
        delete c.data.wrongUrlReason;
        if (c.data.wrongFullText) delete c.data.wrongFullText;
        c.data.needsRefetch = true;
        fs.writeFileSync(filePath, JSON.stringify(c.data, null, 2) + '\n');
      }
    } else {
      console.log('✗');
      failed++;
    }

    await sleep(2000);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Retried: ${retried}`);
  console.log(`Fixed: ${fixed}`);
  console.log(`Not found: ${failed}`);
  if (opts.dryRun) console.log('(dry run — no files changed)');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
