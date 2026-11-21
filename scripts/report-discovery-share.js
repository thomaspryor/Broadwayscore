#!/usr/bin/env node
'use strict';

/**
 * report-discovery-share.js — weekly per-pipeline discovery share + _pending growth (BRO-7934).
 *
 *   node scripts/report-discovery-share.js [--review-texts=PATH] [--days=7] [--dry-run] [--json]
 *
 * Prints which pipeline produced the review files of the last N days (and all time), the share that came
 * from backstop gap audits (primary discovery missed them), and files recorded with no caller. Appends
 * today's _pending count to data/audit/pending-growth-ledger.jsonl and routes a digest alert when it grows.
 * Files created after CALLER_REQUIRED_FROM with no caller route `discovery-caller-missing`.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { discoveryShare, pendingGrowthVerdict, pipelineOf } = require('./lib/discovery-share');

const REPO_ROOT = path.join(__dirname, '..');
const PENDING_LEDGER = path.join(REPO_ROOT, 'data', 'audit', 'pending-growth-ledger.jsonl');
const SNAPSHOT = path.join(REPO_ROOT, 'data', 'audit', 'discovery-share-latest.json');
// ingest-review-from-url.js started requiring --caller on this date (BRO-7934).
const CALLER_REQUIRED_FROM = '2026-11-22';

function parseArgs(argv) {
  const o = { reviewTexts: path.join(REPO_ROOT, 'data', 'review-texts'), days: 7, dryRun: false, json: false };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--review-texts=(.+)$/))) o.reviewTexts = m[1];
    else if ((m = a.match(/^--days=(\d+)$/))) o.days = Number(m[1]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
  }
  return o;
}

function scan(root) {
  const files = [];
  let pending = 0;
  let showDirs = 0;
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir);
    let entries;
    try { if (!fs.statSync(p).isDirectory()) continue; entries = fs.readdirSync(p); } catch { continue; }
    if (dir === '_pending') {
      // _pending/<show-id>/<file>.json: count the files, not the show folders.
      for (const sub of entries) {
        try { pending += fs.readdirSync(path.join(p, sub)).filter((f) => f.endsWith('.json')).length; } catch { /* a stray file */ }
      }
      continue;
    }
    if (dir.startsWith('_') || dir.startsWith('.')) continue;
    showDirs++;
    for (const f of entries) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(p, f), 'utf8')); } catch { continue; }
      files.push({ source: d.source, ingestSource: d.ingestSource, stamp: d.textFetchedAt || d.classifiedAt || '' });
    }
  }
  return { files, pending, showDirs };
}

function readLedger() {
  try {
    return fs.readFileSync(PENDING_LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('usage: node scripts/report-discovery-share.js [--review-texts=PATH] [--days=7] [--dry-run] [--json]'); return 0; }
  const args = parseArgs(argv);
  if (!fs.existsSync(args.reviewTexts)) { console.error(`review-texts not found at ${args.reviewTexts}`); return 2; }
  const { files, pending, showDirs } = scan(args.reviewTexts);
  if (showDirs < 500) { console.error(`review-texts holds only ${showDirs} show dirs: partial checkout, not reporting`); return 2; }
  const sinceMs = Date.now() - args.days * 86400000;
  const recent = discoveryShare(files, { sinceMs });
  const all = discoveryShare(files);
  // Recent window (3d) so the alert clears once callers are fixed; manual-entry is a known hand path; a floor of 5
  // keeps a few re-fetched old files (textFetchedAt resets on re-fetch) from alerting.
  const recentCutoff = new Date(Date.now() - 3 * 86400000).toISOString();
  const afterEnforcement = files.filter((f) => String(f.stamp) >= CALLER_REQUIRED_FROM && String(f.stamp) >= recentCutoff && f.source !== 'manual-entry' && pipelineOf(f).endsWith('(no caller)'));
  const CALLER_ALERT_FLOOR = 5;
  const today = new Date().toISOString().slice(0, 10);
  const history = readLedger().filter((r) => r.date !== today);
  history.push({ date: today, pending });
  const growth = pendingGrowthVerdict(history);

  const report = { date: today, days: args.days, recent, all: { total: all.total, noCaller: all.noCaller, backstop: all.backstop, backstopShare: all.backstopShare }, pending, pendingGrowth: growth, noCallerAfterEnforcement: afterEnforcement.length };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    console.log(`Discovery share, last ${args.days} days: ${recent.total} review files; ${recent.backstop} (${pct(recent.backstopShare)}) came from backstop gap audits; ${recent.noCaller} with no caller recorded`);
    for (const r of recent.rows.slice(0, 15)) console.log(`  ${String(r.count).padStart(6)}  ${pct(r.share).padStart(6)}  ${r.pipeline}${r.backstop ? '  [backstop]' : ''}`);
    console.log(`All time: ${all.total} files, ${all.noCaller} with no caller (${pct(all.noCaller / all.total)}), ${all.backstop} from backstops (${pct(all.backstopShare)})`);
    console.log(`_pending: ${pending} files; growth check: ${growth.status}${growth.alert ? ` (+${growth.growth} over ${growth.floor})` : ''}`);
    console.log(`Files stamped since ${CALLER_REQUIRED_FROM} with no caller: ${afterEnforcement.length}`);
  }
  if (args.dryRun) return 0;

  fs.appendFileSync(PENDING_LEDGER, `${JSON.stringify({ date: today, pending })}\n`);
  fs.writeFileSync(SNAPSHOT, `${JSON.stringify(report, null, 2)}\n`);
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  if (growth.alert) {
    await routeAlert({
      conditionKey: 'discovery-pending-growth', disposition: 'digest', severity: 'error', cooldownHours: 24,
      title: `Review files waiting in the pending folder grew by ${growth.growth} this week (now ${growth.today})`,
      description: `data/review-texts/_pending holds ${growth.today} files, up from a recent low of ${growth.floor}. Pending files are reviews found but not yet matched to a show or critic; a growing pile means the drain (enrich-reviews) is not keeping up and those reviews are missing from scores.`,
      hint: 'Check enrich-reviews.yml scheduled fire rate (node scripts/check-cron-fire-rate.js --workflows=enrich-reviews.yml --dry-run) and the _pending drain log.',
    });
  } else resolveCondition('discovery-pending-growth', { reason: `pending ${pending}, ${growth.status}` });
  if (afterEnforcement.length >= CALLER_ALERT_FLOOR) {
    await routeAlert({
      conditionKey: 'discovery-caller-missing', disposition: 'digest', severity: 'error', cooldownHours: 24,
      title: `${afterEnforcement.length} review files were ingested with no caller recorded`,
      description: `Every ingest must name its pipeline; ${afterEnforcement.length} files stamped since ${CALLER_REQUIRED_FROM} have source submit-review-form (or similar) and no ingestSource, so the discovery-share report cannot say who found them.`,
      hint: 'Find the writer that bypasses scripts/ingest-review-from-url.js --caller (scripts/ingest-caller-guard.test.mjs covers the ingest script spawners).',
    });
  } else resolveCondition('discovery-caller-missing', { reason: 'no uncalled ingests' });
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
module.exports = { parseArgs };
