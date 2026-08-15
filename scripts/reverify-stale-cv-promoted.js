#!/usr/bin/env node
/**
 * Re-verify the reviews audit-stale-cv-hash.js finds: excluded via a
 * CV-promoted flag (wrongShow / wrongProduction / isNonReview) whose
 * contentHash no longer matches the CURRENTLY STORED fullText.
 *
 * Background (task #1404): most of these mismatches turned out not to be
 * genuine staleness at all — collect-review-texts.js was hashing the raw
 * pre-clean scrapedText it handed to verifyContent() while storing the
 * cleaned/junk-stripped text as fullText, so the hash rarely matched even on
 * the write that created the file (fixed separately in collect-review-texts.js).
 * That leaves this existing population stuck: the exclusion flag was set from
 * a verdict whose hash can never be reconciled retroactively, and
 * rebuild-all-reviews.js's promotion logic is add-only — it does not
 * re-examine or clear a flag it already set on a prior run.
 *
 * This script re-verifies each finding against its CURRENT stored fullText
 * (not a re-scrape), exactly like reverify-promoted-reviews.js does for its
 * narrower legacy-no-hash population. Because the hash is computed over the
 * same text that's being stored, the write always produces a hash that
 * matches going forward — the file drops out of the stale-hash audit
 * regardless of whether the flag is cleared or confirmed.
 *
 * "Do NOT bulk-clear the 201 files blind — some are genuinely wrong-show."
 * — the card's own instruction. This script trusts the LLM's fresh verdict
 * against the file's real, current text: clear when it comes back clean,
 * leave excluded (but hash-corrected) when it doesn't.
 *
 * Usage:
 *   node scripts/reverify-stale-cv-promoted.js            # process all findings
 *   node scripts/reverify-stale-cv-promoted.js --limit=20  # smoke-test a subset
 *   node scripts/reverify-stale-cv-promoted.js --dry-run   # verify only, write nothing
 */

const fs = require('fs');
const path = require('path');
const { verifyContent, resolveCvMarket } = require('./lib/content-verifier');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const { audit } = require('./audit-stale-cv-hash');

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

// Never re-touch a file a human already adjudicated or that's mid-recovery —
// same gates the isStaleCvPromoted* self-heal predicates use (review-guards.js).
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

async function main() {
  const args = process.argv.slice(2);
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

  const { findings } = audit();
  const todo = findings.slice(0, Number.isFinite(limit) ? limit : findings.length);
  console.log(`${findings.length} stale-hash CV-promoted findings; processing ${todo.length}${dryRun ? ' (DRY RUN)' : ''}\n`);

  const stats = { cleared: 0, confirmed: 0, protected: 0, skippedNoText: 0, errors: 0 };

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
    if (!data.fullText || data.fullText.length < 200) {
      console.log(`  [NO TEXT] ${f.showId}/${f.file} — skipping (fullText too short/missing)`);
      stats.skippedNoText++;
      continue;
    }

    const show = showById[f.showId] || null;
    const showTitle = show?.title || f.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
    const outletCritic = f.file.replace('.json', '').split('--');

    console.log(`Verifying: ${f.showId}/${f.file}`);
    console.log(`  flags: wrongShow=${f.wrongShow} wrongProduction=${f.wrongProduction} isNonReview=${f.isNonReview} | old cvArticleType=${f.cvArticleType} cvWrongArticle=${f.cvWrongArticle}`);

    try {
      const result = await verifyContent({
        scrapedText: data.fullText, // KEY: verify the STORED text, so the new hash always matches it
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

      console.log(`  New: isValid=${result.isValid} wrongArticle=${result.wrongArticle} wrongProduction=${result.wrongProduction} isFilmTv=${result.isFilmTv} confidence=${result.confidence}`);

      const clean = result.isValid && !result.wrongArticle && !result.wrongProduction && !result.isFilmTv;
      let didClear = false;

      if (!dryRun) {
        data.contentVerification = {
          ...result,
          verifiedAt: new Date().toISOString(),
          reverifiedFrom: 'stored-fullText',
          previousVerification: data.contentVerification ? {
            issues: data.contentVerification.issues,
            reasoning: data.contentVerification.reasoning,
            verifiedBy: data.contentVerification.verifiedBy,
            verifiedAt: data.contentVerification.verifiedAt,
          } : null,
        };
        // clearWrongProductionFlags deletes wrongShowReason/wrongProductionReason
        // outright — preserve them here first so a later audit of a clear that
        // turns out wrong isn't left reconstructing intent from contentVerification
        // .previousVerification.reasoning alone (gpt-5.4-mini adversarial review,
        // task #1404).
        const preClearFlagState = {
          wrongShow: data.wrongShow || false,
          wrongShowReason: data.wrongShowReason || null,
          wrongProduction: data.wrongProduction || false,
          wrongProductionReason: data.wrongProductionReason || null,
          isNonReview: data.isNonReview || false,
          isNonReviewReason: data.isNonReviewReason || null,
          rejectionReason: data.rejectionReason || null,
        };

        // Full-mode clear grants wrongProductionOverride — a PERMANENT exemption
        // from every wrongProduction guard (wrong-production-clear.js's own doc
        // comment: this override "re-admitted prior-production/cross-market
        // contamination, 2026-06-21, 335 reviews"). The codebase's own strict
        // self-heal predicate for this exact flag (isStaleCvPromotedWrongProduction,
        // review-guards.js) requires cv.confidence === 'high' before demoting a
        // wrongProduction flag; this script must not clear on weaker evidence than
        // it took to set one (Codex second-opinion, task #1404). wrongShow-only
        // clears stay ungated, matching reverify-promoted-reviews.js precedent.
        if (clean && (data.wrongShow || data.wrongProduction)) {
          const wantsFullClear = Boolean(data.wrongProduction);
          if (!wantsFullClear || result.confidence === 'high') {
            clearWrongProductionFlags(data, {
              source: 'reverify-stale-cv-promoted.js',
              reason: result.reasoning || 'stored fullText re-verified clean (task #1404 stale-hash sweep)',
              wrongShowOnly: !wantsFullClear,
            });
            data.contentVerification.reasoning = result.reasoning || data.contentVerification.reasoning;
            didClear = true;
          } else {
            console.log(`  (clean but confidence=${result.confidence} — leaving wrongProduction flagged; hash still corrected)`);
          }
        }

        // isNonReview is a SEPARATE flag family from wrongShow/wrongProduction —
        // rebuild-all-reviews.js routes "pure non-review" wrongArticle verdicts
        // (wrongArticle:true, wrongProduction:false) here specifically, and
        // clearWrongProductionFlags never touches it (codebase-aware review,
        // task #1404: without this branch, a clean re-verify logged CLEARED and
        // stamped a matching contentHash — which drops the file from future
        // audit-stale-cv-hash.js runs — while isNonReview stayed true and the
        // review stayed excluded forever, permanently invisible). Gated on high
        // confidence to match isNonReviewDemotedByFreshCV's own bar (review-guards.js).
        const articleConfidence = result.articleTypeConfidence || result.confidence;
        if (clean && data.isNonReview && articleConfidence === 'high') {
          data.isNonReview = false;
          if (data.rejectionReason === 'not_a_review') delete data.rejectionReason;
          delete data.isNonReviewReason;
          data.nonReviewOverride = `reverify-stale-cv-promoted.js: ${result.reasoning || 'stored fullText re-verified clean (task #1404 stale-hash sweep)'}`;
          data.nonReviewOverrideAt = new Date().toISOString();
          didClear = true;
        } else if (clean && data.isNonReview) {
          console.log(`  (clean but articleTypeConfidence=${articleConfidence} — leaving isNonReview flagged; hash still corrected)`);
        }

        if (didClear) data.clearedFlagsBeforeRecovery = preClearFlagState;

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }

      if (didClear) { console.log('  >>> CLEARED'); stats.cleared++; }
      else { console.log('  Confirmed still excluded (hash corrected)'); stats.confirmed++; }
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
