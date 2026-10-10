#!/usr/bin/env node
/**
 * Merge Theater Research into theater-metadata.json
 *
 * Reads per-theater research files from data/theater-research/ and
 * atomically adds venueScores + externalLinks to theater-metadata.json.
 *
 * Usage:
 *   node scripts/merge-theater-research.js           # merge all
 *   node scripts/merge-theater-research.js --dry-run  # preview only
 */

const fs = require('fs');
const path = require('path');

const RESEARCH_DIR = path.join(__dirname, '..', 'data', 'theater-research');
const METADATA_PATH = path.join(__dirname, '..', 'data', 'theater-metadata.json');

const dryRun = process.argv.includes('--dry-run');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function main() {
  const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
  const theaterNames = Object.keys(metadata).filter(k => k !== '_meta');

  let merged = 0;
  let skipped = 0;
  let missing = 0;

  for (const name of theaterNames) {
    const slug = slugify(name);
    const researchPath = path.join(RESEARCH_DIR, `${slug}.json`);

    if (!fs.existsSync(researchPath)) {
      console.log(`  ⚠️  No research file for: ${name} (${slug})`);
      missing++;
      continue;
    }

    const research = JSON.parse(fs.readFileSync(researchPath, 'utf8'));

    if (!research.scores) {
      console.log(`  ⚠️  No scores in research file for: ${name}`);
      skipped++;
      continue;
    }

    // Build venueScores (without overall — computed at runtime)
    metadata[name].venueScores = {
      sightlines: research.scores.sightlines,
      sound: research.scores.sound,
      comfort: research.scores.comfort,
      ambiance: research.scores.ambiance,
      facilities: research.scores.facilities,
      summary: research.scores.summary,
      sources: research.sources,
      lastResearched: research.researchedAt?.split('T')[0] || new Date().toISOString().split('T')[0],
    };

    // Build externalLinks (only include non-null URLs)
    const links = {};
    if (research.externalLinks?.seatplan) links.seatplan = research.externalLinks.seatplan;
    if (research.externalLinks?.aviewfrommyseat) links.aviewfrommyseat = research.externalLinks.aviewfrommyseat;
    if (Object.keys(links).length > 0) {
      metadata[name].externalLinks = links;
    }

    merged++;
    console.log(`  ✅ ${name}: ${Object.values(research.scores).filter(v => typeof v === 'number').join('/')}`);
  }

  console.log(`\nSummary: ${merged} merged, ${skipped} skipped, ${missing} missing`);

  if (dryRun) {
    console.log('\n[DRY RUN] No changes written.');
    return;
  }

  // Atomic write
  const tmpPath = METADATA_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2) + '\n');
  fs.renameSync(tmpPath, METADATA_PATH);
  console.log(`\n✅ Written to ${METADATA_PATH}`);
}

main();
