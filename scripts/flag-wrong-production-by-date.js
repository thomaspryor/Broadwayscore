#!/usr/bin/env node
/**
 * Flag reviews as wrongProduction when publishDate falls outside
 * the show's date window: [previewStart - 14 days, closingDate + 7 days].
 *
 * This catches reviews of earlier/later productions that were incorrectly
 * linked to the wrong showId by aggregator sources.
 *
 * Safe to re-run — skips files already flagged wrongProduction/wrongShow/manualClear.
 * Run after adding new publishDates (e.g., backfill-url-dates.js) to catch more.
 *
 * Usage:
 *   node scripts/flag-wrong-production-by-date.js              # dry run
 *   node scripts/flag-wrong-production-by-date.js --apply      # write flags
 */

const fs = require('fs');
const { laneBypasses } = require('./lib/opening-night-lane/trust-model');
const path = require('path');
const { safeWriteReview, invalidateWrongProductionAutoClear } = require('./lib/review-write-guard');
const { isWithinPriorRun, isWithinTourLeg, isPreRunForUkClear, namesNonLondonCity } = require('./lib/wrong-production-autoclear');
const { evaluateDateGuard, evaluateDatelessRevivalGuard, evaluateShowScorePreviousProduction, evaluateLlmYearMisdate, guardPublishDate, earliestShowDate, DAYS_AFTER_CLOSE } = require('./lib/date-guard');
const { detectPriorRunRepublish } = require('./lib/prior-run-republish-guard');
const { evaluateCurrentRunCorroboration, shouldHoldDateGuardFlag } = require('./lib/wrong-production-corroboration');
const { isAwaitingUrlCorrectionRefetch } = require('./lib/stale-flag-after-url-correction');
const { evaluateDatePlausibility } = require('./lib/date-plausibility');
const { shouldSkipWrongProductionAudit } = require('./lib/review-guards');
const { isLondonMarket } = require('./lib/venue-classification');

// Multi-production (revival) title index: a show id whose base title has ≥2
// productions in shows.json. Used by the dateless-revival guard below to decide
// whether a review LACKING any usable date should be held as suspect prior-
// production contamination. Same base-title normalization as rebuild-all-reviews.js.
function buildMultiProductionTitleIds(showMap) {
  const baseTitle = (t) => String(t || '').replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '').trim().toLowerCase();
  const groups = {};
  for (const s of Object.values(showMap)) {
    const base = baseTitle(s.title);
    if (!base) continue;
    (groups[base] = groups[base] || []).push(s.id);
  }
  const ids = new Set();
  for (const g of Object.values(groups)) if (g.length >= 2) g.forEach(id => ids.add(id));
  return ids;
}

// Overridable via env so tests can point at a temp fixture dir/file instead
// of real data (same pattern as scripts/audit-show-review-gap.js).
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = process.env.SHOWS_PATH
  || path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = !process.argv.includes('--apply');

// Grace periods are defined in scripts/lib/date-guard.js and exported for
// reuse here (DAYS_AFTER_CLOSE only — DAYS_BEFORE_PREVIEW + UK_* are scoped
// to the pure decision function). Single source of truth.

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  const map = {};
  for (const show of Object.values(shows)) {
    map[show.id] = show;
  }
  return map;
}

const { parseDate } = require('./lib/date-utils');
const { extractDateFromUrl } = require('./lib/rebuild-helpers');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');

const USAGE = `flag-wrong-production-by-date.js — Flag reviews as wrongProduction when publishDate falls outside.

Usage:
  node scripts/flag-wrong-production-by-date.js [options]
  node scripts/flag-wrong-production-by-date.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
function run() {
  const showMap = loadShows();

  const showDirs = listShowDirs(REVIEW_TEXTS_DIR);

  const multiProductionTitleIds = buildMultiProductionTitleIds(showMap);

  let flaggedEarly = 0, flaggedLate = 0, skipped = 0, noDate = 0, noWindow = 0, ok = 0;
  let priorRunSkipped = 0, datelessRevivalFlagged = 0, priorRunRepublishFlagged = 0, showScorePrevFlagged = 0;
  let lockedSkipCount = 0, corroborationHeld = 0, corroborationWarned = 0;
  let awaitingRefetchSkipped = 0, overrideClearSkipped = 0, yearCorrected = 0;
  const yearCorrectedDetails = [];
  const flaggedDetails = [];
  const heldDetails = [];
  const stuckCiBlockingDetails = [];
  const overrideClearDetails = [];

  for (const showDir of showDirs) {
    const show = showMap[showDir];
    if (!show) continue;

    // Determine date window
    const earliestStr = earliestShowDate(show);
    if (!earliestStr) { noWindow++; continue; }

    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      // Scoring-model year guess that is provably a year early (BRO-4185):
      // correct the DATE before any guard reads it. Runs ahead of the
      // already-flagged skip on purpose — files this guard already flagged
      // from the bad year get their date fixed here, and the rebuild's stale
      // date-guard auto-clear (shouldAutoClearStaleDateGuard) then releases
      // the flag because its basis no longer holds. Operator decisions win.
      if (!data.wrongProductionOverride && data.humanReviewedWrongProduction === undefined) {
        const fix = evaluateLlmYearMisdate({ review: data, show, isMultiProductionTitle: multiProductionTitleIds.has(showDir) });
        if (fix) {
          yearCorrected++;
          yearCorrectedDetails.push({ showId: showDir, file, from: fix.original, to: fix.corrected });
          if (!DRY_RUN) {
            data.previousPublishDate = fix.original;
            data.publishDate = fix.corrected;
            data.dateSource = 'llm-scoring-year-corrected';
            data.publishDateCorrectedAt = new Date().toISOString();
            const r = safeWriteReview(filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
          }
        }
      }

      // Skip already-flagged
      if (data.wrongProduction || data.wrongShow || data.wrongProductionManualClear || data.allowEarlyDate || laneBypasses(data, 'wrongProduction')) { // BRO-4807: lane reviews are never flagged
        skipped++;
        continue;
      }

      // Skip records whose URL was corrected but whose body hasn't been
      // refetched yet: publishDate still describes the OLD article, so the
      // date window below would be judging evidence that no longer belongs to
      // this record. Flagging here re-creates exactly what the #483 gate
      // clears, so drain and re-flag chase each other forever (a drain of 157
      // files on 2026-08-12 was undone by the next rebuild ~4h later).
      if (isAwaitingUrlCorrectionRefetch(data)) {
        awaitingRefetchSkipped++;
        // This skip is silent to validate-data.js — its CHECK 0
        // (evaluateDatePlausibility, 180-day backstop) does NOT know about
        // isAwaitingUrlCorrectionRefetch, so a file that never actually gets
        // refetched (e.g. it genuinely IS the wrong production, so nothing
        // re-fetches it) sits here forever while CI reds on it with no
        // pointer back to this script (task #1736 — white-rabbit-red-rabbit
        // thestage/dave-fargnoli sat in this exact state, 613d early, until a
        // human hand-flagged it). Surface these separately so they don't go
        // unnoticed until the next CI run turns red.
        const stuckVerdict = evaluateDatePlausibility({ review: data, show });
        if (stuckVerdict.implausible) {
          stuckCiBlockingDetails.push({
            showId: showDir, title: show.title, file,
            date: data.publishDate, daysBefore: stuckVerdict.daysBefore,
          });
        }
        continue;
      }

      // Show Score "For a previous production" (BRO-4884): Show Score itself says
      // the review belongs to an earlier staging. The sentinel parses to no date,
      // so the window checks below never see it.
      if (data.humanReviewedWrongProduction !== false && !shouldSkipWrongProductionAudit(data)) {
        const prev = evaluateShowScorePreviousProduction({ review: data, show });
        if (prev.flag) {
          showScorePrevFlagged++;
          flaggedDetails.push({ showId: showDir, title: show.title, file, date: data.publishDate, issue: 'show_score_previous_production', diffDays: 0, outlet: data.outlet || '?' });
          if (!DRY_RUN) {
            data.wrongProduction = true;
            invalidateWrongProductionAutoClear(data);
            data.wrongProductionReason = 'show-score-previous-production';
            data.wrongProductionNote = 'Show Score lists this review "For a previous production" and the show declares no priorRuns/tourLegs';
            const r = safeWriteReview(filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
          }
          continue;
        }
      }

      // Prior-run republish (BRO-4641): body text names an earlier production. Date
      // guards below cannot catch it (the page was republished with a new date).
      if (data.humanReviewedWrongProduction !== false && !shouldSkipWrongProductionAudit(data)) {
        const republish = detectPriorRunRepublish({ text: data.fullText, show });
        if (republish.flag) {
          priorRunRepublishFlagged++;
          flaggedDetails.push({ showId: showDir, title: show.title, file, date: data.publishDate || '(none)', issue: 'prior_run_republish', diffDays: 0, outlet: data.outlet || '?' });
          if (!DRY_RUN) {
            data.wrongProduction = true;
            invalidateWrongProductionAutoClear(data);
            data.wrongProductionReason = 'prior-run-republish';
            data.wrongProductionNote = `Prior-run republish guard: ${republish.reason} — "${republish.evidence}"`;
            const r = safeWriteReview(filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
          }
          continue;
        }
      }

      // LLM-guessed dates never sole basis for a stamp (BRO-4473)
      let pubDate = parseDate(guardPublishDate(data, show).publishDate);
      if (!pubDate && data.url) {
        // Same URL-date resolution the rebuild uses: extractDateFromUrl handles
        // /YYYY/MM/DD/, Guardian /YYYY/mon/DD/, compact YYYYMMDD and YYYY-MM-DD.
        // Require a FULL YYYY-MM-DD — a month-only/year-only date defaults to the
        // 1st and trips the window on genuine near-boundary reviews (Class B FPs).
        const urlDate = extractDateFromUrl(data.url);
        if (urlDate && urlDate.date && /^\d{4}-\d{2}-\d{2}$/.test(urlDate.date)) {
          const d = parseDate(urlDate.date);
          if (d && !isNaN(d.getTime())) pubDate = d;
        }
      }
      if (!pubDate) {
        // Dateless-revival guard: a review with no usable date on a multi-
        // production title that has NOT yet opened is held as suspect prior-
        // production contamination (mirrors rebuild-all-reviews.js).
        const verdict = evaluateDatelessRevivalGuard({
          hasUsableDate: false,
          isMultiProductionTitle: multiProductionTitleIds.has(showDir),
          show,
        });
        if (verdict.flag && data.humanReviewedWrongProduction !== false) {
          if (shouldSkipWrongProductionAudit(data)) {
            overrideClearSkipped++;
            overrideClearDetails.push({ showId: showDir, file, date: '(none)', issue: 'dateless_revival' });
            console.warn(`[flag-wrong-production-by-date] ${showDir}/${file} → skipping wrongProduction stamp (dateless revival): existing wrongProductionOverride/ManualClear/humanReviewedWrongProduction/allowCrossMarket breadcrumb`);
          } else {
            datelessRevivalFlagged++;
            flaggedDetails.push({ showId: showDir, title: show.title, file, date: '(none)', issue: 'dateless_revival', diffDays: 0, outlet: data.outlet || '?' });
            if (!DRY_RUN) {
              // lane-guarded: the per-file loop skips lane reviews via laneBypasses before any guard runs
              data.wrongProduction = true;
              invalidateWrongProductionAutoClear(data);
              data.wrongProductionReason = 'dateless-revival';
              data.wrongProductionNote = `Dateless revival guard: no publishDate on multi-production title that has not yet opened — unverified production (show starts ${earliestStr})`;
              const r = safeWriteReview(filePath, data);
              if (r.lockedSkipped) lockedSkipCount++;
            }
          }
        } else {
          noDate++;
        }
        continue;
      }

      const decision = evaluateDateGuard({ pubDate, show, outletId: data.outletId });
      let issue = decision.issue;
      let diffDays = decision.diffDays;

      // BRO-4476: inside the 60d London window but the URL names another city
      // (Edinburgh Fringe etc.) and the review predates the run by >14d.
      let nonLondonCityFlag = false;
      if (!issue && isLondonMarket(show.category) && data.url && namesNonLondonCity(data)
          && isPreRunForUkClear(pubDate, earliestStr)) {
        issue = 'before_preview';
        nonLondonCityFlag = true;
        diffDays = Math.ceil((new Date(earliestStr) - pubDate) / 86400000);
      }

      if (!issue) { ok++; continue; }

      // Production-continuity exemption: pubDate falls inside a declared priorRuns
      // window — legitimate coverage of an earlier run of THIS production.
      // Applies to both before_preview and after_close (a priorRun's reviews can
      // appear long after the current production's closing date too).
      if (isWithinPriorRun(pubDate, show.priorRuns) || isWithinTourLeg(pubDate, show.tourLegs)) {
        priorRunSkipped++;
        continue;
      }

      // Current-run corroboration guard: a misparsed publishDate can put a
      // CURRENT review outside the window (care-west-end-2026 incident,
      // 2026-07-11). STRONG corroboration (Theatre Record archives the review
      // under an in-window month) → HOLD the flag, route to human review; the
      // unflagged file stays excluded by the rebuild's own corroboration hold,
      // and validate-data CHECK 0 reddens CI if it is >180d early.
      // cv-affirms-production alone holds only inside that 180-day line
      // (shouldHoldDateGuardFlag, BRO-4884). WEAK
      // (roundup excerpts only — ~75% of those flags were correct in the
      // 2026-07-12 sweep) → flag as usual but count a warning.
      // before_preview only: an after_close date is more likely a successor
      // production mislinked back (can share the TR month near closing).
      if (issue === 'before_preview') {
        const corrob = evaluateCurrentRunCorroboration({ review: data, show });
        const implausible = evaluateDatePlausibility({ review: data, show }).implausible;
        if (shouldHoldDateGuardFlag({ corrob, implausible })) {
          corroborationHeld++;
          heldDetails.push({ showId: showDir, file, date: data.publishDate, outlet: data.outlet || '?', signals: corrob.signals, issue, diffDays });
          continue;
        }
        if (corrob.strength === 'weak') corroborationWarned++;
      }

      if (shouldSkipWrongProductionAudit(data)) {
        overrideClearSkipped++;
        overrideClearDetails.push({ showId: showDir, file, date: data.publishDate, issue, diffDays });
        console.warn(`[flag-wrong-production-by-date] ${showDir}/${file} → skipping wrongProduction stamp (${issue}, ${diffDays}d): existing wrongProductionOverride/ManualClear/humanReviewedWrongProduction/allowCrossMarket breadcrumb`);
        continue;
      }

      const note = nonLondonCityFlag
        ? `Non-London city guard: review ${data.publishDate} is ${diffDays}d before ${earliestStr} (preview/open) and URL names another city — likely a different production`
        : issue === 'before_preview'
        ? `Date guard: review ${data.publishDate} is ${diffDays}d before ${earliestStr} (preview/open) — likely different production`
        : `Date guard: review ${data.publishDate} is ${diffDays}d after ${show.closingDate} (close+${DAYS_AFTER_CLOSE}d) — likely different production`;

      if (issue === 'before_preview') flaggedEarly++;
      else flaggedLate++;

      flaggedDetails.push({
        showId: showDir,
        title: show.title,
        file,
        date: data.publishDate,
        issue,
        diffDays,
        outlet: data.outlet,
      });

      if (!DRY_RUN) {
        // lane-guarded: the per-file loop skips lane reviews via laneBypasses before any guard runs
        data.wrongProduction = true;
        invalidateWrongProductionAutoClear(data);
        data.wrongProductionNote = note;
        // Not a dated-guard note, so rebuild's stale date-guard clear (which
        // re-evaluates at the 60d window) cannot release it; reason also blocks
        // the UK-URL auto-clear.
        if (nonLondonCityFlag) data.wrongProductionReason = 'non-london-city-pre-run';
        const result = safeWriteReview(filePath, data);
        if (result.lockedSkipped) lockedSkipCount++;
      }
    }
  }

  // Print flagged reviews grouped by show
  if (flaggedDetails.length > 0) {
    const byShow = {};
    flaggedDetails.forEach(d => {
      byShow[d.showId] = byShow[d.showId] || { title: d.title, items: [] };
      byShow[d.showId].items.push(d);
    });

    const sorted = Object.entries(byShow).sort((a, b) => b[1].items.length - a[1].items.length);
    console.log(`\n--- ${DRY_RUN ? 'Would flag' : 'Flagged'} ---`);
    for (const [showId, { title, items }] of sorted.slice(0, 30)) {
      console.log(`\n  ${title} (${showId}): ${items.length} reviews`);
      items.slice(0, 5).forEach(d => {
        const tag = d.issue === 'before_preview' ? 'EARLY' : d.issue === 'dateless_revival' ? 'DATELESS' : d.issue === 'prior_run_republish' ? 'PRIOR-RUN' : d.issue === 'show_score_previous_production' ? 'SS-PREV' : 'LATE';
        console.log(`    ${tag} ${d.diffDays}d  ${d.outlet.padEnd(25)} ${d.date}`);
      });
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    }
  }

  // Held flags need HUMAN REVIEW — the date says wrong-production but Theatre
  // Record archives the review inside this run's window (likely misparsed
  // publishDate). Verify the live page date, then either correct publishDate +
  // wrongProductionManualClear, or flag manually.
  if (heldDetails.length > 0) {
    console.log(`\n--- HELD for human review (current-run corroboration contradicts date) ---`);
    for (const h of heldDetails) {
      console.log(`  ${h.showId}/${h.file}  pub=${h.date}  ${h.issue} ${h.diffDays}d  [${h.signals.join(', ')}]`);
    }
  }

  // Task #1775: reviews the date guard would otherwise stamp wrongProduction
  // over, but a pre-existing wrongProductionOverride/ManualClear/
  // humanReviewedWrongProduction/allowCrossMarket breadcrumb means a human
  // (or an earlier automated clear) already made an authoritative call on
  // this file. Printed for audit trail — nothing to action unless the
  // breadcrumb itself looks stale/wrong.
  if (overrideClearDetails.length > 0) {
    console.log(`\n--- Skipped: pre-existing override/manual-clear breadcrumb ---`);
    for (const o of overrideClearDetails) {
      console.log(`  ${o.showId}/${o.file}  pub=${o.date}  ${o.issue}${o.diffDays !== undefined ? ` ${o.diffDays}d` : ''}`);
    }
  }

  // Awaiting-refetch files that ALSO fail validate-data.js CHECK 0 (the
  // 180-day backstop, which does not know about isAwaitingUrlCorrectionRefetch)
  // are stuck: this script will never flag them and nothing will ever
  // refetch a review that is genuinely the wrong production, so they sit
  // here until a human notices CI is red. Surfaced loudly rather than
  // folded into the silent "Awaiting URL refetch" count.
  if (stuckCiBlockingDetails.length > 0) {
    console.log(`\n--- STUCK: awaiting refetch AND already failing validate-data.js CHECK 0 (will redden CI until manually resolved) ---`);
    for (const s of stuckCiBlockingDetails) {
      console.log(`  ${s.showId}/${s.file}  pub=${s.date}  ${s.daysBefore}d before window — hand-set wrongProduction:true (see memory/feedback_manual_review_protection_fields.md) or fix/refetch the URL`);
    }
  }

  if (yearCorrectedDetails.length) {
    console.log(`\n--- ${DRY_RUN ? 'Would correct' : 'Corrected'} scoring-model year guesses (BRO-4185) ---`);
    for (const d of yearCorrectedDetails) console.log(`  ${d.showId}/${d.file}: ${d.from} → ${d.to}`);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Year-corrected dates:  ${yearCorrected}`);
  console.log(`Held (corroboration):  ${corroborationHeld}`);
  console.log(`Warned (weak corrob):  ${corroborationWarned}`);
  console.log(`OK (within window):    ${ok}`);
  console.log(`Skipped (priorRuns):   ${priorRunSkipped}`);
  console.log(`Already flagged:       ${skipped}`);
  console.log(`Skipped (override/manual clear breadcrumb): ${overrideClearSkipped}`);
  console.log(`Awaiting URL refetch:  ${awaitingRefetchSkipped}`);
  console.log(`  ...of which STUCK (also fails CI's date check): ${stuckCiBlockingDetails.length}`);
  console.log(`No publishDate:        ${noDate}`);
  console.log(`${DRY_RUN ? 'Would hold' : 'Held'} (dateless revival): ${datelessRevivalFlagged}`);
  console.log(`No show date window:   ${noWindow}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} (early): ${flaggedEarly}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} (late):  ${flaggedLate}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} (prior-run republish): ${priorRunRepublishFlagged}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} (Show Score previous production): ${showScorePrevFlagged}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} total:   ${flaggedEarly + flaggedLate + priorRunRepublishFlagged + showScorePrevFlagged}`);
  console.log(`[LOCKED-SKIP-COUNT] flag-wrong-production-by-date: ${lockedSkipCount}`);
  if (DRY_RUN && (flaggedEarly + flaggedLate + priorRunRepublishFlagged + showScorePrevFlagged) > 0) {
    console.log(`\nRun with --apply to write flags.`);
  }
}

run();
