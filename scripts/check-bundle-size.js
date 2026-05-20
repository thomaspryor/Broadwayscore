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
 *
 * Thresholds:
 *   - Shared JS: warn if grows >5kB from baseline
 *   - Any page: warn if First Load JS grows >10kB from baseline
 *   - Any page: FAIL if First Load JS exceeds 260kB absolute cap
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASELINE_PATH = path.join(__dirname, '../data/audit/bundle-size-baseline.json');
const HISTORY_PATH = path.join(__dirname, '../data/audit/bundle-size-history.json');

const SHARED_JS_WARN_DELTA = 5; // kB
const PAGE_JS_WARN_DELTA = 10;  // kB
const PAGE_JS_ABSOLUTE_CAP = 260; // kB — no page should exceed this (updated 2026-05-20 after below-fold lazy split reduced /show/[slug] from 332→253kB)

const CI_MODE = process.argv.includes('--ci');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

function parseBuildOutput() {
  console.log('Running Next.js build to capture sizes...');
  let output;
  try {
    output = execSync('npm run build 2>&1', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 600_000, // 10 min
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    // Build might "fail" with warnings but still produce size output
    output = e.stdout || '';
    if (!output.includes('First Load JS')) {
      console.error('Build failed without producing size output.');
      process.exit(1);
    }
  }

  const pages = {};
  let sharedJS = null;

  for (const line of output.split('\n')) {
    // Match page lines: ├ ○ /path    1.23 kB    94.5 kB
    const pageMatch = line.match(/[├└]\s+[○●ƒ]\s+(\S+)\s+[\d.]+\s+kB\s+([\d.]+)\s+kB/);
    if (pageMatch) {
      pages[pageMatch[1]] = parseFloat(pageMatch[2]);
    }
    // Match shared JS: + First Load JS shared by all    87.2 kB
    const sharedMatch = line.match(/First Load JS shared by all\s+([\d.]+)\s+kB/);
    if (sharedMatch) {
      sharedJS = parseFloat(sharedMatch[1]);
    }
  }

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

  // Keep last 50 entries
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

    if (!cur) continue; // Page removed — that's fine

    // Absolute cap
    if (cur > PAGE_JS_ABSOLUTE_CAP) {
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

main().catch(e => { console.error(e); process.exit(1); });
