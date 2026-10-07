#!/usr/bin/env node
/**
 * BRO-79 one-time audit/fix for the 2026-07-21/22 NYC-rollout ensemble-scoreability-check
 * rescore pass. Three actions on ~/broadway-review-texts (private data repo):
 *
 *  1. Backfill the 26 null-reason rejections (rejectedBy set, rejectionReason lost to the
 *     clear-failure-flags self-null bug fixed in scripts/llm-scoring/index.ts saveReviewFile())
 *     with the correct categorical reason, inferred from the surviving rejectionReasoning text.
 *  2. Clear 3 confirmed false-positive rejections found by spot-checking a 20-file sample of
 *     wrong_production/not_a_review rejections from the same cohort (15% FP rate, matches the
 *     known ~15% baseline — feedback_llm_wrongprod_false_positives).
 *  3. Recover wicked-2003 washpost--peter-marks.json: fullText is contaminated (WaPo nav/related-
 *     links junk appended after ~2 real paragraphs) but showScoreExcerpt/dtliExcerpt/llmScore/
 *     assignedScore already exist from an earlier excerpt-based scoring pass. Move the
 *     contaminated fullText to garbageFullText and clear the rejection so getBestTextForScoring()
 *     (scripts/lib/text-quality.js) and isIncludableForRebuild() (scripts/lib/review-guards.js)
 *     both fall through to the excerpt path instead of hard-excluding the review.
 *
 * Writes an audit report to data/audit/bro-79-ensemble-rejection-audit.json for
 * tests/unit/audit-ensemble-rejections.test.mjs to verify against.
 *
 * Usage: node scripts/audit-bro79-ensemble-rejections.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/audit-bro79-ensemble-rejections.js [--dry-run]');
  console.log('');
  console.log('One-time BRO-79 fix: backfills null rejectionReason on the 25 affected');
  console.log('files, clears 3 confirmed FP rejections, and recovers wicked-2003 WaPo');
  console.log('via excerpt-tier scoring in ~/broadway-review-texts. --dry-run prints the');
  console.log('planned changes without writing.');
  process.exit(0);
}

const REVIEW_TEXTS_ROOT = path.join(require('os').homedir(), 'broadway-review-texts');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'audit', 'bro-79-ensemble-rejection-audit.json');
const dryRun = process.argv.includes('--dry-run');

// --- 1. Null-reason backfill: 25 files from the 2026-07-21/22 cohort (26th is
// wicked-2003 WaPo, recovered separately below), each hand-audited against
// fullText + rejectionReasoning. Every one is a SOUND rejection of the stored
// text (see rationale) — none is a recoverable review.
//
// reason choice matters beyond labeling: clear-failure-flags.js auto-nulls
// rejectionReason='garbage_text' (and ONLY that reason) on any future
// success-path write once fullText is >=500 chars, with no re-verification —
// that's the exact mechanism BRO-79 exists to fix. Reserve 'garbage_text' for
// content that's boilerplate-SHAPED (nav shells/CAPTCHA/ad interstitials/
// traffic widgets) where a refetch could plausibly land real article text.
// Anything that's coherent, on-topic-for-the-SITE prose about the WRONG
// subject — a different article, a homepage feed, an index/listing page —
// gets 'not_a_review' instead: refetching the same URL will deterministically
// reproduce the same wrong content, so auto-clearing without re-verification
// would silently let a stale/wrong score resurface (ship-check adversarial
// review, Codex — caught 2 mislabeled examples; audited all 25 against this
// rule and reclassified 13, see WSJ/Newsday/Musto entries below).
const NULL_BACKFILL = [
  { path: 'fully-committed-2016/eater--joshua-david-stein.json', reason: 'garbage_text', rationale: 'Real review contaminated with an unrelated Dallas-dining-scene listicle mid-article (scrape merged two Eater articles) — re-extraction could recover it.' },
  { path: 'grey-house-2023/slash-film--caroline-cao.json', reason: 'garbage_text', rationale: 'Real review present but >80% of the text is an unrelated horror-films listicle appended after it — re-extraction could recover it.' },
  { path: 'hadestown-2019/vox--constance-grady.json', reason: 'garbage_text', rationale: 'Real review interspersed with paywall/ad and personal-finance-story junk mid-article — re-extraction could recover it.' },
  { path: 'harry-potter-2021/limelight-magazine-au--clive-paget.json', reason: 'garbage_text', rationale: 'Truncated mid-sentence into promotional/nav content; paywall cutoff — a fresh fetch could get past it.' },
  { path: 'little-bear-ridge-road-2025/playbill--logan-culwell-block.json', reason: 'not_a_review', rationale: 'Playbill "reviews are in" news roundup — cast/creative-team facts and links to other outlets\' reviews, no evaluative content of its own.' },
  { path: 'network-2018/broadwaynews--charles-isherwood.json', reason: 'garbage_text', rationale: 'Stored text is an archive.ph CAPTCHA interstitial, not article content — a fresh fetch could get past it.' },
  { path: 'promises-promises-2010/timeout--adam-feldman.json', reason: 'garbage_text', rationale: 'Partial real review fragment mixed with site nav and user-comment text; not cleanly scoreable as stored, but re-extraction could recover it.' },
  { path: 'the-lion-king-1997/newsday--linda-winer.json', reason: 'not_a_review', rationale: 'Behind-the-scenes operations/anniversary feature — no evaluative judgment of the production.' },
  { path: 'yellow-face-2024/aaartsalliance--katie-gee-salisbury.json', reason: 'not_a_review', rationale: 'Scrape captured the site\'s reviews-archive INDEX page (titles/links only), not the article body — refetching this same URL will always return the same index page.' },
  { path: '1984-2017/bloomberg--jason-zinoman.json', reason: 'not_a_review', rationale: 'Scrape captured Bloomberg homepage/nav headlines, not the article; the review headline appears only as an unlinked title — this is what an unauthenticated fetch of this URL will always return.' },
  { path: 'brief-encounter-2010/newsday--linda-winer.json', reason: 'not_a_review', rationale: 'Systemic Newsday scraper bug: stored text is a live traffic-report widget, not the article (see also 5 sibling Newsday files below) — reproducible on this URL, not a one-off fetch glitch.' },
  { path: 'butley-2006/wsj--terry-teachout.json', reason: 'not_a_review', rationale: 'Systemic WSJ stream.wsj.com bug: stored text is the CURRENT WSJ homepage feed, not the archived article (identical 4248-char payload as romeo-and-juliet-2013 and the-testament-of-mary-2013 below — same scraper bug, three shows) — reproducible on this URL.' },
  { path: 'cats-2016/out-magazine--michael-musto.json', reason: 'not_a_review', rationale: 'Wrong article entirely — an unrelated Michael Musto interview piece with no Cats content; URL was never a Cats review, so this is permanent, not a fetch fluke.' },
  { path: 'charlie-and-the-chocolate-factory-2017/vulture--jesse-green.json', reason: 'garbage_text', rationale: 'Truncated mid-sentence before the verdict, with nav noise mixed in — a fresh fetch could recover the full text.' },
  { path: 'dont-dress-for-dinner-2012/nydailynews--joe-dziemianowicz.json', reason: 'garbage_text', rationale: 'Truncated and interleaved with unrelated NY Daily News headlines — a fresh fetch could recover the full text.' },
  { path: 'good-people-2011/newsday--linda-winer.json', reason: 'not_a_review', rationale: 'Systemic Newsday scraper bug: traffic-report widget content, not the article (see brief-encounter-2010 above) — reproducible on this URL.' },
  { path: 'jerusalem-2011/newsday--linda-winer.json', reason: 'not_a_review', rationale: 'Systemic Newsday scraper bug: traffic-report widget content, not the article — reproducible on this URL.' },
  { path: 'la-bete-2010/newsday--linda-winer.json', reason: 'not_a_review', rationale: 'Systemic Newsday scraper bug: traffic-report widget content, not the article — reproducible on this URL.' },
  { path: 'miss-saigon-2017/out-magazine--michael-musto.json', reason: 'not_a_review', rationale: 'Wrong article entirely — unrelated Musto interview content, URL was never a Miss Saigon review, so this is permanent, not a fetch fluke.' },
  { path: 'romeo-and-juliet-2013/wsj--unknown.json', reason: 'not_a_review', rationale: 'Systemic WSJ stream.wsj.com bug: current WSJ homepage feed, not the archived article (identical payload to butley-2006 above) — reproducible on this URL.' },
  { path: 'sister-act-2011/ew--thom-geier.json', reason: 'not_a_review', rationale: 'Pre-opening preview piece written before previews began — anticipatory commentary, no evaluation of an actual performance.' },
  { path: 'sister-act-2011/newsday--linda-winer.json', reason: 'not_a_review', rationale: 'Systemic Newsday scraper bug: traffic-report widget content, not the article — reproducible on this URL.' },
  { path: 'sunday-in-the-park-with-george-1984/nydailynews--howard-kissel.json', reason: 'not_a_review', rationale: 'Bernadette Peters career profile/interview piece — no critical evaluation of the production.' },
  { path: 'the-people-in-the-picture-2011/newsday--linda-winer.json', reason: 'not_a_review', rationale: 'Systemic Newsday scraper bug: traffic-report widget content, not the article — reproducible on this URL.' },
  { path: 'the-testament-of-mary-2013/wsj--unknown.json', reason: 'not_a_review', rationale: 'Systemic WSJ stream.wsj.com bug: current WSJ homepage feed, not the archived article (identical payload to butley-2006 above) — reproducible on this URL.' },
];

// --- 2. Confirmed false positives from a 20-file spot-check sample of wrong_production /
// not_a_review rejections in the same cohort (3/20 = 15% FP rate, matches the known baseline).
const FALSE_POSITIVES = [
  {
    path: 'queen-versailles-2025/one-minute-critic--matthew-wexler.json',
    originalReason: 'wrong_production',
    rationale: 'LLM claimed the target venue was "Ethel Barrymore Theatre"; shows.json confirms queen-versailles-2025\'s actual venue is St. James Theatre, exactly as stated in the review text. LLM hallucinated the mismatch.',
  },
  {
    path: 'old-times-2015/huffpost--michael-glitz.json',
    originalReason: 'wrong_production',
    rationale: 'Review says "American Airlines Theatre (Roundabout Theatre Company)"; shows.json lists old-times-2015\'s venue as "Todd Haimes Theatre" — the same building, renamed in 2022. Venue-rename blindness, not a different production.',
    clearWrongProduction: true,
  },
  {
    path: 'the-terms-of-my-surrender-2017/newsday--barbara-schuler.json',
    originalReason: 'not_a_review',
    rationale: 'Full WHAT/WHERE/BOTTOM LINE Newsday review with a complete critical arc and explicit verdict ("Bottom Line: Michael Moore preaches to the choir"). LLM was confused by a subscription-login banner and ad interruptions preceding the review body.',
  },
];

// --- 3. Wicked 2003 WaPo recovery (BRO-79 headline case)
const WICKED_WAPO_PATH = 'wicked-2003/washpost--peter-marks.json';
const EW_ALICE_KING_PATH = 'wicked-2003/ew--alice-king.json';

function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_ROOT, relPath), 'utf8'));
}

function saveJson(relPath, data) {
  if (dryRun) return;
  // force:true skips safeWriteReview's protected-field AND _locked checks entirely
  // (scripts/lib/review-write-guard.js) — refuse to silently bypass a lock on a
  // one-time hand-audited migration like this one (ship-check adversarial review).
  if (data._locked) {
    throw new Error(`${relPath}: refusing force-write, file is _locked — resolve manually`);
  }
  // force+no-merge: `data` was loaded fresh from disk and mutated in place above,
  // so it's already the complete intended file content — safeWriteReview should
  // write it as-is rather than re-merging against disk (which would just read
  // back the same object anyway) or applying protected-field preservation logic
  // meant for independent writers stepping on each other's fields.
  safeWriteReview(path.join(REVIEW_TEXTS_ROOT, relPath), data, { force: true, merge: false });
}

function run() {
  const report = {
    auditedAt: null, // stamped by caller after run() to avoid Date.now() inside workflow-style scripts
    cohort: '2026-07-21/22 ensemble-scoreability-check rescore (NYC rollout, commit 482d2118dee)',
    rootCauseFix: 'scripts/llm-scoring/index.ts saveReviewFile(): clearFailureFlags() was nulling rejectionReason=garbage_text on the SAME write that set it, because garbage text is often >=500 chars (clearFailureFlags\' hasText threshold). Fixed by skipping the stale-flag clear on the rejection-stamping write only (skipFailureFlagClear option).',
    nullReasonBackfill: [],
    falsePositivesFixed: [],
    wickedRecovery: null,
    ewAliceKingDocumented: null,
  };

  for (const entry of NULL_BACKFILL) {
    const data = loadJson(entry.path);
    if (data.rejectionReason !== null) {
      throw new Error(`${entry.path}: expected rejectionReason===null, found ${JSON.stringify(data.rejectionReason)}`);
    }
    data.rejectionReason = entry.reason;
    data.rejectionReasonBackfilledAt = dryRun ? '(dry-run)' : new Date().toISOString();
    data.rejectionReasonBackfilledBy = 'BRO-79-audit';
    saveJson(entry.path, data);
    report.nullReasonBackfill.push({ path: entry.path, backfilledReason: entry.reason, rationale: entry.rationale });
  }

  for (const fp of FALSE_POSITIVES) {
    const data = loadJson(fp.path);
    if (data.rejectionReason !== fp.originalReason) {
      throw new Error(`${fp.path}: expected rejectionReason===${fp.originalReason}, found ${JSON.stringify(data.rejectionReason)}`);
    }
    data.rejectedAt = null;
    data.rejectedBy = null;
    data.rejectionReason = null;
    data.rejectionReasoning = null;
    if (fp.clearWrongProduction) {
      data.wrongProduction = false;
      data.wrongProductionManualClear = true;
    }
    data.manualClearReason = `BRO-79 audit: ${fp.rationale}`;
    data.manualClearAt = dryRun ? '(dry-run)' : new Date().toISOString();
    saveJson(fp.path, data);
    report.falsePositivesFixed.push({ path: fp.path, originalReason: fp.originalReason, rationale: fp.rationale });
  }

  // Wicked WaPo recovery
  {
    const data = loadJson(WICKED_WAPO_PATH);
    if (!data.showScoreExcerpt || !data.llmScore) {
      throw new Error('wicked-2003 WaPo: expected showScoreExcerpt + llmScore to already exist for excerpt-tier recovery');
    }
    // Deliberately NOT stored as `garbageFullText`: rebuild-helpers.js's
    // applyScoreRelevantMigrations() auto-restores garbageFullText into
    // fullText (via cleanText()) whenever fullText is empty and garbageReason
    // isn't an error/404 page (rebuild-helpers.js:951-959) — cleanText() does
    // NOT strip the WaPo related-links/privacy-notice junk appended after the
    // two real paragraphs here, so that migration would silently undo this
    // excerpt-tier recovery on the very next rebuild (Codex adversarial
    // review, BRO-79 ship-check). Archived under a field name no pipeline
    // code reads instead.
    data.bro79ContaminatedFullTextArchive = data.fullText;
    data.garbageReason = 'WaPo archive URL is a journaltimes.com syndication mirror; refetch (2026-02-10) returned ~2 real paragraphs followed by unrelated WaPo homepage related-links/privacy-notice junk (cleanText() does not strip it). No clean washingtonpost.com URL for this 2003 Peter Marks review was located (BRO-79 audit, Wayback CDX + web search both came up empty). Recovering via excerpt-tier scoring instead of fullText; contaminated text archived under bro79ContaminatedFullTextArchive, NOT garbageFullText, so rebuild-helpers.js does not auto-restore it.';
    data.fullText = null;
    data.rejectedAt = null;
    data.rejectedBy = null;
    data.rejectionReason = null;
    data.rejectionReasoning = null;
    data.manualClearReason = 'BRO-79: recovered via excerpt-tier scoring (showScoreExcerpt + dtliExcerpt + pre-existing llmScore=66/assignedScore=85); fullText cleared to null (contaminated text preserved in bro79ContaminatedFullTextArchive, not garbageFullText) so getBestTextForScoring()/isIncludableForRebuild() use the excerpt path and stay there.';
    data.manualClearAt = dryRun ? '(dry-run)' : new Date().toISOString();
    saveJson(WICKED_WAPO_PATH, data);
    report.wickedRecovery = {
      path: WICKED_WAPO_PATH,
      method: 'excerpt-tier (fullText cleared, showScoreExcerpt/dtliExcerpt/llmScore/assignedScore retained, contaminated text archived outside garbageFullText to prevent auto-restore)',
      llmScore: data.llmScore.score,
      assignedScore: data.assignedScore,
    };
  }

  // EW alice-king — documented as a SOUND not_a_review rejection, not touched.
  {
    const data = loadJson(EW_ALICE_KING_PATH);
    report.ewAliceKingDocumented = {
      path: EW_ALICE_KING_PATH,
      verdict: 'sound-rejection-confirmed',
      rejectionReason: data.rejectionReason,
      rationale: 'Wayback CDX for ew.com/article/2003/11/21/wicked shows exactly ONE 200-status capture (2016-03-06) and it is this same roundup content — a 2013-era "10 years on Broadway" retrospective that mentions Wicked only in passing while reviewing four other shows. No original 2003 EW review exists at this URL; every other capture of the URL 404s or redirects. Left rejected.',
    };
  }

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  if (!dryRun) {
    report.auditedAt = new Date().toISOString();
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  run();
}

module.exports = { NULL_BACKFILL, FALSE_POSITIVES, WICKED_WAPO_PATH, EW_ALICE_KING_PATH, REPORT_PATH };
