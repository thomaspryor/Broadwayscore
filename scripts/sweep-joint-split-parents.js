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
 * Usage: node scripts/sweep-joint-split-parents.js [--review-texts=DIR] [--json] [--out=FILE] [--fetch]
 * --fetch: for parents with no whole text in git or in their split sections,
 * fetch the article (fetchPage + article-extractor) and re-plan it. Read-only:
 * nothing is written to review-texts. Exits 1 when any parent needs repair
 * (REPAIR rows) or holds its whole article under split markers (WHOLE-TEXT-ON-SPLIT).
 * Needs full git history in the review-texts checkout (not a shallow clone).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadShows } = require('./lib/multi-show-splitter');
const { isJointParent, replanJointParent, replanReconstructed, replanText } = require('./lib/joint-split-resweep');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const ROOT = path.resolve(arg('review-texts') || path.join(__dirname, '..', 'data', 'review-texts'));
const MAX_REVS = 300;

/** Committed revisions of one file, newest first, read lazily (most parents hit within a few). */
function* history(rel) {
  let revs = [];
  try {
    revs = execFileSync('git', ['-C', ROOT, 'log', '--format=%H', '-n', String(MAX_REVS), '--', rel], { encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n').filter(Boolean);
  } catch { return; }
  for (const h of revs) {
    let parsed = null;
    try { parsed = JSON.parse(execFileSync('git', ['-C', ROOT, 'show', `${h}:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* deleted/renamed rev */ }
    if (parsed) yield Object.assign(parsed, { _rev: h.slice(0, 10) });
  }
}

async function fetchWhole(data) {
  const { fetchPage } = require('./lib/scraper');
  const { extractArticleText } = require('./lib/article-extractor');
  const got = await fetchPage(data.url);
  if (!got || !got.content) return null;
  const text = got.format === 'html' ? extractArticleText(got.content, new URL(data.url).hostname, data.criticName) : String(got.content);
  return typeof text === 'string' && text.length > 800 ? { text, source: `fetched:${got.source || got.method || 'fetchPage'}` } : null;
}

async function main() {
  if (!fs.existsSync(ROOT)) { console.error(`review-texts not found: ${ROOT}`); process.exit(2); }
  const shows = loadShows();
  // An unreadable catalogue makes every planner call return null, which would read as "keep".
  if (!Array.isArray(shows) || shows.length < 1000) { console.error(`show catalogue missing or tiny (${(shows || []).length}); run npm run data:check`); process.exit(2); }
  const rows = [];
  const { listShowDirs } = require('./lib/list-show-dirs');
  for (const dir of listShowDirs(ROOT, { silent: true }).sort()) {
    const d = path.join(ROOT, dir);
    for (const f of fs.readdirSync(d).sort()) {
      if (!f.endsWith('.json')) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
      if (!isJointParent(data)) continue;
      const rel = `${dir}/${f}`;
      const own = { ...data, showId: dir };
      const children = (data.multiShowSplitChildShowIds || []).map((id) => {
        try { return { ...JSON.parse(fs.readFileSync(path.join(ROOT, id, f), 'utf8')), showId: id }; } catch { return null; }
      });
      let r = replanJointParent(own, history(rel), shows, children);
      if (r.verdict === 'no-whole-text') r = replanReconstructed(own, children, shows);
      // A rebuilt text is a guess at the section order: check it against the live article.
      const guess = r.verdict === 'no-whole-text' || r.verdict === 'recon-no-cousin' || r.verdict === 'refetch';
      if (guess && process.argv.includes('--fetch') && data.url) {
        try {
          const whole = await fetchWhole(data);
          if (whole) r = { ...replanText(own, whole, shows), fetchedChars: whole.text.length, before: r.verdict };
          else r.fetchError = 'no article text';
        } catch (e) { r.fetchError = String(e.message || e).slice(0, 200); }
      }
      rows.push({ file: rel, children: data.multiShowSplitChildShowIds || [], currentChars: (data.fullText || '').length, textLengthNow: data.multiShowSplitTextLength,
        originalChars: data.multiShowSplitOriginalLength, ...r });
    }
  }
  const noSplit = rows.filter((r) => r.verdict === 'no-split' || r.verdict === 'recon-no-cousin');
  const repair = rows.filter((r) => r.verdict === 'lede-cousin' || r.verdict === 'refetch');
  const summary = { parents: rows.length };
  for (const r of rows) summary[r.verdict] = (summary[r.verdict] || 0) + 1;
  const report = { generatedAt: new Date().toISOString(), summary, repair, noSplit, rows };
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return repair.length; }
  console.log(JSON.stringify(summary));
  for (const r of repair) console.log(`REPAIR\t${r.verdict}\t${r.file}\tchildren=${r.children.join(',')}`);
  for (const r of noSplit) console.log(`NO-SPLIT(keep)\t${r.verdict}\t${r.file}\tchildren=${r.children.join(',')}\twhole=${r.wholeChars ?? '-'}(${r.source})\tcurrent=${r.currentChars}`);
  for (const r of rows.filter((x) => x.verdict === 'no-whole-text')) console.log(`NO-WHOLE-TEXT\t${r.file}${r.fetchError ? `\tfetch: ${r.fetchError}` : ''}`);
  // Split markers over a whole regrown article: scored as one review of every show in it.
  const wholeOnSplit = rows.filter((r) => Number.isFinite(r.textLengthNow) && r.currentChars > r.textLengthNow + 200);
  for (const r of wholeOnSplit) console.log(`WHOLE-TEXT-ON-SPLIT\t${r.file}\t${r.currentChars}/${r.textLengthNow}`);
  for (const r of rows.filter((x) => String(x.source || '').startsWith('fetched'))) console.log(`FETCHED\t${r.verdict}\t${r.file}\t${r.fetchedChars}/${r.originalChars}`);
  return repair.length + wholeOnSplit.length;
}

main().then((bad) => { if (bad) process.exitCode = 1; }).catch((e) => { console.error(e); process.exit(1); });
