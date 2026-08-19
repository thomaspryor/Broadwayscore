#!/usr/bin/env node
/**
 * Tier 2 stale wrongProduction recovery — one-off script (BRO-53).
 *
 * getWrongProductionReasonFromUrl correctly excludes review files whose
 * stored URL is from an old archive (SERP matched a prior production, a
 * tour leg, or a pre-transfer run against the current show). This script
 * picks up where that guard leaves off: for files with a named critic +
 * outlet flagged that way, it targets a SERP search for the CURRENT review
 * by that critic+outlet, and relinks on a qualifying hit.
 *
 * Modeled on scripts/retry-wrong-urls.js (same SERP-retry shape, same
 * critic/outlet/discoverCorrectUrl usage), scoped to wrongProduction files
 * via scripts/lib/review-guards.js's isEligibleForStaleWrongProductionRecovery
 * / resolveStaleWrongProductionRecovery instead of wrongUrl:true.
 *
 * Usage:
 *   node scripts/retry-stale-wrong-production.js [--dry-run] [--max-tier 3] [--limit 50] [--time-budget-min=N]
 *
 * --time-budget-min=N: wall-clock budget in minutes (0 or omitted = unlimited).
 *
 * Env: SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN (at least one required)
 */

const fs = require('fs');
const path = require('path');
const { discoverCorrectUrl } = require('./lib/url-discovery');
const {
  isEligibleForStaleWrongProductionRecovery,
  resolveStaleWrongProductionRecovery,
  shouldRetryUrlDiscovery,
  recordSerpAttempt,
} = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');
const { updateFileUrlWithInvariant } = require('./lib/url-change-invariant');
const { listShowDirs } = require('./lib/list-show-dirs');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

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
  const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));
  const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY || '';
  const brightDataKey = process.env.BRIGHTDATA_TOKEN || '';

  if (!scrapingBeeKey && !brightDataKey) {
    console.error('Need SCRAPINGBEE_API_KEY or BRIGHTDATA_TOKEN');
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;

  let showsById = {};
  const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  for (const s of showsData.shows) showsById[s.id] = s;

  // Find all wrongProduction reviews eligible for Tier 2 recovery, at T1/T2 outlets.
  const candidates = [];
  const showDirs = listShowDirs(REVIEW_TEXTS_DIR);

  for (const showId of showDirs) {
    const show = showsById[showId];
    if (!show) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        if (!isEligibleForStaleWrongProductionRecovery(data, show)) continue;
        const outletId = (data.outletId || '').toLowerCase();
        const outletInfo = outlets[outletId] || {};
        const tier = outletInfo.tier || 99;
        if (tier > opts.maxTier) continue;
        candidates.push({ showId, file, data, show, outletId, tier, outletName: data.outlet || outletId });
      } catch {}
    }
  }

  candidates.sort((a, b) => a.tier - b.tier);

  console.log(`Found ${candidates.length} stale wrongProduction reviews eligible for Tier 2 recovery at T1-T${opts.maxTier} outlets`);
  if (opts.dryRun) console.log('DRY RUN — no files will be modified\n');

  let retried = 0, recovered = 0, notFound = 0;
  let budgetExit = false;
  const capped = candidates.slice(0, opts.limit);

  for (const c of capped) {
    if (timeBudget.exceeded()) {
      budgetExit = true;
      console.log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — ${capped.length - retried} candidates deferred to next run.`);
      break;
    }

    retried++;
    process.stdout.write(`[${retried}/${Math.min(candidates.length, opts.limit)}] T${c.tier} ${c.outletName} / ${c.data.criticName} @ ${c.showId}... `);

    const filePath = path.join(REVIEW_TEXTS_DIR, c.showId, c.file);
    const reviewObj = {
      ...c.data,
      showId: c.showId,
      outletId: c.outletId,
      outlet: c.outletName,
      criticName: c.data.criticName,
      source: 'stale-wrong-production-retry',
      url: c.data.url || '',
      // Transient discriminator for the shared retry/cooldown gate — not
      // persisted to disk as the file's real incompleteReason.
      incompleteReason: 'stale_wrong_production',
      filePath,
    };

    const gate = shouldRetryUrlDiscovery(c.show, reviewObj);
    if (!gate.shouldRetry) {
      console.log(`gated: ${gate.reason}`);
      if (gate.updates && !opts.dryRun) {
        try {
          Object.assign(c.data, gate.updates);
          safeWriteReview(filePath, c.data);
        } catch (e) { /* non-fatal */ }
      }
      continue;
    }

    const result = await discoverCorrectUrl(reviewObj, scrapingBeeKey, {
      brightDataKey,
      log: () => {}, // quiet
    });

    // Advance retry/cooldown state whether the SERP call succeeded or failed.
    if (!opts.dryRun && result !== '__SERP_UNAVAILABLE__') {
      try {
        const attemptUpdates = recordSerpAttempt(c.show, reviewObj);
        if (Object.keys(attemptUpdates).length > 0) {
          Object.assign(c.data, attemptUpdates);
          safeWriteReview(filePath, c.data);
        }
      } catch (e) { /* non-fatal */ }
    }

    const recovery = (result && result !== '__SERP_UNAVAILABLE__')
      ? resolveStaleWrongProductionRecovery(c.data, result, c.show)
      : null;

    if (recovery) {
      console.log(`✓ recovered: ${recovery.url}`);
      recovered++;

      if (!opts.dryRun) {
        // Canonical write chokepoint for a url move (scripts/lib/url-change-invariant.js):
        // re-reads the file fresh, refuses cross-outlet moves, and clears every
        // old-URL-derived field (wrongProduction/wrongProductionReason/
        // contentVerification/fullText/llmScore/publishDate/…) whose value
        // provably rode along from the old record — same chokepoint
        // rediscover-review-urls.js uses, so a rebuild between this write and
        // the next refetch can't admit the OLD production's text as current.
        updateFileUrlWithInvariant(filePath, recovery.url, {
          staleWrongProductionRecovered: true,
          staleWrongProductionRecoveredFrom: recovery.oldUrl,
          staleWrongProductionRecoveredAt: new Date().toISOString(),
          urlDiscoveryMethod: 'stale-wrong-production-serp-retry',
        });
      }
    } else {
      console.log('✗');
      notFound++;
    }

    await sleep(2000);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Retried: ${retried}`);
  console.log(`Recovered: ${recovered}`);
  console.log(`Not found: ${notFound}`);
  if (budgetExit) console.log(`Deferred (time budget): ${capped.length - retried}`);
  if (opts.dryRun) console.log('(dry run — no files changed)');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
