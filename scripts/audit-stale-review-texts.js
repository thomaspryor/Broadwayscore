#!/usr/bin/env node
/**
 * BRO-2395: audit review-text files that carry a stale manual-clear reason
 * (default: the 2026-04-01 "UK outlet reviewing WE show — false positive
 * cleared" string, which was bulk-stamped onto ~34 WE files). A clear reason
 * says the wrongProduction flag was a false positive; this checks the body
 * actually is about the show, so a bulk clear cannot hide a genuinely wrong text.
 *
 * Verdicts per file:
 *   OK       fullText is long enough and names the show title
 *   NO-BODY  fullText empty/short (nothing to verify; excerpt-only)
 *   SUSPECT  body present but never mentions the show title (read by hand)
 *
 * Usage:
 *   node scripts/audit-stale-review-texts.js [--reason=SUBSTRING] [--field=wrongProductionManualClear]
 *        [--review-texts-dir=PATH] [--json] [--gate]   # --gate exits 1 on any SUSPECT
 *   --restamp="NEW REASON"  rewrite the clear field on OK files (title-match only; hand-read
 *        SUSPECT/NO-BODY files first). --dry-run skips the write. --gate ignores NO-BODY.
 *        Exits 2 if fewer than 100 files scanned (wrong dir / empty clone).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');

const DEFAULT_REASON = 'UK outlet reviewing WE show — false positive cleared 2026-04-01';
const MIN_BODY = 600;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
}

// Title as written in prose: drop trailing parentheticals and subtitle after ':'
function titleVariants(title) {
  const t = String(title || '').replace(/\s*\(.*?\)\s*/g, ' ');
  const out = new Set([norm(t), norm(t.split(':')[0]), norm(t.replace(/^the /i, ''))]);
  return [...out].filter(v => v.length >= 3);
}

function classify(rec, title) {
  const body = norm(rec.fullText);
  if (body.length < MIN_BODY) return { verdict: 'NO-BODY', bodyLen: body.length };
  const padded = ` ${body} `;
  const hit = titleVariants(title).some(v => padded.includes(` ${v} `));
  return { verdict: hit ? 'OK' : 'SUSPECT', bodyLen: body.length };
}

function loadTitles(repoRoot) {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'shows.json'), 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.shows;
  return new Map(arr.map(s => [s.id, s.title]));
}

function audit({ dir, reason, field, titles, stats = {} }) {
  const rows = [];
  stats.scanned = 0;
  for (const show of listShowDirs(dir, { silent: true })) {
    const sdir = path.join(dir, show);
    for (const f of fs.readdirSync(sdir)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(sdir, f);
      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { stats.unparseable = (stats.unparseable || 0) + 1; continue; }
      stats.scanned++;
      if (typeof rec[field] !== 'string' || !rec[field].includes(reason)) continue;
      const title = titles.get(rec.showId || show) || rec.showTitle;
      rows.push({ file, show, title, outlet: rec.outlet, url: rec.url, ...classify(rec, title) });
    }
  }
  return rows;
}

function main(argv) {
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const arg = n => (argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
  const dir = arg('review-texts-dir') || path.join(os.homedir(), 'broadway-review-texts');
  const reason = arg('reason') || DEFAULT_REASON;
  const field = arg('field') || 'wrongProductionManualClear';
  const restamp = arg('restamp');
  if (!fs.existsSync(dir)) { console.error(`review-texts dir not found: ${dir}`); return 2; }
  if (argv.some(a => a === '--restamp' || a === '--restamp=')) { console.error('--restamp needs a non-empty reason'); return 2; }
  const stats = {};
  const rows = audit({ dir, reason, field, titles: loadTitles(path.join(__dirname, '..')), stats });
  if (stats.scanned < 100) { console.error(`only ${stats.scanned} review files scanned in ${dir}; wrong dir or empty clone`); return 2; }
  if (restamp && !argv.includes('--dry-run')) {
    for (const r of rows.filter(r => r.verdict === 'OK')) {
      const rec = JSON.parse(fs.readFileSync(r.file, 'utf8'));
      rec[field] = restamp;
      fs.writeFileSync(r.file + '.tmp', JSON.stringify(rec, null, 2) + '\n');
      fs.renameSync(r.file + '.tmp', r.file);
    }
  }
  if (argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const r of rows) console.log(`${r.verdict.padEnd(8)} ${String(r.bodyLen).padStart(6)}  ${path.relative(dir, r.file)}  [${r.title}]`);
    const c = v => rows.filter(r => r.verdict === v).length;
    console.log(`\n${rows.length} files: ${c('OK')} OK, ${c('NO-BODY')} NO-BODY, ${c('SUSPECT')} SUSPECT`);
  }
  return argv.includes('--gate') && rows.some(r => r.verdict === 'SUSPECT') ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { classify, titleVariants, audit, DEFAULT_REASON };
