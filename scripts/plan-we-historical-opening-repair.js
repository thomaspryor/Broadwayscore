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
 * BRO-6453 adds the Theatricalia class (source 'theatricalia-first-performance',
 * previewsStartDate === openingDate): the press night moves to the review-date
 * mode when a clear cluster exists, else the row is left for the audit to flag.
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
const { repairWosOpening, repairTheatricaliaOpening, MODE_INFERENCE_SOURCE, WOS_FIRST_PERFORMANCE_SOURCE } = require('./lib/we-historical-dates');
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
    const judged = 'judgedStored' in v ? v.judgedStored : undefined;
    if (v.verdict === 'correct') { out.set(id, { date: null, url: v.url, judged }); continue; }
    if (v.verdict !== 'wrong') continue;
    const m = String(v.correctValue || '').match(/^\d{4}-\d{2}-\d{2}/);
    if (m && /opening=first-preview/.test(String(v.note || ''))) out.set(id, { date: m[0], url: v.url, judged });
  }
  return out;
}

/** Plan actions for one row (pure). */
function rowActions(show, reviews, sourced) {
  let changes = repairWosOpening(show, reviews);
  // BRO-6453: Theatricalia-built rows (previews already set) move on a review-date mode only.
  const theatricalia = !changes.length;
  if (theatricalia) changes = repairTheatricaliaOpening(show, reviews);
  if (!changes.length) return [];
  let s = sourced && sourced.get(show.id);
  if (theatricalia && !(s && s.date === null)) s = null; // only a checked-correct opening blocks the mode inference
  // An adjudication of a value the row no longer holds says nothing about it now.
  if (s && s.judged !== undefined && s.judged !== show.openingDate) s = null;
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
    description: `${show.id}: ${c.field} ${c.oldValue ?? 'null'} -> ${c.newValue}${c.field === 'openingDate' && s && c.newValue === s.date ? ` (${s.url})` : ''} (${theatricalia ? 'BRO-6453: Theatricalia first performance, press night from the review-date mode' : 'BRO-5080: WOS date with no preview date is the first performance'})`,
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
  const tally = { rows: 0, sourced: 0, inferred: 0, collapsed: 0, noPreviews: 0, rekeyed: 0 };
  for (const show of shows) {
    const a = rowActions(show, byShow.get(show.id) || [], sourced);
    if (!a.length) continue;
    tally.rows++;
    const src = (a.find((x) => x.field === 'openingDateSource') || {}).newValue;
    if (src === SOURCED) tally.sourced++;
    else if (src === MODE_INFERENCE_SOURCE) tally.inferred++;
    else if (src === WOS_FIRST_PERFORMANCE_SOURCE) tally.collapsed++;
    else tally.noPreviews++; // press night = first performance: keeps 'whatsonstage'
    if (a.some((x) => x.field === 'noReliableArt')) tally.rekeyed++;
    actions.push(...a);
  }
  console.log(JSON.stringify(tally));
  if (arg('apply')) {
    const showsWriteGuard = require('./lib/shows-write-guard');
    const data = showsWriteGuard.loadShows();
    const list = Array.isArray(data) ? data : data.shows;
    const byId = new Map(list.map((s) => [s.id, s]));
    // All of a row's edits or none: a half-applied row (previews set, opening
    // not) leaves the class and no re-run would finish it.
    const perRow = new Map();
    for (const a of actions) { if (!perRow.has(a.showId)) perRow.set(a.showId, []); perRow.get(a.showId).push(a); }
    let applied = 0; let skipped = 0;
    for (const [id, rowActs] of perRow) {
      const row = byId.get(id);
      const stale = !row || rowActs.some((a) => JSON.stringify(row[a.field] === undefined ? null : row[a.field]) !== JSON.stringify(a.oldValue));
      if (stale) { skipped++; console.log(`  skip ${id}: changed since planned`); continue; }
      for (const a of rowActs) row[a.field] = a.newValue;
      applied++;
    }
    if (applied) showsWriteGuard.saveShows(data);
    console.log(`applied ${applied} row(s), skipped ${skipped}`);
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
      summary: `BRO-5080: ${tally.rows} West End historical rows store a WhatsOnStage first-performance date as opening night (sourced sample: 61 of 85 wrong). Move it to previewsStartDate; set the press night from a sourced page (${tally.sourced}) or the review-date mode (${tally.inferred}); mark the rest unconfirmed (${tally.collapsed}); ${tally.noPreviews} opened on their first performance.`,
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

if (require.main === module) {
  if (require('./lib/cli-help').hasHelpFlag(process.argv.slice(2))) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 35).join('\n'));
    process.exit(0);
  }
  main();
}

module.exports = { sourcedPressNights, rowActions, SOURCED };
