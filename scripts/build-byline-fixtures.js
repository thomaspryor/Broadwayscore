#!/usr/bin/env node
/**
 * BRO-7780: build the archived-HTML byline fixtures (tests/fixtures/byline-outlets/) from pages
 * saved by `sweep-stored-bylines.js --save-html=<dir>`. One page per tier-1/2 outlet, cut down by
 * byline-fixture-strip.js (no review prose), gzipped, with the expected critic in manifest.json.
 *
 *   node scripts/build-byline-fixtures.js --pages=<dir> --rows=a.jsonl,b.jsonl [--extra=<url>=<Name>,...]
 *
 * A page qualifies when the shared reader's answer on the FULL page equals the stored critic and the
 * stripped page gives the same answer. --extra adds named pages (e.g. the TheaterMania tommy page,
 * stored under the wrong critic, so its expected name is given here). Outlets with no qualifying
 * page are listed in manifest.missing with the reason, so the gap is visible in the test output.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'byline-outlets');

function pageFile(outletId, url) { return `${outletId}__${Buffer.from(url).toString('base64url').slice(-60)}.html`; }

function main() {
  if (require('./lib/cli-help').hasHelpFlag(process.argv.slice(2))) { require('./lib/cli-help').exitOnHelp(module); return; }
  const { readPageByline } = require('./lib/page-byline');
  const { sameCriticName } = require('./lib/byline-from-text');
  const { stripPageForBylineFixture } = require('./lib/byline-fixture-strip');
  const pages = String(args.pages || '');
  if (!pages || !fs.existsSync(pages)) { console.error('--pages=<dir> is required'); process.exit(2); }
  const rows = [];
  for (const f of String(args.rows || '').split(',').filter(Boolean)) {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
  }
  const extra = new Map(String(args.extra || '').split(',').filter(Boolean).map((p) => { const i = p.lastIndexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  const reg = require('../data/outlet-registry.json');
  const list = Array.isArray(reg.outlets) ? reg.outlets : Object.entries(reg.outlets || reg).map(([id, v]) => ({ id, ...v }));
  const tiers = list.filter((o) => o.tier === 1 || o.tier === 2).map((o) => o.id).sort();
  const quiet = () => {};
  const read = (html, r) => { const l = console.log, w = console.warn; console.log = quiet; console.warn = quiet; try { return readPageByline({ html, url: r.url, outletId: r.outletId }).criticName; } finally { console.log = l; console.warn = w; } };

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString().slice(0, 10), note: 'Byline-only excerpts of real review pages (BRO-7780). Review text is removed; see scripts/lib/byline-fixture-strip.js.', fixtures: [], missing: [] };
  const latest = new Map();
  for (const r of rows) latest.set(r.key, r);
  const take = (r, expected, label) => {
    const file = path.join(pages, pageFile(r.outletId, r.url));
    if (!fs.existsSync(file)) return false;
    const html = fs.readFileSync(file, 'utf8');
    const full = read(html, r);
    if (!full || !sameCriticName(full, expected)) return false;
    const stripped = stripPageForBylineFixture(html);
    if (read(stripped, r) !== full) return false;
    const name = `${label}.html.gz`;
    fs.writeFileSync(path.join(OUT, name), zlib.gzipSync(stripped, { level: 9 }));
    manifest.fixtures.push({ file: name, outletId: r.outletId, url: r.url, expected: full });
    return true;
  };
  for (const id of tiers) {
    const cands = [...latest.values()].filter((r) => r.outletId === id && r.stored && !/^unknown$/i.test(r.stored) && !r.fetchError);
    if (!cands.length) {
      const any = [...latest.values()].filter((r) => r.outletId === id);
      manifest.missing.push({ outletId: id, reason: any.length ? `no page read (${[...new Set(any.map((r) => r.fetchError || r.verdict))].join('; ').slice(0, 120)})` : 'no stored review to sample' });
      continue;
    }
    if (!cands.some((r) => take(r, r.stored, id))) manifest.missing.push({ outletId: id, reason: `no page whose byline equals the stored critic (${cands.length} read)` });
  }
  for (const [url, expected] of extra) {
    const r = [...latest.values()].find((x) => x.url === url);
    if (!r || !take(r, expected, `${r.outletId}-${expected.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, '-')}`)) manifest.missing.push({ outletId: r ? r.outletId : '?', url, reason: `extra page not read as ${expected}` });
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const bytes = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`${manifest.fixtures.length} fixtures, ${manifest.missing.length} outlets missing, ${(bytes / 1024).toFixed(0)} KB`);
  for (const m of manifest.missing) console.log(`  missing ${m.outletId}: ${m.reason}`);
}

if (require.main === module) main();
