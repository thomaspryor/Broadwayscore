#!/usr/bin/env node
/**
 * Diffs normalizeOutlet() routing at a base git ref vs the current working
 * tree, across every registered outlet name/alias/displayName AND every
 * distinct raw "outlet" string observed in data/review-texts. Flags any
 * name whose canonical outletId changed.
 *
 * Why: normalizeOutlet's fuzzy concatenated-outlet-critic matcher can
 * silently misroute names it was never tested against (card #116 —
 * "New York Theater Guide" routed to vulture via a generic alias prefix).
 * There's no snapshot test covering the FULL space of real-world inputs,
 * so a registry edit can introduce or fix routing changes invisibly.
 * This script makes that space diffable on demand.
 *
 * Usage:
 *   node scripts/audit-outlet-routing-diff.js [--base=<git-ref>]
 *
 * Default --base is HEAD~1. Exits 1 if any routing changed (informational —
 * a changed route isn't necessarily wrong, but it must be reviewed).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const base = (process.argv.find(a => a.startsWith('--base=')) || '--base=HEAD~1').slice('--base='.length);

function loadNormalizerAt(ref) {
  if (ref === 'WORKING_TREE') {
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'scripts/lib/review-normalization.js'))];
    return require(path.join(REPO_ROOT, 'scripts/lib/review-normalization.js'));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-routing-audit-'));
  fs.mkdirSync(path.join(tmp, 'data'));
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true });

  const files = ['data/outlet-registry.json', 'scripts/lib/review-normalization.js', 'scripts/lib/text-cleaning.js', 'scripts/lib/exclusion-logger.js'];
  for (const f of files) {
    let content;
    try {
      content = execSync(`git show ${ref}:${f}`, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 50 });
    } catch (e) {
      // Optional deps (exclusion-logger etc.) may not exist at old refs — fall back to current.
      content = fs.readFileSync(path.join(REPO_ROOT, f));
    }
    fs.writeFileSync(path.join(tmp, f), content);
  }
  return require(path.join(tmp, 'scripts/lib/review-normalization.js'));
}

function collectCandidateNames() {
  const names = new Set();

  const registry = require(path.join(REPO_ROOT, 'data/outlet-registry.json'));
  for (const [id, data] of Object.entries(registry.outlets || {})) {
    if (id === '_aliasIndex' || id === '_meta') continue;
    if (data.displayName) names.add(data.displayName);
    for (const alias of (data.aliases || [])) names.add(alias);
  }

  let files = [];
  try {
    files = execSync('find data/review-texts -maxdepth 2 -name "*.json"', { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 200 })
      .toString().trim().split('\n').filter(Boolean);
  } catch (e) { /* no review-texts checked out locally — registry-only audit */ }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
      if (d.outlet) names.add(d.outlet);
    } catch (e) { /* skip unparseable file */ }
  }

  return names;
}

function main() {
  const before = loadNormalizerAt(base);
  const after = loadNormalizerAt('WORKING_TREE');
  const names = collectCandidateNames();

  const diffs = [];
  for (const name of names) {
    const b = before.normalizeOutlet(name);
    const a = after.normalizeOutlet(name);
    if (b !== a) diffs.push({ name, before: b, after: a });
  }

  console.log(`Checked ${names.size} names (registry aliases + observed raw outlet strings) against base=${base}.`);
  if (diffs.length === 0) {
    console.log('No routing changes. Safe.');
    process.exit(0);
  }

  console.log(`\n${diffs.length} routing change(s) — review each for correctness:\n`);
  for (const d of diffs) {
    console.log(`  ${JSON.stringify(d.name)}: ${d.before} -> ${d.after}`);
  }
  process.exit(1);
}

main();
