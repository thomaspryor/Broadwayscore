#!/usr/bin/env node
/**
 * audit-page-furniture.js — read-only survey of page furniture (share bars,
 * related-story runs, comment/ticket widgets, newsletter/paywall/donation
 * boilerplate, copyright lines, repeated paragraphs) inside review bodies
 * (BRO-7171 Stage 5). The detector is scripts/lib/page-furniture.js, the same
 * module the cleaner uses.
 *
 *   node scripts/audit-page-furniture.js --corpus [--dir <review-texts>] [--json out.json]
 *     Stored fullText: files carrying furniture, by category x outlet and by
 *     the writer that stored it (fetchMethod, else sourceMethod), with
 *     examples, plus how many the fixed cleaner would clean.
 *
 *   node scripts/audit-page-furniture.js --archives [--archive-dir data/archives/reviews]
 *     Re-runs TODAY's extractor + save-path cleaning on the locally archived
 *     raw pages and reports furniture that still survives, by outlet: the
 *     "is the extractor still producing it" check.
 *
 * Writes nothing except --json.
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectPageFurniture, stripPageFurniture } = require('./lib/page-furniture');
const { listShowDirs } = require('./lib/list-show-dirs');

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function defaultTextsDir() {
  const local = path.join(__dirname, '..', 'data', 'review-texts');
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), 'broadway-review-texts');
}

function bump(map, k, n = 1) { map[k] = (map[k] || 0) + n; }
function top(map, n = 12) { return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n); }

function surveyCorpus(dir) {
  const byCat = {}; const byCatOutlet = {}; const byCatWriter = {}; const examples = {};
  let files = 0; let withFurniture = 0; let charsRemoved = 0; const byOutlet = {}; const byWriter = {};
  for (const show of listShowDirs(dir, { silent: true, skipHolding: true })) {
    const sd = path.join(dir, show);
    let names;
    try { names = fs.readdirSync(sd); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      if (typeof d.fullText !== 'string' || !d.fullText) continue;
      files++;
      const hits = detectPageFurniture(d.fullText);
      if (!hits.length) continue;
      withFurniture++;
      const outlet = d.outletId || '?';
      const writer = d.fetchMethod || d.sourceMethod || 'unknown';
      bump(byOutlet, outlet); bump(byWriter, writer);
      charsRemoved += d.fullText.length - stripPageFurniture(d.fullText).length;
      const cats = new Set(hits.map((h) => h.category));
      for (const c of cats) {
        bump(byCat, c);
        byCatOutlet[c] = byCatOutlet[c] || {}; bump(byCatOutlet[c], outlet);
        byCatWriter[c] = byCatWriter[c] || {}; bump(byCatWriter[c], writer);
        const ex = hits.find((h) => h.category === c);
        examples[c] = examples[c] || [];
        if (examples[c].length < 8 && !examples[c].some((e) => e.outlet === outlet)) {
          examples[c].push({ file: `${show}/${f}`, outlet, writer, line: ex.line.slice(0, 160) });
        }
      }
    }
  }
  return { files, withFurniture, charsRemoved, byCat, byOutlet: top(byOutlet, 25), byWriter: top(byWriter, 15),
    byCatOutlet: Object.fromEntries(Object.entries(byCatOutlet).map(([k, v]) => [k, top(v)])),
    byCatWriter: Object.fromEntries(Object.entries(byCatWriter).map(([k, v]) => [k, top(v, 8)])), examples };
}

function surveyArchives(archiveDir) {
  const { extractTextFromHtml } = require('./collect-review-texts');
  const { textAsStored } = require('./lib/stored-text-form');
  const byOutlet = {}; const pages = {}; const examples = [];
  let n = 0; let withFurniture = 0;
  for (const show of listShowDirs(archiveDir, { silent: true })) {
    const sd = path.join(archiveDir, show);
    let names;
    try { names = fs.readdirSync(sd); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(sd, f), 'utf8');
      const m = html.slice(0, 600).match(/URL:\s*(\S+)/);
      if (!m) continue;
      const outlet = f.split('--')[0];
      let text;
      try { text = textAsStored(extractTextFromHtml(html, m[1]) || ''); } catch { continue; }
      if (!text || text.length < 300) continue;
      n++; bump(pages, outlet);
      const hits = detectPageFurniture(text);
      if (!hits.length) continue;
      withFurniture++; bump(byOutlet, outlet);
      if (examples.length < 60) examples.push({ file: `${show}/${f}`, hits: hits.slice(0, 4).map((h) => `${h.category}: ${h.line.slice(0, 100)}`) });
    }
  }
  return { pages: n, withFurniture, byOutlet: top(byOutlet, 40).map(([o, c]) => [o, c, pages[o]]), examples };
}

function main() {
  const out = {};
  if (process.argv.includes('--corpus')) {
    const dir = argVal('--dir', defaultTextsDir());
    out.corpus = surveyCorpus(dir);
    const c = out.corpus;
    console.log(`Corpus ${dir}: ${c.files} bodies, ${c.withFurniture} carry furniture (${c.charsRemoved} chars the cleaner removes)`);
    for (const [cat, count] of Object.entries(c.byCat).sort((a, b) => b[1] - a[1])) {
      console.log(`\n  ${cat}: ${count} files`);
      console.log(`    outlets: ${c.byCatOutlet[cat].map(([o, k]) => `${o} ${k}`).join(', ')}`);
      console.log(`    writers: ${c.byCatWriter[cat].map(([o, k]) => `${o} ${k}`).join(', ')}`);
      for (const e of c.examples[cat].slice(0, 3)) console.log(`    e.g. ${e.file} [${e.writer}]: ${e.line}`);
    }
  }
  if (process.argv.includes('--archives')) {
    const dir = argVal('--archive-dir', path.join(__dirname, '..', 'data', 'archives', 'reviews'));
    out.archives = surveyArchives(dir);
    const a = out.archives;
    console.log(`\nArchived pages re-extracted with today's extractor: ${a.pages}, furniture survives in ${a.withFurniture}`);
    for (const [o, k, p] of a.byOutlet) console.log(`  ${o}: ${k}/${p}`);
    for (const e of a.examples.slice(0, 25)) console.log(`  e.g. ${e.file}: ${e.hits.join(' | ')}`);
  }
  if (!out.corpus && !out.archives) {
    console.error('usage: audit-page-furniture.js --corpus|--archives [--json out.json]');
    process.exit(2);
  }
  const json = argVal('--json', null);
  if (json) fs.writeFileSync(json, JSON.stringify(out, null, 2));
}

if (require.main === module) main();
module.exports = { surveyCorpus, surveyArchives };
