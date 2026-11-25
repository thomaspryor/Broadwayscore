#!/usr/bin/env node
/**
 * BRO-8292 — READ-ONLY sweep of joint-split parents (multiShowSplitParent +
 * multiShowSplitAnchorKind=joint). Re-plans each parent's whole pre-split
 * article (current fullText or review-texts git history) with the current
 * planner. REPAIR rows are BRO-8272 cousins: the planner no longer splits them
 * and the lede-comparison rule is the only reason (or, for parents whose whole
 * text never reached git, some order of the rebuilt sections is one) — force-
 * refetch + rescore those. NO-SPLIT(keep) rows decline for other reasons (real
 * multi-show columns the joint strategy no longer reads): leave their split.
 *
 * Usage: node scripts/sweep-joint-split-parents.js [--review-texts=DIR] [--json] [--out=FILE]
 * Needs full git history in the review-texts checkout (not a shallow clone).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadShows } = require('./lib/multi-show-splitter');
const { isJointParent, replanJointParent, replanReconstructed } = require('./lib/joint-split-resweep');

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
    try { out.push(Object.assign(JSON.parse(execFileSync('git', ['-C', ROOT, 'show', `${h}:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })), { _rev: h.slice(0, 10) })); } catch { /* deleted/renamed rev */ }
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
      const own = { showId: dir, ...data };
      const children = (data.multiShowSplitChildShowIds || []).map((id) => {
        try { return JSON.parse(fs.readFileSync(path.join(ROOT, id, f), 'utf8')); } catch { return null; }
      });
      let r = replanJointParent(own, history(rel), shows);
      // Calibration: the reconstruction verdict alongside the true-text one.
      const recon = replanReconstructed(own, children, shows);
      if (r.verdict === 'no-whole-text') r = recon;
      else r.reconstructed = recon.verdict;
      rows.push({ file: rel, children: data.multiShowSplitChildShowIds || [], currentChars: (data.fullText || '').length,
        originalChars: data.multiShowSplitOriginalLength, ...r });
    }
  }
  const noSplit = rows.filter((r) => r.verdict === 'no-split');
  const repair = rows.filter((r) => r.verdict === 'lede-cousin' || r.verdict === 'refetch');
  const summary = { parents: rows.length, ledeCousin: rows.filter((r) => r.verdict === 'lede-cousin').length, noSplit: noSplit.length,
    stillSplit: rows.filter((r) => r.verdict === 'still-split').length,
    refetch: rows.filter((r) => r.verdict === 'refetch').length,
    noWholeText: rows.filter((r) => r.verdict === 'no-whole-text').length };
  const report = { generatedAt: new Date().toISOString(), summary, repair, noSplit, rows };
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(JSON.stringify(summary));
  for (const r of repair) console.log(`REPAIR\t${r.verdict}\t${r.file}\tchildren=${r.children.join(',')}`);
  for (const r of noSplit) console.log(`NO-SPLIT(keep)\t${r.file}\tchildren=${r.children.join(',')}\twhole=${r.wholeChars}(${r.source})\tcurrent=${r.currentChars}`);
  for (const r of rows.filter((x) => x.verdict === 'no-whole-text')) console.log(`${r.verdict.toUpperCase()}\t${r.file}\t${r.ordersSplit ?? ''}/${r.orders ?? ''}`);
}

main();
