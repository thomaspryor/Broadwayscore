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
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');

const REPO_ROOT = path.join(__dirname, '..');
const base = (process.argv.find(a => a.startsWith('--base=')) || '--base=HEAD~1').slice('--base='.length);

// Required at every ref this script will realistically be pointed at — a
// git-show failure here means the ref/path is wrong, not that the file is
// legitimately absent, so it must fail loudly rather than silently diffing
// working-tree-against-working-tree.
const REQUIRED_FILES = ['data/outlet-registry.json', 'scripts/lib/review-normalization.js'];
// Genuinely optional: shared helpers that review-normalization.js didn't
// always depend on. Missing at an old ref is expected, not an error.
const OPTIONAL_FILES = ['scripts/lib/text-cleaning.js', 'scripts/lib/exclusion-logger.js'];

function loadNormalizerAt(ref) {
  if (ref === 'WORKING_TREE') {
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'scripts/lib/review-normalization.js'))];
    return require(path.join(REPO_ROOT, 'scripts/lib/review-normalization.js'));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-routing-audit-'));
  fs.mkdirSync(path.join(tmp, 'data'));
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true });

  for (const f of REQUIRED_FILES) {
    // execFileSync (no shell) so `ref` can never be interpreted as shell syntax.
    const content = execFileSync('git', ['show', `${ref}:${f}`], { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 50 });
    fs.writeFileSync(path.join(tmp, f), content);
  }
  for (const f of OPTIONAL_FILES) {
    let content;
    try {
      content = execFileSync('git', ['show', `${ref}:${f}`], { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 50 });
    } catch (e) {
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

  const registryOnlyCount = names.size;
  let files = [];
  let corpusAvailable = true;
  try {
    files = execFileSync('find', ['data/review-texts', '-maxdepth', '2', '-name', '*.json'], { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 200 })
      .toString().trim().split('\n').filter(Boolean);
  } catch (e) {
    corpusAvailable = false;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
      if (d.outlet) names.add(d.outlet);
    } catch (e) { /* skip unparseable file */ }
  }

  if (!corpusAvailable) {
    console.warn(
      `WARNING: data/review-texts not found — checking only ${registryOnlyCount} registry names, ` +
      `NOT the observed raw-corpus outlet strings. Run from a checkout with review-texts populated ` +
      `(./scripts/setup-local-data.sh) for the full check.`
    );
  }

  return names;
}

function main() {
  // Task #498 class: this script shells out (git show) and walks the corpus, so
  // --help must short-circuit BEFORE any of that runs.
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/audit-outlet-routing-diff.js [--base=<git-ref>]');
    console.log('  Diffs normalizeOutlet() routing at <git-ref> vs the working tree across every');
    console.log('  registry name/alias and every raw outlet string in data/review-texts.');
    console.log('  Read-only. Default --base=HEAD~1. Exits 1 if any routing changed.');
    process.exit(0);
  }
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
