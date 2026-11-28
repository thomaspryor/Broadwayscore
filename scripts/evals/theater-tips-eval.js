#!/usr/bin/env node
/**
 * theater-tips-eval.js
 *
 * Offline eval for LLM-generated theater tips. Runs pure validators from
 * scripts/lib/theater-tips-validators.js against the current draft data.
 * No API credits burned — this replays the production output through the
 * same guards the generator runs at write time, so regressions (prompt
 * drift, validator removal, fixture rot) show up here.
 *
 * Exits 0 on clean, non-zero on any finding. CI-safe.
 *
 * Usage:
 *   node scripts/evals/theater-tips-eval.js
 *   node scripts/evals/theater-tips-eval.js --json           # machine output
 *   node scripts/evals/theater-tips-eval.js --draft path.json --scraped path.json
 *   node scripts/evals/theater-tips-eval.js --strict         # fail on diversity warnings too
 */

const fs = require('fs');
const path = require('path');
const {
  validateTips,
  auditCrossTheaterDiversity,
} = require('../lib/theater-tips-validators');

function parseArgs(argv) {
  const args = { json: false, strict: false, mode: 'draft' };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--draft') args.draft = list[++i];
    else if (a === '--scraped') args.scraped = list[++i];
    // --metadata scans theater-metadata.json, the file the site ACTUALLY
    // reads. Ship-check 2026-04-15 found the draft eval passing clean
    // while metadata shipped 12 wrong subway claims live. Always run with
    // --metadata after a merge.
    else if (a === '--metadata') { args.mode = 'metadata'; args.metadata = list[++i] || null; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: theater-tips-eval.js [--json] [--strict] [--draft PATH | --metadata PATH] [--scraped PATH]');
      process.exit(0);
    }
  }
  return args;
}

function loadTheatersFromMetadata(metadataPath) {
  const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (name === '_meta') continue;
    if (v && v.structuredTips) out[name] = v.structuredTips;
  }
  return { theaters: out };
}

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv);
  const root = path.join(__dirname, '..', '..');
  const scrapedPath = args.scraped || path.join(root, 'data', 'theater-tips-scraped.json');

  let draft;
  if (args.mode === 'metadata') {
    const metadataPath = args.metadata || path.join(root, 'data', 'theater-metadata.json');
    draft = loadTheatersFromMetadata(metadataPath);
  } else {
    const draftPath = args.draft || path.join(root, 'data', 'theater-tips-draft.json');
    draft = loadJSON(draftPath);
  }
  const scraped = loadJSON(scrapedPath);

  const theaters = draft.theaters || {};
  const theaterNames = Object.keys(theaters);

  const perTheater = [];
  let totalSchemaErrors = 0;
  let totalBannedClaims = 0;
  let totalGrounding = 0;
  let totalCategoryDupes = 0;
  let totalSubway = 0;
  let totalEntrance = 0;

  // Schema check applies only to raw LLM output (draft mode). Metadata has
  // legitimate extra fields (injected accessibility) and optional omissions
  // (avoidSeats absent when null). Only banned-claims, subway, entrance,
  // grounding, and dedup run in metadata mode — those are the user-facing
  // correctness checks.
  const skipSchema = args.mode === 'metadata';

  for (const name of theaterNames) {
    const tips = theaters[name];
    const scrapedForTheater = scraped.theaters?.[name] || null;
    const result = validateTips(tips, scrapedForTheater, name);
    const subwayFindings = result.subwayFindings || [];
    const entranceFindings = result.entranceFindings || [];
    if (skipSchema) result.schemaErrors = [];

    totalSchemaErrors += result.schemaErrors.length;
    totalBannedClaims += result.bannedClaims.length;
    totalGrounding += result.groundingFindings.length;
    totalCategoryDupes += result.categoryDupes.length;
    totalSubway += subwayFindings.length;
    totalEntrance += entranceFindings.length;

    const hasAnyFinding = result.schemaErrors.length > 0 ||
      result.bannedClaims.length > 0 ||
      result.groundingFindings.length > 0 ||
      result.categoryDupes.length > 0 ||
      subwayFindings.length > 0 ||
      entranceFindings.length > 0;

    if (hasAnyFinding) {
      perTheater.push({ theater: name, ...result });
    }
  }

  const diversity = auditCrossTheaterDiversity(theaters, 0.5);

  const summary = {
    totalTheaters: theaterNames.length,
    cleanTheaters: theaterNames.length - perTheater.length,
    totalSchemaErrors,
    totalBannedClaims,
    totalGrounding,
    totalCategoryDupes,
    totalSubway,
    totalEntrance,
    overusedRestaurants: diversity.length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, perTheater, diversity }, null, 2));
  } else {
    console.log('='.repeat(60));
    console.log('Theater Tips Eval');
    console.log('='.repeat(60));
    console.log(`Theaters: ${summary.totalTheaters}`);
    console.log(`Clean:    ${summary.cleanTheaters}`);
    console.log('');
    console.log(`Schema errors:      ${summary.totalSchemaErrors}`);
    console.log(`Banned claims:      ${summary.totalBannedClaims}  ← accessibility/safety/medical hallucinations`);
    console.log(`Invented names:     ${summary.totalGrounding}`);
    console.log(`Category dupes:     ${summary.totalCategoryDupes}`);
    console.log(`Subway line errors: ${summary.totalSubway}  ← MTA truth-table cross-check`);
    console.log(`Entrance errors:    ${summary.totalEntrance}  ← theater-address truth-table cross-check`);
    console.log(`Overused (>50%):    ${summary.overusedRestaurants}`);
    console.log('');

    if (perTheater.length > 0) {
      console.log('PER-THEATER FINDINGS');
      console.log('-'.repeat(60));
      for (const t of perTheater) {
        console.log(`\n${t.theater}`);
        for (const e of t.schemaErrors) console.log(`  schema: ${e}`);
        for (const b of t.bannedClaims) console.log(`  banned [${b.category}] ${b.path}: "${b.match}" — ${b.reason}`);
        for (const g of t.groundingFindings) console.log(`  grounding: invented ${g.kind} "${g.name}" at ${g.path}`);
        for (const d of t.categoryDupes) console.log(`  dupe: "${d.name}" at ${d.path} (already in ${d.duplicateOf})`);
        for (const s of (t.subwayFindings || [])) console.log(`  subway: claimed ${s.wrongLines.join(',')} at "${s.station}" — actual lines: ${s.truthLines.join(',')}`);
        for (const e of (t.entranceFindings || [])) console.log(`  entrance: claimed streets ${e.wrongStreets.join(',')} — valid for this theater: ${e.validStreets.join(',')}`);
      }
    }

    if (diversity.length > 0) {
      console.log('\nCROSS-THEATER DIVERSITY');
      console.log('-'.repeat(60));
      for (const d of diversity) {
        console.log(`  ${d.count}/${d.theaters} (${Math.round(d.fraction * 100)}%) — ${d.name}`);
      }
    }
    console.log('');
  }

  // Hard failures: schema, banned claims, invented names, category dupes.
  const hardFail = totalSchemaErrors + totalBannedClaims + totalGrounding + totalCategoryDupes + totalSubway + totalEntrance;
  const softFail = args.strict && diversity.length > 0;

  if (hardFail > 0 || softFail) {
    if (!args.json) console.error(`FAIL — ${hardFail} hard finding(s)${softFail ? `, ${diversity.length} diversity warning(s)` : ''}`);
    process.exit(1);
  }
  if (!args.json) console.log('PASS — no findings');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Eval failed:', err.message);
    process.exit(2);
  }
}

module.exports = { parseArgs, main };
