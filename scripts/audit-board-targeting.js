#!/usr/bin/env node
/**
 * audit-board-targeting.js — "is the fleet's always-on automation actually
 * working the LIVE board?" (BRO-3423)
 *
 * On 2026-09-15 the answer was no, and had been no for two weeks: the crowned
 * dispatch watchdog spent its entire 12/day budget re-dispatching ids from the
 * retired Notion mirror while 122 of 137 armed Linear issues had never been
 * touched by automation at all. Nothing was watching, because "we migrated to
 * Linear" was a claim in prose that no scheduled job ever re-checked against
 * the running system. This is that scheduled re-check.
 *
 * THIS SCRIPT IS A PRINTER. Every decision lives in
 * scripts/lib/board-targeting-audit.js (pure) and every read in
 * scripts/lib/board-targeting-sources.js (I/O) — both under scripts/lib/**,
 * so both are covered by test.yml's push-path glob and the colocated unit-test
 * glob. Logic added HERE would get zero CI on a solo edit.
 *
 * The scheduled consumer is scripts/send-morning-digest.js, which calls the
 * same two modules directly and folds an 'error' verdict into
 * sections.health.errors — the field that drives the digest subject line, so a
 * mis-targeted fleet is loud on the first morning rather than one quiet line
 * in a block nobody reads. There is deliberately NO launchd plist for this
 * script: a separate Mac-local producer writing a snapshot the digest reads is
 * the exact shape that let backlog-drain's own metric sit dead and unnoticed
 * from 2026-08-31.
 *
 * Usage:
 *   node scripts/audit-board-targeting.js              human-readable report
 *   node scripts/audit-board-targeting.js --json       machine-readable
 *   node scripts/audit-board-targeting.js --no-network writer arm only (skip live-board query)
 *   node scripts/audit-board-targeting.js --window-days N
 *   --help, -h
 *
 * Exit: 0 = targeting the live board, 1 = mis-targeted (an 'error' verdict),
 *       2 = could not run.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  auditWriterBoards,
  auditLiveBoardCoverage,
  summarizeBoardTargeting,
  DEFAULT_WINDOW_DAYS,
} = require('./lib/board-targeting-audit.js');
const { readDispatchLedgers, fetchLiveBoardArmed } = require('./lib/board-targeting-sources.js');

const HELP = `audit-board-targeting — is the fleet's always-on automation working the LIVE board?

  node scripts/audit-board-targeting.js [--json] [--no-network] [--window-days N]

  --json          machine-readable output
  --no-network    writer arm only; skip the live-board coverage query
  --window-days N mix window for the writer arm (default ${DEFAULT_WINDOW_DAYS})

Exit 0 = healthy, 1 = mis-targeted, 2 = could not run.`;

function parseArgs(argv) {
  const args = { json: false, network: true, windowDays: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--no-network') args.network = false;
    else if (a === '--window-days') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--window-days needs a positive number, got ${argv[i + 1]}`);
        process.exit(2);
      }
      args.windowDays = n;
      i += 1;
    }
  }
  return args;
}

function pct(x) {
  return x == null ? '—' : `${Math.round(x * 100)}%`;
}

async function main() {
  if (hasHelpFlag(process.argv)) { console.log(HELP); return 0; }
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const { rows, everTouchedIds, problems, sources, blind, primaryLedger, primaryLastRowTs } = readDispatchLedgers({});

  const writerAudit = auditWriterBoards({ rows, now, windowDays: args.windowDays });

  let coverage = null;
  if (args.network) {
    const live = await fetchLiveBoardArmed({});
    coverage = auditLiveBoardCoverage({
      eligibleIds: live.eligibleIds,
      everTouchedIds,
      ok: live.ok,
      reason: live.reason,
    });
  }

  const row = summarizeBoardTargeting({ writerAudit, coverage, now, blind, primaryLedger, primaryLastRowTs });

  if (args.json) {
    console.log(JSON.stringify({ ...row, ledgers: sources, ledgerProblems: problems }, null, 2));
    return row.status === 'error' ? 1 : 0;
  }

  console.log(`Board targeting — ${row.details && row.details.blind ? 'NO EVIDENCE' : row.status === 'error' ? 'MIS-TARGETED' : 'OK'} (${args.windowDays}d window)`);
  console.log('');
  console.log(row.message);
  console.log('');
  console.log('Dispatch writers (by board ids written in window):');
  for (const w of writerAudit.writers) {
    const flag = w.verdict === 'fail' ? '  FAIL  ' : w.verdict === 'clearing' ? 'clearing' : w.verdict === 'insufficient-data' ? '  n/a   ' : '   ok   ';
    console.log(
      `  ${flag} ${w.event.padEnd(24)} board=${String(w.boardRows).padStart(4)}  live=${String(w.live).padStart(4)}  retired=${String(w.retired).padStart(4)}  retiredShare=${pct(w.retiredFraction).padStart(4)}  lastRow=${(w.lastRowTs || '—').slice(0, 16)}`
    );
    if (w.reason && w.verdict !== 'insufficient-data') console.log(`           ${w.reason}`);
  }
  if (writerAudit.exemptEvents.length) {
    console.log(`\n  exempt (reconciliation over history): ${writerAudit.exemptEvents.join(', ')}`);
  }

  if (coverage) {
    console.log('\nLive-board coverage:');
    if (coverage.verdict === 'unknown') {
      console.log(`  UNKNOWN — ${coverage.reason}`);
    } else {
      console.log(`  armed/eligible: ${coverage.eligibleCount}   never in any ledger: ${coverage.neverTouched} (${pct(coverage.neverTouchedFraction)})`);
      if (coverage.neverTouchedSample && coverage.neverTouchedSample.length) {
        console.log(`  sample never dispatched: ${coverage.neverTouchedSample.join(', ')}`);
      }
    }
  }

  console.log('\nLedgers read:');
  for (const s of sources) {
    console.log(`  ${s.present ? '✓' : '✗'} ${s.file}  rows=${s.rows}${s.lastRowTs ? `  last=${s.lastRowTs.slice(0, 16)}` : ''}`);
  }
  for (const p of problems) console.log(`  note: ${p}`);

  if (row.hint) console.log(`\nNext: ${row.hint}`);
  return row.status === 'error' ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => { console.error(`[board-targeting] ${err && err.stack ? err.stack : err}`); process.exit(2); });
}

module.exports = { parseArgs };
