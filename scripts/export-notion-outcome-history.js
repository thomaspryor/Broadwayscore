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

  --corpus=<dir>   Sprint 2 corpus dir (default ~/broadway-scorecard-data/notion-corpus)
  --out=<path>     output file (default data/archive/notion-card-history.jsonl)
  --help, -h       this message`;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
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

  const { file, records, malformed } = readCorpusRecords(corpusDir);
  if (malformed) throw new Error(`${malformed} malformed corpus line(s) in ${file} — re-verify the archive before exporting`);

  const rows = buildOutcomeHistory(records);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));

  const doneCount = records.filter((r) => ((r.properties || {}).Status || '') === 'Done').length;
  console.error(`── notion outcome history export ─────────`);
  console.error(`  corpus                ${file}`);
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
