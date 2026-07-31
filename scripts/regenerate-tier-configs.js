#!/usr/bin/env node
/**
 * Regenerate domain-specific tier ordering and skip configs from fetchAttempts data.
 *
 * Mines all review-text files' fetchAttempts arrays to build:
 * 1. domain-tier-order.json — tiers ranked by success rate per domain
 * 2. domain-tier-skip.json — tiers with 3+ failures and 0 successes per domain
 *
 * Usage:
 *   node scripts/regenerate-tier-configs.js [--dry-run] [--min-attempts=5] [--skip-threshold=3]
 *
 * Run locally after pulling review-texts, or in CI via regenerate-tier-configs.yml.
 */

const fs = require('fs');
const path = require('path');
const { buildSkipConfig } = require('./lib/domain-tier-skip');

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MIN_ATTEMPTS = parseInt((args.find(a => a.startsWith('--min-attempts=')) || '').split('=')[1]) || 3;
const SKIP_THRESHOLD = parseInt((args.find(a => a.startsWith('--skip-threshold=')) || '').split('=')[1]) || 3;

const BASE = path.join(__dirname, '..', 'data', 'review-texts');
const ORDER_PATH = path.join(__dirname, 'config', 'domain-tier-order.json');
const SKIP_PATH = path.join(__dirname, 'config', 'domain-tier-skip.json');

// Normalize method names to canonical tier IDs
function normalizeTierId(method, tierNum) {
  const map = {
    'playwright': 'playwright',
    'playwright-stealth': 'playwright',
    'scrapingbee': 'scrapingbee',
    'brightdata': 'brightdata',
    'browserbase': 'browserbase',
    'archive-first': 'archive-first',
    'archive-today': 'archive-today',
    'archive.ph': 'archive-today',
    'amp': 'amp-variant',
    'amp-variant': 'amp-variant',
    'direct-cookies': 'direct-cookies',
    'direct': 'direct-cookies',
  };
  if (method === 'archive') {
    if (tierNum <= 0.5) return 'archive-cdx';
    if (tierNum >= 3.5) return 'archive-cdx-final';
    return 'archive-final';
  }
  return map[method] || method;
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

// domain → tier → { successes, failures }
const stats = {};
let totalFiles = 0;
let filesWithAttempts = 0;

console.log(`Scanning ${BASE}...`);

const showDirs = fs.readdirSync(BASE).filter(d => {
  try { return fs.statSync(path.join(BASE, d)).isDirectory() && d !== '.git'; }
  catch { return false; }
});

for (const showDir of showDirs) {
  const showPath = path.join(BASE, showDir);
  let files;
  try { files = fs.readdirSync(showPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json'); }
  catch { continue; }

  for (const file of files) {
    totalFiles++;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showPath, file), 'utf8'));
      const domain = getDomain(data.url);
      if (!domain) continue;

      if (data.fetchAttempts && Array.isArray(data.fetchAttempts) && data.fetchAttempts.length > 0) {
        filesWithAttempts++;
        for (const attempt of data.fetchAttempts) {
          const tierId = normalizeTierId(attempt.method, attempt.tier);
          if (!stats[domain]) stats[domain] = {};
          if (!stats[domain][tierId]) stats[domain][tierId] = { successes: 0, failures: 0 };
          if (attempt.success) stats[domain][tierId].successes++;
          else stats[domain][tierId].failures++;
        }
      }
    } catch {}
  }
}

console.log(`Total files: ${totalFiles}`);
console.log(`Files with fetchAttempts: ${filesWithAttempts}`);
console.log(`Domains with data: ${Object.keys(stats).length}`);

// Build tier ordering: rank tiers by success rate per domain
const tierOrder = {};
let orderDomains = 0;

for (const [domain, tiers] of Object.entries(stats)) {
  const tierEntries = Object.entries(tiers)
    .filter(([_, s]) => s.successes + s.failures >= MIN_ATTEMPTS)
    .map(([tierId, s]) => ({
      tierId,
      rate: s.successes / (s.successes + s.failures),
      total: s.successes + s.failures,
    }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total);

  if (tierEntries.length >= 2) {
    tierOrder[domain] = tierEntries.map(e => e.tierId);
    orderDomains++;
  }
}

// Sort by domain name for stable output
const sortedOrder = {};
for (const k of Object.keys(tierOrder).sort()) sortedOrder[k] = tierOrder[k];

// Build skip list: domain+tier combos with sufficient failures and 0 successes.
// {skip, reason, addedAt} shape (Scraping v2 Sprint 1 T10) — addedAt is
// preserved from the existing file across regenerations so a skip's age is
// visible instead of resetting on every run (the missing provenance is why
// stale skips like didtheylikeit.com/theatre.reviews' scrapingdog entries
// went unreviewed for months after SD became a supported tier).
let existingSkipConfig = {};
try { existingSkipConfig = JSON.parse(fs.readFileSync(SKIP_PATH, 'utf8')); } catch {}
const sortedSkip = buildSkipConfig(stats, existingSkipConfig, {
  skipThreshold: SKIP_THRESHOLD,
  now: new Date().toISOString().slice(0, 10),
});
const skipCount = Object.values(sortedSkip).reduce((n, tiers) => n + Object.keys(tiers).length, 0);

console.log(`\nTier ordering: ${orderDomains} domains (min ${MIN_ATTEMPTS} attempts per tier)`);
console.log(`Tier skip list: ${Object.keys(sortedSkip).length} domains, ${skipCount} skips (threshold: ${SKIP_THRESHOLD}+ failures, 0 successes)`);

// Compare with existing configs
function diffConfigs(oldPath, newConfig, label) {
  try {
    const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    const oldKeys = new Set(Object.keys(old));
    const newKeys = new Set(Object.keys(newConfig));
    const added = [...newKeys].filter(k => !oldKeys.has(k));
    const removed = [...oldKeys].filter(k => !newKeys.has(k));
    let changed = 0;
    for (const k of [...newKeys].filter(k => oldKeys.has(k))) {
      if (JSON.stringify(old[k]) !== JSON.stringify(newConfig[k])) changed++;
    }
    console.log(`\n${label} diff vs existing:`);
    console.log(`  Added: ${added.length} domains`);
    console.log(`  Removed: ${removed.length} domains`);
    console.log(`  Changed: ${changed} domains`);
    if (added.length > 0) console.log(`  New domains: ${added.slice(0, 10).join(', ')}${added.length > 10 ? '...' : ''}`);
    return added.length + removed.length + changed;
  } catch {
    console.log(`\n${label}: no existing file to compare`);
    return Object.keys(newConfig).length;
  }
}

const orderDiff = diffConfigs(ORDER_PATH, sortedOrder, 'Tier ordering');
const skipDiff = diffConfigs(SKIP_PATH, sortedSkip, 'Tier skip list');

if (DRY_RUN) {
  console.log('\n[DRY RUN] Would write configs but --dry-run specified.');
  process.exit(0);
}

if (orderDiff === 0 && skipDiff === 0) {
  console.log('\nNo changes needed — configs are up to date.');
  process.exit(0);
}

// Write configs
fs.writeFileSync(ORDER_PATH, JSON.stringify(sortedOrder, null, 2) + '\n');
fs.writeFileSync(SKIP_PATH, JSON.stringify(sortedSkip, null, 2) + '\n');

console.log(`\nWritten:`);
console.log(`  ${ORDER_PATH}`);
console.log(`  ${SKIP_PATH}`);
