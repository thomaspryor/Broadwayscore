#!/usr/bin/env node
/**
 * audit-we-historical-season.js
 *
 * Quality gate for one West End historical backfill season (BRO-4851, plan
 * v3.1 docs/specs/west-end-historical-backfill-v3.md "Season audit"). Read-only:
 * prints pass/fail per check, writes nothing. Measure it ~7 days after the
 * season's last scoring dispatch; a season must pass before the next starts.
 *
 * Checks, over shows promoted by promote-historical-we.js
 * (discoverySource 'we-historical:wos' or, review-led, 'we-historical:tr') for the season:
 *   1. displayable   >= 70% of shows have >= 5 scored reviews
 *   2. in-window     every scored review is inside the show's run window
 *                    (date-guard.js evaluateDateGuard, the same rule the
 *                    rebuild's flagger uses), so no review of another
 *                    production is counted
 *   3. duplicates    no outlet+critic appears twice for one show
 *   4. provenance    share of T1/T2 reviews with a URL (reported, not gated:
 *                    paywalled Theatre Record texts legitimately lack one)
 *   5. poster        no row's art comes from a NYC-only source (Theatr) for a
 *                    London row or from a URL in show.rejectedImageUrls
 *                    (Phase B: Othello/Godot got Broadway posters); rows with
 *                    no art are listed
 *   6. titles        no censored title left ("P*rn Play": search found nothing)
 *   7. synopsis      listed, not gated: rows whose synopsis opens with
 *                    pitch, billing, a pull quote or a cast list
 *                    (todaytix-page-identity nonStoryReason; Phase B saved
 *                    several) and rows with none
 *   8. fact-check    advisory (BRO-5080): per-field error rates from the
 *                    sourced two-checker sample (fact-check-historical-sample.js)
 *                    for this season's rows, or a note that none was run.
 *                    Proposed to gate once a season sample pass is routine.
 *
 * Usage:
 *   node scripts/audit-we-historical-season.js --season=2024-2025 [--json] [--ids=a,b]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { evaluateDateGuard } = require('./lib/date-guard');
const { getOutletTier } = require('./lib/review-normalization');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { todaytixMarket } = require('./lib/todaytix-market');
const { nonStoryReason } = require('./lib/todaytix-page-identity');
const { isRejectedImage } = require('./lib/image-source-match');
const { WE_HISTORICAL_DISCOVERY_SOURCES } = require('./lib/we-historical-corroboration');
const { seasonSummary } = require('./lib/fact-check-sample');

const NYC_ONLY_IMAGE_HOST_RE = /theatr-app\.appspot\.com/;
const CENSORED_TITLE_RE = /[a-z]\*+[a-z]/i;
const sentences = t => (String(t || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(?=\s|$)/g) || []).map(x => x.trim());

/** Why this row's art is the wrong production, or null. imageSources: data/image-sources.json map. */
function posterProblem(show, sourceUrls) {
  // Only fields the row still shows: a cleared hero keeps its old source entry.
  const img = show.images || {};
  const urls = Object.entries(sourceUrls || {})
    .filter(([field, u]) => typeof u === 'string' && img[field])
    .map(([, u]) => u);
  if (urls.some(u => isRejectedImage({ poster: u }, show))) return 'art from a rejected URL';
  if (todaytixMarket(show) === 'london' && urls.some(u => NYC_ONLY_IMAGE_HOST_RE.test(u))) return 'London row with NYC-only (Theatr) art';
  return null;
}

/** True when one of the first 4 sentences is pitch, billing, a pull quote or a list (nonStoryReason). */
function synopsisNeedsLook(text) {
  if (!text) return false;
  return sentences(text).slice(0, 4).some(x => nonStoryReason(x));
}

const MIN_SCORED = 5;
const MIN_DISPLAYABLE_SHARE = 0.7;

const USAGE = `audit-we-historical-season.js — pass/fail quality gate for a West End historical season.

Usage:
  node scripts/audit-we-historical-season.js --season=YYYY-YYYY [options]

Options:
  --ids=a,b     Audit only these show ids (e.g. a pilot batch)
  --json        Print the result as JSON
  --help, -h    print this usage and exit
`;

const isScored = r => typeof r.assignedScore === 'number' && Number.isFinite(r.assignedScore);

/**
 * Pure: shows + reviews → audit result.
 * @param {{shows: object[], reviews: object[], season: string, ids?: Set<string>}} input
 */
// Reviewed exceptions to the in-window check (data/audit/we-historical-window-exceptions.json):
// a review outside the run window that a session checked and kept, with the
// evidence. Matched on show + outlet + publish date.
const windowExceptionKey = (showId, outletId, publishDate) => `${showId}|${outletId}|${String(publishDate || '').slice(0, 10)}`;

function auditSeason({ shows, reviews, season, ids, imageSources = {}, factCheckVerdicts = [], windowExceptions = [] }) {
  const excepted = new Map(windowExceptions.map(e => [windowExceptionKey(e.showId, e.outletId, e.publishDate), e]));
  const exempted = [];
  const promoted = shows.filter(s => WE_HISTORICAL_DISCOVERY_SOURCES.has(s.discoverySource) && s.season === season
    && (!ids || !ids.size || ids.has(s.id)));
  const byShow = new Map(promoted.map(s => [s.id, []]));
  for (const r of reviews) if (byShow.has(r.showId)) byShow.get(r.showId).push(r);

  const perShow = [];
  const outOfWindow = [];
  const duplicates = [];
  let t12 = 0;
  let t12WithUrl = 0;
  for (const show of promoted) {
    const rows = byShow.get(show.id);
    const scored = rows.filter(isScored);
    const seen = new Map();
    for (const r of scored) {
      const pub = r.publishDate ? new Date(String(r.publishDate).slice(0, 10)) : null;
      if (pub && !Number.isNaN(pub.getTime())) {
        // A declared earlier run / tour leg is the same production (Amélie
        // 2021's Other Palace 2019-20 run); the rebuild includes those (BRO-5141).
        const d = evaluateDateGuard({ pubDate: pub, show, outletId: r.outletId, priorRuns: show.priorRuns, tourLegs: show.tourLegs });
        if (d && d.flag) {
          const row = { showId: show.id, outlet: r.outlet, critic: r.criticName, publishDate: r.publishDate };
          const exception = excepted.get(windowExceptionKey(show.id, r.outletId, r.publishDate));
          if (exception && (!exception.url || exception.url === r.url)) exempted.push({ ...row, reason: exception.reason });
          else outOfWindow.push(row);
        }
      }
      const key = `${r.outletId || r.outlet}|${String(r.criticName || '').toLowerCase()}`;
      if (seen.has(key)) duplicates.push({ showId: show.id, outlet: r.outlet, critic: r.criticName });
      seen.set(key, true);
      const tier = getOutletTier(r.outletId);
      if (tier === 1 || tier === 2) { t12++; if (r.url) t12WithUrl++; }
    }
    perShow.push({ id: show.id, scored: scored.length, total: rows.length, displayable: scored.length >= MIN_SCORED });
  }

  const badPosters = [];
  const noPoster = [];
  const censored = [];
  const synopsisLook = [];
  const noSynopsis = [];
  for (const show of promoted) {
    const img = show.images || {};
    if (!img.thumbnail && !img.poster) noPoster.push(show.id);
    const problem = posterProblem(show, imageSources[show.id]);
    if (problem) badPosters.push({ showId: show.id, problem });
    if (CENSORED_TITLE_RE.test(show.title || '')) censored.push({ showId: show.id, title: show.title });
    if (!show.synopsis) noSynopsis.push(show.id);
    else if (synopsisNeedsLook(show.synopsis)) synopsisLook.push({ showId: show.id, synopsis: String(show.synopsis).slice(0, 120) });
  }

  const displayableShare = promoted.length ? perShow.filter(s => s.displayable).length / promoted.length : 0;
  const checks = {
    displayable: { pass: displayableShare >= MIN_DISPLAYABLE_SHARE, value: Math.round(displayableShare * 100) / 100, threshold: MIN_DISPLAYABLE_SHARE },
    inWindow: { pass: outOfWindow.length === 0, value: outOfWindow.length, rows: outOfWindow, exempted },
    duplicates: { pass: duplicates.length === 0, value: duplicates.length, rows: duplicates },
    provenance: { pass: null, value: t12 ? Math.round((t12WithUrl / t12) * 100) / 100 : null, note: `${t12WithUrl}/${t12} T1/T2 reviews have a URL (reported, not gated)` },
    poster: { pass: badPosters.length === 0, value: badPosters.length, rows: badPosters, missing: noPoster },
    titles: { pass: censored.length === 0, value: censored.length, rows: censored },
    synopsis: { pass: null, value: synopsisLook.length, rows: synopsisLook, missing: noSynopsis },
    factCheck: { pass: null, ...seasonSummary(factCheckVerdicts, promoted.map(s => s.id)) },
  };
  const gated = Object.values(checks).filter(c => c.pass !== null);
  return { season, shows: promoted.length, pass: promoted.length > 0 && gated.every(c => c.pass), checks, perShow };
}

function main() {
  const args = process.argv.slice(2);
  const season = args.find(a => a.startsWith('--season='))?.split('=')[1];
  if (!season) { console.error('Usage: node scripts/audit-we-historical-season.js --season=YYYY-YYYY'); process.exit(2); }
  const ids = new Set((args.find(a => a.startsWith('--ids='))?.split('=')[1] || '').split(',').filter(Boolean));
  const root = path.join(__dirname, '..');
  const showsRaw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const reviewsRaw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || Object.values(showsRaw));
  const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : (reviewsRaw.reviews || []);
  let imageSources = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'image-sources.json'), 'utf8'));
    imageSources = raw.shows || raw;
  } catch { /* no sources file: poster provenance check sees no URLs */ }
  // Sourced sample verdicts (BRO-5080): the cross-season sample plus a season sample if one was drawn.
  let factCheckVerdicts = [];
  try {
    const { verdictsFor } = require('./fact-check-historical-sample');
    factCheckVerdicts = [...verdictsFor('we-historical'), ...verdictsFor(`we-historical-${season}`)];
  } catch (e) {
    // Missing files read as "no sample"; anything else (a corrupt adjudications file, a bug) must not hide verdicts.
    if (e.code !== 'ENOENT' && !(e.code === 'MODULE_NOT_FOUND' && /fact-check-historical-sample/.test(e.message.split('\n')[0]))) throw e;
  }
  let windowExceptions = [];
  try {
    windowExceptions = JSON.parse(fs.readFileSync(path.join(root, 'data', 'audit', 'we-historical-window-exceptions.json'), 'utf8')).exceptions || [];
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const result = auditSeason({ shows, reviews, season, ids, imageSources, factCheckVerdicts, windowExceptions });

  if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); }
  else {
    console.log(`West End historical season ${season}: ${result.shows} promoted show(s)`);
    for (const s of result.perShow) console.log(`  ${s.displayable ? '✓' : '·'} ${s.id}: ${s.scored} scored / ${s.total} reviews`);
    const c = result.checks;
    const mark = p => (p === null ? 'INFO' : p ? 'PASS' : 'FAIL');
    console.log(`${mark(c.displayable.pass)} displayable: ${c.displayable.value} (need >= ${c.displayable.threshold})`);
    console.log(`${mark(c.inWindow.pass)} in-window: ${c.inWindow.value} review(s) outside their show's run`);
    for (const r of c.inWindow.rows) console.log(`    ${r.showId}: ${r.outlet} / ${r.critic} ${r.publishDate}`);
    for (const r of c.inWindow.exempted) console.log(`    kept (reviewed exception): ${r.showId}: ${r.outlet} ${r.publishDate} (${r.reason})`);
    console.log(`${mark(c.duplicates.pass)} duplicates: ${c.duplicates.value}`);
    for (const r of c.duplicates.rows) console.log(`    ${r.showId}: ${r.outlet} / ${r.critic}`);
    console.log(`${mark(c.provenance.pass)} provenance: ${c.provenance.note}`);
    console.log(`${mark(c.poster.pass)} poster: ${c.poster.value} row(s) with wrong-production art; ${c.poster.missing.length} with none`);
    for (const r of c.poster.rows) console.log(`    ${r.showId}: ${r.problem}`);
    if (c.poster.missing.length) console.log(`    no art: ${c.poster.missing.join(', ')}`);
    console.log(`${mark(c.titles.pass)} titles: ${c.titles.value} censored title(s)`);
    for (const r of c.titles.rows) console.log(`    ${r.showId}: "${r.title}" (set the real title)`);
    console.log(`${mark(c.synopsis.pass)} synopsis: ${c.synopsis.value} to look at (pitch/billing/quotes); ${c.synopsis.missing.length} missing`);
    for (const r of c.synopsis.rows) console.log(`    ${r.showId}: ${r.synopsis}`);
    if (!c.factCheck.sampled) {
      console.log(`INFO fact-check: no sourced sample pass covers this season (node scripts/fact-check-historical-sample.js sample --cohort=we-historical --season=${season} --n=30, then check + report)`);
    } else {
      const t = c.factCheck.table;
      const line = Object.entries(t).filter(([, v]) => v.checked).map(([f, v]) => `${f} ${v.wrong}/${v.checked}`).join(', ');
      console.log(`INFO fact-check: ${c.factCheck.sampled} sampled row(s), wrong/checked: ${line}`);
      for (const w of c.factCheck.wrong) console.log(`    ${w.id} ${w.field}: ${w.note || ''}${w.url ? ` (${w.url})` : ''}`);
    }
    console.log(result.pass ? 'SEASON PASS' : 'SEASON FAIL');
  }
  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main();
}

module.exports = { auditSeason, posterProblem, synopsisNeedsLook };
