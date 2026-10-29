#!/usr/bin/env node
/**
 * plan-ob-historical-cohort.js — build the add-show actions for one cohort of
 * the Off-Broadway historical backfill (BRO-6153,
 * docs/specs/ob-historical-backfill-v2.md, "Gap cohort results").
 *
 * READ-ONLY. Never writes shows.json or a plan file. Prints a summary and, at
 * the end, the add-show actions as JSON between ACTIONS_BEGIN / ACTIONS_END,
 * for new-fix-plan.js-style plans (buildPlans) built by the caller. Runs where
 * the scraper keys are (Actions, via scripts/cloud-run-script.js, or the Mac).
 *
 * Flow:
 *   1. TheaterMania OB listings whose run starts in [--from, --to]
 *      (fetchTmOffBroadway with a window filter; free WP JSON).
 *   2. Parse rows and drop non-theater and one-night rows (discovery's gates),
 *      then rows already in shows.json (findTmSameTitleShow, checkForDuplicate).
 *   3. Playbill check per candidate (validate-show-venue.js validateOne).
 *      Only 'match' results with parsed dates go on.
 *   4. selectPromotable (promote-ob-historical.js): venue, retired-id and
 *      duplicate guards, entry built from Playbill dates.
 *   5. decideObHistoricalEntry: both dates, run of 14+ days, closed 90+ days.
 *
 * Usage:
 *   node scripts/plan-ob-historical-cohort.js --from=2024-06-01 --to=2025-05-31 [--limit=N] [--time-budget-min=50] [--today=YYYY-MM-DD]
 *   node scripts/plan-ob-historical-cohort.js --from=... --to=... --no-playbill   (steps 1-2 only, no keys needed)
 *   node scripts/plan-ob-historical-cohort.js --from=... --to=... --candidates-file=PATH
 *     (BRO-6496: outlet-first. Step 1 reads the census candidates in PATH instead of
 *     TheaterMania, and step 5 also requires the Playbill run to start in the window.)
 */
'use strict';

// venue-write-guard-ok: venues here only feed validateOne's Playbill lookup and the selection; the one written value goes through toAddShowAction, which applies sanitizeVenueForWrite.

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `plan-ob-historical-cohort.js — list Playbill-validated Off-Broadway productions for one backfill window (read-only).

Usage:
  node scripts/plan-ob-historical-cohort.js --from=YYYY-MM-DD --to=YYYY-MM-DD [--limit=N] [--time-budget-min=50] [--today=YYYY-MM-DD]
  node scripts/plan-ob-historical-cohort.js --from=... --to=... --no-playbill   (TheaterMania + dedup only, no scraper keys)
  --titles-file=PATH   keep only candidates whose title is in this JSON array (the outlet census's notable catalog gaps, BRO-6481)
  --candidates-file=PATH   take candidates from this JSON array instead of TheaterMania (BRO-6496):
                       [{title, openingDate (earliest review date), closingDate?, venue?, evidenceUrls?}],
                       as written by scripts/ob-census-candidates.js. Rows get discoverySource ob-historical:census.
`;

function arg(name) {
  const a = process.argv.slice(2).find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Title key for --titles-file: case, accents and punctuation do not count.
function titleKey(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const fromIso = arg('from');
  const toIso = arg('to');
  if (!ISO.test(fromIso || '') || !ISO.test(toIso || '') || fromIso > toIso) {
    console.error(USAGE);
    process.exit(2);
  }
  const todayIso = arg('today') || new Date().toISOString().slice(0, 10);
  const limit = Number(arg('limit')) || Infinity;
  const budgetMs = (Number(arg('time-budget-min')) || 50) * 60 * 1000;
  const noPlaybill = process.argv.includes('--no-playbill');
  const titlesFile = arg('titles-file');
  const candidatesFile = arg('candidates-file');
  const wantTitles = titlesFile ? new Set(JSON.parse(fs.readFileSync(titlesFile, 'utf8')).map(titleKey)) : null;
  const started = Date.now();

  const { fetchTmOffBroadway, isTmRowInWindow, parseTmOffBroadwayRow, findTmSameTitleShow } = require('./lib/theatermania-ob');
  const { checkForDuplicate } = require('./lib/deduplication');
  const { isNonTheaterContent, isOneNightShow } = require('./discover-new-shows');
  const { selectPromotable } = require('./promote-ob-historical');
  const { decideObHistoricalEntry, toAddShowAction, isStructuralOnlyMismatch, playbillFacts, transferLinkFields, isEntryInWindow } = require('./lib/ob-historical-cohort');

  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = Array.isArray(showsData) ? showsData : showsData.shows;

  // 1. TheaterMania window (or, with --candidates-file, the census list).
  // ~80 pages of 100; ordered by id so edits mid-scan cannot shift pages.
  const feed = candidatesFile ? censusFeed(candidatesFile) : await fetchTmOffBroadway({
    maxPages: 120,
    rowFilter: r => isTmRowInWindow(r, { fromIso, toIso }),
    stopWhenPageEmpty: false,
    orderby: 'id',
  });
  console.log(`${candidatesFile ? 'Census candidates' : 'TheaterMania'}: ${feed.rawCount} rows over ${feed.pagesFetched} pages; ${feed.rows.length} start in ${fromIso}..${toIso}`);
  if (feed.pagesFetched >= 120) console.log('::warning::hit the 120-page cap; the scan may be truncated');
  if (feed.rawCount === 0) {
    console.error(candidatesFile ? `::error::${candidatesFile} has no rows` : '::error::TheaterMania returned no rows (feed blind) — not a real empty cohort');
    process.exit(1);
  }

  // 2. Parse, gate, dedup.
  const skips = {};
  const note = (k) => { skips[k] = (skips[k] || 0) + 1; };
  const candidates = [];
  for (const row of feed.rows) {
    const r = candidatesFile ? { candidate: row, gateShape: { title: row.title, venue: row.venue } }
      : parseTmOffBroadwayRow(row, { venuesById: feed.venuesById, genresById: feed.genresById });
    if (r.skip) { note('parse'); continue; }
    if (isNonTheaterContent(r.gateShape) || isOneNightShow(r.gateShape)) { note('gate'); continue; }
    const c = r.candidate;
    // BRO-6254: a transfer (other venue, runs apart) is its own production here.
    // Census rows have no venue yet, so a later Broadway transfer cannot be told
    // apart here (isDistinctTransfer needs both venues). Only an Off-Broadway row
    // counts as in-catalog for them; selectPromotable re-checks with Playbill's venue.
    const sameRun = (s) => s && (!candidatesFile || s.category === 'off-broadway');
    if (sameRun(findTmSameTitleShow(c, shows, { allowTransfers: true }))) { note('in-catalog'); continue; }
    let dup = null;
    try { dup = checkForDuplicate(c, shows); } catch (e) { note('dedup-error'); console.log(`  ! checkForDuplicate failed for "${c.title}": ${e.message}`); dup = null; }
    if (dup && dup.isDuplicate && (!candidatesFile || sameRun(dup.existingShow))) { note('in-catalog'); continue; }
    if (wantTitles && !wantTitles.has(titleKey(c.title))) { note('not-in-titles-file'); continue; }
    candidates.push(c);
  }
  console.log(`Candidates after parse/gate/dedup: ${candidates.length} (skipped ${JSON.stringify(skips)})`);
  if (noPlaybill) {
    for (const c of candidates.slice(0, limit)) console.log(`  ${c.previewsStartDate || c.openingDate} → ${c.closingDate || '?'}  ${c.title} @ ${c.venue}`);
    return;
  }

  // 3. Playbill per candidate.
  const { validateOne } = require('./validate-show-venue');
  const results = [];
  const verdicts = {};
  let checked = 0;
  for (const c of candidates) {
    if (checked >= limit) break;
    if (Date.now() - started > budgetMs) { console.log(`Time budget reached after ${checked} candidates; ${candidates.length - checked} not checked`); break; }
    checked++;
    const target = {
      id: `${c.slug}-off-broadway-pending`, title: c.title, venue: c.venue, category: 'off-broadway',
      openingDate: c.openingDate || c.previewsStartDate || null, closingDate: c.closingDate || null,
    };
    let r;
    try { r = await validateOne(target, () => {}); } catch (e) { r = { result: 'error', error: e.message }; }
    if (isStructuralOnlyMismatch(r, { claimedOpening: target.openingDate })) r = { ...r, result: 'match', structuralOnly: r.mismatches.map(m => m.field) };
    verdicts[r.result] = (verdicts[r.result] || 0) + 1;
    if (r.result === 'match' && r.playbillUrl && r.parsed && r.parsed.dates) {
      results.push({ ...r, title: c.title, venue: c.venue, tmUrl: c.theatermaniaUrl, censusUrls: c.evidenceUrls || [], listingGenre: c.listingGenre });
    }
  }
  console.log(`Playbill: checked ${checked}; ${JSON.stringify(verdicts)}`);
  try { await require('./lib/scraper').cleanup(); } catch (_) { /* best-effort: browser/pool teardown */ }

  // 4-5. Guards, then cohort rules.
  const { toPromote, skipped, transferOf, typeGuessed } = selectPromotable(results, shows);
  const showById = new Map(shows.map(s => [s.id, s]));
  const tmById = new Map(results.map(r => [r.playbillUrl, r.tmUrl]));
  const censusById = new Map(results.map(r => [r.playbillUrl, r.censusUrls]));
  const resultByUrl = new Map(results.map(r => [r.playbillUrl, r]));
  const actions = [];
  const ruleSkips = [];
  for (const raw of toPromote) {
    const e = { ...raw, ...playbillFacts(resultByUrl.get(raw.playbillUrl), raw) };
    const d = decideObHistoricalEntry(e, { todayIso });
    if (!d.ok) { ruleSkips.push(`${e.title}: ${d.reason}`); continue; }
    if (candidatesFile && !isEntryInWindow(e, { fromIso, toIso })) { ruleSkips.push(`${e.title}: Playbill run starts ${e.previewsStartDate || e.openingDate}, outside ${fromIso}..${toIso}`); continue; }
    const action = toAddShowAction(e, {
      discoveredAt: `${todayIso}T00:00:00.000Z`,
      dateSource: 'playbill-ob-historical',
      evidenceUrls: [e.playbillUrl, tmById.get(e.playbillUrl), ...(censusById.get(e.playbillUrl) || []).slice(0, 3)],
      ...(candidatesFile ? { discoverySource: 'ob-historical:census' } : {}),
    });
    if (!action) { ruleSkips.push(`${e.title}: venue "${e.venue}" failed sanitizeVenueForWrite`); continue; }
    // BRO-6254: link a split-off transfer to the run already in shows.json.
    Object.assign(action, transferLinkFields(action.show, showById.get(transferOf.get(e.id))));
    actions.push(action);
  }
  for (const s of skipped) console.log(`  - ${s.entry.title} (${s.reason})`);
  for (const s of ruleSkips) console.log(`  - ${s}`);
  for (const a of actions) console.log(`  + ${a.show.openingDate} → ${a.show.closingDate}  ${a.show.id} @ ${a.show.venue}`);
  // BRO-6506: rows typed 'play' with no Playbill tag, TM genre or title signal.
  const guessedIds = new Set(typeGuessed);
  const guessed = actions.filter(a => guessedIds.has(a.show.id));
  if (guessed.length) {
    console.log(`Type guessed as 'play' (check by hand before approving): ${guessed.length}`);
    for (const a of guessed) console.log(`  ? ${a.show.id}`);
  }
  console.log(`Promotable: ${actions.length}`);
  console.log('ACTIONS_BEGIN');
  console.log(JSON.stringify(actions));
  console.log('ACTIONS_END');
}

// BRO-6496: census candidates in the shape step 2 reads from a TheaterMania row.
function censusFeed(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).map(x => ({
    title: String(x.title || '').trim(),
    venue: x.venue || '',
    slug: String(x.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    openingDate: x.openingDate || null,
    previewsStartDate: null,
    closingDate: x.closingDate || null,
    category: 'off-broadway',
    source: 'outlet-census',
    evidenceUrls: x.evidenceUrls || [],
  })).filter(x => x.title && x.slug);
  return { rows, rawCount: rows.length, pagesFetched: 1, venuesById: {}, genresById: {} };
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
