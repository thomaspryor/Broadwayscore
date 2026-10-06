#!/usr/bin/env node
/**
 * BRO-2075 — drain the unknown-outlet backlog via ingest-review-from-url.js --provisional.
 *
 *   node scripts/drain-unknown-outlets.js                 # dry-run: print the plan
 *   node scripts/drain-unknown-outlets.js --execute [--batch=50]
 *
 * Checkpointed: each result is written to data/audit/unknown-outlet-drain-ledger.json right
 * after the ingest, so a re-run (or a crash mid-batch) never re-ingests a done (show,url).
 * Failures are recorded too and retried only with --retry-failed.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { planDrain } = require('./lib/drain-unknown-outlets');

const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(ROOT, 'data/audit/unknown-aggregator-outlets.json');
const LEDGER = path.join(ROOT, 'data/audit/unknown-outlet-drain-ledger.json');
const argv = process.argv.slice(2);
const execute = argv.includes('--execute');
const retryFailed = argv.includes('--retry-failed');
const batchSize = Number((argv.find(a => a.startsWith('--batch=')) || '--batch=50').split('=')[1]);

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const ledger = readJson(LEDGER, {});
const shows = readJson(path.join(ROOT, 'data/shows.json'), { shows: [] }).shows;
const showsById = Object.fromEntries(shows.map(s => [s.id, s]));
const effective = Object.fromEntries(Object.entries(ledger).filter(([, v]) => !(retryFailed && v.status === 'failed')));

const { batch, skipped, remaining } = planDrain(readJson(AUDIT, { outlets: [] }), showsById, { ledger: effective, batchSize });
console.log(`plan: ${batch.length} ingests (${remaining} more after this batch), ${skipped.length} skipped`);
for (const b of batch) console.log(`  ${b.showId}  ${b.outletId}  ${b.url}`);
if (!execute) { console.log('dry-run; pass --execute to ingest'); process.exit(0); }

for (const b of batch) {
  const r = spawnSync('node', b.args, { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  ledger[b.key] = { status: r.status === 0 ? 'ok' : 'failed', at: new Date().toISOString(), outletId: b.outletId };
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n'); // checkpoint per URL
  console.log(`${r.status === 0 ? 'ok    ' : 'FAILED'} ${b.key}`);
}
