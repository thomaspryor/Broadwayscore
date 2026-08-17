#!/usr/bin/env node
/**
 * migrate-import-ledger.js — re-key the Notion→Linear import ledger from local
 * mirror task id to Notion pageId, as append-only JSONL (S3-T2 of
 * sprint-plan-notion-linear-cutover.md).
 *
 * A SEPARATE SCRIPT, not a flag on linear-import.js. The plan filed this under
 * "linear-import.js (modify)", but a one-shot data migration and a repeatable
 * importer are different things with different failure modes: this runs once,
 * must be idempotent, and must be auditable line by line, whereas the importer
 * runs for hours and writes to a live board. Keeping them apart means a bug in
 * this can never be reached by an import run, and vice versa.
 *
 * WHY THE OLD KEY DOES NOT WORK. data/linear-import-mapping.json is keyed by
 * local mirror task id. The mirror only ever held a subset of the board (it
 * syncs P0/P1 and in-progress), so the ~1,700 cards Sprint 3 migrates have no
 * key in it at all — and measured on 2026-08-17, 50 of its 255 rows point at
 * mirror files that have since been pruned, plus 17 whose mirror record carries
 * no [notion:] marker. 188 of 255 resolve from the mirror alone.
 *
 * RECOVERY FOR THE REST. With --corpus, the remaining rows are matched by TITLE
 * against the Sprint 2 corpus, and accepted ONLY when exactly one page carries
 * that title. Ambiguous titles are left unresolved on purpose: distinct cards
 * legitimately share titles (three "main red" P0s), which is the same fact that
 * makes S3-T3 delete the importer's exact-title dedupe. Guessing here would
 * quietly bind a Linear issue to the wrong Notion page, which is worse than an
 * honest null.
 *
 * Unresolved rows are still WRITTEN. They name real Linear issues that really
 * exist; dropping them would satisfy a pageId-shaped ledger while losing work.
 * They are counted, listed, and excluded from the anti-join by definition.
 *
 * Usage:
 *   node scripts/migrate-import-ledger.js [--corpus=<dir-or-ndjson>] [--out=<path>]
 *                                         [--legacy=<path>] [--apply] [--json]
 *
 * Dry-run by default. --apply writes the JSONL.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledgerLib = require('./lib/import-ledger');
const { extractNotionId } = require('./lib/linear-import-rules');
const { hasHelpFlag } = require('./lib/cli-help');

const REPO_ROOT = path.join(__dirname, '..');
const MIRROR_DIR =
  process.env.LINEAR_IMPORT_MIRROR_DIR || path.join(os.homedir(), '.claude/tasks/broadwayscore');

const USAGE = `migrate-import-ledger.js — re-key the import ledger to Notion pageId, append-only.

  --corpus=<path>   Sprint 2 corpus dir or corpus.ndjson, for title recovery of
                    rows whose mirror file has been pruned
  --legacy=<path>   legacy mapping (default data/linear-import-mapping.json)
  --out=<path>      output JSONL (default data/linear-import-mapping.jsonl)
  --apply           actually write (dry-run otherwise)
  --json            machine-readable summary
  --help, -h        this message`;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

/** taskId -> notion pageId, from the local mirror's [notion:<id>] marker. */
function mirrorPageIds() {
  const out = new Map();
  if (!fs.existsSync(MIRROR_DIR)) return out;
  for (const f of fs.readdirSync(MIRROR_DIR)) {
    if (!f.endsWith('.json')) continue;
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(MIRROR_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    const id = extractNotionId(task.description || '');
    if (id) out.set(path.basename(f, '.json'), id);
  }
  return out;
}

/**
 * title -> pageId, but ONLY for titles that are unique in the corpus. A title
 * shared by two pages maps to nothing rather than to one of them.
 */
function corpusTitleIndex(corpusArg) {
  const file =
    corpusArg && fs.existsSync(corpusArg) && fs.statSync(corpusArg).isDirectory()
      ? path.join(corpusArg, 'corpus.ndjson')
      : corpusArg;
  if (!file || !fs.existsSync(file)) return { unique: new Map(), ambiguous: new Set(), pages: 0 };
  const counts = new Map();
  const first = new Map();
  let pages = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    pages++;
    const title = (rec.properties && rec.properties.Name) || '';
    if (!title) continue;
    counts.set(title, (counts.get(title) || 0) + 1);
    if (!first.has(title)) first.set(title, rec.id);
  }
  const unique = new Map();
  const ambiguous = new Set();
  for (const [title, n] of counts) {
    if (n === 1) unique.set(title, first.get(title));
    else ambiguous.add(title);
  }
  return { unique, ambiguous, pages };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const legacyPath = args.legacy || path.join(REPO_ROOT, ledgerLib.LEGACY_LEDGER);
  const outPath = args.out || path.join(REPO_ROOT, ledgerLib.DEFAULT_LEDGER);

  if (!fs.existsSync(legacyPath)) {
    console.error(`❌ no legacy mapping at ${legacyPath}`);
    process.exit(1);
  }
  const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));

  const fromMirror = mirrorPageIds();
  const titles = corpusTitleIndex(args.corpus);

  const via = { mirror: 0, corpusTitle: 0, none: 0 };
  const ambiguousHits = [];
  const resolve = (taskId, entry) => {
    const m = fromMirror.get(String(taskId));
    if (m) {
      via.mirror++;
      return m;
    }
    const title = entry && entry.title;
    if (title && titles.unique.has(title)) {
      via.corpusTitle++;
      return titles.unique.get(title);
    }
    if (title && titles.ambiguous.has(title)) ambiguousHits.push({ taskId, title, identifier: entry.identifier });
    via.none++;
    return null;
  };

  const { rows, unresolved } = ledgerLib.migrateLegacy(legacy, resolve);

  // Nothing may be lost. Checked by BRO identifier, which is what the
  // acceptance criterion names, because it is the key that survives whether or
  // not a pageId could be recovered.
  const legacyIdents = new Set(Object.values(legacy).map((e) => e && e.identifier).filter(Boolean));
  const rowIdents = ledgerLib.indexByIdentifier(rows);
  const lost = [...legacyIdents].filter((i) => !rowIdents.has(i));
  const dupPageIds = (() => {
    const seen = new Map();
    const dupes = [];
    for (const r of rows) {
      if (!r.pageId) continue;
      if (seen.has(r.pageId)) dupes.push({ pageId: r.pageId, a: seen.get(r.pageId), b: r.identifier });
      seen.set(r.pageId, r.identifier);
    }
    return dupes;
  })();

  const summary = {
    legacyEntries: Object.keys(legacy).length,
    legacyIdentifiers: legacyIdents.size,
    rowsWritten: rows.length,
    identifiersLost: lost,
    resolvedVia: via,
    unresolved: unresolved.length,
    corpusPages: titles.pages,
    ambiguousTitleHits: ambiguousHits.length,
    duplicatePageIds: dupPageIds,
    out: outPath,
    applied: !!args.apply,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, unresolved, ambiguousHits }, null, 2));
  } else {
    console.log('── import ledger migration ─────────────────────────');
    console.log(`  legacy entries        ${summary.legacyEntries} (${summary.legacyIdentifiers} distinct BRO ids)`);
    console.log(`  rows to write         ${summary.rowsWritten}`);
    console.log(`  resolved via mirror   ${via.mirror}`);
    console.log(`  resolved via corpus   ${via.corpusTitle}${titles.pages ? '' : '  (no --corpus given)'}`);
    console.log(`  unresolved (pageId=null) ${summary.unresolved}`);
    if (ambiguousHits.length) {
      console.log(`  ⚠ ${ambiguousHits.length} left unresolved because their title is shared by >1 page:`);
      for (const a of ambiguousHits.slice(0, 10)) console.log(`      ${a.identifier}  ${a.title.slice(0, 70)}`);
    }
    if (dupPageIds.length) {
      console.log(`  ⚠ ${dupPageIds.length} pageId(s) claimed by more than one Linear issue:`);
      for (const d of dupPageIds.slice(0, 10)) console.log(`      ${d.pageId}  ${d.a} vs ${d.b}`);
    }
    console.log(`  identifiers lost      ${lost.length}${lost.length ? ` — ${lost.join(', ')}` : ''}`);
  }

  if (lost.length) {
    console.error('\n❌ refusing to write: the migration would lose Linear issues.');
    process.exit(1);
  }

  if (!args.apply) {
    console.log('\n(dry run — pass --apply to write)');
    return;
  }

  if (fs.existsSync(outPath)) {
    // Append-only means append-only. Re-running the migration on top of an
    // existing ledger would double every legacy row; a caller who really wants
    // to redo it should move the old file aside deliberately.
    console.error(`\n❌ ${outPath} already exists. Move it aside first — this file is append-only by contract.`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const stats = ledgerLib.ledgerStats(outPath);
  console.log(`\n✅ wrote ${outPath}`);
  console.log(`   ${JSON.stringify(stats)}`);
  if (stats.rows !== rows.length || stats.malformed) {
    console.error('❌ read-back mismatch');
    process.exit(1);
  }
}

main();
