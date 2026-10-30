#!/usr/bin/env node
/**
 * audit-scoreless-llmscore.js — read-only (BRO-5395).
 *
 * The LLM scorer's unscored filter skips any file that carries an llmScore
 * object, so a file whose llmScore holds no numeric score (left by a move, a
 * restore from history, or a rejected run) is never scored and never
 * published. Counts those files, groups them by the llmScore keys present and
 * by rejection markers on the record (rejectedAt, rejectionReason,
 * rejectedTextHash, the scorer's text-gate block), and lists them. Ids only,
 * no review text.
 *
 * Usage: node scripts/audit-scoreless-llmscore.js [--list=N] [--json] [--counts=PATH]
 * --counts writes counts only (BRO-6038 shadow job) and prints the summary only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const listN = Number((args.find((a) => a.startsWith('--list=')) || '--list=200').slice(7));
const asJson = args.includes('--json');
const { countsPathFromArgv, writeAuditCounts } = require('./lib/audit-counts');
const countsPath = countsPathFromArgv(args);

function main() {
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }
  const rows = [];
  let scanned = 0;
  for (const show of fs.readdirSync(textsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const dir = path.join(textsDir, show);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      scanned++;
      const ls = r.llmScore;
      if (!ls || typeof ls !== 'object' || typeof ls.score === 'number') continue;
      rows.push({
        show, file,
        llmKeys: Object.keys(ls).sort().join(','),
        rejected: !!(r.rejectedAt || r.rejectionReason || r.rejectedTextHash),
        rejectionReason: r.rejectionReason || null,
        chars: String(r.fullText || '').length,
        tier: r.contentTier || null,
        assignedScore: typeof r.assignedScore === 'number' ? r.assignedScore : null,
      });
    }
  }
  const count = (key) => rows.reduce((m, r) => { const k = String(r[key]); m[k] = (m[k] || 0) + 1; return m; }, {});
  const summary = { scanned, scoreless: rows.length, byKeys: count('llmKeys'), byRejected: count('rejected'), byRejectionReason: count('rejectionReason'), byTier: count('tier') };
  if (countsPath) {
    writeAuditCounts(countsPath, 'audit-scoreless-llmscore.js', { findings: rows.length, scanned, rejected: rows.filter((r) => r.rejected).length });
    console.log(`scanned: ${scanned}; scoreless: ${rows.length}`);
    return;
  }
  if (asJson) { console.log(JSON.stringify({ summary, rows: rows.slice(0, listN) }, null, 2)); return; }
  for (const [k, v] of Object.entries(summary)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  console.log('\nshow | file | rejected | reason | tier | chars | assignedScore | llmScore keys');
  for (const r of rows.slice(0, listN)) console.log([r.show, r.file, r.rejected, r.rejectionReason, r.tier, r.chars, r.assignedScore, r.llmKeys].join(' | '));
}

if (require.main === module) main();
