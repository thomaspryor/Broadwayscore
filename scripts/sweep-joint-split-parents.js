#!/usr/bin/env node
/**
 * BRO-8292 — READ-ONLY sweep of joint-split parents (multiShowSplitParent +
 * multiShowSplitAnchorKind=joint). Re-plans each parent's whole pre-split
 * article (current fullText or review-texts git history) with the current
 * planner and lists the parents it no longer splits: those are older-planner
 * mis-splits (BRO-8272 class) to force-refetch + rescore.
 *
 * Usage: node scripts/sweep-joint-split-parents.js [--review-texts=DIR] [--json] [--out=FILE]
 * Needs full git history in the review-texts checkout (not a shallow clone).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadShows } = require('./lib/multi-show-splitter');
const { isJointParent, replanJointParent } = require('./lib/joint-split-resweep');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const ROOT = path.resolve(arg('review-texts') || path.join(__dirname, '..', 'data', 'review-texts'));
const MAX_REVS = 40;

function history(rel) {
  let revs = [];
  try {
    revs = execFileSync('git', ['-C', ROOT, 'log', '--format=%H', '-n', String(MAX_REVS), '--', rel], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { return []; }
  const out = [];
  for (const h of revs.slice(1)) {
    try { out.push(JSON.parse(execFileSync('git', ['-C', ROOT, 'show', `${h}:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }))); } catch { /* deleted/renamed rev */ }
  }
  return out;
}

function main() {
  if (!fs.existsSync(ROOT)) { console.error(`review-texts not found: ${ROOT}`); process.exit(2); }
  const shows = loadShows();
  const rows = [];
  for (const dir of fs.readdirSync(ROOT).sort()) {
    const d = path.join(ROOT, dir);
    if (dir.startsWith('.') || dir.startsWith('_') || !fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (!f.endsWith('.json')) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
      if (!isJointParent(data)) continue;
      const rel = `${dir}/${f}`;
      const r = replanJointParent({ showId: dir, ...data }, history(rel), shows);
      rows.push({ file: rel, children: data.multiShowSplitChildShowIds || [], currentChars: (data.fullText || '').length,
        originalChars: data.multiShowSplitOriginalLength, ...r });
    }
  }
  const noSplit = rows.filter((r) => r.verdict === 'no-split');
  const summary = { parents: rows.length, noSplit: noSplit.length,
    stillSplit: rows.filter((r) => r.verdict === 'still-split').length,
    noWholeText: rows.filter((r) => r.verdict === 'no-whole-text').length };
  const report = { generatedAt: new Date().toISOString(), summary, noSplit, rows };
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(JSON.stringify(summary));
  for (const r of noSplit) console.log(`NO-SPLIT\t${r.file}\tchildren=${r.children.join(',')}\twhole=${r.wholeChars}(${r.source})\tcurrent=${r.currentChars}`);
  for (const r of rows.filter((x) => x.verdict === 'no-whole-text')) console.log(`NO-WHOLE-TEXT\t${r.file}`);
}

main();
