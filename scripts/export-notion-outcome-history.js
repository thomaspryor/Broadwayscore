#!/usr/bin/env node
/**
 * export-notion-outcome-history.js — extract the Outcome knowledge on every
 * Notion card BRO-376's import will NOT create as a live Linear issue, before
 * that card is archived in Notion (ADDED 2026-08-17 to BRO-376).
 *
 * Reads the same frozen, hash-verified Sprint 2 corpus the importer itself
 * reads from (scripts/lib/notion-corpus-io.js) rather than querying Notion
 * live — the corpus already carries the fully reassembled Outcome text
 * (overflow-recovered, see scripts/lib/notion-corpus.js), and reading it keeps
 * this export answerable against the exact same source the import decision
 * was made from.
 *
 * Writes one JSON object per line to --out (default
 * data/archive/notion-card-history.jsonl), sorted by pageId for a
 * deterministic, greppable, git-diffable file — exactly like cloud-memory/
 * already is.
 *
 * Usage:
 *   node scripts/export-notion-outcome-history.js [--corpus=<dir>] [--out=<path>]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readCorpusRecords } = require('./lib/notion-corpus-io');
const { buildOutcomeHistory } = require('./lib/notion-outcome-history');
const { hasHelpFlag } = require('./lib/cli-help');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_CORPUS = path.join(os.homedir(), 'broadway-scorecard-data/notion-corpus');
const DEFAULT_OUT = path.join(REPO_ROOT, 'data/archive/notion-card-history.jsonl');

const USAGE = `export-notion-outcome-history.js — extract Outcome knowledge from cards leaving the live board.

  --corpus=<dir>       Sprint 2 corpus dir (default ~/broadway-scorecard-data/notion-corpus)
  --out=<path>         output file (default data/archive/notion-card-history.jsonl)
  --skip-manifest-check  proceed even if the corpus has no manifest.json to verify against
                         (fixtures / standalone files in tests — never for the real corpus)
  --help, -h           this message`;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

/**
 * Refuse to trust a corpus that cannot prove it is complete.
 *
 * readCorpusRecords() only checks that every line PARSES — it says nothing
 * about whether the export itself finished cleanly. A stale-but-valid partial
 * raw corpus.ndjson (left over from a killed run) parses perfectly and
 * produces a smaller-but-"successful" history that silently overwrites the
 * real 2,799-row archive with fewer rows — exactly the failure class
 * export-notion-corpus.js's own manifest was built to make checkable
 * (adversarial review, BRO-376). This is the same check that script's own
 * `partial`/`errorCount` fields exist for; reusing the manifest here rather
 * than re-deriving trust from record count alone, which cannot distinguish
 * "the board actually shrank" from "the export was cut short".
 */
function verifyCorpusManifest(corpusDir, records, { skip }) {
  const manifestPath = path.join(corpusDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    if (skip) return { checked: false, reason: 'no manifest.json — --skip-manifest-check set' };
    throw new Error(
      `no manifest.json found at ${manifestPath} — cannot verify this corpus is a complete, non-partial export. ` +
        `Pass --skip-manifest-check only for test fixtures, never for the real corpus.`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.partial) {
    throw new Error(`corpus at ${corpusDir} is PARTIAL (manifest.partial=true) — re-export with export-notion-corpus.js before trusting it`);
  }
  if (manifest.errorCount) {
    throw new Error(`corpus at ${corpusDir} has ${manifest.errorCount} recorded export error(s) — re-export before trusting it`);
  }
  if (typeof manifest.pagesExported === 'number' && manifest.pagesExported !== records.length) {
    throw new Error(
      `corpus record count mismatch: manifest says ${manifest.pagesExported} pages exported, but read ${records.length} — ` +
        `the raw corpus.ndjson may be stale relative to the manifest. Re-export or point --corpus at the published .gz.`
    );
  }
  return { checked: true, manifest };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const corpusDir = args.corpus || DEFAULT_CORPUS;
  const outPath = args.out || DEFAULT_OUT;
  const skipManifestCheck = args['skip-manifest-check'] === true || args['skip-manifest-check'] === 'true';

  const { file, records, malformed } = readCorpusRecords(corpusDir);
  if (malformed) throw new Error(`${malformed} malformed corpus line(s) in ${file} — re-verify the archive before exporting`);

  // `--corpus` may be a directory (the default) OR a direct file path — this
  // export's own error message for a count mismatch tells the user to "point
  // --corpus at the published .gz" (a FILE), and the earlier version of this
  // check only ran when corpusDir was literally a directory, so following
  // that advice silently skipped every manifest protection it exists to
  // provide (code review finding). manifest.json always lives in the
  // corpus's DIRECTORY regardless of which form the user passed.
  const manifestDir = fs.existsSync(corpusDir) && fs.statSync(corpusDir).isDirectory()
    ? corpusDir
    : path.dirname(corpusDir);
  const manifestResult = verifyCorpusManifest(manifestDir, records, { skip: skipManifestCheck });

  const rows = buildOutcomeHistory(records);

  // Atomic write: a temp file + rename, matching export-notion-corpus.js's
  // own pattern. Without it, a killed process (ctrl-C, OOM) mid-write leaves
  // the canonical, git-tracked archive truncated with no signal that it
  // happened (adversarial review, BRO-376).
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  fs.renameSync(tmpPath, outPath);

  const doneCount = records.filter((r) => ((r.properties || {}).Status || '') === 'Done').length;
  console.error(`── notion outcome history export ─────────`);
  console.error(`  corpus                ${file}`);
  console.error(`  manifest check        ${manifestResult.checked ? 'OK (non-partial, 0 errors, count matches)' : `SKIPPED — ${manifestResult.reason}`}`);
  console.error(`  records               ${records.length}`);
  console.error(`  Done cards            ${doneCount}`);
  console.error(`  extracted (archived + non-empty outcome)  ${rows.length}`);
  console.error(`  → ${outPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

module.exports = { main };
