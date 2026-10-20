#!/usr/bin/env node
/**
 * audit-uk-rows-on-broadway.js — read-only (BRO-5420).
 *
 * The rebuild's reverse cross-market guard flags a UK outlet on a Broadway
 * show, but exempts dual-market outlets, and the registry marks the UK
 * nationals (Daily Mail, Times, Telegraph, Guardian, The Stage) dual-market.
 * So a London review of a same-title London production, filed under the
 * Broadway id, can be live: chicago-1996 carried the Daily Mail's 1997 review
 * of the London Adelphi production at 78.
 *
 * Lists every LIVE review file (explainExclusion null) on a category
 * broadway show whose outlet is UK-side (registry region london / uk / dual)
 * or whose source is theatre-record, and whose publishDate is outside the
 * show's opening window (earliest show date - 21d .. opening + 60d) and not
 * inside a declared priorRuns window. A UK critic covering a Broadway show
 * does so at opening; a date months or years later is the signal that the
 * review is of a London production. Every hit needs a hand check.
 *
 * Also names a London show in shows.json with the same title family whose
 * run contains the date (a move target), when there is one.
 *
 * Ids, outlets, critics, dates and urls only, never review text.
 *
 * Usage: node scripts/audit-uk-rows-on-broadway.js [--show=a,b] [--lag-days=60] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { explainExclusion } = require('./lib/review-guards');
const { earliestShowDate } = require('./lib/date-guard');
const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');
const { buildOutletRegionMap } = require('./lib/cross-market-guard');
const { toDateMs } = require('./lib/date-utils');
const { foldDiacritics } = require('./lib/title-match');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const onlyShows = val('show') ? val('show').split(',') : null;
const lagDays = Number(val('lag-days') || 60);
const asJson = args.includes('--json');
const DAY = 86400000;
const UK_SIDE = new Set(['london', 'uk', 'dual']);

const ymd = (ms) => (Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10));
const titleKey = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

function londonCandidates(shows, show, pubMs) {
  const key = titleKey(show.title);
  return shows.filter((s) => s.id !== show.id && /west-end|off-west-end/.test(String(s.category || ''))
    && titleKey(s.title) === key).map((s) => {
    const start = toDateMs(earliestShowDate(s) || '');
    const end = s.closingDate ? toDateMs(s.closingDate) : Date.now();
    const inRun = !Number.isNaN(start) && pubMs >= start - 21 * DAY && pubMs <= (Number.isNaN(end) ? Date.now() : end) + 30 * DAY;
    return `${s.id}${inRun ? ' (date in run)' : ''}`;
  });
}

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const regionMap = buildOutletRegionMap(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8')));
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }

  const hits = [];
  let scanned = 0;
  for (const show of shows) {
    if (show.category !== 'broadway') continue;
    if (onlyShows && !onlyShows.includes(show.id)) continue;
    const dir = path.join(textsDir, show.id);
    if (!fs.existsSync(dir)) continue;
    const startMs = toDateMs(earliestShowDate(show) || '');
    const openMs = toDateMs(show.openingDate || show.previewsStartDate || '');
    if (Number.isNaN(startMs) || Number.isNaN(openMs)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      const outletId = r.outletId || file.split('--')[0];
      const region = regionMap[outletId] || null;
      const isTr = r.source === 'theatre-record';
      if (!isTr && !UK_SIDE.has(region)) continue;
      scanned++;
      const pubMs = toDateMs(r.publishDate || '');
      if (Number.isNaN(pubMs)) continue;
      if (pubMs >= startMs - 21 * DAY && pubMs <= openMs + lagDays * DAY) continue;
      if (isWithinPriorRun(new Date(pubMs), show.priorRuns)) continue;
      let excl;
      try { excl = explainExclusion(r, show, path.join(dir, file)); } catch (e) { excl = `error: ${e.message}`; }
      if (excl) continue;
      hits.push({
        show: show.id, file, outlet: outletId, region, source: r.source || null, critic: r.criticName || null,
        publishDate: ymd(pubMs), opening: show.openingDate || null, closing: show.closingDate || null,
        daysAfterOpening: Math.round((pubMs - openMs) / DAY), score: r.llmScore && r.llmScore.score !== undefined ? r.llmScore.score : (r.assignedScore ?? null),
        url: r.url || r.theatreRecordUrl || null, londonShows: londonCandidates(shows, show, pubMs),
      });
    }
  }
  hits.sort((a, b) => a.show.localeCompare(b.show) || a.file.localeCompare(b.file));
  if (asJson) { console.log(JSON.stringify({ scanned, hits: hits.length, rows: hits }, null, 2)); return; }
  console.log(`UK-side or Theatre Record files on Broadway shows scanned: ${scanned}`);
  console.log(`live and dated outside the opening window (-21d..+${lagDays}d) and priorRuns: ${hits.length}`);
  console.log('\nshow | file | outlet(region) | source | critic | publishDate | opening..closing | days after opening | score | london shows same title | url');
  for (const h of hits) {
    console.log([h.show, h.file, `${h.outlet}(${h.region})`, h.source, h.critic, h.publishDate, `${h.opening}..${h.closing || ''}`,
      h.daysAfterOpening, h.score, h.londonShows.join('; ') || '-', h.url].join(' | '));
  }
}

if (require.main === module) main();
