#!/usr/bin/env node
/**
 * BRO-2075 — drain the unknown-outlet backlog via ingest-review-from-url.js --provisional.
 *
 *   node scripts/drain-unknown-outlets.js                 # dry-run: print the plan
 *   node scripts/drain-unknown-outlets.js --execute --hosts=cleveland.com,spokesman.com [--batch=50]
 *
 * --execute REQUIRES --hosts: only hosts a human vetted from the dry-run plan are ingested
 * (each registers a provisional outlet id; title-token pairing can still mis-pair tour stops).
 *
 * Checkpointed: each result is written to data/audit/unknown-outlet-drain-ledger.json right
 * after the ingest, so a re-run (or a crash mid-batch) never re-ingests a done (show,url).
 * Failures are recorded too and retried only with --retry-failed.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { planDrain } = require('./lib/drain-unknown-outlets');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(ROOT, 'data/audit/unknown-aggregator-outlets.json');
const LEDGER = path.join(ROOT, 'data/audit/unknown-outlet-drain-ledger.json');
const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log('Usage: node scripts/drain-unknown-outlets.js [--execute --hosts=a.com,b.com] [--batch=50] [--retry-failed]\nDry-run by default; --execute requires --hosts (vetted from the dry-run plan).');
  process.exit(0);
}
const execute = argv.includes('--execute');
const hostsArg = (argv.find(a => a.startsWith('--hosts=')) || '').split('=')[1];
const retryFailed = argv.includes('--retry-failed');
const batchSize = Number((argv.find(a => a.startsWith('--batch=')) || '--batch=50').split('=')[1]);
if (!Number.isInteger(batchSize) || batchSize < 1) { console.error('--batch must be a positive integer'); process.exit(2); }

const readJson = (p, d) => {
  if (!fs.existsSync(p)) return d;
  return JSON.parse(fs.readFileSync(p, 'utf8')); // corrupt file must throw: a silent {} ledger would re-ingest everything
};
const ledger = readJson(LEDGER, {});
const shows = readJson(path.join(ROOT, 'data/shows.json'), { shows: [] }).shows;
const showsById = Object.fromEntries(shows.map(s => [s.id, s]));
const effective = Object.fromEntries(Object.entries(ledger).filter(([, v]) => !(retryFailed && v.status === 'failed')));

const { batch, skipped, remaining } = planDrain(readJson(AUDIT, { outlets: [] }), showsById, { ledger: effective, batchSize });
console.log(`plan: ${batch.length} ingests (${remaining} more after this batch), ${skipped.length} skipped`);
for (const b of batch) console.log(`  ${b.showId}  ${b.outletId}  ${b.url}`);
if (execute && !hostsArg) { console.error('--execute requires --hosts=<comma list of vetted hosts from the dry-run plan>'); process.exit(2); }
if (!execute) { console.log('dry-run; pass --execute to ingest'); process.exit(0); }

const approved = new Set(hostsArg.split(',').map(h => h.trim().replace(/^www\./, '')));
for (const b of batch.filter(x => approved.has(x.host.replace(/^www\./, '')))) {
  const r = spawnSync(process.execPath, b.args, { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  // Exit 0 is not enough: ingest also exits 0 when it only queues a fetch-failure stub for retry.
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const queued = /Queued for retry/i.test(out);
  const status = r.status === 0 && !queued ? 'ok' : 'failed';
  ledger[b.key] = { status, at: new Date().toISOString(), outletId: b.outletId, exit: r.status, signal: r.signal || null, tail: status === 'ok' ? undefined : out.slice(-300) };
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n'); // checkpoint per URL
  console.log(`${status === 'ok' ? 'ok    ' : 'FAILED'} ${b.key}`);
}
