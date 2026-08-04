#!/usr/bin/env node
/**
 * Advisory guard (Scraping v2 Sprint 2, T12; extended task #1005): flag
 * scripts that construct a raw HTTP call to a scraping provider's
 * content-fetch OR SERP endpoint instead of routing through
 * fetchPage()/fetchJSON() (scripts/lib/scraper.js) or
 * serpQuery()/serpNewsQuery()/serpImagesQuery() (scripts/lib/url-discovery.js).
 *
 * A direct call bypasses every fallback tier, cost guard, URL-verification
 * check, and domain-skip rule that lives in those chokepoints — each
 * direct-SB/BD/SD caller is its own unmaintained mini-scraper.js, and for the
 * SERP endpoints specifically, its spend never reaches
 * data/audit/scraper-spend-ledger.jsonl (task #998's bug class). See
 * scripts/lib/CLAUDE.md scraping rule + memory/scraper-reference.
 *
 * Advisory-first (per task #684 T12): pre-existing debt is frozen in the
 * baseline (data/audit/direct-provider-calls-baseline.json) and never fails
 * CI. Only a NEW direct-provider-call site (not in the baseline, not in the
 * allowlist) fails under --strict — provider-aware, not just file-aware, so a
 * file already baselined for one provider still trips on a newly-added,
 * different-provider hit. Default mode always exits 0 (report only).
 *
 * Two carve-outs, both tracked in scripts/config/direct-provider-calls-allowlist.json:
 *   - scraper.js itself, and a handful of libs providing a genuinely different
 *     capability fetchPage() doesn't cover (SERP, site-search, Reddit API-as-proxy)
 *   - diagnostic/billing/bake-off tools that need the RAW per-provider response
 *
 * Usage:
 *   node scripts/audit-direct-provider-calls.js                report only
 *   node scripts/audit-direct-provider-calls.js --strict        exit 1 on new (non-baselined) violators
 *   node scripts/audit-direct-provider-calls.js --update-baseline   regenerate the baseline from current scan
 *
 * hygiene-help-flag-ok: audit-help-flag-safety.js's RISKY_CALL_RE matches the
 * literal string "fetchPage(" inside the USAGE help text below (a prose
 * mention, not a call) and flags it as risky-work-before-the---help-gate. The
 * gate above runs first and this script does no fs/network work in default
 * mode regardless. Verified: node scripts/audit-direct-provider-calls.js --help
 * exits immediately with no side effects.
 */
const fs = require('fs');
const path = require('path');
const { scanSourceForDirectProviderCalls, computeNewViolators } = require('./lib/direct-provider-detector');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-direct-provider-calls.js — flag scripts bypassing fetchPage()/fetchJSON() with raw provider HTTP calls.

Usage:
  node scripts/audit-direct-provider-calls.js [--strict] [--update-baseline]
  node scripts/audit-direct-provider-calls.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'config', 'direct-provider-calls-allowlist.json');
const BASELINE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'direct-provider-calls-baseline.json');
const SELF_PATH = 'scripts/lib/direct-provider-detector.js'; // pattern definitions, not a caller

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');

// Matches both .js and .ts callers — task #684 ship-check found the original
// .js-only walk silently missed two known direct-ScrapingBee cron scripts
// (scrape-grosses.ts, scrape-alltime.ts, task #328), the exact class this
// audit exists to catch.
const SOURCE_FILE_RE = /\.(js|ts)$/;
const TEST_FILE_RE = /\.test\.(js|ts)$/;

function walkJsFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, out);
    } else if (SOURCE_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * A file is cron-reachable if a workflow with a `schedule:` trigger runs it
 * (via `node scripts/X.js` or `node scripts/lib/X.js` in a `run:` block).
 * Heuristic string match, consistent with the other workflow-parsing audits
 * in this repo (audit-run-budget-coverage.js, audit-workflow-hygiene.js) —
 * false positives/negatives are expected and acceptable for an advisory scan.
 */
function findCronReachableScripts() {
  const cronReachable = new Set();
  if (!fs.existsSync(WORKFLOW_DIR)) return cronReachable;
  for (const name of fs.readdirSync(WORKFLOW_DIR)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const full = path.join(WORKFLOW_DIR, name);
    const content = fs.readFileSync(full, 'utf8');
    if (!/^\s*-\s*cron:/m.test(content)) continue; // workflow_dispatch-only — not cron-reachable
    const scriptRefs = content.matchAll(/\bscripts\/[\w./-]+\.js\b/g);
    for (const m of scriptRefs) cronReachable.add(m[0]);
  }
  return cronReachable;
}

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function scanRepo() {
  const files = walkJsFiles(SCRIPTS_DIR, []);
  const cronReachable = findCronReachableScripts();
  const allowlist = loadJson(ALLOWLIST_PATH, {});
  const violators = [];

  for (const abs of files) {
    const rel = relPath(abs);
    if (rel === SELF_PATH) continue;
    if (allowlist[rel]) continue;
    const source = fs.readFileSync(abs, 'utf8');
    const hits = scanSourceForDirectProviderCalls(source);
    if (hits.length === 0) continue;
    violators.push({
      file: rel,
      providers: [...new Set(hits.map(h => h.provider))],
      lines: hits.map(h => h.line),
      cronReachable: cronReachable.has(rel),
    });
  }
  violators.sort((a, b) => a.file.localeCompare(b.file));
  return violators;
}

function main() {
  const violators = scanRepo();

  if (UPDATE_BASELINE) {
    const baseline = {
      generatedAt: new Date().toISOString().slice(0, 10),
      files: {},
    };
    for (const v of violators) {
      baseline.files[v.file] = {
        providers: v.providers,
        cronReachable: v.cronReachable,
      };
    }
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`✅ Baseline updated: ${violators.length} known direct-provider-call sites (${BASELINE_PATH})`);
    return;
  }

  const baseline = loadJson(BASELINE_PATH, { files: {} });
  // Provider-aware, not just file-aware (task #1005) — see computeNewViolators()
  // doc comment for why (fetch-square-images.js's existing content-fetch
  // baseline entry must not blanket-forgive a future scrapingbee-serp hit).
  const newViolators = computeNewViolators(violators, baseline.files || {});
  const cronReachableCount = violators.filter(v => v.cronReachable).length;

  console.log(`Direct-provider-call audit: ${violators.length} file(s) call BD/SB/SD content-fetch/SERP endpoints directly (bypassing fetchPage()/serpQuery()).`);
  console.log(`  Baselined (tracked debt): ${violators.length - newViolators.length}`);
  console.log(`  Cron-reachable: ${cronReachableCount}`);
  if (newViolators.length > 0) {
    console.log(`\n⚠️  NEW direct-provider-call sites not in the baseline:`);
    for (const v of newViolators) {
      console.log(`  ${v.file} — ${v.providers.join(', ')} (line ${v.lines.join(', ')})${v.cronReachable ? ' [cron-reachable]' : ''}`);
    }
    console.log(`\nRoute through fetchPage()/fetchJSON() (scripts/lib/scraper.js) instead, or if this is`);
    console.log(`intentional (SERP/site-search/billing/diagnostic — a different capability than page`);
    console.log(`fetch), add it to scripts/config/direct-provider-calls-allowlist.json with a reason.`);
    console.log(`\nIf this migration is deliberate progress, refresh the baseline:`);
    console.log(`  node scripts/audit-direct-provider-calls.js --update-baseline`);
  }

  if (STRICT && newViolators.length > 0) {
    process.exit(1);
  }
  process.exit(0); // advisory-first: default mode never fails the build
}

main();
