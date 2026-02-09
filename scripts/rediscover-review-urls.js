#!/usr/bin/env node
/**
 * URL Rediscovery Script
 *
 * Pre-processes review files to fix broken/moved URLs before the collection
 * pipeline runs. Three phases:
 *   Phase 1: Protocol upgrades (http→https) + domain redirects (FREE, instant)
 *   Phase 2: HTTP redirect detection via HEAD requests (FREE, ~500ms/URL)
 *   Phase 3: Google SERP search for 404 URLs via ScrapingBee (~$0.02/search)
 *
 * Usage:
 *   node scripts/rediscover-review-urls.js [options]
 *     --dry-run        Show changes without writing
 *     --phase=1|2|3    Run specific phase (default: all)
 *     --limit=N        Max reviews per phase (default: 500 P2, 200 P3)
 *     --show=SLUG      Only process specific show
 *     --domain=X       Only process specific domain
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { OUTLET_DOMAINS, DOMAIN_REDIRECTS, discoverCorrectUrl } = require('./lib/url-discovery');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
};

const CONFIG = {
  dryRun: args.includes('--dry-run'),
  phase: getArg('phase') ? parseInt(getArg('phase')) : null, // null = all
  limit: getArg('limit') ? parseInt(getArg('limit')) : null,
  showFilter: getArg('show') || null,
  domainFilter: getArg('domain') || null,
  reviewTextsDir: path.join(process.cwd(), 'data/review-texts'),
  failedFetchesPath: path.join(process.cwd(), 'data/review-texts/failed-fetches.json'),
  scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '',
  isCI: !!process.env.CI || !!process.env.GITHUB_ACTIONS,
  phase2Limit: 500,
  phase3Limit: 200,
  phase2Delay: 500,  // ms between HTTP requests
  phase3Delay: 1000, // ms between SERP calls
};

// Override limits if provided
if (CONFIG.limit) {
  CONFIG.phase2Limit = CONFIG.limit;
  CONFIG.phase3Limit = CONFIG.limit;
}

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------

const stats = {
  phase1: { scanned: 0, protocolUpgrades: 0, domainRedirects: 0, skipped: 0 },
  phase2: { scanned: 0, redirectsFound: 0, urlsOk: 0, dead404: 0, paywall: 0, errors: 0, skipped: 0 },
  phase3: { scanned: 0, found: 0, notFound: 0, errors: 0, skipped: 0 },
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load all review files that are candidates for URL rediscovery.
 * Filters: missing fullText, has URL, not flagged, not already processed.
 */
function loadCandidates() {
  const candidates = [];
  const dirs = fs.readdirSync(CONFIG.reviewTextsDir).filter(d => {
    try { return fs.statSync(path.join(CONFIG.reviewTextsDir, d)).isDirectory(); } catch (e) { return false; }
  });

  for (const dir of dirs) {
    if (CONFIG.showFilter && dir !== CONFIG.showFilter) continue;

    const showDir = path.join(CONFIG.reviewTextsDir, dir);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const filePath = path.join(showDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip flagged reviews
        if (data.wrongProduction || data.wrongShow || data.wrongAttribution || data.isRoundupArticle) continue;

        // Only process reviews missing fullText
        if (data.fullText && data.fullText.length > 100) continue;

        // Must have a URL
        if (!data.url) continue;

        // Skip already processed by rediscovery
        if (data.urlDiscoveryMethod) continue;

        // Domain filter
        if (CONFIG.domainFilter) {
          try {
            const domain = new URL(data.url).hostname.replace(/^www\./, '');
            if (!domain.includes(CONFIG.domainFilter)) continue;
          } catch (e) { continue; }
        }

        candidates.push({
          filePath,
          reviewId: `${dir}/${file}`,
          showId: dir,
          outletId: data.outletId || file.split('--')[0],
          outlet: data.outlet,
          url: data.url,
          fetchAttempts: data.fetchAttempts || [],
          data,
        });
      } catch (e) {
        // Skip unreadable files
      }
    }
  }

  return candidates;
}

/**
 * Update a review file with new URL and metadata.
 * Does NOT clear fetchAttempts (per revised plan).
 */
function updateReviewUrl(candidate, newUrl, method) {
  if (CONFIG.dryRun) {
    console.log(`  [DRY RUN] Would update ${candidate.reviewId}: ${candidate.url} → ${newUrl} (${method})`);
    return;
  }

  const data = candidate.data;
  data.previousUrl = candidate.url;
  data.url = newUrl;
  data.urlDiscoveredAt = new Date().toISOString();
  data.urlDiscoveryMethod = method;

  fs.writeFileSync(candidate.filePath, JSON.stringify(data, null, 2));

  // Clear from failed-fetches.json if present
  clearFromFailedFetches(candidate.reviewId);
}

/**
 * Remove a review from failed-fetches.json.
 */
function clearFromFailedFetches(reviewId) {
  if (!fs.existsSync(CONFIG.failedFetchesPath)) return;
  try {
    const entries = JSON.parse(fs.readFileSync(CONFIG.failedFetchesPath, 'utf8'));
    const filtered = entries.filter(f => f.reviewId !== reviewId);
    if (filtered.length < entries.length) {
      fs.writeFileSync(CONFIG.failedFetchesPath, JSON.stringify(filtered, null, 2));
    }
  } catch (e) {
    // Non-fatal
  }
}

/**
 * Git checkpoint (CI only) — commit and push with retry.
 */
function gitCheckpoint(message) {
  if (!CONFIG.isCI || CONFIG.dryRun) return;

  try {
    execSync('git add data/review-texts/', { stdio: 'pipe' });

    const status = execSync('git diff --staged --quiet || echo "changes"', {
      encoding: 'utf8', stdio: 'pipe'
    }).trim();

    if (status !== 'changes') return;

    try {
      execSync('git config user.email "action@github.com"', { stdio: 'pipe' });
      execSync('git config user.name "GitHub Action"', { stdio: 'pipe' });
    } catch (e) {}

    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });

    // Push with retry + rebase
    let pushed = false;
    for (let attempt = 1; attempt <= 5 && !pushed; attempt++) {
      try {
        execSync('git fetch origin main', { stdio: 'pipe' });
        try {
          execSync('git rebase origin/main', { stdio: 'pipe' });
        } catch (rebaseErr) {
          execSync('git checkout --ours data/', { stdio: 'pipe' });
          execSync('git add data/', { stdio: 'pipe' });
          try {
            execSync('git rebase --continue', { stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } });
          } catch (e) {
            try { execSync('git rebase --abort', { stdio: 'pipe' }); } catch (e2) {}
            execSync('git merge origin/main -X ours --no-edit', { stdio: 'pipe' });
          }
        }
        execSync('git push origin HEAD:main', { stdio: 'pipe' });
        pushed = true;
      } catch (e) {
        console.log(`  Push attempt ${attempt}/5 failed: ${e.message}`);
        if (attempt < 5) {
          const delay = attempt * 3000;
          execSync(`sleep ${delay / 1000}`, { stdio: 'pipe' });
        }
      }
    }

    if (pushed) {
      console.log(`  ✓ ${message}`);
    } else {
      console.error('  ✗ Git push failed after 5 attempts');
    }
  } catch (e) {
    console.error(`  ✗ Git checkpoint failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// PHASE 1: Protocol + Domain Transforms
// ---------------------------------------------------------------------------

function runPhase1(candidates) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('PHASE 1: Protocol Upgrades + Domain Redirects');
  console.log('═══════════════════════════════════════════════════════════\n');

  let updated = 0;

  for (const c of candidates) {
    stats.phase1.scanned++;

    let newUrl = c.url;
    let method = null;

    // Protocol upgrade: http → https
    if (newUrl.startsWith('http://')) {
      newUrl = newUrl.replace('http://', 'https://');
      method = 'protocol-upgrade';
    }

    // Domain redirects
    try {
      const urlObj = new URL(newUrl);
      const host = urlObj.hostname;
      if (DOMAIN_REDIRECTS[host]) {
        urlObj.hostname = DOMAIN_REDIRECTS[host];
        newUrl = urlObj.toString();
        method = 'domain-redirect';
      }
    } catch (e) {}

    if (newUrl === c.url) {
      stats.phase1.skipped++;
      continue;
    }

    if (method === 'protocol-upgrade') stats.phase1.protocolUpgrades++;
    if (method === 'domain-redirect') stats.phase1.domainRedirects++;

    updateReviewUrl(c, newUrl, method);
    updated++;

    // Checkpoint every 100 in CI
    if (CONFIG.isCI && updated > 0 && updated % 100 === 0) {
      gitCheckpoint(`chore: URL rediscovery Phase 1 checkpoint (${updated} URLs fixed)`);
    }
  }

  console.log(`\nPhase 1 complete:`);
  console.log(`  Scanned: ${stats.phase1.scanned}`);
  console.log(`  Protocol upgrades: ${stats.phase1.protocolUpgrades}`);
  console.log(`  Domain redirects: ${stats.phase1.domainRedirects}`);
  console.log(`  Skipped (no change needed): ${stats.phase1.skipped}`);

  if (CONFIG.isCI && updated > 0) {
    gitCheckpoint(`chore: URL rediscovery Phase 1 complete (${stats.phase1.protocolUpgrades} protocol, ${stats.phase1.domainRedirects} domain)`);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// PHASE 2: HTTP Redirect Detection
// ---------------------------------------------------------------------------

async function runPhase2(candidates) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('PHASE 2: HTTP Redirect Detection');
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Limit: ${CONFIG.phase2Limit} URLs\n`);

  // Filter to only https URLs (Phase 1 should have upgraded them)
  // Also skip reviews already processed by Phase 1 in this run
  const phase2Candidates = candidates.filter(c => {
    // Re-read the file to get latest state (Phase 1 may have updated it)
    try {
      const fresh = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
      if (fresh.urlDiscoveryMethod) return false; // Already processed
      if (!fresh.url) return false;
      c.url = fresh.url; // Use updated URL
      c.data = fresh;
      return true;
    } catch (e) { return false; }
  });

  console.log(`  Eligible: ${phase2Candidates.length} reviews\n`);

  let processed = 0;

  for (const c of phase2Candidates) {
    if (processed >= CONFIG.phase2Limit) break;
    stats.phase2.scanned++;
    processed++;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(c.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)',
        },
      });
      clearTimeout(timeout);

      const status = response.status;

      if (status >= 300 && status < 400) {
        // Redirect — capture Location header
        const location = response.headers.get('location');
        if (location) {
          // Resolve relative URLs
          let newUrl;
          try {
            newUrl = new URL(location, c.url).toString();
          } catch (e) {
            newUrl = location;
          }

          if (newUrl !== c.url) {
            console.log(`  [301/302] ${c.reviewId}`);
            console.log(`    ${c.url} → ${newUrl}`);
            updateReviewUrl(c, newUrl, 'http-redirect');
            stats.phase2.redirectsFound++;
          }
        }
      } else if (status === 200) {
        stats.phase2.urlsOk++;
      } else if (status === 404 || status === 410) {
        // Mark for Phase 3
        if (!CONFIG.dryRun) {
          c.data.httpStatus = status;
          fs.writeFileSync(c.filePath, JSON.stringify(c.data, null, 2));
        }
        stats.phase2.dead404++;
        if (CONFIG.dryRun) {
          console.log(`  [${status}] ${c.reviewId}: ${c.url}`);
        }
      } else if (status === 403 || status === 503) {
        // Paywall or bot block — skip
        stats.phase2.paywall++;
      }
    } catch (e) {
      stats.phase2.errors++;
      // Timeout, DNS failure, etc. — skip
    }

    if (processed % 50 === 0) {
      console.log(`  Progress: ${processed}/${Math.min(phase2Candidates.length, CONFIG.phase2Limit)} (${stats.phase2.redirectsFound} redirects, ${stats.phase2.dead404} 404s)`);
    }

    // Checkpoint every 25 in CI
    if (CONFIG.isCI && stats.phase2.redirectsFound > 0 && stats.phase2.redirectsFound % 25 === 0) {
      gitCheckpoint(`chore: URL rediscovery Phase 2 checkpoint (${stats.phase2.redirectsFound} redirects found)`);
    }

    await sleep(CONFIG.phase2Delay);
  }

  console.log(`\nPhase 2 complete:`);
  console.log(`  Scanned: ${stats.phase2.scanned}`);
  console.log(`  Redirects found: ${stats.phase2.redirectsFound}`);
  console.log(`  URLs OK (200): ${stats.phase2.urlsOk}`);
  console.log(`  Dead (404/410): ${stats.phase2.dead404}`);
  console.log(`  Paywall (403/503): ${stats.phase2.paywall}`);
  console.log(`  Errors: ${stats.phase2.errors}`);

  if (CONFIG.isCI && stats.phase2.redirectsFound > 0) {
    gitCheckpoint(`chore: URL rediscovery Phase 2 complete (${stats.phase2.redirectsFound} redirects found)`);
  }

  return stats.phase2.redirectsFound;
}

// ---------------------------------------------------------------------------
// PHASE 3: Google SERP Search
// ---------------------------------------------------------------------------

async function runPhase3(candidates) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('PHASE 3: Google SERP URL Search');
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Limit: ${CONFIG.phase3Limit} searches\n`);

  if (!CONFIG.scrapingBeeKey && !CONFIG.dryRun) {
    console.log('  ⚠ SCRAPINGBEE_API_KEY not set — skipping Phase 3');
    return 0;
  }

  // Phase 3 candidates: missing fullText AND (httpStatus=404 OR last fetchAttempt has 404 error)
  const phase3Candidates = candidates.filter(c => {
    try {
      const fresh = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
      if (fresh.urlDiscoveryMethod) return false;
      if (fresh.fullText && fresh.fullText.length > 100) return false;
      if (!fresh.url) return false;
      c.url = fresh.url;
      c.data = fresh;

      // Check for 404 indicators
      if (fresh.httpStatus === 404 || fresh.httpStatus === 410) return true;

      // Check last fetch attempt for 404-ish errors
      const attempts = fresh.fetchAttempts || [];
      if (attempts.length > 0) {
        const lastError = (attempts[attempts.length - 1].error || '').toLowerCase();
        if (lastError.includes('404') || lastError.includes('not found') || lastError.includes('dead')) return true;
      }

      return false;
    } catch (e) { return false; }
  });

  console.log(`  Eligible (404 candidates): ${phase3Candidates.length}\n`);

  let processed = 0;
  let found = 0;

  for (const c of phase3Candidates) {
    if (processed >= CONFIG.phase3Limit) break;
    stats.phase3.scanned++;
    processed++;

    try {
      const newUrl = await discoverCorrectUrl(
        { showId: c.showId, outletId: c.outletId, outlet: c.outlet, url: c.url },
        CONFIG.scrapingBeeKey
      );

      if (newUrl) {
        updateReviewUrl(c, newUrl, 'google-serp');
        stats.phase3.found++;
        found++;
      } else {
        stats.phase3.notFound++;
      }
    } catch (e) {
      stats.phase3.errors++;
      console.log(`  ✗ Error for ${c.reviewId}: ${e.message}`);
    }

    // Checkpoint every 25 in CI
    if (CONFIG.isCI && found > 0 && found % 25 === 0) {
      gitCheckpoint(`chore: URL rediscovery Phase 3 checkpoint (${found} URLs found via SERP)`);
    }

    await sleep(CONFIG.phase3Delay);
  }

  console.log(`\nPhase 3 complete:`);
  console.log(`  Scanned: ${stats.phase3.scanned}`);
  console.log(`  Found via Google: ${stats.phase3.found}`);
  console.log(`  Not found: ${stats.phase3.notFound}`);
  console.log(`  Errors: ${stats.phase3.errors}`);

  if (CONFIG.isCI && found > 0) {
    gitCheckpoint(`chore: URL rediscovery Phase 3 complete (${found} URLs found via SERP)`);
  }

  return found;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log('URL Rediscovery Script');
  console.log('======================');
  console.log(`  Dry run: ${CONFIG.dryRun}`);
  console.log(`  Phase: ${CONFIG.phase || 'all'}`);
  console.log(`  Show filter: ${CONFIG.showFilter || 'none'}`);
  console.log(`  Domain filter: ${CONFIG.domainFilter || 'none'}`);
  console.log('');

  const candidates = loadCandidates();
  console.log(`Loaded ${candidates.length} candidates (missing fullText, has URL, not flagged)\n`);

  let totalFixed = 0;

  // Phase 1
  if (!CONFIG.phase || CONFIG.phase === 1) {
    totalFixed += runPhase1(candidates);
  }

  // Phase 2
  if (!CONFIG.phase || CONFIG.phase === 2) {
    totalFixed += await runPhase2(candidates);
  }

  // Phase 3
  if (!CONFIG.phase || CONFIG.phase === 3) {
    totalFixed += await runPhase3(candidates);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total URLs fixed: ${totalFixed}`);
  console.log(`  Phase 1 - Protocol: ${stats.phase1.protocolUpgrades}, Domain: ${stats.phase1.domainRedirects}`);
  console.log(`  Phase 2 - Redirects: ${stats.phase2.redirectsFound}`);
  console.log(`  Phase 3 - SERP found: ${stats.phase3.found}`);

  if (CONFIG.dryRun) {
    console.log('\n  (DRY RUN — no files were modified)');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
