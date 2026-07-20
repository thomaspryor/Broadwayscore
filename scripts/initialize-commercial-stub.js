#!/usr/bin/env node
/**
 * initialize-commercial-stub.js
 *
 * Enrolls a show in commercial.json with an empty stub. NO LLM calls, NO
 * network, NO data invention. This replaces the dangerous pattern of
 * LLM-backfill in the enrollment hot path — enrollment just reserves the
 * slot; a human or a separate research pass fills in real numbers later.
 *
 * SCOPE: this script trusts its caller's slug list completely — it never
 * looks up shows.json, so it has no way to reject an Off-Broadway/West-End
 * slug. Every caller MUST pre-filter with isCommercialScope()
 * (scripts/lib/commercial-scope.js) before building --show= args, the way
 * opening-night-orchestrator.yml's "Enroll commercial stubs" step does.
 *
 * Usage:
 *   node scripts/initialize-commercial-stub.js --show=SLUG [--show=SLUG2 ...]
 *   node scripts/initialize-commercial-stub.js --show=SLUG --data-file=/path/to/commercial.json
 *
 * Exit codes:
 *   0 — success (including no-op when entry already exists)
 *   2 — bad usage (missing --show, or invalid slug format)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');

const SLUG_RE = /^[a-z0-9-]+$/;

function printUsage() {
  console.error('Usage: node scripts/initialize-commercial-stub.js --show=SLUG [--show=SLUG2 ...] [--data-file=PATH]');
  console.error('  SLUG must match /^[a-z0-9-]+$/ (lowercase alphanumeric + hyphens)');
}

function parseArgs(argv) {
  const shows = [];
  let dataFile = null;
  for (const arg of argv) {
    if (arg.startsWith('--show=')) {
      shows.push(arg.slice('--show='.length));
    } else if (arg.startsWith('--data-file=')) {
      dataFile = arg.slice('--data-file='.length);
    }
  }
  return { shows, dataFile };
}

function makeStub() {
  return {
    designation: 'TBD',
    capitalization: null,
    weeklyRunningCost: null,
    recouped: false,
    recoupedSource: null,
    notes: 'Auto-enrolled stub; awaiting model + curation.',
    sources: [],
  };
}

function main(argv) {
  const { shows: slugs, dataFile } = parseArgs(argv);
  const commercialPath = dataFile || DEFAULT_COMMERCIAL_PATH;

  if (slugs.length === 0) {
    printUsage();
    return 2;
  }

  for (const slug of slugs) {
    if (!slug || !SLUG_RE.test(slug)) {
      console.error(`Invalid slug: ${JSON.stringify(slug)} — must match /^[a-z0-9-]+$/`);
      printUsage();
      return 2;
    }
  }

  let commercial;
  try {
    commercial = JSON.parse(fs.readFileSync(commercialPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to read/parse ${commercialPath}: ${e.message}`);
    return 1;
  }

  if (!commercial.shows || typeof commercial.shows !== 'object') {
    console.error(`Malformed commercial data at ${commercialPath}: missing "shows" object`);
    return 1;
  }

  let wrote = false;
  for (const slug of slugs) {
    if (Object.prototype.hasOwnProperty.call(commercial.shows, slug)) {
      console.log(`Entry exists for ${slug} — no-op`);
      continue;
    }
    commercial.shows[slug] = makeStub();
    wrote = true;
    console.log(`Created stub entry for ${slug}`);
  }

  if (wrote) {
    fs.writeFileSync(commercialPath, JSON.stringify(commercial, null, 2) + '\n');
  }

  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, makeStub, SLUG_RE };
