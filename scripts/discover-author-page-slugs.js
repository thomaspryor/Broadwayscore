'use strict';
/**
 * discover-author-page-slugs.js — One-shot discovery helper for BWW author pages.
 *
 * Scans critic-registry for T1/T2 critics with totalReviews>=50 that lack
 * BWW author-page overrides, probes BWW slug variants, and writes proposals to
 * data/audit/critic-author-pages-candidates.json for manual review.
 *
 * Does NOT auto-merge into critic-author-pages.json — manual review required.
 *
 * Usage:
 *   node scripts/discover-author-page-slugs.js [--limit=N] [--dry-run]
 *
 * Sprint S1-T6
 */

const fs = require('fs');
const path = require('path');
const bww = require(path.join(__dirname, 'lib/author-pages/bww.js'));

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Resolve a data file path, with fallback to the main repo checkout.
 * The worktree's data/ dir only contains public files; private files like
 * critic-registry.json live in the main repo at ~/Broadwayscore/data/.
 */
function resolveDataFile(filename) {
  const inWorktree = path.join(REPO_ROOT, 'data', filename);
  if (fs.existsSync(inWorktree)) return inWorktree;
  // Fallback: walk up from worktree to find main repo.
  // Worktree is at <main>/.claude/worktrees/<name>/ → 3 levels up = main repo root
  const mainRepo = path.resolve(REPO_ROOT, '..', '..', '..');
  const inMain = path.join(mainRepo, 'data', filename);
  if (fs.existsSync(inMain)) return inMain;
  throw new Error(`Cannot find data/${filename} in worktree (${inWorktree}) or main repo (${inMain})`);
}

// --- Parse CLI args ---
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 100;

// --- Load data files ---
const criticRegistry = JSON.parse(fs.readFileSync(resolveDataFile('critic-registry.json'), 'utf8'));
const outletRegistry = JSON.parse(fs.readFileSync(resolveDataFile('outlet-registry.json'), 'utf8'));
const criticAuthorPages = JSON.parse(fs.readFileSync(resolveDataFile('critic-author-pages.json'), 'utf8'));

const outlets = outletRegistry.outlets || outletRegistry;
const critics = criticRegistry.critics || criticRegistry;

// Build tier map: outletSlug -> tier number
const tierMap = {};
for (const [k, v] of Object.entries(outlets)) {
  if (!k.startsWith('_')) tierMap[k] = v.tier;
}

// Set of critic slugs already in critic-author-pages.json
const existingOverrides = new Set(
  Object.keys(criticAuthorPages).filter(k => !k.startsWith('_'))
);

/**
 * Convert a display name to a BWW slug variant.
 * e.g. "Jesse Green" -> "Jesse-Green" (original-case)
 * e.g. "Jesse Green" -> "jesse-green" (all-lowercase)
 */
function toSlugVariants(displayName) {
  // Strip trailing punctuation that can appear in registry names (e.g. "Marilyn Stasio.")
  const cleaned = displayName.replace(/[.!?,]+$/, '').trim();
  const hyphenated = cleaned.replace(/\s+/g, '-');
  return [
    hyphenated,                    // original-case: "Jesse-Green"
    hyphenated.toLowerCase(),      // all-lowercase: "jesse-green"
  ];
}

/**
 * Determine confidence level based on result count and which variant succeeded.
 * @param {number} count - number of BWW results returned
 * @param {number} variantIndex - 0=original-case, 1=all-lowercase
 * @returns {'high'|'medium'|'low'}
 */
function getConfidence(count, variantIndex) {
  if (count >= 10 && variantIndex === 0) return 'high';
  if (count === 3) return 'low';
  if (count >= 3 && count < 10) return 'medium';
  if (count >= 10 && variantIndex > 0) return 'medium';
  return 'low';
}

/**
 * Select and sort candidates from critic registry.
 * Filters: not Unknown, T1/T2 outlet, totalReviews>=50, not already overridden.
 */
function selectCandidates() {
  const results = [];
  for (const [slug, c] of Object.entries(critics)) {
    if (c.displayName === 'Unknown') continue;
    const tier = tierMap[c.primaryOutlet];
    if (tier !== 1 && tier !== 2) continue;
    if (c.totalReviews < 50) continue;
    if (existingOverrides.has(slug)) continue;
    results.push({ slug, ...c, tier });
  }
  // Sort by totalReviews descending (highest-value critics first)
  results.sort((a, b) => b.totalReviews - a.totalReviews);
  return results;
}

/**
 * Probe BWW for a single critic, trying slug variants in order.
 * Returns the first successful hit, or null if none.
 */
async function probeCritic(critic, index, total) {
  const variants = toSlugVariants(critic.displayName);

  for (let vi = 0; vi < variants.length; vi++) {
    const slug = variants[vi];
    process.stderr.write(`[${index + 1}/${total}] ${critic.displayName} → trying ${slug} ... `);

    let results;
    try {
      results = await bww.fetch(slug);
    } catch (err) {
      process.stderr.write(`ERROR: ${err.message}\n`);
      continue;
    }

    const count = results.length;
    process.stderr.write(`${count} results`);

    if (count >= 3) {
      const confidence = getConfidence(count, vi);
      process.stderr.write(`, confidence=${confidence}\n`);
      return {
        registrySlug: critic.slug,
        displayName: critic.displayName,
        primaryOutlet: critic.primaryOutlet,
        tier: critic.tier,
        totalReviews: critic.totalReviews,
        bwwSlug: slug,
        confidence,
        evidence: `bww.fetch returned ${count} results`,
      };
    } else {
      process.stderr.write(` (below threshold)\n`);
    }
  }

  // No variant worked
  process.stderr.write(`[${index + 1}/${total}] ${critic.displayName} → no valid slug found\n`);
  return null;
}

/**
 * Process critics in batches of 4 (sequential within each batch).
 */
async function processBatch(critics, total) {
  const CONCURRENCY = 4;
  const candidates = [];

  for (let i = 0; i < critics.length; i += CONCURRENCY) {
    const batch = critics.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((critic, batchIdx) => probeCritic(critic, i + batchIdx, total))
    );
    for (const result of batchResults) {
      if (result) candidates.push(result);
    }
  }

  return candidates;
}

async function main() {
  const allCandidates = selectCandidates();
  const toProcess = allCandidates.slice(0, limit);

  process.stderr.write(`Found ${allCandidates.length} critics eligible (T1/T2, >=50 reviews, no override).\n`);
  process.stderr.write(`Processing top ${toProcess.length} (limit=${limit})${dryRun ? ' [DRY RUN]' : ''}.\n\n`);

  if (dryRun) {
    // In dry-run mode: print what we WOULD do without making any HTTP requests
    process.stderr.write('--- DRY RUN: listing candidates that would be probed ---\n');
    for (let i = 0; i < toProcess.length; i++) {
      const c = toProcess[i];
      const variants = toSlugVariants(c.displayName);
      const label = `[${i + 1}/${toProcess.length}]`;
      process.stdout.write(`${label} ${c.displayName} (${c.primaryOutlet}, T${c.tier}, ${c.totalReviews} reviews)\n`);
      process.stdout.write(`  Would try: ${variants.join(' → ')}\n`);
    }
    process.stdout.write('\n[DRY RUN complete — no file written, no HTTP requests made]\n');
    return;
  }

  const foundCandidates = await processBatch(toProcess, toProcess.length);

  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      totalCriticsConsidered: toProcess.length,
      totalCandidatesProposed: foundCandidates.length,
      limit,
    },
    candidates: foundCandidates,
  };

  // Always write output to the worktree's data/audit/ (public repo output)
  const outPath = path.join(REPO_ROOT, 'data', 'audit', 'critic-author-pages-candidates.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');

  process.stderr.write(`\nDone. ${foundCandidates.length} candidates written to ${outPath}\n`);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
