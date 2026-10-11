#!/usr/bin/env node
/**
 * plan-we-historical-opening-repair.js — fix plan for West End historical rows
 * whose openingDate is really the first performance (BRO-5080).
 *
 * Class: discoverySource 'we-historical:wos', no previewsStartDate,
 * openingDateSource 'whatsonstage'. A WOS listing with no preview_date gives
 * the first performance in opening_date; the sourced sample audit found 61 of
 * 85 sampled rows showing a first preview as opening night. Per row
 * (scripts/lib/we-historical-dates.js repairWosOpening):
 *   - previewsStartDate := the WOS date (the first performance);
 *   - openingDate := a sourced press night from the fact-check adjudications
 *     when the sample has one (source 'press-night-correction-bro-5080'),
 *     else the review-mode inference ('inferred-from-reviews-mode'),
 *     else unchanged with source 'whatsonstage-first-performance'
 *     (unconfirmed, so enrich-west-end-dates.js --fix-unconfirmed can still
 *     correct it);
 *   - a noReliableArt marker is re-keyed when openingDate changes: the marker's
 *     fingerprint includes openingDate, and a stale marker would put the row
 *     back into the image sweep that filled it with wrong art (BRO-5022).
 *
 * Usage:
 *   node scripts/plan-we-historical-opening-repair.js [--reviews=PATH] [--dry-run]   counts only
 *   node scripts/plan-we-historical-opening-repair.js --out=PATH                     write a plan of data-edit actions
 *   node scripts/plan-we-historical-opening-repair.js --apply                        edit data/shows.json in place
 * A plan for the whole class runs past the 25-action plan cap, so the class is
 * applied from a fix plan's run-script action (execute-approved-fix.js
 * ALLOWED_SCRIPTS) with --apply. It recomputes from the data it finds and is
 * idempotent: a repaired row has a previewsStartDate and leaves the class.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { repairWosOpening } = require('./lib/we-historical-dates');
const { hasActiveNoArtMarker, buildNoReliableArtMarker } = require('./lib/no-reliable-art');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : (process.argv.includes(`--${n}`) ? true : d); };

const SOURCED = 'press-night-correction-bro-5080';

/**
 * Sourced press nights from the fact-check adjudications: id -> {date, url}.
 * A row whose stored opening was checked and found correct maps to
 * {date: null}: it is left alone, never re-inferred.
 */
function sourcedPressNights(adjudications) {
  const out = new Map();
  for (const [key, v] of Object.entries(adjudications || {})) {
    const [id, field] = key.split('|');
    if (field !== 'openingNight' || !v.url) continue;
    if (v.verdict === 'correct') { out.set(id, { date: null, url: v.url }); continue; }
    if (v.verdict !== 'wrong') continue;
    const m = String(v.correctValue || '').match(/^\d{4}-\d{2}-\d{2}/);
    if (m && /opening=first-preview/.test(String(v.note || ''))) out.set(id, { date: m[0], url: v.url });
  }
  return out;
}

/** Plan actions for one row (pure). */
function rowActions(show, reviews, sourced) {
  let changes = repairWosOpening(show, reviews);
  if (!changes.length) return [];
  const s = sourced && sourced.get(show.id);
  if (s && s.date === null) return [];
  if (s && s.date > show.openingDate) {
    changes = [
      { field: 'previewsStartDate', oldValue: null, newValue: show.openingDate },
      { field: 'openingDate', oldValue: show.openingDate, newValue: s.date },
      { field: 'openingDateSource', oldValue: show.openingDateSource, newValue: SOURCED },
    ];
  }
  const actions = changes.map((c) => ({
    type: 'data-edit', file: 'shows.json', showId: show.id, field: c.field, oldValue: c.oldValue, newValue: c.newValue,
    description: `${show.id}: ${c.field} ${c.oldValue ?? 'null'} -> ${c.newValue}${c.field === 'openingDate' && s && c.newValue === s.date ? ` (${s.url})` : ''} (BRO-5080: WOS date with no preview date is the first performance)`,
  }));
  const newOpening = (changes.find((c) => c.field === 'openingDate') || {}).newValue;
  if (newOpening && hasActiveNoArtMarker(show)) {
    actions.push({
      type: 'data-edit', file: 'shows.json', showId: show.id, field: 'noReliableArt', oldValue: show.noReliableArt,
      newValue: { ...buildNoReliableArtMarker({ ...show, openingDate: newOpening }, { reason: show.noReliableArt.reason }), at: show.noReliableArt.at },
      description: `${show.id}: re-key the no-reliable-art marker to the corrected opening date so the image sweep keeps skipping it`,
    });
  }
  return actions;
}

function main() {
  const showsJson = JSON.parse(fs.readFileSync(arg('shows', path.join(ROOT, 'data', 'shows.json')), 'utf8'));
  const shows = Array.isArray(showsJson) ? showsJson : showsJson.shows;
  const rj = JSON.parse(fs.readFileSync(arg('reviews', path.join(ROOT, 'data', 'reviews.json')), 'utf8'));
  const reviews = Array.isArray(rj) ? rj : rj.reviews;
  const byShow = new Map();
  for (const r of reviews) { if (!byShow.has(r.showId)) byShow.set(r.showId, []); byShow.get(r.showId).push(r); }
  const adjPath = path.join(ROOT, 'data', 'audit', 'fact-check', 'we-historical-adjudications.json');
  const sourced = sourcedPressNights(fs.existsSync(adjPath) ? JSON.parse(fs.readFileSync(adjPath, 'utf8')) : {});
  // Sample rows whose stored opening a sourced checker confirmed (no adjudication needed) are left alone too.
  if (fs.existsSync(path.join(ROOT, 'data', 'audit', 'fact-check', 'we-historical-checks.jsonl'))) {
    const { triage } = require('./fact-check-historical-sample');
    for (const r of triage('we-historical')) {
      if (r.field === 'openingNight' && (r.status === 'ok' || r.status === 'ok-cited') && !sourced.has(r.id)) sourced.set(r.id, { date: null, url: null });
    }
  }

  const actions = [];
  const tally = { rows: 0, sourced: 0, inferred: 0, collapsed: 0, rekeyed: 0 };
  for (const show of shows) {
    const a = rowActions(show, byShow.get(show.id) || [], sourced);
    if (!a.length) continue;
    tally.rows++;
    const src = (a.find((x) => x.field === 'openingDateSource') || {}).newValue;
    if (src === SOURCED) tally.sourced++; else if (src === 'inferred-from-reviews-mode') tally.inferred++; else tally.collapsed++;
    if (a.some((x) => x.field === 'noReliableArt')) tally.rekeyed++;
    actions.push(...a);
  }
  console.log(JSON.stringify(tally));
  if (arg('apply')) {
    const showsWriteGuard = require('./lib/shows-write-guard');
    const data = showsWriteGuard.loadShows();
    const list = Array.isArray(data) ? data : data.shows;
    const byId = new Map(list.map((s) => [s.id, s]));
    let applied = 0;
    for (const a of actions) {
      const row = byId.get(a.showId);
      const cur = row && row[a.field] !== undefined ? row[a.field] : null;
      if (!row || JSON.stringify(cur) !== JSON.stringify(a.oldValue)) { console.log(`  skip ${a.showId}.${a.field}: changed since planned`); continue; }
      row[a.field] = a.newValue;
      applied++;
    }
    showsWriteGuard.saveShows(data);
    console.log(`applied ${applied}/${actions.length} edits to data/shows.json`);
    return;
  }
  if (arg('dry-run') || !arg('out')) return;
  const plan = {
    issueNumber: 'bro-5080-opening',
    planId: crypto.randomUUID(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    submitter: { name: null, email: null },
    plan: {
      summary: `BRO-5080: ${tally.rows} West End historical rows store a WhatsOnStage first-performance date as opening night (sourced sample: 61 of 85 wrong). Move it to previewsStartDate; set the press night from a sourced page (${tally.sourced}) or the review-date mode (${tally.inferred}); mark the rest unconfirmed (${tally.collapsed}).`,
      steps: [
        'previewsStartDate null -> the WOS first-performance date',
        'openingDate -> sourced press night or most common review date minus one day, when a clear cluster exists',
        "openingDateSource -> 'press-night-correction-bro-5080' | 'inferred-from-reviews-mode' | 'whatsonstage-first-performance' (unconfirmed)",
        'Re-key noReliableArt markers whose fingerprint includes the old opening date',
      ],
      riskLevel: 'Low',
      actions,
    },
  };
  const out = arg('out');
  fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, out)}: ${actions.length} actions`);
}

if (require.main === module) main();

module.exports = { sourcedPressNights, rowActions, SOURCED };
