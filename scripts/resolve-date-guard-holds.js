#!/usr/bin/env node
/**
 * Resolve date-guard HOLDS without a person (BRO-5032).
 *
 * flag-wrong-production-by-date.js stamps `dateGuardHeld` on a review dated
 * outside the run when current-run corroboration contradicts the date; rebuild
 * excludes such a file from scores until it is resolved. This script refetches
 * the live page, extracts the real publish date (never dateModified), and:
 *   - date inside the run, no prior-run republish  -> correct publishDate, clear marker
 *   - date inside the run but a prior-run republish -> wrongProduction
 *   - otherwise re-runs content verification (publishDate withheld so the bad
 *     date does not bias it): high-confidence affirm clears the marker, reject
 *     sets wrongProduction
 *   - 3 inconclusive attempts -> dateGuardResolveExhausted (stays excluded)
 * Decisions live in scripts/lib/date-guard-hold.js resolveHoldDecision().
 * Never writes a file carrying a humanReviewScore. Writes via safeWriteReview.
 *
 * Usage:
 *   node scripts/resolve-date-guard-holds.js --dry-run   decide, write nothing (first live pass)
 *   node scripts/resolve-date-guard-holds.js             apply
 *   node scripts/resolve-date-guard-holds.js --limit=N   at most N fetches (default and max 10)
 */
const fs = require('fs');
const { verifierExcerpt } = require('./lib/excerpt-fields');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `resolve-date-guard-holds.js: refetch and resolve reviews carrying a dateGuardHeld marker.
  --dry-run   decide, write nothing
  --limit=N   at most N refetches this run (max 10, the nightly budget)
  --help, -h  print this usage and exit
`;

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_JSON = path.join(__dirname, '..', 'data', 'shows.json');
const STATE_PATH = path.join(__dirname, '..', 'data', 'audit', 'date-guard-resolve-state.json');

function marketFor(showId, show) {
  if (show?.type === 'opera') return 'opera';
  if (show?.category) return show.category;
  if (showId.includes('west-end')) return 'west-end';
  if (showId.includes('off-broadway')) return 'off-broadway';
  return 'broadway';
}

function findHeld(dir) {
  const held = [];
  for (const showId of fs.readdirSync(dir)) {
    const sd = path.join(dir, showId);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const file of fs.readdirSync(sd)) {
      if (!file.endsWith('.json')) continue;
      const fp = path.join(sd, file);
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      if (!raw.includes('"dateGuardHeld"')) continue;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      if (data.dateGuardHeld && typeof data.dateGuardHeld === 'object') held.push({ showId, file, filePath: fp, data });
    }
  }
  return held;
}

async function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = Math.max(1, Math.min(10, limitArg ? Number(limitArg.split('=')[1]) || 10 : 10));

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) { console.error(`No review-texts corpus at ${REVIEW_TEXTS_DIR}.`); process.exit(1); }

  const {
    resolveHoldDecision, clearDateGuardHold, RESOLVE_ATTEMPTS_FIELD, RESOLVE_EXHAUSTED_FIELD,
  } = require('./lib/date-guard-hold');
  const { extractPublishDate, extractArticleText } = require('./lib/article-extractor');
  const { fetchPage } = require('./lib/scraper');
  const { verifyContent, resolveCvMarket } = require('./lib/content-verifier');
  const { isLongRunningProduction } = require('./lib/long-runner-registry');
  const { safeWriteReview, invalidateWrongProductionAutoClear } = require('./lib/review-write-guard');
  const breaker = require('./lib/refetch-circuit-breaker');
  const { laneBypasses } = require('./lib/opening-night-lane/trust-model');
  const { shouldSkipWrongProductionAudit } = require('./lib/review-guards');

  const showsData = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
  const showById = {};
  for (const s of showsData.shows) showById[s.id] = s;

  const held = findHeld(REVIEW_TEXTS_DIR).filter(h => !h.data[RESOLVE_EXHAUSTED_FIELD]);
  console.log(`${held.length} held file(s)${dryRun ? ' (DRY RUN)' : ''}`);
  const stats = { 'correct-date': 0, 'wrong-production': 0, 'cv-affirm': 0, retry: 0, exhausted: 0, refuse: 0, skippedBudget: 0, errors: 0 };
  let state = breaker.loadRecoveryState(STATE_PATH);
  let fetches = 0;

  for (const h of held) {
    const { showId, file, filePath, data } = h;
    const show = showById[showId];
    if (!show) { console.log(`  [NO SHOW] ${showId}/${file}`); continue; }
    if (fetches >= limit) { stats.skippedBudget++; continue; }
    const gate = breaker.decideRefetch(state, { showId, fileName: file });
    if (!gate.allowed) {
      console.log(`  [BUDGET:${gate.reason}] ${showId}/${file}`);
      if (gate.reason === 'per-file-cap' && !dryRun) {
        // Dead URL: the breaker will never allow another fetch, so settle it.
        data[RESOLVE_EXHAUSTED_FIELD] = { at: new Date().toISOString(), reason: 'refetch per-file cap reached without a resolution' };
        if (safeWriteReview(filePath, data)?.wrote !== false) stats.exhausted++;
      } else stats.skippedBudget++;
      continue;
    }

    console.log(`Resolving ${showId}/${file} (stored ${data.publishDate})`);
    try {
      let refetch = { ok: false };
      if (!data.url && !dryRun) {
        data[RESOLVE_EXHAUSTED_FIELD] = { at: new Date().toISOString(), reason: 'no url to refetch' };
        if (safeWriteReview(filePath, data)?.wrote !== false) stats.exhausted++;
        continue;
      }
      if (data.url) {
        fetches++;
        state = breaker.recordRefetch(gate.state, { showId, fileName: file });
        if (!dryRun) breaker.saveRecoveryState(STATE_PATH, state);
        try {
          const res = await fetchPage(data.url, { timeout: 20000 });
          const html = typeof res === 'string' ? res : (res?.html || res?.content || '');
          if (html && html.length > 200) {
            refetch = { ok: true, date: extractPublishDate(html, data.url), text: extractArticleText(html, new URL(data.url).hostname) || null };
          }
        } catch (e) { console.log(`  fetch error: ${e.message}`); }
      }

      const attempts = data[RESOLVE_ATTEMPTS_FIELD] || 0;
      let cv = null;
      let decision = resolveHoldDecision({ review: data, show, refetch, cv, attempts });
      let cvResult = null;
      if (decision.action === 'need-cv') {
        const text = (refetch.text && refetch.text.length > 200 ? refetch.text : data.fullText) || '';
        const [outlet, critic] = file.replace('.json', '').split('--');
        cvResult = await verifyContent({
          scrapedText: text,
          excerpt: verifierExcerpt(data),
          showTitle: show.title,
          outletName: outlet || data.outlet || 'unknown',
          criticName: critic || data.criticName || 'unknown',
          openingDate: show.openingDate || null,
          venue: show.venue || null, // venue-write-guard-ok: read-only context passed to verifyContent, never written to a record
          market: resolveCvMarket(show) || marketFor(showId, show),
          isLongRunningProduction: isLongRunningProduction(show),
          publishDate: null, // the held date is the suspect; do not let it bias CV
          url: data.url || null,
          show,
        });
        cv = cvResult;
        decision = resolveHoldDecision({ review: data, show, refetch, cv, attempts });
      }
      console.log(`  -> ${decision.action}: ${decision.reason}`);
      stats[decision.action] = (stats[decision.action] || 0) + 1;
      if (dryRun || decision.action === 'refuse') continue;

      const now = new Date().toISOString();
      if (decision.countAttempt) data[RESOLVE_ATTEMPTS_FIELD] = attempts + 1;
      if (cvResult) {
        const stamped = { ...cvResult, verifiedAt: now, reverifiedFrom: 'date-guard-hold-resolver' };
        // Only a settled verdict goes on contentVerification: an affirming CV on a
        // file that stays held would add cv-affirms-production, flip the hold to a
        // CHECK 0 error and let rebuild include it.
        if (decision.action === 'cv-affirm' || decision.action === 'wrong-production') data.contentVerification = stamped;
        else data.dateGuardResolveLastCv = stamped;
      }
      switch (decision.action) {
        case 'correct-date':
          data.previousPublishDate = data.publishDate;
          data.publishDate = decision.date;
          data.dateSource = 'date-guard-hold-refetch';
          data.publishDateCorrectedAt = now;
          clearDateGuardHold(data);
          break;
        case 'cv-affirm':
          clearDateGuardHold(data);
          break;
        case 'wrong-production':
          // Opening-night lane reviews are never flagged (BRO-4807): leave the hold as is.
          if (laneBypasses(data, 'wrongProduction')) { console.log('  lane review: not flagging'); break; }
          // A file a person cleared or overrode is left alone (manual-clear breadcrumb).
          if (shouldSkipWrongProductionAudit(data)) { console.log('  manual clear/override on file: not flagging'); break; }
          data.wrongProduction = true;
          invalidateWrongProductionAutoClear(data);
          // Note only, prefixed "Date guard" so priorRuns auto-clear still applies.
          data.wrongProductionNote = `Date guard hold resolver: ${decision.reason}`;
          clearDateGuardHold(data);
          break;
        case 'exhausted':
          data[RESOLVE_EXHAUSTED_FIELD] = { at: now, reason: decision.reason };
          break;
        default: break; // retry: attempt counter only
      }
      const w = safeWriteReview(filePath, data);
      if (w && (w.wrote === false || w.lockedSkipped || w.preserved)) console.log(`  write did not fully land: ${JSON.stringify({ wrote: w.wrote, lockedSkipped: w.lockedSkipped, skipped: w.skipped })}`);
    } catch (e) {
      console.log(`  ERROR ${e.message}`);
      stats.errors++;
    }
  }
  console.log('=== SUMMARY ===');
  console.log(JSON.stringify(stats, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
