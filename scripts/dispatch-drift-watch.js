#!/usr/bin/env node
/**
 * dispatch-drift-watch.js — which in-flight sessions are running instructions
 * their card no longer shows? (card #1009)
 *
 * bsc-next seeds a session with its card ONCE. Correcting the card afterwards
 * reaches Notion and nothing else: the session keeps executing the original
 * text, and every human reading the card believes it is following the new one.
 * That happened on 2026-08-04 to task #1002 and was only caught because a
 * person happened to run `cmux send` by hand.
 *
 * This is the cheap watcher over the detector (scripts/lib/dispatch-card-drift.js):
 *   - reads the dispatch ledger, takes the still-in-flight launches
 *   - fetches each one's CURRENT card (one Notion read per in-flight session)
 *   - reports which are drifted, and why
 *
 * Modes:
 *   (default)   report only — exit 0 always
 *   --deliver   re-deliver the corrected card into each drifted session
 *               (bsc-next.js --id N --amend), then report what landed
 *   --alert     queue a Daily Digest line when anything is drifted
 *   --json      machine-readable output
 *   --max-age-hours N   how far back an un-terminated launch still counts (default 72)
 *   --limit N   cap the Notion reads (default 40)
 *
 * Read-only by default: no cmux writes, no card writes, no ledger writes.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const cardDrift = require('./lib/dispatch-card-drift.js');
// BRO-2603: dispatch-ledger.jsonl is one of the 7 ledgers BRO-385 froze for
// 30 days (2026-08-26 -> 2026-09-25) — gate the alert this script files so
// the freeze actually suppresses new cards instead of just documenting a
// decision nothing reads.
const { FROZEN_LEDGERS, isLedgerFrozenNow, freezeSkipMessage } = require('./freeze-ledgers.js');
const DISPATCH_LEDGER_NAME = FROZEN_LEDGERS.find((l) => l.endsWith('dispatch-ledger.jsonl'));

const REPO = path.join(__dirname, '..');

const USAGE = `dispatch-drift-watch — find sessions running instructions their card no longer shows

Usage:
  node scripts/dispatch-drift-watch.js [--deliver] [--alert] [--json]
                                       [--max-age-hours N] [--limit N]

  (default)            report only — reads the dispatch ledger + each in-flight card
  --deliver            re-deliver the current card into every drifted session
                       (runs: bsc-next.js --id N --amend)
  --alert              queue a Daily Digest line when anything is drifted
  --json               machine-readable output
  --max-age-hours N    un-terminated launches older than this are ignored (default 72)
  --limit N            cap Notion reads (default 40)
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function fetchCard(pageId) {
  try {
    const raw = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', pageId],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  } catch { return null; }
}

function amend(taskId) {
  try {
    const out = execFileSync('node', [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(taskId), '--amend'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message };
  }
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const args = parseArgs(argv);
  const maxAgeMs = (Number(args['max-age-hours']) > 0 ? Number(args['max-age-hours']) : 72) * 3600 * 1000;
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 40;

  const entries = dispatchLedger.readEntries();
  const launches = cardDrift.inFlightLaunches(entries, { maxAgeMs });

  // Newest first, capped: the Notion read is the only cost here, and a fresh
  // dispatch is both the likeliest to be corrected mid-flight and the one where
  // delivering the correction still changes the outcome. The cap is REPORTED
  // (never silently truncating — that reads as "everything is fine").
  const ordered = [...launches].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const examined = ordered.slice(0, limit);
  const skipped = ordered.length - examined.length;

  const cards = {};
  for (const l of examined) {
    if (!l.notionId) continue;
    cards[String(l.taskId)] = fetchCard(l.notionId);
  }

  const rows = examined.map(launch =>
    cardDrift.detectDrift({ launch, card: cards[String(launch.taskId)] || null, amendments: entries })
  );
  const summary = cardDrift.summarizeDrift(rows);

  const delivered = [];
  if (args.deliver) {
    for (const r of summary.driftedRows) {
      const res = amend(r.taskId);
      delivered.push({ taskId: r.taskId, ok: res.ok, detail: res.out.split('\n').slice(0, 3).join(' | ') });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ summary: { ...summary, driftedRows: undefined }, rows, delivered, skipped }, null, 2));
  } else {
    console.log(summary.line);
    if (skipped > 0) console.log(`  (${skipped} older in-flight launch(es) beyond --limit ${limit} were NOT examined)`);
    for (const r of rows) {
      if (r.status === cardDrift.STATUS.NO_DRIFT) continue;
      const mark = r.status === cardDrift.STATUS.DRIFTED ? '🔴' : (r.status === cardDrift.STATUS.AMENDED ? '✅' : '❓');
      console.log(`  ${mark} #${r.taskId} ${r.workspaceRef || '(no ref)'} [${r.status}${r.confidence ? `/${r.confidence}` : ''}] ${r.subject || ''}`);
      console.log(`     ${r.reason}`);
      if (r.status === cardDrift.STATUS.DRIFTED) console.log(`     deliver it: node scripts/bsc-next.js --id ${r.taskId} --amend`);
    }
    for (const d of delivered) {
      console.log(`  ${d.ok ? 'delivered' : 'FAILED  '} → #${d.taskId}: ${d.detail}`);
    }
  }

  // Alert on PROVEN drift only. Every launch predating card #1009 carries no
  // content hash, so the timestamp-only signal fires on any property edit
  // (status flip, tag, a sync write) — 7 of 8 in-flight launches on the day
  // this shipped. Paging the owner on that would train the digest to be
  // ignored; the weak rows are still printed here and listed in the alert body
  // whenever a proven one gets the alert sent.
  if (args.alert && summary.exact > 0 && isLedgerFrozenNow(DISPATCH_LEDGER_NAME)) {
    console.log(`[dispatch-drift-watch] ${freezeSkipMessage(DISPATCH_LEDGER_NAME)} — skipping alert`);
  } else if (args.alert && summary.exact > 0) {
    try {
      const { routeAlert } = require('./lib/owner-alert-router.js');
      await routeAlert({
        conditionKey: 'dispatch-card-drift:in-flight',
        title: `${summary.exact} session(s) running stale card instructions (${summary.weak} more suspected)`,
        description: `${summary.line}\n\n` + summary.driftedRows
          .map(r => `#${r.taskId} (${r.workspaceRef}) [${r.confidence}]: ${r.reason}`).join('\n'),
        hint: 'Re-deliver with: node scripts/bsc-next.js --id <taskId> --amend',
        severity: 'warning',
        disposition: 'digest',
        cooldownHours: 6,
      });
    } catch (e) {
      console.error(`[dispatch-drift-watch] alert routing failed (non-fatal): ${e.message}`);
    }
  }

  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; })
    .catch(e => { console.error(`[dispatch-drift-watch] ${e.stack || e.message}`); process.exitCode = 1; });
}

module.exports = { main, parseArgs, USAGE };
