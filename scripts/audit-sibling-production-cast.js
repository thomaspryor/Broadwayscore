#!/usr/bin/env node
'use strict';
/**
 * audit-sibling-production-cast — corpus sweep for reviews whose text names only
 * a same-title SIBLING production's cast/creatives (BRO-5499: Sea Wall 2026 held
 * the 2019 Gyllenhaal review, scored 88). Report-only: fixes go through a
 * data/pending-fixes review-field-edit plan (wrongProduction + reason).
 *
 *   node scripts/audit-sibling-production-cast.js [--show=ID] [--json] [--strict] [--casts]
 *   --casts  report shows.json rows whose cast list was copied from a same-title sibling (not review files)
 *
 * Skips files already excluded (wrongProduction/wrongShow/invalid/rejected,
 * human-cleared). --strict exits 1 when any live (scored or includable) hit remains.
 */
const fs = require('fs');
const path = require('path');
const { findSiblingProductionCastMismatch } = require('./lib/sibling-production-cast');
const { isHumanClearedWrongProduction } = require('./lib/stale-flag-neutralization');

require('./lib/cli-help').exitOnHelp(module);

const ROOT = path.join(__dirname, '..');
const RT = path.join(ROOT, 'data', 'review-texts');
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--show=')) || '').slice(7) || null;
const asJson = args.includes('--json');
const strict = args.includes('--strict');

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const shows = Array.isArray(raw) ? raw : raw.shows;
const { titleKey } = require('./lib/sibling-production-cast');
const groups = new Map();
for (const s of shows) {
  const k = titleKey(s.title);
  if (!k) continue;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(s);
}

// --casts: shows.json rows whose cast list was copied from a same-title sibling of another year
if (args.includes('--casts')) {
  const { findCopiedSiblingCasts } = require('./lib/sibling-production-cast');
  const copied = findCopiedSiblingCasts(shows);
  if (asJson) console.log(JSON.stringify({ copied }, null, 2));
  else {
    console.log(`${copied.length} shows.json rows share >=80% of their cast with a same-title entry 3+ years apart`);
    for (const c of copied) console.log(`  ${c.showId} <- ${c.siblingId} (${c.shared}/${c.of})`);
  }
  // --strict fails only on rows opened since 2020: older rows are revivals that really brought the original cast back
  // (paul-robeson-1995, aint-misbehavin-1988), while a copied cast lands on new placeholder entries.
  if (strict && copied.some((c) => c.year >= 2020)) process.exit(1);
  process.exit(0);
}

const hits = [];
let scanned = 0;
for (const grp of groups.values()) {
  if (grp.length < 2) continue;
  for (const show of grp) {
    if (only && show.id !== only) continue;
    const dir = path.join(RT, show.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (d.wrongProduction || d.wrongShow || d.contentTier === 'invalid' || d.rejectedAt) continue;
      if (isHumanClearedWrongProduction(d)) continue;
      scanned++;
      const m = findSiblingProductionCastMismatch(d.fullText, show, grp, { publishDate: d.publishDate });
      if (m) hits.push({ showId: show.id, file: f, outlet: d.outlet, criticName: d.criticName, publishDate: d.publishDate || null, assignedScore: d.assignedScore ?? null, ...m });
    }
  }
}
if (asJson) console.log(JSON.stringify({ scanned, hits }, null, 2));
else {
  console.log(`scanned ${scanned} review files in same-title groups; ${hits.length} sibling-cast mismatches`);
  for (const h of hits) console.log(`  ${h.showId}/${h.file} score=${h.assignedScore} pub=${h.publishDate} -> ${h.siblingId}: ${h.siblingNamesFound.join(', ')}`);
}
if (strict && hits.some((h) => h.assignedScore != null)) process.exit(1);
