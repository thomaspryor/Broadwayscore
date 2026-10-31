#!/usr/bin/env node
/**
 * Advisory audit (BRO-4284): list homepage featuredRows entries that have no
 * explicit minCount, with their CURRENT list length, flagging rows that are
 * already hidden (< default floor of 4) or within 2 of it.
 *
 *   node scripts/audit-featured-row-mincount.js          # report, exit 0
 *   node scripts/audit-featured-row-mincount.js --strict # exit 1 if any row is hidden
 *   node scripts/audit-featured-row-mincount.js --json
 *
 * Row sizes come from the real buildHomepageExtra() run through tsx, so it
 * reflects data/shows.json as checked out.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyFeaturedRows } = require('./lib/featured-row-mincount');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/audit-featured-row-mincount.js [--strict] [--json]\nAdvisory audit of homepage featuredRows entries without an explicit minCount.');
  process.exit(0);
}

function loadRows() {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'featured-rows-'));
  const probe = path.join(dir, 'probe.ts');
  fs.writeFileSync(probe, `import { buildHomepageExtra } from ${JSON.stringify(path.join(root, 'src/lib/homepage-extra'))};
const e: any = buildHomepageExtra();
console.log('ROWS_JSON=' + JSON.stringify((e.featuredRows || []).map((r: any) => ({ title: r.title, count: r.shows.length, minCount: r.minCount ?? null }))));
`);
  try {
    const res = spawnSync('npx', ['--no-install', 'tsx', probe], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('ROWS_JSON='));
    if (!line) throw new Error(`could not read featured rows: ${(res.stderr || res.stdout || '').slice(-300)}`);
    return JSON.parse(line.slice('ROWS_JSON='.length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rows = loadRows();
const findings = classifyFeaturedRows(rows);
if (args.includes('--json')) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  console.log(`featuredRows: ${rows.length} total, ${findings.length} without explicit minCount`);
  for (const f of findings) {
    console.log(`  ${f.status.toUpperCase().padEnd(8)} ${String(f.count).padStart(3)} shows (floor ${f.effectiveMin})  ${f.title}`);
  }
  const hidden = findings.filter((f) => f.status === 'hidden');
  if (hidden.length) console.log(`\n${hidden.length} row(s) currently render nothing. Add an explicit minCount if a short shelf is intended, or grow the list.`);
}
if (args.includes('--strict') && findings.some((f) => f.status === 'hidden')) process.exit(1);
