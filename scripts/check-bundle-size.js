#!/usr/bin/env node
/**
 * check-bundle-size.js
 *
 * Tracks page-level JS bundle sizes from Next.js build output.
 * Compares against a recorded baseline and flags regressions.
 *
 * Usage:
 *   node scripts/check-bundle-size.js                    # Check against baseline
 *   node scripts/check-bundle-size.js --update-baseline  # Record new baseline
 *   node scripts/check-bundle-size.js --ci               # Strict mode (exit 1 on regression)
 *   node scripts/check-bundle-size.js --check-stale      # exit 1 on baseline pages with no src/app route (BRO-5315, no build)
 *   node scripts/check-bundle-size.js --prune-stale      # drop only those pages from the baseline (no build)
 *
 * Thresholds:
 *   - Shared JS: warn if grows >5kB from baseline
 *   - Any page: warn if First Load JS grows >10kB from baseline
 *   - Any page: FAIL if First Load JS exceeds 260kB absolute cap
 */

const { parseBuildOutput: parseBuildTable } = require('./lib/bundle-size-parse.js');
const { parseBuildManifests } = require('./lib/bundle-size-manifests.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASELINE_PATH = path.join(__dirname, '../data/audit/bundle-size-baseline.json');
const HISTORY_PATH = path.join(__dirname, '../data/audit/bundle-size-history.json');
const { foldHistoryByDay } = require('./lib/history-fold-by-day');
const { bundleBuildEnv } = require('./lib/bundle-build-env');
const { computeStaleBaselineKeys, reportStaleBaseline, runStaleModes } = require('./lib/stale-baseline');

const APP_DIR = path.join(__dirname, '..', 'src', 'app');
const PAGE_FILE_RE = /^(page|route)\.(tsx|ts|jsx|js)$/;

/**
 * BRO-5315: the App Router page routes under src/app, in the form `next build`
 * prints them ('/', '/show/[slug]'). Route groups `(x)` drop out of the URL;
 * private `_x` folders and parallel `@slot` folders are not routes. Lets
 * --check-stale find baseline pages whose route was deleted WITHOUT a 10-min
 * build (a pruned page could otherwise come back under the old size and ride
 * a stale entry's budget).
 */
function listAppPageRoutes(appDir = APP_DIR) {
  const routes = new Set();
  const walk = (dir, segs) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('_') || e.name.startsWith('@') || e.name === 'node_modules') continue;
        const group = /^\(.*\)$/.test(e.name);
        walk(path.join(dir, e.name), group ? segs : [...segs, e.name]);
      } else if (PAGE_FILE_RE.test(e.name)) {
        routes.add('/' + segs.join('/'));
      }
    }
  };
  walk(appDir, []);
  return routes;
}

// `next build` also prints framework routes (/_not-found, /_app) and metadata
// routes generated from robots.ts / sitemap.ts / icon files (/robots.txt,
// /sitemap.xml, /icon.png). They have no page.tsx, so the static route list
// can't vouch for them: never call them stale (a build-time compare still can).
// generateSitemaps() in sitemap.ts emits /sitemap/[__metadata_id__] the same way (BRO-6041).
const NON_PAGE_ROUTE_RE = /^\/_|\.[a-z0-9]+$|\[__metadata_id__\]/i;

/** Baseline pages with no live route (from a build's pages, or listAppPageRoutes()). */
function computeStalePages(baseline, liveRoutes, { staticRoutes = false } = {}) {
  let keys = Object.keys((baseline && baseline.pages) || {});
  if (staticRoutes) keys = keys.filter((k) => !NON_PAGE_ROUTE_RE.test(k));
  return computeStaleBaselineKeys(keys, new Set(liveRoutes));
}

const SHARED_JS_WARN_DELTA = 5; // kB
const PAGE_JS_WARN_DELTA = 10;  // kB
const PAGE_JS_ABSOLUTE_CAP = 330; // kB (re-measured from prerendered HTML after the Next 16 upgrade, 2026-10-30, BRO-6609; was 260 on the old table)
// previously: 260 kB — no page should exceed this (updated 2026-05-20 after below-fold lazy split reduced /show/[slug] from 332→253kB)
// Internal tools no visitor loads (Sanity Studio is ~1.6MB by design). The
// cap guards public pages; these became visible to it once the parser stopped
// skipping rows (BRO-5985).
const CAP_EXEMPT_RE = /^\/(studio|admin|test|dev)(\/|$)/;

const CI_MODE = process.argv.includes('--ci');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

function parseBuildOutput() {
  console.log('Running Next.js build to capture sizes...');
  let output;
  try {
    output = execSync('npm run build 2>&1', {
      cwd: path.join(__dirname, '..'),
      env: bundleBuildEnv(),
      encoding: 'utf8',
      timeout: 600_000, // 10 min
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    // Build might "fail" with warnings but still produce size output
    output = e.stdout || '';
    if (!output.includes('First Load JS')) {
      console.error('Build failed without producing size output.');
      // execSync buffers the build log. Preserve the failure details so CI
      // reports the cause instead of only a misleading performance alert.
      console.error(output.trim().split('\n').slice(-30).join('\n'));
      process.exit(1);
    }
  }

  // Advisory page-weight check on the market pages the build just prerendered
  // (BRO-5991, lands advisory first per CLAUDE.md section 19). Never fails the run.
  try {
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'check-market-page-weight.js')], { encoding: 'utf8', timeout: 60_000 });
    if (r.stdout) console.log(r.stdout.trim());
  } catch (e) {
    console.warn('Market page-weight check skipped: ' + e.message);
  }

  // Shared parser: the old inline regex skipped the homepage (┌ row) and
  // every route whose own code printed in bytes, show pages included.
  let { pages, sharedJS } = parseBuildTable(output);
  // Next 16 prints no size table (BRO-6609): measure the prerendered pages instead.
  if (sharedJS == null) ({ pages, sharedJS } = parseBuildManifests(path.join(__dirname, '..', '.next')));

  return { pages, sharedJS, timestamp: new Date().toISOString() };
}

function loadBaseline() {
  try {
    const data = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    if (!data || typeof data.pages !== 'object') {
      console.warn('Baseline file is malformed (missing pages). Will create a new one.');
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveBaseline(data) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nBaseline saved to ${BASELINE_PATH}`);
  console.log(`  Shared JS: ${data.sharedJS} kB`);
  console.log(`  Pages tracked: ${Object.keys(data.pages).length}`);
}

function appendHistory(data) {
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch { /* first run */ }

  history.push({
    timestamp: data.timestamp,
    sharedJS: data.sharedJS,
    pageCount: Object.keys(data.pages).length,
    // Track key pages only to keep history small
    keyPages: {
      '/': data.pages['/'] || null,
      '/show/[slug]': data.pages['/show/[slug]'] || null,
      '/west-end': data.pages['/west-end'] || null,
      '/off-broadway': data.pages['/off-broadway'] || null,
      '/browse/[...slug]': data.pages['/browse/[...slug]'] || null,
    },
  });

  // Fold to one entry per calendar day BEFORE trimming. Without this the
  // "last 50 entries" window is 50 RUNS, not 50 days — and CI runs this many
  // times a day. The live file held 50 entries covering 8 days, 21 of them on
  // 2026-04-19, so the far end of the "trend" was yesterday rather than last
  // month. Same class as the #530 duplicate-history-row bug, but invisible here
  // because the key is a full ISO timestamp so no two rows ever collide.
  history = foldHistoryByDay(history, 'timestamp');
  if (history.length > 50) history = history.slice(-50);

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
}

function compare(current, baseline) {
  const warnings = [];
  const failures = [];

  // Check shared JS
  if (baseline.sharedJS != null && current.sharedJS != null) {
    const delta = current.sharedJS - baseline.sharedJS;
    if (delta > SHARED_JS_WARN_DELTA) {
      warnings.push(`Shared JS grew by ${delta.toFixed(1)}kB (${baseline.sharedJS}kB → ${current.sharedJS}kB)`);
    } else if (delta < -SHARED_JS_WARN_DELTA) {
      console.log(`  ✓ Shared JS shrank by ${Math.abs(delta).toFixed(1)}kB — nice!`);
    }
  }

  // Check each page
  const pagesChecked = new Set([...Object.keys(current.pages), ...Object.keys(baseline.pages)]);
  const regressions = [];
  const improvements = [];

  for (const page of pagesChecked) {
    const cur = current.pages[page];
    const base = baseline.pages[page];

    if (!cur) continue; // Page removed — reported as stale baseline in main()

    // Absolute cap
    if (cur > PAGE_JS_ABSOLUTE_CAP && !CAP_EXEMPT_RE.test(page)) {
      failures.push(`${page}: ${cur}kB exceeds ${PAGE_JS_ABSOLUTE_CAP}kB absolute cap`);
    }

    if (!base) continue; // New page — no baseline to compare

    const delta = cur - base;
    if (delta > PAGE_JS_WARN_DELTA) {
      regressions.push({ page, delta, from: base, to: cur });
    } else if (delta < -PAGE_JS_WARN_DELTA) {
      improvements.push({ page, delta: Math.abs(delta), from: base, to: cur });
    }
  }

  if (regressions.length > 0) {
    warnings.push(`${regressions.length} page(s) grew significantly:`);
    for (const r of regressions.sort((a, b) => b.delta - a.delta)) {
      warnings.push(`  ${r.page}: +${r.delta.toFixed(1)}kB (${r.from}kB → ${r.to}kB)`);
    }
  }

  if (improvements.length > 0) {
    console.log(`  ✓ ${improvements.length} page(s) shrank:`);
    for (const i of improvements.sort((a, b) => b.delta - a.delta)) {
      console.log(`    ${i.page}: -${i.delta.toFixed(1)}kB`);
    }
  }

  return { warnings, failures };
}

async function main() {
  const current = parseBuildOutput();

  if (!current.sharedJS) {
    console.error('Could not parse build output. Is the build succeeding?');
    process.exit(1);
  }

  console.log(`\n=== Bundle Size Check ===`);
  console.log(`Shared JS: ${current.sharedJS} kB`);
  console.log(`Pages: ${Object.keys(current.pages).length}`);

  // Show top 10 heaviest pages
  const sorted = Object.entries(current.pages).sort((a, b) => b[1] - a[1]);
  console.log(`\nHeaviest pages (First Load JS):`);
  for (const [page, size] of sorted.slice(0, 10)) {
    console.log(`  ${size.toString().padStart(6)} kB  ${page}`);
  }

  // Save history regardless
  appendHistory(current);

  if (UPDATE_BASELINE) {
    saveBaseline(current);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.log('\nNo baseline found. Run with --update-baseline to create one.');
    saveBaseline(current);
    return;
  }

  console.log(`\nComparing against baseline from ${baseline.timestamp}:`);
  const { warnings, failures } = compare(current, baseline);
  const stalePages = computeStalePages(baseline, Object.keys(current.pages));
  if (stalePages.length) reportStaleBaseline(stalePages, { label: 'bundle-size', updateCmd: 'node scripts/check-bundle-size.js --prune-stale' });

  if (failures.length > 0) {
    console.log('\n❌ FAILURES (must fix):');
    for (const f of failures) console.log(`  ${f}`);
  }

  if (warnings.length > 0) {
    console.log('\n⚠️  WARNINGS (review before shipping):');
    for (const w of warnings) console.log(`  ${w}`);
  }

  if (failures.length === 0 && warnings.length === 0) {
    console.log('\n✓ All page sizes within budget.');
  }

  // Summary
  if (current.sharedJS != null && baseline.sharedJS != null) {
    console.log(`\nShared JS delta: ${(current.sharedJS - baseline.sharedJS).toFixed(1)}kB`);
  }

  if (CI_MODE && failures.length > 0) {
    console.error('\nBundle size check FAILED in CI mode.');
    process.exit(1);
  }

  if (CI_MODE && warnings.length > 0) {
    console.log('\nBundle size warnings in CI — not blocking, but review recommended.');
  }
}

function runStaticStaleModes(argv) {
  const baseline = loadBaseline();
  return runStaleModes(argv, {
    stale: computeStalePages(baseline, listAppPageRoutes(), { staticRoutes: true }),
    label: 'bundle-size (baseline pages vs src/app routes)',
    updateCmd: 'node scripts/check-bundle-size.js --prune-stale',
    prune: (stale) => {
      for (const p of stale) delete baseline.pages[p];
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    },
  });
}

if (require.main === module) {
  if (!runStaticStaleModes(process.argv.slice(2))) {
    main().catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { listAppPageRoutes, computeStalePages, loadBaseline, compare, BASELINE_PATH };
