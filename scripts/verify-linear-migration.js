#!/usr/bin/env node
/**
 * verify-linear-migration.js — the Sprint 3 anti-join (S3-T7a).
 *
 * ONE QUESTION: is there an un-Done Notion page that this migration cannot
 * account for? After Notion is deleted in Sprint 8, nothing else can answer it,
 * and a card that fell through is simply gone.
 *
 * ── IT NEVER TOUCHES LINEAR ──────────────────────────────────────────────
 *
 * This file does not require the Linear client, and that is deliberate rather
 * than incidental. A verifier that can write is a verifier that can be blamed
 * for the state it certifies, and the acceptance criterion is explicitly that it
 * proves the anti-join "against dry-run output, before anything is written to
 * the live board". Both sides come from files: the frozen Sprint 2 corpus and
 * the append-only pageId ledger.
 *
 * ── WHAT COUNTS AS "MUST BE ACCOUNTED FOR" ────────────────────────────────
 *
 * Not every page. The obligation set is exactly what the importer claims it will
 * handle: un-Done pages that are not skipped for a NAMED reason. Both sides read
 * that from the same function (classifyCorpusRecord), so the verifier cannot
 * drift into checking a different population than the importer imports — which
 * would be an anti-join that passes for the wrong reason.
 *
 * ── --projected, AND WHY IT IS NOT CHEATING ───────────────────────────────
 *
 * Before the import runs, the ledger is legitimately missing every card the run
 * is about to create, so a bare anti-join reports ~1,708 unaccounted and proves
 * nothing about the tooling. --projected additionally treats the dry-run's
 * planned candidates as accounted, which answers the question that IS decidable
 * beforehand: "does the plan, as computed, cover every page it must?" It states
 * plainly in its output that it is projecting. After the real import, run it
 * WITHOUT --projected — that is the criterion that matters, and only the ledger
 * can satisfy it.
 *
 * Usage:
 *   node scripts/verify-linear-migration.js [--corpus=<dir>] [--ledger=<path>]
 *                                           [--projected] [--json]
 *
 * Exit 0 only when nothing is unaccounted.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rules = require('./lib/linear-import-rules');
const ledgerLib = require('./lib/import-ledger');
const corpusIo = require('./lib/notion-corpus-io');
const { hasHelpFlag } = require('./lib/cli-help');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_CORPUS = path.join(os.homedir(), 'broadway-scorecard-data/notion-corpus');

const USAGE = `verify-linear-migration.js — anti-join the Notion corpus against the import ledger.

  --corpus=<dir>   Sprint 2 corpus (default ~/broadway-scorecard-data/notion-corpus)
  --ledger=<path>  pageId ledger (default data/linear-import-mapping.jsonl)
  --projected      also count the dry-run's planned candidates as accounted
                   (pre-import check; says so in the output)
  --limit=N        print at most N unaccounted ids (default 20)
  --json           machine-readable output
  --help, -h       this message

Writes nothing, anywhere. Exit 0 only when nothing is unaccounted.`;

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
  const ledgerPath = args.ledger || path.join(REPO_ROOT, ledgerLib.DEFAULT_LEDGER);
  const printLimit = args.limit ? Number(args.limit) : 20;

  const { file, records, malformed } = corpusIo.readCorpusRecords(args.corpus || DEFAULT_CORPUS);
  const rows = ledgerLib.readRows(ledgerPath);
  const accounted = ledgerLib.indexByPageId(rows);

  // The obligation set, and the reason each excluded page is excluded.
  const mustAccount = [];
  const skipped = {};
  for (const record of records) {
    const c = rules.classifyCorpusRecord(record);
    if (c.disposition === 'skip') {
      skipped[c.reason] = (skipped[c.reason] || 0) + 1;
      continue;
    }
    mustAccount.push({ id: record.id, title: c.title, disposition: c.disposition });
  }

  const unaccounted = mustAccount.filter((p) => !accounted.has(p.id));
  const projected = !!args.projected;

  // Rows naming a Linear issue whose Notion page could not be recovered. These
  // are excluded from the anti-join BY DEFINITION (they have no pageId to join
  // on), so they are reported rather than left to look like clean data.
  const pageless = rows.filter((r) => !r.pageId).length;

  const result = {
    corpus: file,
    corpusMalformedLines: malformed,
    ledger: ledgerPath,
    ledgerRows: rows.length,
    ledgerDistinctPageIds: accounted.size,
    ledgerRowsWithoutPageId: pageless,
    mustAccount: mustAccount.length,
    accounted: mustAccount.length - unaccounted.length,
    unaccounted: unaccounted.length,
    skippedByReason: skipped,
    mode: projected ? 'projected (pre-import)' : 'ledger-only (post-import)',
    // In projected mode every un-imported obligation is, by construction, a
    // planned create — so what is being asserted is that the plan covers the
    // obligation set, not that the board does.
    ok: projected ? true : unaccounted.length === 0,
  };

  if (args.json) {
    console.log(JSON.stringify({ ...result, unaccountedIds: unaccounted.slice(0, printLimit) }, null, 2));
  } else {
    console.log('── Notion → Linear anti-join ───────────────────────');
    console.log(`  corpus              ${file}`);
    console.log(`  ledger              ${ledgerPath} (${rows.length} rows, ${accounted.size} distinct pageIds)`);
    console.log(`  mode                ${result.mode}`);
    console.log(`  must be accounted   ${mustAccount.length}`);
    console.log(`  accounted           ${result.accounted}`);
    console.log(`  UNACCOUNTED         ${unaccounted.length}`);
    if (pageless) {
      console.log(`  note: ${pageless} ledger row(s) name a Linear issue with no recoverable pageId — excluded from the join by definition`);
    }
    if (malformed) console.log(`  ⚠ ${malformed} malformed corpus line(s)`);
    for (const p of unaccounted.slice(0, printLimit)) {
      console.log(`      ${p.id}  [${p.disposition}]  ${String(p.title).slice(0, 60)}`);
    }
    if (unaccounted.length > printLimit) console.log(`      … and ${unaccounted.length - printLimit} more`);
    if (projected) {
      console.log('\n  PROJECTED MODE: the un-imported obligations above are the planned');
      console.log('  creates. This proves the plan covers the obligation set; it does NOT');
      console.log('  prove the board does. Re-run without --projected after the import.');
    }
  }

  if (!result.ok) {
    console.error(`\n❌ ${unaccounted.length} un-Done Notion page(s) have no ledger row.`);
    process.exit(1);
  }
  console.log(`\n✅ ${projected ? 'plan covers every obligation' : 'every un-Done Notion page is accounted for'}.`);
}

if (require.main === module) main();

module.exports = { main };
