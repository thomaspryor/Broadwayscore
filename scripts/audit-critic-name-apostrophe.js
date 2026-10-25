#!/usr/bin/env node
/**
 * audit-critic-name-apostrophe.js — read-only (BRO-5444).
 *
 * Finds review files whose criticName was cut at an apostrophe or a name
 * particle ("Holly O'", "Holly O", "Jane D'", "Ian Mc"), the shape a byline
 * parser leaves when its name pattern stops at ' or ’. For each hit it lists
 * the full names the same outlet (or any outlet) carries that start with the
 * cut name, the file's source / sourceMethod (which collector wrote it), and
 * whether a file under the suggested full-name slug already exists in the same
 * show (a duplicate to merge rather than re-credit).
 *
 * Ids, outlets, names, dates and sources only, never review text.
 *
 * --garbage lists criticName values that are not a name at all (OCR residue from
 * Theatre Record scans, one-letter fragments, glued all-caps runs) instead, with
 * whether the rebuild excludes the file.
 *
 * Usage: node scripts/audit-critic-name-apostrophe.js [--garbage] [--show=a,b] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isCutAtApostrophe, isGarbageCriticName } = require('./lib/critic-name-apostrophe');
const { explainExclusion } = require('./lib/review-guards');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const onlyShows = val('show') ? val('show').split(',') : null;
const asJson = args.includes('--json');
const garbage = args.includes('--garbage');
const isHit = garbage ? isGarbageCriticName : isCutAtApostrophe;

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function main() {
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }
  const rawShows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const showById = Object.fromEntries((Array.isArray(rawShows) ? rawShows : (rawShows.shows || [])).map((s) => [s.id, s]));
  const shows = onlyShows || fs.readdirSync(textsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  const all = [];
  for (const show of shows) {
    const dir = path.join(textsDir, show);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      all.push({ show, file, outletId: r.outletId || null, critic: typeof r.criticName === 'string' ? r.criticName.trim() : '', r });
    }
  }

  // Full names per outlet and corpus-wide, for suggestions.
  const fullByOutlet = new Map();
  const fullAny = new Set();
  for (const x of all) {
    if (!x.critic || isHit(x.critic)) continue;
    fullAny.add(x.critic);
    if (!fullByOutlet.has(x.outletId)) fullByOutlet.set(x.outletId, new Set());
    fullByOutlet.get(x.outletId).add(x.critic);
  }
  const startsWithCut = (full, cut) => {
    const stem = cut.replace(/['’]$/, '');
    const next = full.charAt(stem.length);
    return full.startsWith(stem) && full.length > stem.length + 1 && (next === "'" || next === '’' || /[A-Z]/.test(next));
  };

  const hits = [];
  for (const x of all) {
    if (!isHit(x.critic)) continue;
    const sameOutlet = [...(fullByOutlet.get(x.outletId) || [])].filter((f) => startsWithCut(f, x.critic));
    const anyOutlet = sameOutlet.length ? sameOutlet : [...fullAny].filter((f) => startsWithCut(f, x.critic));
    const suggestion = sameOutlet.length === 1 ? sameOutlet[0] : null;
    const siblingFile = suggestion ? `${x.outletId}--${slug(suggestion)}.json` : null;
    hits.push({
      show: x.show, file: x.file, outlet: x.outletId, criticName: x.critic,
      publishDate: x.r.publishDate || null, source: x.r.source || null, sourceMethod: x.r.sourceMethod || null,
      url: x.r.url || x.r.theatreRecordUrl || null,
      excludedBy: (() => { try { return explainExclusion(x.r, showById[x.show] || null, path.join(textsDir, x.show, x.file)) || null; } catch (e) { return `error: ${e.message}`; } })(),
      suggestions: anyOutlet.slice(0, 5), suggestion,
      siblingExists: siblingFile ? fs.existsSync(path.join(textsDir, x.show, siblingFile)) && siblingFile !== x.file : false,
    });
  }

  const bySource = {};
  for (const h of hits) { const k = `${h.source || 'none'}/${h.sourceMethod || 'none'}`; bySource[k] = (bySource[k] || 0) + 1; }
  if (asJson) { console.log(JSON.stringify({ scanned: all.length, hits: hits.length, bySource, rows: hits }, null, 2)); return; }
  console.log(`files scanned: ${all.length}`);
  console.log(`${garbage ? 'criticName not a name' : 'criticName cut at an apostrophe'}: ${hits.length}`);
  console.log('by source/sourceMethod:', JSON.stringify(bySource));
  console.log('\nshow | file | outlet | criticName | publishDate | source/method | suggestion (same outlet) | sibling file exists | other candidates | url | excludedBy');
  for (const h of hits) {
    console.log([h.show, h.file, h.outlet, JSON.stringify(h.criticName), h.publishDate, `${h.source}/${h.sourceMethod}`,
      h.suggestion || '-', h.siblingExists, h.suggestions.join('; ') || '-', h.url, h.excludedBy || 'live'].join(' | '));
  }
}

if (require.main === module) main();
