#!/usr/bin/env node
/**
 * Regenerate src/lib/stats-ui/theater-houses.json (the web Stats house list)
 * from data/theater-metadata.json. Projection: scripts/lib/theater-houses.js.
 *
 * Run after editing theater-metadata.json's capacity / yearBuilt / formerNames
 * or adding a house; tests/unit/stats-theater-houses-drift.test.mjs fails
 * until you do. `--check` exits 1 on drift without writing.
 */

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help');
const { METADATA_PATH, HOUSES_PATH, serializeTheaterHouses } = require('./lib/theater-houses');

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log(
    'Usage: node scripts/generate-theater-houses.js [--check]\n\n' +
      'Writes src/lib/stats-ui/theater-houses.json from data/theater-metadata.json.\n' +
      '  --check  exit 1 if the committed file is stale, without writing',
  );
  process.exit(0);
}

const expected = serializeTheaterHouses(JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8')));
const current = fs.existsSync(HOUSES_PATH) ? fs.readFileSync(HOUSES_PATH, 'utf8') : '';
if (args.includes('--check')) {
  if (current !== expected) {
    console.error('✗ theater-houses.json is stale — run: node scripts/generate-theater-houses.js');
    process.exit(1);
  }
  console.log('✓ theater-houses.json matches data/theater-metadata.json');
} else {
  fs.writeFileSync(HOUSES_PATH, expected);
  console.log(`✓ theater-houses.json: ${Object.keys(JSON.parse(expected)).length} houses${current === expected ? ' (unchanged)' : ' (updated)'}`);
}
