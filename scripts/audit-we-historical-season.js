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
 *   9. opening       no row still stores a WhatsOnStage first performance as
 *                    its openingDate (openingDateSource
 *                    'whatsonstage-first-performance', the fallback when
 *                    review-mode inference finds no press night). BRO-5851:
 *                    the 2017-18 sample found all 5 such rows wrong; set a
 *                    sourced press night with a fix plan, or, when a sourced
 *                    search finds none, openingDateSource
 *                    'first-performance-no-press-night-found' (counted, not
 *                    gated). BRO-6450: 'theatricalia-first-performance' too.
 *  10. completeness  advisory (BRO-6450): share of the two-source season
 *                    reference list (data/audit/we-season-reference/<season>.json,
 *                    build-we-season-reference.js) that has a west-end row,
 *                    with the missing titles listed. Gate once the backfill lands.
 *                    gap-justifications.json maps a miss to an existing row
 *                    (same-production) or out of scope; wouldPass uses the
 *                    in-scope share.
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
const { WOS_FIRST_PERFORMANCE_SOURCE, NO_PRESS_NIGHT_FOUND_SOURCE, THEATRICALIA_FIRST_PERFORMANCE_SOURCE } = require('./lib/we-historical-dates');
const { referenceCoverage, loadGapJustifications } = require('./lib/we-season-reference');

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

// A review-text file the gather found but whose text was never fetched: it
// can never be scored, so a season full of these fails displayable with no
// other sign of why (2016-17: 215 such files, BRO-5851).
const isUnfetched = f => f && f.contentTier === 'stub' && f.incompleteReason === 'not_attempted' && !f.wrongProduction;

function auditSeason({ shows, reviews, season, ids, imageSources = {}, factCheckVerdicts = [], windowExceptions = [], textFiles = {}, reference = null, gapJustifications = [] }) {
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

  // The searched-none source vouches only for a collapsed row (opening = first
  // performance); on any other shape the label means nothing, so it fails.
  const collapsed = s => Boolean(s.previewsStartDate) && s.openingDate === s.previewsStartDate;
  const firstPerformanceOpenings = promoted.filter(s => s.openingDateSource === WOS_FIRST_PERFORMANCE_SOURCE
    || s.openingDateSource === THEATRICALIA_FIRST_PERFORMANCE_SOURCE
    || (s.openingDateSource === NO_PRESS_NIGHT_FOUND_SOURCE && !collapsed(s)))
    .map(s => ({ showId: s.id, openingDate: s.openingDate }));
  const noPressNightFound = promoted.filter(s => s.openingDateSource === NO_PRESS_NIGHT_FOUND_SOURCE && collapsed(s)).length;

  const unfetched = promoted.map(s => ({ showId: s.id, count: (textFiles[s.id] || []).filter(isUnfetched).length }))
    .filter(r => r.count > 0);
  // Files that would not parse are named, not silently counted as fetched.
  const unreadable = promoted.reduce((n, s) => n + (textFiles[s.id] || []).filter(f => f === null).length, 0);

  const displayableShare = promoted.length ? perShow.filter(s => s.displayable).length / promoted.length : 0;
  const checks = {
    displayable: { pass: displayableShare >= MIN_DISPLAYABLE_SHARE, value: Math.round(displayableShare * 100) / 100, threshold: MIN_DISPLAYABLE_SHARE },
    inWindow: { pass: outOfWindow.length === 0, value: outOfWindow.length, rows: outOfWindow, exempted },
    duplicates: { pass: duplicates.length === 0, value: duplicates.length, rows: duplicates },
    provenance: { pass: null, value: t12 ? Math.round((t12WithUrl / t12) * 100) / 100 : null, note: `${t12WithUrl}/${t12} T1/T2 reviews have a URL (reported, not gated)` },
    poster: { pass: badPosters.length === 0, value: badPosters.length, rows: badPosters, missing: noPoster },
    titles: { pass: censored.length === 0, value: censored.length, rows: censored },
    synopsis: { pass: null, value: synopsisLook.length, rows: synopsisLook, missing: noSynopsis },
    opening: { pass: firstPerformanceOpenings.length === 0, value: firstPerformanceOpenings.length, rows: firstPerformanceOpenings, noPressNightFound },
    unfetched: { pass: null, value: unfetched.reduce((n, r) => n + r.count, 0), rows: unfetched, unreadable },
    factCheck: { pass: null, ...seasonSummary(factCheckVerdicts, promoted.map(s => s.id)) },
    // Completeness against the two-source season reference list (BRO-6450).
    // Every west-end row counts, not only promoted ones: a long-runner or a
    // pre-existing row carries its reference entry too. Advisory until the
    // backfill lands (CLAUDE.md §19); `wouldPass` is what gating would say.
    completeness: reference
      ? (({ pass, ...rest }) => ({ pass: null, wouldPass: pass, ...rest }))(referenceCoverage({ reference, shows, justifications: gapJustifications }))
      : { pass: null, total: 0, present: [], missing: [], share: null, wouldPass: null },
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
  // Review-text metadata only (never the text), for the unfetched count. No
  // review-texts checkout reads as "nothing to report".
  const textFiles = {};
  const textsDir = path.join(root, 'data', 'review-texts');
  for (const s of shows) {
    if (!WE_HISTORICAL_DISCOVERY_SOURCES.has(s.discoverySource) || s.season !== season) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(textsDir, s.id)).filter(n => n.endsWith('.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    textFiles[s.id] = names.map(n => {
      try {
        const { contentTier, incompleteReason, wrongProduction } = JSON.parse(fs.readFileSync(path.join(textsDir, s.id, n), 'utf8'));
        return { contentTier, incompleteReason, wrongProduction };
      } catch { return null; }
    });
  }
  // Committed reference list (scripts/build-we-season-reference.js); none for this season reads as "not checked".
  let reference = null;
  try {
    reference = JSON.parse(fs.readFileSync(path.join(root, 'data', 'audit', 'we-season-reference', `${season}.json`), 'utf8')).reference;
  } catch (e) {
    // Advisory input: a broken list must not turn into a SEASON FAIL.
    if (e.code !== 'ENOENT') console.log(`INFO completeness: reference list unreadable (${e.message.split('\n')[0]}); skipped`);
  }
  // Sourced reasons for reference entries the matcher misses (gap-justifications.json).
  let gapJustifications = [];
  try {
    gapJustifications = loadGapJustifications(root, season);
  } catch (e) {
    console.log(`INFO completeness: gap justifications unreadable (${e.message.split('\n')[0]}); ignored`);
  }
  const result = auditSeason({ shows, reviews, season, ids, imageSources, factCheckVerdicts, windowExceptions, textFiles, reference, gapJustifications });

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
    console.log(`${mark(c.opening.pass)} opening: ${c.opening.value} row(s) whose openingDate is a first performance (WhatsOnStage or Theatricalia), not a press night; ${c.opening.noPressNightFound} kept after a search found no press night`);
    for (const r of c.opening.rows) console.log(`    ${r.showId}: ${r.openingDate} (set a sourced press night)`);
    if (c.unfetched.value) {
      console.log(`INFO unfetched: ${c.unfetched.value} review(s) found but never fetched, so they cannot be scored (dispatch collect-review-texts.yml -f show_filter=<ids> -f archive_first=true -f max_reviews=0)`);
      console.log(`    ${c.unfetched.rows.map(r => `${r.showId} ${r.count}`).join(', ')}`);
    } else {
      console.log('INFO unfetched: 0 review(s) waiting for their text');
    }
    if (c.unfetched.unreadable) console.log(`    ${c.unfetched.unreadable} review-text file(s) would not parse; check them by hand`);
    if (!c.factCheck.sampled) {
      console.log(`INFO fact-check: no sourced sample pass covers this season (node scripts/fact-check-historical-sample.js sample --cohort=we-historical --season=${season} --n=30, then check + report)`);
    } else {
      const t = c.factCheck.table;
      const line = Object.entries(t).filter(([, v]) => v.checked).map(([f, v]) => `${f} ${v.wrong}/${v.checked}`).join(', ');
      console.log(`INFO fact-check: ${c.factCheck.sampled} sampled row(s), wrong/checked: ${line}`);
      for (const w of c.factCheck.wrong) console.log(`    ${w.id} ${w.field}: ${w.note || ''}${w.url ? ` (${w.url})` : ''}`);
    }
    const k = c.completeness;
    if (k.total) {
      const scope = k.outOfScope.length ? `, ${k.present.length}/${k.inScopeTotal} in scope = ${k.inScopeShare}` : '';
      console.log(`INFO completeness: ${k.present.length}/${k.total} reference production(s) on the site (${k.share}${scope}, ${k.wouldPass ? 'meets' : 'below'} ${k.threshold}; advisory)`);
      for (const r of k.missing) console.log(`    missing: ${r.title} (${r.venue}, ${r.start})`);
      for (const r of k.present.filter(p => p.via)) console.log(`    same production: ${r.title} (${r.start}) = ${r.showId}`);
      for (const r of k.outOfScope) console.log(`    out of scope (${r.category}): ${r.title} (${r.venue}, ${r.start})`);
      for (const r of k.staleJustifications) console.log(`    WARN stale justification: ${r.title} (${r.start})${r.showId ? ` -> ${r.showId}` : ''}`);
    } else {
      console.log(`INFO completeness: no reference list for ${season} (node scripts/build-we-season-reference.js --season=${season})`);
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
