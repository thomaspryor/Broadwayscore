#!/usr/bin/env node
/**
 * strip-variety-promo-bleed.js — strip the Variety promo modules ("Related
 * Stories", "Popular on Variety") that the old generic extractor left inside
 * stored Variety review texts (BRO-5254). Rules: scripts/lib/variety-promo-bleed.js.
 *
 * Default is a dry run that prints every block it would remove (clipped) and
 * the rows it refuses (those need a refetch). --apply writes through
 * safeWriteReview and queues a rescore. Runs in CI only (review texts are private):
 *   node scripts/cloud-run-script.js --review-texts scripts/strip-variety-promo-bleed.js
 *   data/pending-fixes run-script action: args "--apply --limit=5"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const {
  stripVarietyPromoBleed, applyVarietyPromoStrip, hasVarietyPromoBleed, isExcludedRow,
  hasDuplicatedLead, duplicatedLead, restoreBigMove, undoRestore,
} = require('./lib/variety-promo-bleed');
const { safeWriteReview } = require('./lib/review-write-guard');

const USAGE = `strip-variety-promo-bleed.js — Variety promo bleed in stored review texts (BRO-5254).

Usage:
  node scripts/strip-variety-promo-bleed.js                 dry run: blocks it would remove, refused rows
  node scripts/strip-variety-promo-bleed.js --apply         write the strips and queue rescores
    --limit=N            only N rows, spread evenly over the list (sample runs)
    --files=a/x.json,b/y.json   only these rows (show/file)
    --verbose            print every removed line (dry run prints a clipped summary)
  node scripts/strip-variety-promo-bleed.js --refetch-list  rows the strip refuses (need a refetch)
  node scripts/strip-variety-promo-bleed.js --verify-live [--limit=N|--files=]  removed lines vs the live article (exit 1 on a hit)
  node scripts/strip-variety-promo-bleed.js --ab            A/B of stripped rows: pre-strip score vs rescore
  node scripts/strip-variety-promo-bleed.js --restore-big-moves [--apply]  keep the pre-strip score where the rescore moved 5+ or changed bucket
  node scripts/strip-variety-promo-bleed.js --use-rescore --files=show/file.json,... [--apply]  undo a restore: the rescore fits the text better
  node scripts/strip-variety-promo-bleed.js --dup-leads     live rows whose first paragraph repeats the second (exact or near), lengths only
  node scripts/strip-variety-promo-bleed.js --dump[=N]      marker stats and N context samples (read-only)
`;
if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const arg = (name) => {
  const a = process.argv.find(x => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  return a.includes('=') ? a.slice(name.length + 3) : '';
};
const DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const MARKER_RE = /Related Stories|Popular on Variety|More From Our Brands|Read More About|Must Read|Sign Up for Variety|Variety Confidential/i;

function varietyFiles() {
  const out = [];
  for (const showId of listShowDirs(DIR)) {
    const showDir = path.join(DIR, showId);
    for (const f of fs.readdirSync(showDir)) {
      if (!f.endsWith('.json')) continue;
      const raw = fs.readFileSync(path.join(showDir, f), 'utf8');
      // Cheap filter before parsing every file in the corpus.
      if (!/^variety--/.test(f) && !/variety\.com/i.test(raw)) continue;
      let d;
      try { d = JSON.parse(raw); } catch { continue; }
      const isVariety = /^variety--/.test(f) || /variety\.com/i.test(d.url || '');
      if (!isVariety || typeof d.fullText !== 'string') continue;
      out.push({ rel: `${showId}/${f}`, d });
    }
  }
  return out;
}

function clip(s, n) { s = s.replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; }

function dump(n) {
  const files = varietyFiles();
  const hit = files.filter(x => MARKER_RE.test(x.d.fullText));
  console.log(`variety files with fullText: ${files.length}; with any marker: ${hit.length}`);
  const perMarker = {};
  const lineShape = {};
  const nlRelated = { newlineAfter: 0, inline: 0, atEnd: 0, mid: 0 };
  for (const { d } of hit) {
    const t = d.fullText;
    for (const m of t.matchAll(new RegExp(MARKER_RE.source, 'gi'))) {
      const k = m[0].toLowerCase();
      perMarker[k] = (perMarker[k] || 0) + 1;
      if (k === 'related stories') {
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 2);
        if (/^\s*\n/.test(after)) nlRelated.newlineAfter++; else nlRelated.inline++;
        if (t.length - m.index < 600) nlRelated.atEnd++; else nlRelated.mid++;
      }
    }
    // Shape of the line holding the marker: its length bucket and how it ends.
    for (const line of t.split(/\n/)) {
      if (!MARKER_RE.test(line)) continue;
      const key = `${line.trim().length < 20 ? 'marker-alone' : line.trim().length < 300 ? 'short-line' : 'long-line'}`;
      lineShape[key] = (lineShape[key] || 0) + 1;
    }
  }
  console.log('marker counts:', JSON.stringify(perMarker));
  console.log('related-stories position:', JSON.stringify(nlRelated));
  console.log('marker line shape:', JSON.stringify(lineShape));
  const newlineStats = hit.reduce((a, { d }) => { a[d.fullText.includes('\n\n') ? 'para' : d.fullText.includes('\n') ? 'line' : 'flat']++; return a; }, { para: 0, line: 0, flat: 0 });
  console.log('newline style of hit files:', JSON.stringify(newlineStats));
  // Sources of the hit rows (which collector path wrote them).
  const src = {};
  for (const { d } of hit) { const k = d.textSource || d.source || d.fetchMethod || 'unknown'; src[k] = (src[k] || 0) + 1; }
  console.log('sources:', JSON.stringify(src));
  console.log('scored hits:', hit.filter(x => x.d.llmScore || x.d.assignedScore).length);

  // Context samples spread across the list.
  const step = Math.max(1, Math.floor(hit.length / Math.max(1, n)));
  for (let i = 0, shown = 0; i < hit.length && shown < n; i += step, shown++) {
    const { rel, d } = hit[i];
    const t = d.fullText;
    const m = t.match(MARKER_RE);
    console.log(`\n=== ${rel} (len ${t.length}, marker at ${m.index})`);
    const lines = t.split(/\n/);
    let idx = 0, pos = 0;
    for (; idx < lines.length; idx++) { if (pos + lines[idx].length >= m.index) break; pos += lines[idx].length + 1; }
    for (let j = Math.max(0, idx - 2); j < Math.min(lines.length, idx + 8); j++) {
      console.log(`  ${j === idx ? '>' : ' '}[${j}] (${lines[j].length}) ${JSON.stringify(clip(lines[j], 260))}`);
    }
    if (lines.length === 1) {
      console.log(`  inline window: ${JSON.stringify(t.slice(Math.max(0, m.index - 200), m.index + 700))}`);
    }
  }
}

/** Rows the strip looks at: Variety, has a promo block, not excluded, not already stripped. */
function candidates() {
  const tally = { locked: 0, excluded: 0, dupLead: 0 };
  const rows = [];
  for (const x of varietyFiles()) {
    const dup = hasDuplicatedLead(x.d.fullText);
    if (!hasVarietyPromoBleed(x.d.fullText) && !dup) continue;
    if (isExcludedRow(x.d)) { tally.excluded++; continue; }
    if (x.d._locked) { tally.locked++; continue; }
    if (dup) tally.dupLead++;
    rows.push(x);
  }
  return { rows, tally };
}

/** n rows spread evenly over the list (an alphabetical head would be a few shows only). */
function spread(rows, n) {
  if (!n || n >= rows.length) return rows;
  const out = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.floor((i * rows.length) / n)]);
  return out;
}

function run({ apply, limit, files, verbose, refetchOnly }) {
  const { rows: all, tally } = candidates();
  let rows = all;
  if (files) {
    const want = new Set(files);
    rows = all.filter(x => want.has(x.rel));
    for (const f of want) if (!rows.some(x => x.rel === f)) console.log(`  ? ${f}: not a candidate (no promo block, excluded, locked or missing)`);
  }
  const refused = [];
  const ok = [];
  for (const x of rows) {
    const r = stripVarietyPromoBleed(x.d.fullText);
    if (r.refused) refused.push({ ...x, reason: r.refused });
    else ok.push({ ...x, r });
  }
  console.log(`candidates: ${all.length} (skipped: ${tally.excluded} excluded, ${tally.locked} locked; ${tally.dupLead} with a duplicated lead paragraph); strippable: ${ok.length}; refused: ${refused.length}`);
  const reasons = {};
  for (const x of refused) { const k = x.reason.replace(/\(\d+\)/, '(N)'); reasons[k] = (reasons[k] || 0) + 1; }
  console.log('refused by reason:', JSON.stringify(reasons));
  if (refetchOnly) {
    for (const x of refused) console.log(`  refetch ${x.rel}  (${x.reason}; ${x.d.fullText.length} chars)`);
    return 0;
  }
  const todo = spread(ok, limit);
  let wrote = 0, failed = 0;
  const lineCounts = {};
  for (const { rel, d, r } of todo) {
    const removed = r.blocks.flatMap(b => b.lines);
    for (const l of removed) { const k = clip(l, 80); lineCounts[k] = (lineCounts[k] || 0) + 1; }
    const what = `${r.blocks.length} block(s)${hasDuplicatedLead(d.fullText) ? ' + duplicated lead' : ''}, ${d.fullText.length} → ${r.text.length} chars`;
    if (!apply) {
      console.log(`  ✓ ${rel}: ${what}${removed.length ? ` — removes: ${removed.map(l => JSON.stringify(clip(l, verbose ? 300 : 60))).join(' | ')}` : ''}`);
      continue;
    }
    const file = path.join(DIR, rel);
    // Only a repeated lead paragraph went: the verdict text is the same, no rescore.
    const res = safeWriteReview(file, applyVarietyPromoStrip(d, r.text, { rescore: r.blocks.length > 0 }), { force: true });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    if ((res && res.wrote === false) || after.fullText !== r.text) {
      failed++;
      console.log(`  ✗ ${rel}: write did not stick (${(res && (res.skipped || res.reason)) || 'text differs after write'})`);
      continue;
    }
    if (after.wrongShow && !d.wrongShow) {
      // The write guard's wrong-article screen dropped the row from the rebuild:
      // the strip may have removed the text that tied it to the show. Stop the batch.
      failed++;
      console.log(`  ✗ ${rel}: ${what}, but the write guard flagged wrongShow — batch stopped, check by hand`);
      break;
    }
    wrote++;
    console.log(`  ✓ ${rel}: ${what}`);
  }
  // Lines removed more than once: the headline runs should be mostly unique; a
  // repeated line that reads like review prose would mean the rule is too wide.
  const repeated = Object.entries(lineCounts).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (repeated.length) console.log('removed lines seen more than once:', JSON.stringify(repeated));
  console.log(apply ? `applied: ${wrote}, failed: ${failed}` : `dry run: would strip ${todo.length}`);
  return failed ? 1 : 0;
}

/**
 * Read-only check of the rule against the live article: every line the strip
 * would remove must be absent from Variety's article body (extractVarietyBody
 * already drops the promo modules at the HTML level). A removed line found in
 * the body is a review sentence the rule would delete: exit 1.
 */
async function verifyLive({ limit, files }) {
  const { fetchPage } = require('./lib/scraper');
  const { extractVarietyBody } = require('./lib/article-extractor');
  const { foldDiacritics } = require('./lib/title-match');
  const norm = (t) => foldDiacritics(String(t)).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  let rows = candidates().rows;
  if (files) rows = rows.filter(x => files.includes(x.rel));
  const ok = rows.map(x => ({ ...x, r: stripVarietyPromoBleed(x.d.fullText) })).filter(x => !x.r.refused);
  let inBody = 0, checked = 0, noPage = 0;
  for (const { rel, d, r } of spread(ok, limit || 5)) {
    let body = null;
    try {
      const page = await fetchPage(d.url);
      if (page && page.content) body = extractVarietyBody(page.content);
    } catch (e) { console.log(`  ? ${rel}: fetch failed (${(e.message || '').slice(0, 80)})`); }
    if (!body) { noPage++; console.log(`  ? ${rel}: no article body from the live page`); continue; }
    const live = norm(body);
    checked++;
    const removed = r.blocks.flatMap(b => b.lines);
    const hits = removed.filter(l => norm(l).length >= 12 && live.includes(norm(l)));
    // The kept text should be the live article: its first and last 80 chars should be in the body.
    const kept = norm(r.text);
    const edges = [kept.slice(0, 80), kept.slice(-80)].filter(e => !live.includes(e));
    inBody += hits.length;
    console.log(`  ${hits.length ? '✗' : '✓'} ${rel}: ${removed.length} removed line(s)${hits.length ? `; IN ARTICLE BODY: ${hits.map(h => JSON.stringify(clip(h, 80))).join(' | ')}` : ', none in the article body'}${edges.length ? '; kept text edges not found live (page changed?)' : ''}`);
    for (const l of removed) console.log(`      removed: ${JSON.stringify(clip(l, 120))}`);
  }
  console.log(`verify-live: ${checked} checked, ${noPage} without a live body; removed lines found in the article body: ${inBody}`);
  return inBody ? 1 : checked ? 0 : 2;
}

/** Pre-strip score (stamp) vs the rescored row, with the llm-scoring A/B limits. */
function ab() {
  const { compare, SHIFT_LIMIT, DRIFT_LIMIT } = require('./report-false-truncation-ab');
  const before = [];
  const current = new Map();
  for (const { rel, d } of varietyFiles()) {
    const s = d.varietyPromoStrip;
    // Unscored before the strip: nothing to compare, and a null bucket would skew the shares.
    if (!s || s.previousScore == null) continue;
    // Not on the live site (e.g. stripped before wrongAttribution joined isExcludedRow): tells the A/B nothing.
    if (isExcludedRow(d)) continue;
    before.push({ file: rel, score: s.previousScore, bucket: s.previousBucket, scoredAt: s.previousScoredAt, confidence: null, textStatus: null });
    // A restored row measures the rescore it overrode, so --restore-big-moves cannot make the A/B pass.
    const r = s.restored;
    current.set(rel, r ? { ...d, assignedScore: r.rescoredScore, llmScore: { ...d.llmScore, score: r.rescoredScore, bucket: r.rescoredBucket } } : d);
  }
  const c = compare(before, current, { requireTextFix: false });
  const restored = before.filter(b => current.get(b.file).varietyPromoStrip.restored).length;
  // (the drift numbers below use the rescore's own score for restored rows)
  console.log(`stripped rows: ${c.total}; rescored: ${c.rescored}; pending: ${c.pending}; pre-strip score restored: ${restored}`);
  console.log(`mean drift ${c.meanSigned.toFixed(2)} (abs ${c.meanAbs.toFixed(2)}, limit ${DRIFT_LIMIT}); max bucket share shift ${c.maxShift.toFixed(1)}pts (limit ${SHIFT_LIMIT}); bucket changes ${c.changedBucket}`);
  console.log('bucket share shifts:', JSON.stringify(Object.fromEntries(Object.entries(c.shifts).map(([k, v]) => [k, +v.toFixed(1)]))));
  const moves = before
    .map(b => ({ file: b.file, before: b.score, after: current.get(b.file).assignedScore, d: current.get(b.file) }))
    .filter(m => !m.d.needsRescore && m.before != null && typeof m.after === 'number' && m.d.llmMetadata && m.d.llmMetadata.scoredAt !== before.find(b => b.file === m.file).scoredAt)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    .slice(0, 10);
  for (const m of moves) console.log(`  ${m.file}: ${m.before} → ${m.after} (${m.after - m.before >= 0 ? '+' : ''}${m.after - m.before})`);
  console.log(`A/B: ${c.pass ? 'PASS' : c.rescored ? 'FAIL' : 'NO RESCORED ROWS YET'}`);
  return c.pass || !c.rescored ? 0 : 1;
}

/** Put the pre-strip score back on rescored rows that moved BIG_MOVE_POINTS+ or changed bucket. */
function restoreBigMoves({ apply }) {
  let found = 0, wrote = 0, failed = 0;
  for (const { rel, d } of varietyFiles()) {
    if (isExcludedRow(d)) continue;
    const next = restoreBigMove(d);
    if (!next) continue;
    found++;
    const r = next.varietyPromoStrip.restored;
    const line = `${rel}: ${d.varietyPromoStrip.previousScore} ${d.varietyPromoStrip.previousBucket || '?'} kept (rescore said ${r.rescoredScore} ${r.rescoredBucket || '?'})`;
    if (!apply) { console.log(`  would restore ${line}`); continue; }
    const file = path.join(DIR, rel);
    safeWriteReview(file, next, { force: true });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!after.llmScore || after.llmScore.score !== d.varietyPromoStrip.previousScore) { failed++; console.log(`  ✗ ${rel}: restore did not stick`); continue; }
    wrote++;
    console.log(`  restored ${line}`);
  }
  console.log(apply ? `restore: ${wrote} restored, ${failed} failed (of ${found})` : `restore dry run: ${found} rows would keep the pre-strip score`);
  return failed ? 1 : 0;
}

/** Put the rescore back on named restored rows (a reader judged it fits the text better). */
function useRescore({ files, apply }) {
  let wrote = 0, failed = 0;
  for (const rel of files) {
    const file = path.join(DIR, rel);
    let d;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { failed++; console.log(`  ✗ ${rel}: not readable`); continue; }
    const next = undoRestore(d);
    if (!next) { failed++; console.log(`  ✗ ${rel}: not a restored row with its rescore intact`); continue; }
    const line = `${rel}: rescore ${next.llmScore.score} ${next.llmScore.bucket || '?'} replaces kept ${d.llmScore.score}`;
    if (!apply) { console.log(`  would use ${line}`); continue; }
    safeWriteReview(file, next, { force: true });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!after.llmScore || after.llmScore.score !== next.llmScore.score) { failed++; console.log(`  ✗ ${rel}: did not stick`); continue; }
    wrote++;
    console.log(`  used ${line}`);
  }
  console.log(apply ? `use-rescore: ${wrote} written, ${failed} failed (of ${files.length})` : `use-rescore dry run: ${files.length - failed} ok, ${failed} refused`);
  return failed ? 1 : 0;
}

/** Live rows with a repeated lead paragraph. Prints lengths and word counts only (logs are public). */
function dupLeads() {
  const kinds = {};
  for (const x of varietyFiles()) {
    if (isExcludedRow(x.d)) continue;
    const dl = duplicatedLead(x.d.fullText);
    if (!dl) continue;
    kinds[dl.kind] = (kinds[dl.kind] || 0) + 1;
    const t = x.d.fullText;
    console.log(`  ${dl.kind} ${x.rel}: lead ${dl.end} chars dropped of ${t.length}, ${Math.round(dl.share * 100)}% of its words in order in paragraph 2${x.d._locked ? ' (locked)' : ''}`);
  }
  console.log('duplicated leads:', JSON.stringify(kinds));
  return 0;
}

if (arg('use-rescore') !== null) {
  process.exit(useRescore({ files: (arg('files') || '').split(',').filter(Boolean), apply: arg('apply') !== null }));
} else if (arg('dup-leads') !== null) {
  process.exit(dupLeads());
} else if (arg('restore-big-moves') !== null) {
  process.exit(restoreBigMoves({ apply: arg('apply') !== null }));
} else if (arg('dump') !== null) {
  dump(Number(arg('dump')) || 20);
} else if (arg('ab') !== null) {
  process.exit(ab());
} else if (arg('verify-live') !== null) {
  const files = arg('files');
  verifyLive({ limit: Number(arg('limit')) || 0, files: files ? files.split(',') : null })
    .then(code => process.exit(code), e => { console.error(e); process.exit(1); });
} else {
  const files = arg('files');
  process.exit(run({
    apply: arg('apply') !== null,
    limit: Number(arg('limit')) || 0,
    files: files ? files.split(',').map(f => f.trim()).filter(Boolean) : null,
    verbose: arg('verbose') !== null,
    refetchOnly: arg('refetch-list') !== null,
  }));
}
