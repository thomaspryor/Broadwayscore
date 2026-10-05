#!/usr/bin/env node
/**
 * enrich-tour-runtimes.js (BRO-4750): a runtime for every national tour whose
 * own source publishes one.
 *
 * A tour page showed an empty Runtime for 11 tours at the Reddit launch: the
 * parent-inheritance rule (tour-family.js tourInheritance) only fills a runtime
 * when the Broadway parent is plausibly the same production, and these
 * parents were not (or had no runtime of their own). The tour's Tours To You
 * page (tourstoyou.org/shows/<slug>/, the source of its schedule) lists the
 * touring production's Runtime and Intermissions; scripts/lib/tour-runtime.js
 * reads them.
 *
 * Rules:
 *   - Only tours with NO runtime are touched; a stored runtime is never
 *     replaced, so hand corrections and parent-inherited values stand.
 *   - Never the Broadway parent's runtime (tour cuts differ): the value comes
 *     from the tour's own page, and the page URL is stored as runtimeSource.
 *   - Fails closed: a page that is not that tour's page, has no runtime,
 *     disagrees with itself, or cannot be fetched leaves the tour unchanged.
 *   - Writes go through the shows write guard (loadShows/saveShows).
 *
 * Usage:
 *   node scripts/enrich-tour-runtimes.js               every tour without a runtime
 *   node scripts/enrich-tour-runtimes.js --show=ID     one tour
 *   node scripts/enrich-tour-runtimes.js --dry-run     report, write nothing
 *
 * Run daily by .github/workflows/fetch-tour-schedules.yml, right after the
 * schedules. Once a tour has a runtime it is never fetched again, so a normal
 * day reads only the tours still waiting for one. Exits 1 only when at least 3
 * tours were unreachable and that is more than half of those tried (a dead
 * source); a page that publishes no runtime, or a 404 for a removed page, is
 * not a failure.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { politeFetchText, looksLikeShowPage } = require('./lib/tours-to-you');
const { extractTourRuntime, pageIsTour, candidateUrls } = require('./lib/tour-runtime');
const { createRunBudget } = require('./lib/run-budget');

const SCHEDULES_PATH = path.join(__dirname, '..', 'data', 'tour-schedules.json');

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('enrich-tour-runtimes.js [--show=ID] [--dry-run]'); return; }
  const only = (argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;
  const dryRun = argv.includes('--dry-run');

  const data = loadShows();
  const schedules = fs.existsSync(SCHEDULES_PATH) ? JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8')) : { tours: {} };
  const targets = data.shows.filter(s => s.category === 'tour' && !s.runtime && (!only || s.id === only));
  console.log(`${targets.length} tour(s) without a runtime${dryRun ? ' (dry run)' : ''}`);
  if (only && !targets.length) console.log(`${only}: not a tour without a runtime (nothing to do; a stored runtime is never replaced)`);

  // ~11 tours x up to 3 pages x 2s apart is about a minute; 5 leaves room for 429 backoffs
  // without eating the job's timeout (the tour-art step after this needs up to 30).
  const budget = createRunBudget(5);
  let filled = 0, noRuntime = 0, notFetched = 0;
  for (const [i, tour] of targets.entries()) {
    if (budget.exceeded()) { console.log(`Time budget reached; ${targets.length - i} tour(s) wait until tomorrow`); break; }
    let found = null;
    // The site answered (a page, or a plain 404 for a slug guess). Only a network
    // error, a 5xx or a 429 that outlasted its retries counts as "could not fetch":
    // a closed tour whose page was removed is "no page", not a dead source.
    let reached = false;
    for (const url of candidateUrls(tour, schedules).slice(0, 3)) {
      let html = '';
      try { html = await politeFetchText(url, { budget }); reached = true; } catch (e) {
        if (e.status === 404) reached = true;
        console.log(`  ${tour.id}: ${url} -> ${e.message}`);
        continue;
      }
      if (!looksLikeShowPage(html)) { console.log(`  ${tour.id}: ${url} is not a Tours To You show page`); continue; }
      if (!pageIsTour(html, tour)) { console.log(`  ${tour.id}: ${url} is a different show's page; skipped`); continue; }
      const rt = extractTourRuntime(html);
      if (rt) { found = { url, ...rt }; break; }
    }
    if (!reached) { notFetched++; console.log(`${tour.id}: no page could be fetched`); continue; }
    if (!found) { noRuntime++; console.log(`${tour.id}: no runtime published`); continue; }
    console.log(`${tour.id}: ${found.runtime}${found.intermissions != null ? `, ${found.intermissions} intermission(s)` : ''} (${found.url})`);
    filled++;
    if (dryRun) continue;
    tour.runtime = found.runtime;
    if (tour.intermissions == null && found.intermissions != null) tour.intermissions = found.intermissions;
    tour.runtimeSource = found.url;
  }

  if (filled && !dryRun) saveShows(data);
  console.log(`${filled} filled, ${noRuntime} publish no runtime, ${notFetched} not fetched, of ${targets.length}`);
  // A dead source, not one missing page: at least 3 tours unreachable and more than half.
  if (notFetched >= 3 && notFetched / targets.length > 0.5) {
    console.error(`::error::${notFetched}/${targets.length} tour pages could not be fetched from Tours To You`);
    process.exit(1);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
