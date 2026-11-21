#!/usr/bin/env node
/**
 * BRO-7932: re-run the collector's content verifier over every review stamped
 * "Collector LLM: wrong production" on a West End / Off-West End record, and
 * report how many flags survive. READ-ONLY on review files (writes only --out).
 *
 *   node scripts/recheck-london-wrongprod.js --out=/tmp/x.json [--since=2024-11-20] [--limit=N] [--concurrency=4]
 *   node scripts/recheck-london-wrongprod.js --summarize=/tmp/x.json   # before/after counts
 *   node scripts/recheck-london-wrongprod.js --stored-audit --strict    # no LLM: unhealed own-venue flags (exit 1); add --apply to heal them
 *
 * Needs the main checkout's data/review-texts (absent in worktrees): set DATA_ROOT.
 */
const fs = require('fs');
const path = require('path');
// Minimal .env loader (dotenv is not installed in worktrees).
try {
  for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* env already set */ }
const { verifyContent, resolveCvMarket } = require('./lib/content-verifier');
const { isLongRunningProduction } = (() => { try { return { isLongRunningProduction: require('./lib/long-runner-registry').isLongRunningProduction }; } catch (e) { return {}; } })();

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const DATA = process.env.DATA_ROOT || path.join(__dirname, '..', 'data');
const LONDON = new Set(['west-end', 'off-west-end']);

// A cleared flag counts only when a model re-judged real text and found a valid, non-film review of the right
// production; skip-short / heuristic fallbacks and isValid=false rows are 'noEvidence', not cleared.
function summary(rows) {
  const done = rows.filter(x => !x.error);
  const judged = done.filter(x => /^llm:/.test(x.verifiedBy || ''));
  const stillFlagged = judged.filter(x => x.wrongProduction).length;
  const cleared = judged.filter(x => !x.wrongProduction && x.isValid === true && !x.isFilmTv && !x.wrongArticle).length;
  return { total: rows.length, errors: rows.length - done.length, stillFlagged, cleared, noEvidence: done.length - stillFlagged - cleared };
}

function listFlags(since) {
  const shows = (x => Array.isArray(x) ? x : x.shows)(JSON.parse(fs.readFileSync(path.join(DATA, 'shows.json'), 'utf8')));
  const out = [];
  for (const s of shows) {
    if (!LONDON.has(s.category) || !s.openingDate || s.openingDate < since) continue;
    const dir = path.join(DATA, 'review-texts', s.id);
    let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) { continue; }
    for (const f of files) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      if (j.wrongProduction && /Collector LLM: wrong prod/.test(j.wrongProductionReason || '')) out.push({ show: s, file: f, data: j });
    }
  }
  return { out, shows };
}

/**
 * --stored-audit [--strict]: no model call. Lists London collector flags that
 * the own-venue carve-out would clear from the verdict ALREADY on file (critic
 * attended this record's own theatre, review inside the run) and that no
 * override covers. Such a flag means a pre-carve-out verdict was never healed.
 */
// --apply: heal the audit's findings (review-texts is the private repo: commit + push it afterwards).
function applyOwnVenueHeal(items) {
  const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
  const { classifyContentTier } = require('./lib/content-quality');
  const { restoreQuarantinedText, resetWrongContentTier } = require('./lib/collector-wp-release');
  const { isStaleScoreInput, markRescoreNeeded } = require('./lib/rescore-flagging');
  const { applyOwnVenueTourCarveout } = require('./lib/tour-stop-carveout');
  const { textNamesEarlierRun } = require('./lib/run-contamination');
  const nowIso = new Date().toISOString();
  let n = 0;
  for (const { show, file } of items) {
    const fp = path.join(DATA, 'review-texts', show.id, file);
    const orig = fs.readFileSync(fp, 'utf8'); // fresh read
    const data = JSON.parse(orig);
    const cv = data.contentVerification || {};
    const ok = data.wrongProduction === true && !data.wrongProductionOverride && !data.wrongProductionManualClear
      && typeof data.humanReviewedWrongProduction !== 'boolean' && !textNamesEarlierRun(data, show)
      && applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: cv.reasoning || data.wrongProductionReason, issues: cv.issues, reviewedVenue: cv.reviewedVenue }, show, { publishDate: data.publishDate }).tourStopCarveoutApplied;
    const field = String(data.fullText || '').length >= 800 ? 'fullText' : String(data.wrongFullText || '').length >= 800 ? 'wrongFullText' : null;
    if (!ok || !field) { console.log(`  skipped ${show.id}/${file}`); continue; }
    const note = `[${nowIso.slice(0, 10)} cleared collector wrongProduction: critic attended this record's own venue (${cv.reviewedVenue}); own-venue carve-out applied to the stored verdict${field === 'wrongFullText' ? '; text restored' : ''} (BRO-7932)]`;
    clearWrongProductionFlags(data, { source: 'recheck-london-wrongprod.js', reason: note });
    data.wrongProductionManualClear = true;
    data.wrongProductionClearedNote = note;
    if (field === 'wrongFullText') restoreQuarantinedText(data, classifyContentTier); else resetWrongContentTier(data, classifyContentTier);
    if (isStaleScoreInput(data, show, fp)) markRescoreNeeded(data, 'wrongProduction false-positive cleared (recheck-london-wrongprod)');
    fs.writeFileSync(fp, JSON.stringify(data, null, 2) + (orig.endsWith('\n') ? '\n' : ''));
    n++; console.log(`  healed ${show.id}/${file}`);
  }
  console.log(`APPLIED: healed ${n}`);
}

function storedAudit(since, strict) {
  const { applyOwnVenueTourCarveout } = require('./lib/tour-stop-carveout');
  const { out } = listFlags(since);
  const bad = [];
  const badItems = [];
  for (const { show, file, data } of out) {
    if (data.wrongProductionOverride === true || data.wrongProductionManualClear === true || typeof data.humanReviewedWrongProduction === 'boolean') continue;
    const cv = data.contentVerification || {};
    // Excluded for another reason too (duplicate, wrong show, feature/roundup, cut-off text): not a hidden real review.
    if (data.duplicateOf || data.wrongShow === true || data.isRoundupArticle === true || cv.truncated === true || (cv.articleType && cv.articleType !== 'review')) continue;
    const r = applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: cv.reasoning || data.wrongProductionReason, issues: cv.issues, reviewedVenue: cv.reviewedVenue }, show, { publishDate: data.publishDate });
    if (r.tourStopCarveoutApplied) { bad.push(`${show.id}/${file}`); badItems.push({ show, file, data }); }
  }
  const noVenue = out.filter(o => !(o.data.contentVerification || {}).reviewedVenue).length;
  // noVenueStored flags predate the reviewedVenue field: the audit cannot judge them (--recheck can).
  console.log(JSON.stringify({ londonCollectorFlags: out.length, noVenueStored: noVenue, unhealedOwnVenueFlags: bad.length }));
  bad.forEach(b => console.log(`  ${b}`));
  // A corpus that yields no flags at all is a broken read, not a clean bill (the gate must not pass on missing data).
  if (process.argv.includes('--apply')) applyOwnVenueHeal(badItems);
  if (strict && out.length === 0) { console.error('stored-audit: no London collector flags found; corpus unreadable?'); process.exit(2); }
  if (strict && bad.length) process.exit(1);
}

async function main() {
  if (process.argv.includes('--stored-audit')) return storedAudit(arg('since') || '0000-00-00', process.argv.includes('--strict'));
  if (arg('summarize')) {
    const r = JSON.parse(fs.readFileSync(arg('summarize'), 'utf8'));
    const done = r.filter(x => !x.error);
    const by = {}; done.forEach(x => by[x.verifiedBy] = (by[x.verifiedBy] || 0) + 1);
    console.log('verifiedBy', JSON.stringify(by));
    console.log(JSON.stringify(summary(r), null, 1));
    return;
  }
  const since = arg('since') || '2024-11-20';
  const { out, shows } = listFlags(since);
  const lim = +arg('limit') || out.length;
  const outFile = arg('out') || '/tmp/bro7932-recheck.json';
  let results = []; if (fs.existsSync(outFile)) results = JSON.parse(fs.readFileSync(outFile, 'utf8')); // corrupt file: throw, never silently restart
  const seen = new Set(results.filter(r => !r.error).map(r => r.key));
  const todo = out.filter(x => !seen.has(`${x.show.id}/${x.file}`)).slice(0, lim);
  const otherShowTitles = shows.filter(s => s.title && s.title.length >= 6).map(s => ({ id: s.id, t: s.title }));
  console.log(`${out.length} flagged, ${todo.length} to run`);
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const { show, file, data } = todo[i++];
      const key = `${show.id}/${file}`;
      const text = data.fullText || data.wrongFullText || '';
      const row = { key, showId: show.id, category: show.category, venue: show.venue, publishDate: data.publishDate || null, url: data.url, before: data.wrongProductionReason };
      try {
        const cv = await verifyContent({
          scrapedText: text, excerpt: data.excerpt || null, showTitle: show.title, outletName: data.outlet, criticName: data.criticName,
          openingDate: show.openingDate, venue: show.venue, market: resolveCvMarket(show),
          isLongRunningProduction: isLongRunningProduction ? !!isLongRunningProduction(show) : false,
          publishDate: data.publishDate || null, url: data.url || null,
          otherShowTitles: otherShowTitles.filter(o => o.id !== show.id).map(o => o.t), show,
        });
        Object.assign(row, { wrongProduction: !!cv.wrongProduction, isValid: cv.isValid, isFilmTv: !!cv.isFilmTv, wrongArticle: !!cv.wrongArticle, confidence: cv.confidence, reviewedVenue: cv.reviewedVenue, tourStopCarveoutApplied: cv.tourStopCarveoutApplied, reasoning: (cv.reasoning || '').slice(0, 400), verifiedBy: cv.verifiedBy });
      } catch (e) { row.error = String(e.message || e).slice(0, 200); }
      results = results.filter(r => r.key !== key); results.push(row);
      fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
    }
  }
  await Promise.all(Array.from({ length: +arg('concurrency') || 4 }, worker));
  const done = results.filter(r => !r.error);
  const by = {}; done.forEach(x => by[x.verifiedBy] = (by[x.verifiedBy] || 0) + 1); console.log('verifiedBy', JSON.stringify(by));
  console.log(JSON.stringify(summary(results)));
}
main().catch(e => { console.error(e); process.exit(1); });
