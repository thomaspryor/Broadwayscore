#!/usr/bin/env node
/**
 * Re-verify the reviews audit-stale-cv-hash.js's `nulledFindings` surfaces:
 * excluded via a CV-promoted flag (wrongShow / wrongProduction / isNonReview)
 * whose fullText was nulled entirely rather than merely drifting from its hash.
 *
 * Background (task #1618, follow-up to #1404): #1404 fixed a stale-contentHash
 * bug for 203 reviews whose fullText was still on disk. Auditing that
 * population surfaced a LARGER, separate one — 667 files where
 * collect-review-texts.js's quarantine branches (showNotMentioned, wrongArticle,
 * wrongProduction, isFilmTv) moved the fetched text to `wrongFullText` and set
 * `fullText: null` before promoting the exclusion flag. These were invisible to
 * the #1404 audit (no fullText to hash against) and to reverify-stale-cv-promoted.js
 * (its `!data.fullText` guard skips them outright).
 *
 * 580 of 667 have a non-empty `wrongFullText` — the original fetch is still on
 * disk, just quarantined. This script re-verifies that quarantined text against
 * a FRESH LLM call, same "do not bulk-clear blind" principle as #1404: trust
 * the fresh verdict, restore + clear only when it comes back clean on EVERY
 * exclusion-flag family the file currently carries (each family gated at the
 * same confidence bar reverify-stale-cv-promoted.js uses), otherwise leave the
 * file exactly as found. Partial clears (fixing one family while leaving
 * another) are deliberately not attempted — the review stays excluded either
 * way while any flag remains, so a partial restore of fullText would just be
 * bookkeeping churn with no scoring effect.
 *
 * The other 87 of 667 have no wrongFullText at all — genuinely lost (or, per a
 * spot check, correctly-excluded pre-opening preview/interview/news content
 * that was never worth keeping). This script does not touch them.
 *
 * Usage:
 *   node scripts/reverify-nulled-cv-promoted.js              # process all recoverable findings
 *   node scripts/reverify-nulled-cv-promoted.js --limit=20    # smoke-test a subset
 *   node scripts/reverify-nulled-cv-promoted.js --dry-run     # verify only, write nothing
 *   node scripts/reverify-nulled-cv-promoted.js --help, -h    # print this usage and exit
 */

const fs = require('fs');
const path = require('path');
const { verifyContent, resolveCvMarket } = require('./lib/content-verifier');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const { classifyContentTier } = require('./lib/content-quality');
const { safeWriteReview } = require('./lib/review-write-guard');
const { audit } = require('./audit-stale-cv-hash');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `reverify-nulled-cv-promoted.js — re-verify reviews excluded by a CV-promoted
flag (wrongShow / wrongProduction / isNonReview) whose fullText was nulled entirely
(quarantined to wrongFullText) rather than merely drifting from its hash. Re-runs
verification against the quarantined wrongFullText: restores + clears only when the
fresh verdict comes back clean on every exclusion-flag family the file carries,
leaves it exactly as found otherwise.

Usage:
  node scripts/reverify-nulled-cv-promoted.js             process all recoverable findings
  node scripts/reverify-nulled-cv-promoted.js --limit=20  smoke-test a subset
  node scripts/reverify-nulled-cv-promoted.js --dry-run   verify only, write nothing
  node scripts/reverify-nulled-cv-promoted.js --help, -h  print this usage and exit

Makes live LLM verification calls and writes review files — never blind-clears.
`;

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_JSON = path.join(__dirname, '..', 'data', 'shows.json');

function marketFor(showId, show) {
  if (show?.type === 'opera') return 'opera';
  if (show?.category) return show.category;
  if (showId.includes('off-west-end')) return 'off-west-end';
  if (showId.includes('west-end')) return 'west-end';
  if (showId.includes('off-broadway')) return 'off-broadway';
  return 'broadway';
}

// Same gates reverify-stale-cv-promoted.js uses: never re-touch a file a human
// already adjudicated or that's mid-recovery.
function isProtected(d) {
  return Boolean(
    d.wrongProductionManualClear === true ||
    d.wrongProductionOverride === true ||
    d.wrongShowOverride === true ||
    d.humanReviewedWrongProduction === false ||
    d._locked === true ||
    d.manualContentTier === 'complete'
  );
}

// Quarantine bookkeeping fields the four collect-review-texts.js null branches
// stamp alongside wrongFullText/fullText=null. None of these are meaningful
// once fullText is restored — leaving them behind would misdescribe a
// recovered file as still-quarantined to the next reader.
// NOTE: safeWriteReview's merge-mode "keep any existing field not in newData"
// pass (review-write-guard.js ~line 1000) restores ANY field this function
// deletes unless CLEAR_BREADCRUMBS registers a clear predicate for it — none
// of these quarantine-bookkeeping fields are registered. A plain `delete`
// here is silently reverted to its stale on-disk value; assigning null/false
// instead makes newData[key] !== undefined, so the merge pass leaves the new
// value alone. Caught live: the first smoke-test run wrote isNonReview:false
// but left the stale isNonReviewReason/rejectionReason text sitting next to
// it (task #1618, discovered post-merge — see the two-file cleanup this
// script's next run also needs to catch via nulledTextReverifiedAt already
// being stamped on them).
function clearQuarantineBookkeeping(data) {
  data.showNotMentioned = false;
  data._showNotMentionedDiscoveryAttempted = null;
  data.suspectedLlmHallucination = false;
  data.contentMismatchNote = null;
  data.contentMismatchScore = null;
  if (data.incompleteReason === 'non_review') data.incompleteReason = null;
}

async function main() {
  const args = process.argv.slice(2);

  // --help/-h BEFORE the corpus walk: this script runs live LLM verifyContent()
  // calls and rewrites review files through safeWriteReview — real side effects
  // on --help, the class the help-flag safety audit blocks on (task #498).
  if (hasHelpFlag(args)) {
    console.log(USAGE);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`No review-texts corpus at ${REVIEW_TEXTS_DIR}.`);
    process.exit(1);
  }

  const showsData = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
  const showById = {};
  for (const s of showsData.shows) showById[s.id] = s;

  const { nulledFindings } = audit();
  const recoverable = nulledFindings.filter(f => f.hasWrongFullText && !f.nulledTextReverifiedAt);
  const alreadyDone = nulledFindings.filter(f => f.hasWrongFullText && f.nulledTextReverifiedAt).length;
  const lost = nulledFindings.filter(f => !f.hasWrongFullText).length;
  const todo = recoverable.slice(0, Number.isFinite(limit) ? limit : recoverable.length);

  console.log(`${nulledFindings.length} nulled-fullText findings: ${recoverable.length + alreadyDone} recoverable (${alreadyDone} already reverified), ${lost} with no wrongFullText (skipped, not touched by this script)`);
  console.log(`Processing ${todo.length}${dryRun ? ' (DRY RUN)' : ''}\n`);

  const stats = { cleared: 0, confirmedStillExcluded: 0, protected: 0, skippedNoText: 0, errors: 0 };

  for (const f of todo) {
    const filePath = path.join(REVIEW_TEXTS_DIR, f.showId, f.file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.log(`  ERROR reading ${f.showId}/${f.file}: ${e.message}`);
      stats.errors++;
      continue;
    }

    if (isProtected(data)) {
      console.log(`  [PROTECTED] ${f.showId}/${f.file} — skipping`);
      stats.protected++;
      continue;
    }
    if (!data.wrongFullText || data.wrongFullText.length < 200) {
      console.log(`  [NO TEXT] ${f.showId}/${f.file} — skipping (wrongFullText too short/missing)`);
      stats.skippedNoText++;
      continue;
    }

    const show = showById[f.showId] || null;
    const showTitle = show?.title || f.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
    const outletCritic = f.file.replace('.json', '').split('--');

    console.log(`Verifying: ${f.showId}/${f.file}`);
    console.log(`  flags: wrongShow=${f.wrongShow} wrongProduction=${f.wrongProduction} isNonReview=${f.isNonReview} | old cvArticleType=${f.cvArticleType} wrongFullTextLen=${data.wrongFullText.length}`);

    try {
      const result = await verifyContent({
        scrapedText: data.wrongFullText, // verify the quarantined text — restoring it IS the candidate change
        excerpt: data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt || '',
        showTitle,
        outletName: outletCritic[0] || f.outletId || 'unknown',
        criticName: outletCritic[1] || f.criticName || 'unknown',
        openingDate: show?.openingDate || null,
        venue: show?.venue || null,
        market: resolveCvMarket(show) || marketFor(f.showId, show),
        isLongRunningProduction: false,
        publishDate: data.publishDate || data.textFetchedAt || null,
        url: data.url || null,
        show,
      });

      const clean = result.isValid && !result.wrongArticle && !result.wrongProduction && !result.isFilmTv;
      const articleConfidence = result.articleTypeConfidence || result.confidence;

      // Per-family clearability, decided BEFORE any mutation. A family that
      // isn't currently set is trivially "clearable" (nothing to do for it).
      // wrongProduction needs high confidence (wrongProductionOverride is a
      // blanket, permanent exemption — task #1404 / Codex review). wrongShow
      // clears stay ungated, matching established precedent. isNonReview needs
      // high articleTypeConfidence, matching isNonReviewDemotedByFreshCV's bar.
      const wrongProductionClearable = !data.wrongProduction || result.confidence === 'high';
      const isNonReviewClearable = !data.isNonReview || articleConfidence === 'high';
      const fullyClean = clean && wrongProductionClearable && isNonReviewClearable;

      console.log(`  New: isValid=${result.isValid} wrongArticle=${result.wrongArticle} wrongProduction=${result.wrongProduction} isFilmTv=${result.isFilmTv} confidence=${result.confidence} articleTypeConfidence=${articleConfidence} -> fullyClean=${fullyClean}`);
      if (clean && !fullyClean) {
        console.log(`  (clean verdict but confidence bar not met on ${!wrongProductionClearable ? 'wrongProduction' : ''}${!wrongProductionClearable && !isNonReviewClearable ? '+' : ''}${!isNonReviewClearable ? 'isNonReview' : ''} — leaving fully quarantined)`);
      }

      if (!dryRun) {
        // Stamp the re-verify attempt regardless of outcome, so a re-run of
        // this script (or a future audit) doesn't re-spend an LLM call on a
        // file already confirmed still-excluded.
        data.nulledTextReverifiedAt = new Date().toISOString();
        data.contentVerification = {
          ...result,
          verifiedAt: new Date().toISOString(),
          reverifiedFrom: 'wrongFullText',
          previousVerification: data.contentVerification ? {
            issues: data.contentVerification.issues,
            reasoning: data.contentVerification.reasoning,
            verifiedBy: data.contentVerification.verifiedBy,
            verifiedAt: data.contentVerification.verifiedAt,
          } : null,
        };

        if (fullyClean) {
          const preClearFlagState = {
            wrongShow: data.wrongShow || false,
            wrongShowReason: data.wrongShowReason || null,
            wrongProduction: data.wrongProduction || false,
            wrongProductionReason: data.wrongProductionReason || null,
            isNonReview: data.isNonReview || false,
            isNonReviewReason: data.isNonReviewReason || null,
            rejectionReason: data.rejectionReason || null,
            contentTier: data.contentTier || null,
          };

          // Restore BEFORE clearing/reclassifying — clearWrongProductionFlags and
          // classifyContentTier both read data.fullText.
          data.fullText = data.wrongFullText;
          // wrongFullText is a PROTECTED_FIELDS entry whose clear is only
          // honored with this breadcrumb (review-write-guard.js CLEAR_BREADCRUMBS:
          // wrongFullText -> _wrongArticleCleared) — a plain delete is silently
          // reverted by safeWriteReview's preserve loop, resurrecting the stale
          // text alongside the restored fullText (same bug class fixed for
          // wrongAttribution in fix-cross-outlet-attributions.js, task #1008/#1023;
          // caught here by adversarial review before this script ever ran live).
          data.wrongArticleManualClear = true;
          delete data.wrongFullText;
          clearQuarantineBookkeeping(data);

          if (data.wrongShow || data.wrongProduction) {
            clearWrongProductionFlags(data, {
              source: 'reverify-nulled-cv-promoted.js',
              reason: result.reasoning || 'wrongFullText restored + re-verified clean (task #1618)',
              wrongShowOnly: !data.wrongProduction,
            });
            data.contentVerification.reasoning = result.reasoning || data.contentVerification.reasoning;
          }

          if (data.isNonReview) {
            data.isNonReview = false;
            // null, not delete — see clearQuarantineBookkeeping's note: neither
            // field has a CLEAR_BREADCRUMBS entry, so a delete is silently
            // reverted by safeWriteReview's merge-mode restore pass.
            if (data.rejectionReason === 'not_a_review') data.rejectionReason = null;
            data.isNonReviewReason = null;
            data.nonReviewOverride = `reverify-nulled-cv-promoted.js: ${result.reasoning || 'wrongFullText restored + re-verified clean (task #1618)'}`;
            data.nonReviewOverrideAt = new Date().toISOString();
          }

          data.clearedFlagsBeforeRecovery = preClearFlagState;

          const tierResult = classifyContentTier(data);
          data.contentTier = tierResult.contentTier;
          data.wordCount = tierResult.wordCount;
          data.truncationSignals = tierResult.truncationSignals;
          data.tierReason = tierResult.tierReason;
          const tierToTextStatus = { complete: 'complete', truncated: 'truncated', excerpt: 'incomplete', stub: 'incomplete' };
          const tierToTextQuality = { complete: 'full', truncated: 'truncated', excerpt: 'excerpt', stub: 'stub' };
          if (tierToTextStatus[data.contentTier]) data.textStatus = tierToTextStatus[data.contentTier];
          if (tierToTextQuality[data.contentTier]) data.textQuality = tierToTextQuality[data.contentTier];
          data.isFullReview = data.contentTier === 'complete';
        }
        // Not fullyClean: fullText/wrongFullText untouched, all flags untouched.
        // Only the fresh contentVerification + nulledTextReverifiedAt stamp lands,
        // so a repeat run treats this file as already-diagnosed.

        safeWriteReview(filePath, data);
      }

      if (fullyClean) { console.log('  >>> CLEARED (fullText restored)'); stats.cleared++; }
      else { console.log('  Confirmed still excluded (fullText stays quarantined)'); stats.confirmedStillExcluded++; }
      console.log('');

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`  ERROR: ${e.message}\n`);
      stats.errors++;
    }
  }

  console.log('=== SUMMARY ===');
  console.log(JSON.stringify(stats, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
