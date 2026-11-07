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
 *   --baseline        baseline file (default <dir>/corpus-baseline.json, else <dir>/../)
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
const corpusIo = require('./lib/notion-corpus-io');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `verify-notion-corpus.js — assert an export by character volume, not card count.

  --dir=<dir>        export directory (corpus.ndjson + manifest.json)
  --write-baseline   record this export's volume as the baseline, then exit 0
  --baseline=<path>  baseline file (default <dir>/corpus-baseline.json, else <dir>/../)
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
  const rows = [];
  do {
    const r = await notion.dataSources.query({
      data_source_id: BRAIN_DATABASE_ID,
      page_size: 100,
      start_cursor: cursor,
    });
    // created_time as well as id: it is what lets the verifier separate "made
    // while the export was running" from "existed and got skipped".
    for (const p of r.results) rows.push({ id: p.id, createdTime: p.created_time || null });
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return rows;
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

  // The PUBLISHED corpus is gzipped (95MB raw would break GitHub's 100MB blob
  // limit on the next export). Read either form, so the archive can be verified
  // as published rather than only in its working directory — a verifier that
  // cannot read the artifact it certifies is not much of a verifier.
  const manifestPath = path.join(args.dir, 'manifest.json');
  let corpusPath;
  let records;
  let malformed;
  try {
    // Same locate-and-read as every other corpus consumer. This logic used to
    // live here and ONLY here, which is how migrate-import-ledger.js ended up
    // with a copy that could not see the published gz.
    ({ file: corpusPath, records, malformed } = corpusIo.readCorpusRecords(args.dir));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;

  // Two layouts, and the default has to find both.
  //
  //   WORKING RUNS  <runs-dir>/run-a/          baseline at <runs-dir>/corpus-baseline.json
  //                 <runs-dir>/run-b/          (a sibling, shared by both runs)
  //   PUBLISHED     <dest>/notion-corpus/      baseline INSIDE it — promote-notion-corpus.sh:125
  //                                            copies it in so the archive is self-contained
  //
  // Only the sibling form was resolved, so verifying the PUBLISHED archive —
  // the thing anyone who is not the exporting session will ever point this at,
  // including from a fresh clone — looked in the wrong directory, found no
  // baseline, and failed the run (exit 1) with "none at <path>". The archive was
  // fine; the lookup was not. In-dir first, because that is the self-contained
  // one and cannot belong to a different export.
  const inDirBaseline = path.join(path.resolve(args.dir), 'corpus-baseline.json');
  const siblingBaseline = path.join(path.dirname(path.resolve(args.dir)), 'corpus-baseline.json');
  const baselinePath =
    args.baseline ||
    (fs.existsSync(inDirBaseline) && !args['write-baseline'] ? inDirBaseline : siblingBaseline);

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
