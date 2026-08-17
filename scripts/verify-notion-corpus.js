#!/usr/bin/env node
/**
 * verify-notion-corpus.js — prove a Notion corpus export is complete, by
 * character volume rather than card count (S2-T5 of
 * sprint-plan-notion-linear-cutover.md).
 *
 * WHY VOLUME. The documented way this migration goes wrong is an export that
 * succeeds and is wrong: it enumerates every card, reports the right number,
 * exits 0, and has silently truncated the longest ones — because ~2,183 cards
 * keep most of their text in the page body and a property-only read looks
 * identical to a complete one at the record level. Record count cannot detect
 * that. Per-field character totals can, and nothing else in the pipeline does.
 *
 * THE BASELINE IS MEASURED, NOT CARRIED. The sprint plan quotes per-field
 * baselines (Notes ≈5.26M and friends); do not assert against them. They were
 * computed the way Sprint 0 computed its per-card total, which double-counts
 * the property preview on top of a body that already contains it — re-measured
 * by hand on the S0-T1 card as 4,547, not 6,251. Asserting a correct export
 * against an inflated baseline reports data loss that did not happen, and a
 * verifier that cries wolf is worse than none. So: --write-baseline records
 * what a known-good export actually contains, and every later run asserts
 * against that file.
 *
 * Usage:
 *   node scripts/verify-notion-corpus.js --dir=<export dir> [--write-baseline]
 *        [--baseline=<path>] [--tolerance=0.02] [--live] [--json]
 *
 *   --dir             export directory (contains corpus.ndjson + manifest.json)
 *   --write-baseline  record this export's volume as the baseline and exit 0
 *   --baseline        baseline file (default <dir>/../corpus-baseline.json)
 *   --tolerance       how far BELOW baseline is tolerated (default 0.02 = 2%)
 *   --live            also re-count pages against the live board
 *   --json            machine-readable output
 *
 * Exit 0 only if every check passes.
 */

require('./lib/load-env').loadEnv();

const fs = require('node:fs');
const path = require('node:path');
const corpus = require('./lib/notion-corpus');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `verify-notion-corpus.js — assert an export by character volume, not card count.

  --dir=<dir>        export directory (corpus.ndjson + manifest.json)
  --write-baseline   record this export's volume as the baseline, then exit 0
  --baseline=<path>  baseline file (default <dir>/../corpus-baseline.json)
  --tolerance=N      fraction BELOW baseline tolerated (default 0.02)
  --live             also re-count pages against the live Notion board
  --json             machine-readable output
  --help, -h         this message`;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

// IDs, not a count. A count can only be compared by equality, and equality
// against a board that gains cards during the ~60-minute export can never
// hold. Containment answers the question that actually matters.
async function livePageIds() {
  const { Client } = require('@notionhq/client');
  const { BRAIN_DATABASE_ID, NOTION_VERSION } = require('./lib/notion-constants');
  const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: NOTION_VERSION });
  let cursor;
  const ids = [];
  do {
    const r = await notion.dataSources.query({
      data_source_id: BRAIN_DATABASE_ID,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const p of r.results) ids.push(p.id);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return ids;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  if (!args.dir) {
    console.error(USAGE);
    process.exit(1);
  }

  const corpusPath = path.join(args.dir, 'corpus.ndjson');
  const manifestPath = path.join(args.dir, 'manifest.json');
  if (!fs.existsSync(corpusPath)) {
    console.error(`❌ no corpus at ${corpusPath}`);
    process.exit(1);
  }

  const records = [];
  let malformed = 0;
  for (const line of fs.readFileSync(corpusPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;

  const baselinePath = args.baseline || path.join(path.dirname(path.resolve(args.dir)), 'corpus-baseline.json');

  if (args['write-baseline']) {
    const volume = corpus.charVolume(records);
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify(
        {
          // Provenance matters more than the numbers: whoever reads a future
          // failure needs to know which export minted this floor.
          measuredFrom: path.resolve(corpusPath),
          measuredAt: new Date().toISOString(),
          records: volume.records,
          totals: volume.totals,
        },
        null,
        2
      )}\n`
    );
    console.error(`✅ baseline written to ${baselinePath}`);
    console.error(JSON.stringify(corpus.charVolume(records), null, 2));
    return;
  }

  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  const live = args.live ? await livePageIds() : null;

  const result = corpus.verifyCorpus({
    records,
    manifest,
    baseline,
    tolerance: args.tolerance ? Number(args.tolerance) : 0.02,
    livePageIds: live,
  });
  if (malformed) {
    result.checks.unshift({ name: 'every line parses as JSON', ok: false, detail: `${malformed} malformed` });
    result.ok = false;
  }
  if (!baseline) {
    result.checks.push({
      name: 'a baseline exists to compare against',
      ok: false,
      detail: `none at ${baselinePath} — run once with --write-baseline against a known-good export`,
    });
    result.ok = false;
  }

  if (args.json) {
    console.log(JSON.stringify({ ...result, baselinePath }, null, 2));
  } else {
    console.log('── corpus verification ─────────────────────────────');
    console.log(`  records         ${result.volume.records.toLocaleString()}`);
    for (const [k, v] of Object.entries(result.volume.totals)) {
      console.log(`  chars ${k.padEnd(11)} ${v.toLocaleString()}`);
    }
    console.log('');
    for (const c of result.checks) {
      console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    console.log('');
    console.log(result.ok ? '✅ corpus verified.' : '❌ corpus FAILED verification.');
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
