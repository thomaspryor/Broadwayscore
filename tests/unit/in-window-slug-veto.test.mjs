// In-window + slug-match veto for CV/classifier wrongProduction / wrongShow
// flags (2026 data audit S6-T4, BRO-4204).
//
// The audit sampled 12 hidden tier-1/2 reviews; 8 were in-window reviews
// whose URL slug named the show, flagged by the contentVerification pass or
// the classify-wrong-* LLM scripts. review-guards.js now downgrades such a
// verdict to low confidence — at CV time (applyTemporalOverrides) and in the
// guard layer (explainExclusion's wrongProduction / wrongShow branches, the
// rebuild's inline gates, scoring-delta's replay) — regardless of outlet tier.
// The window is previews − 14d … closing + 14d, or opening ± 30d when the
// show has no closingDate. The strong-signal bypass and every non-CV flag
// provenance are untouched.
//
// Fixture: the Data / NYSR Roma Torre review (2026-01-25, opening 2026-01-09)
// that CV called a "feature" and the rebuild promoted to wrongShow — cleared
// by a human in S3-T3; this test replays the pre-clear shape.
//
// Per CLAUDE.md §15: real functions only, then wiring assertions.
//
// Run: node --test tests/unit/in-window-slug-veto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const {
  explainExclusion, isIncludableForRebuild, applyTemporalOverrides,
  cvFlagVetoedInWindow, isInWindowSlugMatchedReview, urlSlugMatchesShowTitle, isWithinInWindowVetoWindow,
  isCvSourcedWrongProduction, isCvSourcedWrongShow, currentCvVerdictStands,
  IN_WINDOW_VETO_LEAD_DAYS, IN_WINDOW_VETO_LAG_DAYS, IN_WINDOW_VETO_NO_CLOSING_DAYS,
} = require(path.join(ROOT, 'scripts/lib/review-guards.js'));

// shows.json snapshot, 2026-09-28.
const DATA = {
  id: 'data-off-broadway-2026', title: 'Data', category: 'off-broadway', market: 'broadway', status: 'closed',
  previewsStartDate: '2026-01-09', openingDate: '2026-01-09', closingDate: '2026-03-29',
};
const DATA_URL = 'https://nystagereview.com/2026/01/25/data-scorching-play-pulls-back-the-curtain-on-the-power-of-big-tech/';
const FULL_TEXT = 'If there is anything to be learned from Data, it is that we should be scared. The four young actors are all splendid. '.repeat(40);

// The real file's CV block (contentVerification) as it was before the S3-T3 clear.
const DATA_CV = {
  isValid: false, confidence: 'high', truncated: true,
  wrongArticle: true, articleType: 'feature', articleTypeConfidence: 'high', wrongProduction: false, isFilmTv: false,
  issues: [
    "Content is a plot summary and production description, not a critical review with the critic's evaluative assessment",
    'No critic byline (Roma Torre) appears in the scraped text',
    'Reads as a feature/preview rather than a critical review',
  ],
  reasoning: 'The scraped content is a detailed plot and production overview with no critical evaluation or reviewer opinion. While it correctly identifies the show, venue (Lucille Lortel Theatre via context), and cast members (Brandon Flynn as Jonah, matching the expected excerpt), it lacks the hallmark elements of a review. This appears to be a feature article or preview rather than a critical review.',
  verifiedBy: 'llm:claude-haiku', verifiedAt: '2026-04-15T19:44:53.894Z',
};

function dataFile(extra = {}) {
  return {
    showId: DATA.id, outletId: 'nysr', outlet: 'New York Stage Review', criticName: 'Roma Torre',
    url: DATA_URL, publishDate: 'January 25, 2026', fullText: FULL_TEXT, contentTier: 'complete',
    assignedScore: 85, llmScore: { score: 89, confidence: 'medium' },
    wrongShow: true,
    wrongShowReason: 'CV-promoted: The scraped content is a detailed plot and production overview with no critical evaluation',
    contentVerificationPromoted: 'rebuild: promoted from contentVerification (llm:claude-haiku, high)',
    contentVerification: DATA_CV,
    ...extra,
  };
}
// The wrongProduction sibling shape: the STALE class the corpus is full of —
// the rebuild promoted an earlier CV wrongProduction verdict ("venue is
// American Airlines Theatre, not Todd Haimes Theatre"), a later CV pass
// re-verified the review as the correct production (the 2023 rename), and
// the on-disk flag never cleared. (Real specimens: travesties-2018/stagezine,
// violet-2014/thewrap, the-big-knife-2013/timeout, fish-in-the-dark-2015/latimes.)
function dataWpFile(extra = {}) {
  return dataFile({
    wrongShow: undefined, wrongShowReason: undefined,
    wrongProduction: true,
    wrongProductionReason: 'CV-promoted: This is a valid theater review of Data, but the venue named (Lucille Lortel Theatre) does not match the expected venue',
    contentVerification: {
      ...DATA_CV, wrongArticle: false, articleType: 'review', wrongProduction: false, isValid: true, issues: [],
      reasoning: 'This is a legitimate review of the Off-Broadway production of Data at the Lucille Lortel Theatre (the correct venue), published in the run.',
    },
    ...extra,
  });
}
// The FRESH class: the file's current CV verdict still says wrongProduction at
// high confidence, naming another staging. tuck-everlasting-2016/variety is the
// real specimen — the URL is Variety's 2015 Atlanta Alliance review, the
// publishDate is the aggregator's stamped Broadway opening night.
const TUCK = {
  id: 'tuck-everlasting-2016', title: 'Tuck Everlasting', category: 'broadway', status: 'closed',
  previewsStartDate: '2016-03-31', openingDate: '2016-04-26', closingDate: '2016-05-29',
};
function tuckFile(extra = {}) {
  return {
    showId: TUCK.id, outletId: 'variety', criticName: 'Marilyn Stasio',
    url: 'http://variety.com/2015/legit/reviews/tuck-everlasting-review-musical-alliance-1201421421/', publishDate: 'April 26, 2016',
    fullText: 'The new musical Tuck Everlasting, premiering at Atlanta\'s Alliance Theater, is a sweet, small-scale show. '.repeat(30),
    contentTier: 'complete', assignedScore: 79,
    wrongProduction: true,
    wrongProductionReason: "CV-promoted (bulk-remediation): The review explicitly mentions the show premiering at Atlanta's Alliance Theater, indicating it's not the Broadway production.",
    contentVerification: { isValid: true, confidence: 'high', wrongArticle: false, wrongProduction: true, isFilmTv: false, issues: [], reasoning: "The review explicitly mentions the show premiering at Atlanta's Alliance Theater, indicating it's not the Broadway production. The scraped content is also truncated." },
    ...extra,
  };
}

test('Data / NYSR Roma Torre 2026-01-25 (opening 2026-01-09): in-window, slug matches → CV-promoted wrongShow is vetoed once the wrongArticle verdict is cleared', () => {
  const d = dataFile();
  assert.equal(isInWindowSlugMatchedReview(d, DATA), true);
  assert.equal(isCvSourcedWrongShow(d), true);
  // While the high-confidence CV wrongArticle verdict stands, so does the flag
  // (and explainExclusion's own cvWrongArticleHighConfidence rule): the
  // wrongArticle family — "not a review at all" — is a different signal, and
  // its human hatch (S3-T3, wrongArticleManualClear) is what clears it.
  assert.equal(cvFlagVetoedInWindow(d, DATA, 'wrongShow'), false);
  assert.equal(explainExclusion(d, DATA), 'wrongShow');
  // The S3-T3 clear releases the verdict; the veto then treats the promoted
  // wrongShow as low-confidence and the review is includable.
  const cleared = dataFile({ wrongArticleManualClear: true });
  assert.equal(cvFlagVetoedInWindow(cleared, DATA, 'wrongShow'), true);
  assert.equal(explainExclusion(cleared, DATA), null);
  assert.equal(isIncludableForRebuild(cleared, DATA), true);
  // A medium-confidence wrongArticle verdict never stood on its own.
  const medium = dataFile({ contentVerification: { ...DATA_CV, confidence: 'medium' } });
  assert.equal(cvFlagVetoedInWindow(medium, DATA, 'wrongShow'), true);
  assert.equal(explainExclusion(medium, DATA), null);
});

test('the same review dated 2015 on the 2026 show → not in window → wrongShow still excludes', () => {
  const d = dataFile({ publishDate: '2015-01-25', url: 'https://nystagereview.com/2015/01/25/data-scorching-play-pulls-back-the-curtain/', wrongArticleManualClear: true });
  assert.equal(isInWindowSlugMatchedReview(d, DATA), false);
  assert.equal(cvFlagVetoedInWindow(d, DATA, 'wrongShow'), false);
  assert.equal(explainExclusion(d, DATA), 'wrongShow');
  assert.equal(isIncludableForRebuild(d, DATA), false);
});

test('the wrongProduction branch: CV-promoted flag vetoed in window, kept at a 2015 date', () => {
  assert.equal(isCvSourcedWrongProduction(dataWpFile()), true);
  assert.equal(cvFlagVetoedInWindow(dataWpFile(), DATA, 'wrongProduction'), true);
  assert.equal(explainExclusion(dataWpFile(), DATA), null);
  assert.equal(isIncludableForRebuild(dataWpFile(), DATA), true);
  const old = dataWpFile({ publishDate: '2015-01-25', url: 'https://nystagereview.com/2015/01/25/data-scorching-play/' });
  assert.equal(explainExclusion(old, DATA), 'wrongProduction');
  // classify-wrong-production.js's stamp is the other classifier provenance.
  const llm = dataWpFile({ wrongProductionReason: undefined, llmClassified: 'wrongProduction', llmConfidence: 'high', wrongProductionProvenance: 'content' });
  assert.equal(explainExclusion(llm, DATA), null);
  // classify-wrong-show.js's stamp likewise.
  const llmWs = dataFile({ wrongShowReason: 'LLM (medium): the review discusses a different play', wrongArticleManualClear: true });
  assert.equal(explainExclusion(llmWs, DATA), null);
});

test('a CURRENT high-confidence CV verdict for the same flag stands (Tuck Everlasting / Variety 2015 Atlanta review, aggregator-stamped opening-night date)', () => {
  const fresh = tuckFile();
  assert.equal(isInWindowSlugMatchedReview(fresh, TUCK), true, 'date + slug alone would qualify');
  assert.equal(currentCvVerdictStands(fresh, 'wrongProduction'), true);
  assert.equal(cvFlagVetoedInWindow(fresh, TUCK, 'wrongProduction'), false);
  assert.equal(explainExclusion(fresh, TUCK), 'wrongProduction');
  assert.equal(isIncludableForRebuild(fresh, TUCK), false);
  // The same verdict at medium confidence is the classifier's own doubt — vetoed.
  const medium = tuckFile({ contentVerification: { ...tuckFile().contentVerification, confidence: 'medium' } });
  assert.equal(currentCvVerdictStands(medium, 'wrongProduction'), false);
  assert.equal(cvFlagVetoedInWindow(medium, TUCK, 'wrongProduction'), true);
  // A later re-verification that flips wrongProduction to false is the stale class — vetoed.
  const stale = tuckFile({ contentVerification: { ...tuckFile().contentVerification, wrongProduction: false, reasoning: 'This is a valid review of the Broadway production.' } });
  assert.equal(cvFlagVetoedInWindow(stale, TUCK, 'wrongProduction'), true);
  // wrongShow: an uncleared high-confidence wrongArticle stands; the S3-T3 human hatch releases it.
  assert.equal(currentCvVerdictStands(dataFile(), 'wrongShow'), true);
  assert.equal(currentCvVerdictStands(dataFile({ wrongArticleManualClear: true }), 'wrongShow'), false);
  assert.equal(currentCvVerdictStands(dataFile({ humanReviewedWrongArticle: false }), 'wrongShow'), false);
});

test('tier is never consulted: a T3 blog and a T2 outlet get the same verdict', () => {
  assert.equal(explainExclusion(dataWpFile({ outletId: 'nysr' }), DATA), null);
  assert.equal(explainExclusion(dataWpFile({ outletId: 'some-unregistered-blog', outlet: 'Some Blog' }), DATA), null);
});

test('applyTemporalOverrides: the run-long window downgrades wrongProduction AND wrongShow confidence past the 30-day rule', () => {
  const url = 'https://nystagereview.com/2026/02/20/data-review-second-look/';
  const legacy = applyTemporalOverrides(true, false, 'high', DATA.openingDate, '2026-02-20');
  assert.equal(legacy.wpConfidence, 'high', '42 days after opening: outside the opening-week net');
  assert.equal(legacy.inWindowSlugMatch, false);
  const r = applyTemporalOverrides(true, false, 'high', DATA.openingDate, '2026-02-20', { url, show: DATA, wrongShow: true });
  assert.equal(r.inWindowSlugMatch, true);
  assert.equal(r.wpConfidence, 'low');
  assert.equal(r.wsConfidence, 'low');
  assert.equal(r.bypassedForStrongSignal, false);
  // Old callers: same keys as before, wsConfidence mirrors the input when nothing fires.
  const old = applyTemporalOverrides(true, false, 'high', DATA.openingDate, '2015-02-20', { url: 'https://nystagereview.com/2015/02/20/data-review/', show: DATA, wrongShow: true });
  assert.equal(old.wpConfidence, 'high');
  assert.equal(old.wsConfidence, 'high');
  assert.equal(old.inWindowSlugMatch, false);
  for (const key of ['wpConfidence', 'filmTvFlag', 'bypassedForStrongSignal']) assert.ok(key in legacy, key);
});

test('applyTemporalOverrides: the strong-signal bypass still wins over the slug match', () => {
  const url = 'https://nystagereview.com/2026/02/20/data-review/';
  const r = applyTemporalOverrides(true, false, 'high', DATA.openingDate, '2026-02-20', {
    url, show: DATA, wrongShow: true,
    issues: ["Expected show 'Data' does not appear in scraped content at all"], reasoning: 'reviews the wrong production entirely',
  });
  assert.equal(r.bypassedForStrongSignal, true);
  assert.equal(r.inWindowSlugMatch, false);
  assert.equal(r.wpConfidence, 'high');
  assert.equal(r.wsConfidence, 'high');
});

test(`window with a closingDate: previews − ${IN_WINDOW_VETO_LEAD_DAYS}d … closing + ${IN_WINDOW_VETO_LAG_DAYS}d`, () => {
  assert.equal(isWithinInWindowVetoWindow(DATA, '2025-12-26'), true, '14 days before previews');
  assert.equal(isWithinInWindowVetoWindow(DATA, '2025-12-25'), false);
  assert.equal(isWithinInWindowVetoWindow(DATA, '2026-04-12'), true, '14 days after closing');
  assert.equal(isWithinInWindowVetoWindow(DATA, '2026-04-13'), false);
  assert.equal(isWithinInWindowVetoWindow(DATA, 'January 25th, 2026'), true, 'ordinal publishDate parses');
});

test(`window without a closingDate: opening ± ${IN_WINDOW_VETO_NO_CLOSING_DAYS}d`, () => {
  const open = { title: 'Data', openingDate: '2026-01-09', status: 'open' };
  assert.equal(isWithinInWindowVetoWindow(open, '2026-02-08'), true, '30 days after');
  assert.equal(isWithinInWindowVetoWindow(open, '2026-02-09'), false, '31 days after');
  assert.equal(isWithinInWindowVetoWindow(open, '2025-12-10'), true, '30 days before');
  assert.equal(isWithinInWindowVetoWindow(open, '2025-12-09'), false);
  assert.equal(isWithinInWindowVetoWindow({ title: 'Data' }, '2026-01-25'), false, 'no dates at all');
});

test('urlSlugMatchesShowTitle: two distinctive tokens, or the whole short title as a phrase', () => {
  assert.equal(urlSlugMatchesShowTitle('https://x.com/2026/romeo-juliet-review-delacorte', 'Romeo and Juliet'), true);
  assert.equal(urlSlugMatchesShowTitle('https://x.com/2026/juliet-and-her-nurse', 'Romeo and Juliet'), false, 'one of two tokens');
  assert.equal(urlSlugMatchesShowTitle(DATA_URL, 'Data'), true);
  assert.equal(urlSlugMatchesShowTitle('https://x.com/theater/the-pass-review.html', 'The Pass'), true);
  assert.equal(urlSlugMatchesShowTitle('https://x.com/celebrity-sex-pass-review', 'The Pass'), false, 'lone common token is not identity');
  assert.equal(urlSlugMatchesShowTitle('https://www.timeout.com/london/theatre/abigails-party-5-review', "Abigail's Party"), true, 'apostrophes dropped');
  assert.equal(urlSlugMatchesShowTitle('https://x.com/oh-mary-broadway-review', 'Oh, Mary!'), true);
  assert.equal(urlSlugMatchesShowTitle('https://x.com/theater/hamlet-review-bam.html', 'Hamlet'), true);
  assert.equal(urlSlugMatchesShowTitle('https://x.com/theater/macbeth-review.html', 'Hamlet'), false);
  assert.equal(urlSlugMatchesShowTitle('not a url', 'Hamlet'), false);
  assert.equal(urlSlugMatchesShowTitle(null, 'Hamlet'), false);
});

const HAMLET = {
  id: 'hamlet-off-broadway-2026', title: 'Hamlet', category: 'off-broadway', market: 'broadway', status: 'closed',
  previewsStartDate: '2026-04-19', openingDate: '2026-05-04', closingDate: '2026-05-17',
  creativeTeam: [{ name: 'Robert Hastie', role: 'Director' }],
};

test('Hamlet FRC class: a CV verdict naming a different director is a strong signal — no veto, in window or not', () => {
  const frc = {
    showId: HAMLET.id, outletId: 'front-row-center', criticName: 'Vahni Kurra',
    url: 'https://frontrowcenter.com/2026/05/06/hamlet-review-teatro-la-plaza/', publishDate: '2026-05-06',
    fullText: 'A moving Hamlet in Spanish, performed by a company of actors with Down syndrome. '.repeat(30),
    wrongProduction: true, wrongProductionReason: "CV-promoted: This is Teatro La Plaza's Hamlet directed by Chela De Ferrari, not the BAM production",
    contentVerification: { isValid: true, confidence: 'high', wrongProduction: true, wrongArticle: false, issues: [], reasoning: "The review describes Teatro La Plaza's production of Hamlet directed by Chela De Ferrari at TFANA, a completely different staging." },
  };
  assert.equal(isInWindowSlugMatchedReview(frc, HAMLET), true, 'the slug and date alone would qualify');
  assert.equal(cvFlagVetoedInWindow(frc, HAMLET, 'wrongProduction'), false);
  assert.equal(explainExclusion(frc, HAMLET), 'wrongProduction');
  // Schmigadoon EBT markers likewise.
  const ebt = dataWpFile({ contentVerification: { ...DATA_CV, wrongArticle: false, wrongProduction: true, issues: ["Expected show 'Data' does not appear in scraped content at all"], reasoning: 'completely different show' } });
  assert.equal(cvFlagVetoedInWindow(ebt, DATA, 'wrongProduction'), false);
  assert.equal(explainExclusion(ebt, DATA), 'wrongProduction');
  // The rebuild's own strong-signal promotion path is not CV-sourced for this purpose.
  const lowStrong = dataWpFile({ wrongProductionReason: 'CV-low-but-strong-signal: the expected show does not appear' });
  assert.equal(isCvSourcedWrongProduction(lowStrong), false);
});

test('provenance scope: only CV / classifier flags are vetoed', () => {
  const inWindowCrossMarket = dataWpFile({ wrongProductionReason: undefined, wrongProductionNote: 'Cross-market: London outlet "thestage" reviewing off-broadway show' });
  assert.equal(cvFlagVetoedInWindow(inWindowCrossMarket, DATA, 'wrongProduction'), false);
  assert.equal(explainExclusion(inWindowCrossMarket, DATA), 'wrongProduction');
  // The ingest anticipatory date gate (Abigail's Party / Time Out shape: in
  // window by 11 days-before-previews, slug matches, but a date-gate flag).
  const ABIGAIL = { id: 'abigails-party-west-end-2026', title: "Abigail's Party", category: 'west-end', status: 'closed', previewsStartDate: '2026-08-12', openingDate: '2026-08-19', closingDate: '2026-09-19' };
  const anticipatory = {
    url: 'https://www.timeout.com/london/theatre/abigails-party-5-review', publishDate: '2026-08-01', fullText: FULL_TEXT,
    wrongProduction: true, wrongProductionReason: 'anticipatory_pre_opening_post',
    wrongProductionDetail: 'published 18d before openingDate (2026-08-19); exceeds 2-day grace', wrongProductionDetectedBy: 'ingest-anticipatory-gate',
  };
  assert.equal(isInWindowSlugMatchedReview(anticipatory, ABIGAIL), true);
  assert.equal(cvFlagVetoedInWindow(anticipatory, ABIGAIL, 'wrongProduction'), false);
  assert.equal(explainExclusion(anticipatory, ABIGAIL), 'wrongProduction');
  // hamlet-off-broadway-2026's backfilled manual reasons (BRO-867) — no URL, no date, a human's reason.
  const manual = { showId: HAMLET.id, wrongProduction: true, wrongProductionReason: 'national-theatre-hamlet-2025' };
  assert.equal(cvFlagVetoedInWindow(manual, HAMLET, 'wrongProduction'), false);
  assert.equal(explainExclusion(manual, HAMLET), 'wrongProduction');
  const manualWithUrl = { ...manual, url: 'https://x.com/hamlet-review', publishDate: '2026-05-06' };
  assert.equal(explainExclusion(manualWithUrl, HAMLET), 'wrongProduction');
  // Ensemble rejections, human confirmations, wrongShowNote.
  assert.equal(cvFlagVetoedInWindow(dataWpFile({ rejectionReason: 'wrong_production' }), DATA, 'wrongProduction'), false);
  assert.equal(cvFlagVetoedInWindow(dataWpFile({ humanReviewedWrongProduction: true }), DATA, 'wrongProduction'), false);
  assert.equal(cvFlagVetoedInWindow(dataFile({ wrongShowNote: 'audit-cross-attribution: fingerprint matches another show' }), DATA, 'wrongShow'), false);
  assert.equal(cvFlagVetoedInWindow(dataFile({ rejectionReason: 'wrong_show' }), DATA, 'wrongShow'), false);
  assert.equal(cvFlagVetoedInWindow(dataFile({ humanReviewedWrongShow: true }), DATA, 'wrongShow'), false);
  // A flag with no reason at all is not attributable to CV.
  assert.equal(cvFlagVetoedInWindow(dataWpFile({ wrongProductionReason: undefined }), DATA, 'wrongProduction'), false);
});

test("the collector's wrong-content stamps are lifted only by a clear, never by the veto (guard/loop parity)", () => {
  // explainExclusion holds these via wrongContentFlagsUncleared / contentTierInvalid;
  // the rebuild loop has no inline gate for either field, so the veto must not
  // release what every guard-layer caller still reports as excluded.
  const wrongContent = dataWpFile({ incompleteReason: 'wrong_content', contentTier: 'invalid' });
  assert.equal(cvFlagVetoedInWindow(wrongContent, DATA, 'wrongProduction'), false);
  assert.equal(explainExclusion(wrongContent, DATA), 'wrongProduction');
  const invalidTier = dataWpFile({ contentTier: 'invalid', contentTierReason: 'Wrong production' });
  assert.equal(cvFlagVetoedInWindow(invalidTier, DATA, 'wrongProduction'), false);
  assert.equal(explainExclusion(invalidTier, DATA), 'wrongProduction');
  const wsInvalid = dataFile({ wrongArticleManualClear: true, contentTier: 'invalid' });
  assert.equal(cvFlagVetoedInWindow(wsInvalid, DATA, 'wrongShow'), false);
  assert.equal(explainExclusion(wsInvalid, DATA), 'wrongShow');
  // A real clear (the S3-T3 manualContentTier route on the Data file) lifts the tier stamp and the veto applies again.
  const retiered = dataWpFile({ contentTier: 'complete', manualContentTier: 'complete' });
  assert.equal(cvFlagVetoedInWindow(retiered, DATA, 'wrongProduction'), true);
});

test('a URL also filed under another production is never released (caller context)', () => {
  assert.equal(cvFlagVetoedInWindow(dataWpFile(), DATA, 'wrongProduction', { urlFiledUnderOtherShow: true }), false);
  assert.equal(cvFlagVetoedInWindow(dataWpFile(), DATA, 'wrongProduction', { urlFiledUnderOtherShow: false }), true);
  assert.equal(cvFlagVetoedInWindow(dataWpFile(), DATA, 'wrongProduction'), true);
});

test('wiring: explainExclusion, the rebuild gates, scoring-delta and content-verifier all sit on cvFlagVetoedInWindow', () => {
  const guards = fs.readFileSync(path.join(ROOT, 'scripts/lib/review-guards.js'), 'utf8');
  assert.ok(guards.includes("if (!cleared && !cvFlagVetoedInWindow(data, show, 'wrongProduction')) return 'wrongProduction';"), 'explainExclusion wrongProduction branch');
  assert.ok(guards.includes("&& !cvFlagVetoedInWindow(data, show, 'wrongShow')) return 'wrongShow';"), 'explainExclusion wrongShow branch');
  const rebuild = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  assert.ok(rebuild.includes("cvFlagVetoedInWindow(data, showById[showId], 'wrongProduction', {"), 'rebuild wrongProduction gate');
  assert.ok(rebuild.includes("cvFlagVetoedInWindow(data, showById[showId], 'wrongShow', {"), 'rebuild wrongShow gate');
  const delta = fs.readFileSync(path.join(ROOT, 'scripts/scoring-delta.js'), 'utf8');
  assert.ok(delta.includes('guards.cvFlagVetoedInWindow(review, show, kind, {'), 'scoring-delta replay');
  assert.ok(delta.includes('title: s.title || null,') && delta.includes('creativeTeam: s.creativeTeam || null,'), 'scoring-delta show summary carries title + creativeTeam');
  const cv = fs.readFileSync(path.join(ROOT, 'scripts/lib/content-verifier.js'), 'utf8');
  const start = cv.indexOf('const temporalOverrides = applyTemporalOverrides(');
  const end = cv.indexOf('});', start);
  const call = cv.slice(start, end);
  assert.ok(start > 0 && /\burl,/.test(call), 'content-verifier passes url into the cvContext');
  assert.ok(/wrongShow:/.test(call), 'content-verifier passes the wrongShow shape into the cvContext');
});
