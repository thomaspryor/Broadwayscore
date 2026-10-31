#!/usr/bin/env node
/**
 * Slug-canonicalization probe (S1-T6)
 *
 * Read-only audit. For every data/llm-scores/{showId}/{outletId}.json file,
 * compare the on-disk outletId (from filename + JSON content) against what
 * normalizeOutlet() would return when re-evaluating the outlet name through
 * outlet-registry.json.
 *
 * Surfaces any mismatches BEFORE Sprint 4 swaps gather-reviews.js's SERP loop
 * to read from outlet-registry.json. Pre-mortem primary scenario for that
 * change is: writes use canonical slug, reads still use legacy slug, 40% of
 * reviews silently drop from reviews.json.
 *
 * If mismatchCount > 0, a follow-up migration script must be written before
 * Sprint 4 ships.
 *
 * Usage:
 *   node scripts/probe-outlet-id-canonicalization.js \
 *     > data/audit/outlet-id-canonicalization-probe.json
 *
 * Output schema:
 *   {
 *     totalFiles: <int>,
 *     mismatchCount: <int>,
 *     mismatchesByOutlet: { "<diskOutletId>": <count>, ... },
 *     samples: [{ file, diskOutletId, normalizedOutletId, outletNameInJson }, ...]
 *   }
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet } = require('./lib/review-normalization');

const LLM_SCORES_DIR = path.join(__dirname, '..', 'data', 'llm-scores');

function main() {
  if (!fs.existsSync(LLM_SCORES_DIR)) {
    process.stderr.write(`[probe] ${LLM_SCORES_DIR} not found\n`);
    process.exit(1);
  }

  let totalFiles = 0;
  let mismatchCount = 0;
  const mismatchesByOutlet = Object.create(null);
  const samples = [];

  const showDirs = fs.readdirSync(LLM_SCORES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const showId of showDirs) {
    const showDir = path.join(LLM_SCORES_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const filename of files) {
      totalFiles++;

      // Filename schema: {outletId}--{criticSlug}.json (or {outletId}.json for legacy).
      // outletId is everything before the first "--".
      const stem = filename.replace(/\.json$/, '');
      const diskOutletId = stem.includes('--') ? stem.split('--')[0] : stem;

      // Try to read JSON for the outlet display name; if absent, use diskOutletId
      let outletNameInJson = null;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf8'));
        outletNameInJson = data.outlet || data.outletName || data.outletId || null;
      } catch (e) {
        // unreadable → skip canonicalization; report as a separate sample category
        samples.push({
          file: `${showId}/${filename}`,
          diskOutletId,
          normalizedOutletId: null,
          outletNameInJson: null,
          reason: 'unreadable-json'
        });
        continue;
      }

      // What would normalizeOutlet return given the JSON's outlet name?
      // If the JSON has no outlet name, fall back to running normalizeOutlet on
      // the diskOutletId itself — this catches purely-stale filename cases.
      const normalizationInput = outletNameInJson || diskOutletId;
      const normalizedOutletId = normalizeOutlet(normalizationInput);

      if (normalizedOutletId && normalizedOutletId !== diskOutletId) {
        mismatchCount++;
        mismatchesByOutlet[diskOutletId] = (mismatchesByOutlet[diskOutletId] || 0) + 1;
        if (samples.length < 50) {
          samples.push({
            file: `${showId}/${filename}`,
            diskOutletId,
            normalizedOutletId,
            outletNameInJson
          });
        }
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    totalFiles,
    mismatchCount,
    mismatchesByOutlet,
    samples
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  // Stderr summary so CI/eyeballing is easy without parsing JSON
  process.stderr.write(
    `[probe] Scanned ${totalFiles} llm-scores files; ` +
    `${mismatchCount} mismatches across ${Object.keys(mismatchesByOutlet).length} outlet IDs.\n`
  );

  if (mismatchCount > 0) {
    process.stderr.write(
      `[probe] ⚠️  ACTION REQUIRED: write migration script before Sprint 4 ships.\n` +
      `[probe]    Top mismatches: ${
        Object.entries(mismatchesByOutlet)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => `${k} (${v})`)
          .join(', ')
      }\n`
    );
  } else {
    process.stderr.write(`[probe] ✅ All llm-scores filenames already match normalizeOutlet output.\n`);
  }
}

if (require.main === module) {
  main();
}
