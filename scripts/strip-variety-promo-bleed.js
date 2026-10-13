#!/usr/bin/env node
/**
 * strip-variety-promo-bleed.js — find (and later strip) the Variety promo
 * modules ("Related Stories", "Popular on Variety") that the old generic
 * extractor left inside stored Variety review texts (BRO-5254).
 *
 * Stage 1 (this version): --dump only. Prints how the promo lines look in the
 * stored plain text so the strip patterns are built from real rows, not
 * guessed. Read-only. Run in CI with the review texts:
 *   node scripts/cloud-run-script.js --review-texts scripts/strip-variety-promo-bleed.js --dump=25
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');

const USAGE = `strip-variety-promo-bleed.js — Variety promo bleed in stored review texts (BRO-5254).

Usage:
  node scripts/strip-variety-promo-bleed.js --dump[=N]   print marker stats and N context samples (read-only)
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
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { continue; }
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

if (arg('dump') !== null) {
  dump(Number(arg('dump')) || 20);
} else {
  console.log(USAGE);
  process.exit(2);
}
