#!/usr/bin/env node
/**
 * audit-director-guard-dates.js — read-only (BRO-5373 cousin sweep).
 *
 * The rebuild's director guard (review-guards evaluateDirectorGuard, map from
 * prior-run-sibling buildMultiProdDirectorGuard) drops a review filed under an
 * older production when its text names a director listed on a NEWER production
 * of the same title. When the older entry has no director on file and the newer
 * one is a revival or return by the same director (National Theatre returns, the
 * Old Vic's yearly Christmas Carol), real reviews of the older production are
 * dropped.
 *
 * For every review the guard drops today this prints the review's publishDate,
 * the older production's dates, the newer production the director came from and
 * its start date, and whether the review was published before that newer
 * production began (so it cannot be about it). It also flags guard entries whose
 * "newer" production has no openingDate (sorted last by default) but closed
 * before the older one opened.
 *
 * Prints ids, outlets, critics and dates only, never review text.
 *
 * Usage: node scripts/audit-director-guard-dates.js [--show=ID] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildMultiProdDirectorGuard } = require('./lib/prior-run-sibling');
const { evaluateDirectorGuard } = require('./lib/review-guards');
const { toDateMs } = require('./lib/date-utils');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const onlyShow = (args.find(a => a.startsWith('--show=')) || '').slice(7) || null;
const asJson = args.includes('--json');

// Any date toDateMs reads ("March 19th, 2025" included), as YYYY-MM-DD.
const ymd = (d) => {
  const ms = d ? toDateMs(d) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
};
const startOf = (s) => ymd(s && s.previewsStartDate) || ymd(s && s.openingDate);

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const byId = Object.fromEntries(shows.map(s => [s.id, s]));
  const guard = buildMultiProdDirectorGuard(shows);
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }

  const rows = [];
  const misorderedNewer = [];
  for (const [olderId, dirMap] of Object.entries(guard)) {
    if (onlyShow && olderId !== onlyShow) continue;
    const older = byId[olderId];
    for (const newerId of new Set([...dirMap.values()].map(v => v.newerId))) {
      const newer = byId[newerId];
      if (newer && !ymd(newer.openingDate) && ymd(newer.closingDate) && startOf(older)
          && ymd(newer.closingDate) < startOf(older)) {
        misorderedNewer.push({ olderId, newerId, newerClosing: ymd(newer.closingDate), olderStart: startOf(older) });
      }
    }
    const dir = path.join(textsDir, olderId);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      const hit = evaluateDirectorGuard(data, older, dirMap);
      if (!hit) continue;
      const newer = byId[hit.newerId];
      const pub = ymd(data.publishDate);
      const newerStart = startOf(newer);
      const verdict = !pub ? 'no-publishDate'
        : !newerStart ? 'newer-has-no-start'
          : pub < newerStart ? 'published-before-newer-began' : 'published-after-newer-began';
      rows.push({
        show: olderId, file, outlet: data.outletId || data.outlet || null, critic: data.criticName || null,
        publishDate: pub, olderOpening: ymd(older.openingDate), olderClosing: ymd(older.closingDate),
        olderDirectors: (older.creativeTeam || []).filter(c => /director/i.test(c.role)).map(c => c.name),
        director: hit.dirName, newerId: hit.newerId, newerStart, verdict,
      });
    }
  }

  const byVerdict = {};
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  if (asJson) {
    console.log(JSON.stringify({ total: rows.length, byVerdict, misorderedNewer, rows }, null, 2));
    return;
  }
  console.log(`director-guard drops: ${rows.length}`);
  console.log('by verdict:', JSON.stringify(byVerdict));
  console.log(`\nguard entries whose "newer" production closed before the older one began (null openingDate sorted last): ${misorderedNewer.length}`);
  for (const m of misorderedNewer) console.log(`  ${m.olderId} <- ${m.newerId} (newer closed ${m.newerClosing}, older began ${m.olderStart})`);
  console.log('\nshow | file | publishDate | older open..close | director -> newer (start) | verdict');
  for (const r of rows) {
    console.log(`${r.show} | ${r.file} | ${r.publishDate} | ${r.olderOpening}..${r.olderClosing} | ${r.director} -> ${r.newerId} (${r.newerStart}) | ${r.verdict}`);
  }
}

if (require.main === module) main();
