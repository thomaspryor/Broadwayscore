/**
 * BRO-2770: a review body replaced in place while url/publishDate/stars stayed
 * from an older article. Covers the byline parser, the mismatch detector, the
 * date-guard hold signal, the shared writer's stale-field cleanup, the
 * push-restore exception and the corpus audit's explained/unexplained split.
 * Every assertion runs the real functions (CLAUDE.md rule 15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  extractDateFromText, extractBylineDate, detectBodyDateMismatch, isDifferentDatedArticle,
  invalidateStaleArticleFields, bodySwapClearsField,
} = require('../../scripts/lib/body-date-mismatch');
const { evaluateCurrentRunCorroboration, shouldHoldDateGuardFlag } = require('../../scripts/lib/wrong-production-corroboration');
const { safeWriteReview, isIntentionalClear } = require('../../scripts/lib/review-write-guard');
const { explainedBy, scanCorpus } = require('../../scripts/audit-body-date-mismatch');

const pad = (s) => s + ' ' + 'The production is lucid, sharply acted and very well paced. '.repeat(30);
// Real byline shape from london-box-office--stuart-king.json (the incident file).
const NEW_BODY = pad('Home Theatre News Reviews Review: THE STORY at Olivier, National Theatre Stuart King 4 September, 2026, 08:36 When a young white couple are car-jacked');
const OLD_BODY = pad('Review: A GHOST STORY at the Apollo Theatre By Stuart King / May 31, 2023 A chilling evening');

describe('extractBylineDate', () => {
  test('reads the incident byline (date followed by a clock time)', () => {
    assert.equal(extractBylineDate(NEW_BODY), '2026-09-04');
  });
  test('reads a "By <name> /" byline', () => {
    assert.equal(extractBylineDate(OLD_BODY), '2023-05-31');
  });
  test('ignores listing ranges, run dates, Updated stamps, news tickers and colon-led performance dates', () => {
    assert.equal(extractBylineDate(pad('Regent’s Park Open Air Theatre 20 June – 18 July 2026 Listing details')), null);
    assert.equal(extractBylineDate(pad('the run now reaches 28 November 2026. New rehearsal images')), null);
    assert.equal(extractBylineDate(pad('Elysa Gardner, USA TODAYNov. 19, 2012Updated March 29, 2013, 5:33 p.m. ET New musical')), null);
    assert.equal(extractBylineDate(pad('Breaking News Padres win October 6, 2026 at 6:04 pm Latest Headlines')), null);
    assert.equal(extractBylineDate(pad('By David Sheward January 22, 2025: Billed as a new play')), null);
    assert.equal(extractBylineDate(pad('By The Recs AG - Arlene Getz 27 minutes ago It’s November 30, 1993. The eve')), null);
  });
  // BRO-5261 retro-review: these byline separators were rejected outright.
  test('reads dash and "on" byline separators (real Louder Than War / WordPress shapes)', () => {
    assert.equal(extractBylineDate(pad('Abba – Voyage: live review! By Filthy Dirty - 13 June 2022 8 Subscribe')), '2022-06-13');
    assert.equal(extractBylineDate(pad('Review: HAMLET By Jane Doe – March 3, 2026 The production')), '2026-03-03');
    assert.equal(extractBylineDate(pad('Posted by Jane Doe on March 3, 2026 The production')), '2026-03-03');
  });
  test('after a byline name, Updated stamps, run words and a sentence-opening "On" still disqualify', () => {
    assert.equal(extractBylineDate(pad('By Jane Doe Updated on March 3, 2026 The production')), null);
    assert.equal(extractBylineDate(pad('By Jane Doe, from March 3, 2026 The production')), null);
    assert.equal(extractBylineDate(pad('Runs until - March 3, 2026 tickets')), null);
    // operawire.com: the dateline above the headline is the byline; "On <date>," is the performance.
    assert.equal(extractBylineDate(pad('Gershwin Revival Earns Grand Reception By Logan Martell On December 2, 2025, the Metropolitan Opera delivered')), null);
  });
  test('a byline dated after today is a page typo, not a date', () => {
    const y = new Date().getFullYear() + 1;
    assert.equal(extractBylineDate(pad(`Theatre Review by Howard Miller - October 26, ${y} Paranormal Activity`)), null);
  });
  test('the bound is the fetch day, so the typo stays a typo after its date passes', () => {
    // talkinbroadway.com Paranormal Activity: published 2026-08-25, byline typo "October 26, 2026".
    const rec = { fullText: pad('Theatre Review by Howard Miller - October 26, 2026 Paranormal Activity'), publishDate: '2026-08-25T20:51:56-04:00', textFetchedAt: '2026-10-13T13:05:54.629Z' };
    assert.equal(detectBodyDateMismatch(rec), null);
    assert.equal(extractBylineDate(rec.fullText, { notAfter: '2026-10-13' }), null);
    assert.equal(extractBylineDate(rec.fullText, { notAfter: '2026-11-01' }), '2026-10-26');
  });
  test('a stale textFetchedAt or a late-evening UTC fetch never hides a real byline', () => {
    // london-box-office THE STORY: textFetchedAt 2026-06-28 left behind, byline and publishDate 2026-09-04.
    assert.equal(detectBodyDateMismatch({ fullText: NEW_BODY, publishDate: '2026-09-04', textFetchedAt: '2026-06-28T10:00:00Z' }), null);
    assert.ok(detectBodyDateMismatch({ fullText: NEW_BODY, publishDate: '2023-05-31', textFetchedAt: '2026-06-28T10:00:00Z', firstSeenAt: '2026-09-04T09:00:00Z' }));
    // Fetched 23:30Z on the 3rd, UK byline dated the 4th.
    assert.ok(detectBodyDateMismatch({ fullText: NEW_BODY, publishDate: '2023-05-31', textFetchedAt: '2026-09-03T23:30:00Z' }));
  });
  test('only date-shaped Auto-flagged notes are date claims', () => {
    const { isDateClaimWrongProduction } = require('../../scripts/lib/stale-flag-neutralization');
    assert.equal(isDateClaimWrongProduction({ wrongProductionNote: "Auto-flagged: mentions director 'sam gold' who is not this production's" }), false);
    assert.equal(isDateClaimWrongProduction({ wrongProductionNote: 'Auto-flagged: published 400 days before show earliest date 2026-08-20' }), true);
    assert.equal(isDateClaimWrongProduction({ wrongProductionNote: 'Auto-flagged: URL date 2023-05-31 is 1177 days before show earliest date 2026-08-20.' }), true);
  });
});

describe('extractDateFromText (collector publishDate fallback) keeps its old behaviour', () => {
  test('a byline after an "opens" headline still parses', () => {
    assert.equal(extractDateFromText('Hamlet opens on Broadway. By Jane Doe, March 3, 2026 The production'), '2026-03-03');
  });
  test('no hard year ceiling: next year parses', () => {
    const y = new Date().getFullYear() + 1;
    assert.equal(extractDateFromText(`By Jane Doe, March 3, ${y} The production`), `${y}-03-03`);
  });
});

describe('detectBodyDateMismatch', () => {
  test('flags a byline more than 3 days from publishDate', () => {
    const m = detectBodyDateMismatch({ fullText: NEW_BODY, publishDate: '2023-05-31' });
    assert.deepEqual(m, { bodyDate: '2026-09-04', publishDate: '2023-05-31', deltaDays: 1192 });
  });
  test('passes when they agree within 3 days, or either date is missing', () => {
    assert.equal(detectBodyDateMismatch({ fullText: NEW_BODY, publishDate: '2026-09-06' }), null);
    assert.equal(detectBodyDateMismatch({ fullText: NEW_BODY }), null);
    assert.equal(detectBodyDateMismatch({ fullText: pad('no byline here'), publishDate: '2023-05-31' }), null);
  });
});

describe('date guards hold instead of flagging wrongProduction (acceptance 1)', () => {
  const show = { id: 'the-story-west-end-2026', previewsStartDate: '2026-08-20', openingDate: '2026-09-03' };
  test('in-window byline is a strong signal and holds at any gap', () => {
    const review = { fullText: NEW_BODY, publishDate: '2023-05-31' };
    const corrob = evaluateCurrentRunCorroboration({ review, show });
    assert.equal(corrob.strength, 'strong');
    assert.ok(corrob.signals.includes('body-byline-date:2026-09-04'));
    assert.equal(shouldHoldDateGuardFlag({ corrob, implausible: true }), true);
  });
  test('a malformed closingDate gives no signal (conservative, like the Theatre Record check)', () => {
    const review = { fullText: NEW_BODY, publishDate: '2023-05-31' };
    const corrob = evaluateCurrentRunCorroboration({ review, show: { ...show, closingDate: 'TBA' } });
    assert.equal(corrob.signals.some((s) => s.startsWith('body-byline-date:')), false);
  });
  test('a byline outside the run window gives no signal (a genuinely old article stays flaggable)', () => {
    const review = { fullText: OLD_BODY, publishDate: '2026-09-04' };
    const corrob = evaluateCurrentRunCorroboration({ review, show });
    assert.equal(corrob.signals.some((s) => s.startsWith('body-byline-date:')), false);
  });
});

describe('shared writer clears the old article’s fields on an in-place body swap (acceptance 2)', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2770-'));
  const seed = () => ({
    showId: 'the-story-west-end-2026', outletId: 'london-box-office', criticName: 'Stuart King',
    url: 'https://www.londonboxoffice.co.uk/news/post/a-ghost-story-apollo-review',
    publishDate: '2023-05-31', fullText: OLD_BODY,
    aggregatorStars: '4/5', originalScore: '4/5', originalScoreNormalized: 80, scoreSource: 'unicode-stars',
  });

  test('swap: stale publishDate/stars/score parked, date from byline, url marked for repair', () => {
    const p = path.join(TMP, 'swap.json');
    fs.writeFileSync(p, JSON.stringify(seed()));
    const incoming = { ...seed(), fullText: NEW_BODY };
    safeWriteReview(p, incoming);
    const out = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(out.fullText, NEW_BODY);
    assert.equal(out.publishDate, '2026-09-04');
    for (const f of ['aggregatorStars', 'originalScore', 'originalScoreNormalized', 'scoreSource']) {
      assert.equal(out[f], undefined, `${f} should be cleared`);
    }
    assert.equal(out.staleArticleFieldsParked.aggregatorStars, '4/5');
    assert.equal(out.needsUrlRepair, true);
    assert.equal(out.bodySwapDetected.oldBodyDate, '2023-05-31');
    assert.equal(out.bodySwapDetected.newBodyDate, '2026-09-04');
  });

  test('re-fetch of the same article (same byline) keeps every field', () => {
    const p = path.join(TMP, 'same.json');
    fs.writeFileSync(p, JSON.stringify(seed()));
    safeWriteReview(p, { ...seed(), fullText: OLD_BODY + ' One more sentence.' });
    const out = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(out.aggregatorStars, '4/5');
    assert.equal(out.originalScore, '4/5');
    assert.equal(out.publishDate, '2023-05-31');
    assert.equal(out.bodySwapDetected, undefined);
  });

  test('the right article replacing a stray body keeps the record (its publishDate matches the new byline)', () => {
    const p = path.join(TMP, 'right-article.json');
    // On disk: the url and metadata are THE STORY's; the body was another article.
    const onDisk = { ...seed(), url: 'https://www.londonboxoffice.co.uk/news/post/the-story-olivier-review', publishDate: '2026-09-04', fullText: OLD_BODY };
    fs.writeFileSync(p, JSON.stringify(onDisk));
    safeWriteReview(p, { ...onDisk, fullText: NEW_BODY });
    const out = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(out.fullText, NEW_BODY);
    assert.equal(out.publishDate, '2026-09-04');
    assert.equal(out.aggregatorStars, '4/5');
    assert.equal(out.needsUrlRepair, undefined, 'a correct url is never queued for repair');
    assert.equal(out.bodySwapDetected, undefined);
    assert.equal(isDifferentDatedArticle(OLD_BODY, NEW_BODY, { recordDate: '2026-09-05' }), null);
    assert.ok(isDifferentDatedArticle(OLD_BODY, NEW_BODY, { recordDate: '2023-05-31' }));
    // publishDate is often prose (talkinbroadway / EW records): still read as the record's date.
    assert.equal(isDifferentDatedArticle(OLD_BODY, NEW_BODY, { recordDate: 'September 4th, 2026' }), null);
  });

  test('a human-verified rating from the old page is cleared too', () => {
    const swap = isDifferentDatedArticle(OLD_BODY, NEW_BODY);
    const old = { ...seed(), originalScoreSource: 'manual-verified', scoreSource: 'manual-verified' };
    const newData = { ...old, fullText: NEW_BODY };
    const cleared = invalidateStaleArticleFields(newData, old, swap, { now: '2026-10-13T00:00:00Z' });
    assert.ok(cleared.includes('originalScore'));
    assert.equal(newData.originalScore, undefined);
  });

  test('a field the swapping write refreshed itself is kept', () => {
    const swap = isDifferentDatedArticle(OLD_BODY, NEW_BODY);
    const newData = { ...seed(), fullText: NEW_BODY, aggregatorStars: null, originalScore: '3/5' };
    const cleared = invalidateStaleArticleFields(newData, seed(), swap, { now: '2026-10-13T00:00:00Z' });
    assert.equal(newData.originalScore, '3/5');
    assert.ok(!cleared.includes('originalScore'));
    assert.ok(cleared.includes('publishDate'));
  });

  test('push restore treats the recorded clears as intentional, only for this body', () => {
    const p = path.join(TMP, 'swap.json');
    const local = JSON.parse(fs.readFileSync(p, 'utf8'));
    const committed = seed();
    assert.equal(bodySwapClearsField('aggregatorStars', local, committed), true);
    assert.equal(isIntentionalClear('originalScore', local, committed), true);
    // A later re-fetch put different text in: the old breadcrumb no longer applies.
    const refetched = { ...local, fullText: OLD_BODY };
    assert.equal(bodySwapClearsField('aggregatorStars', refetched, committed), false);
    // The committed copy already holds a re-collection of the NEW article: its values are restorable.
    const committedNew = { ...committed, fullText: NEW_BODY + ' More text from a richer re-collection.', aggregatorStars: '3/5' };
    assert.equal(bodySwapClearsField('aggregatorStars', local, committedNew), false);
  });
});

describe('corpus audit (acceptance 3)', () => {
  const show = { id: 'the-story-west-end-2026', previewsStartDate: '2026-08-20', openingDate: '2026-09-03' };
  test('content exclusions and queued re-fetches are explained; a shipping record is not', () => {
    assert.equal(explainedBy({ wrongShow: true }), 'wrongShow');
    assert.equal(explainedBy({ crossOutletDuplicate: true, wrongProduction: true }), 'crossOutletDuplicate');
    assert.equal(explainedBy({ needsRefetch: true, urlCorrectedFrom: 'https://x' }), 'awaiting-url-refetch');
    assert.equal(explainedBy({ needsRefetch: true }), null);
    assert.equal(explainedBy({}), null);
    assert.equal(explainedBy({ isNotReview: true }), 'isNotReview');
    assert.equal(explainedBy({ wrongAttribution: true }), 'wrongAttribution');
    assert.equal(explainedBy({ rejectionReason: 'not_a_review' }), 'rejected');
  });
  test('every date-window note shape counts as a date claim (rebuild and URL-date guards too)', () => {
    for (const note of [
      'Review published 1177 days before show opened — likely reviewing a different production',
      'Auto-flagged: published 1177 days before show earliest date 2026-08-20',
      'URL date 2023-05-31 is 1177 days before show window starts (2026-08-20). Likely review of an earlier production',
    ]) {
      const victim = { fullText: NEW_BODY, publishDate: '2023-05-31', wrongProduction: true, wrongProductionNote: note };
      assert.equal(explainedBy(victim, show), null, note);
    }
  });
  test('a DATE-based wrongProduction contradicted by an in-run byline is unexplained; a content reason explains it', () => {
    const victim = { fullText: NEW_BODY, publishDate: '2023-05-31', wrongProduction: true, wrongProductionNote: 'Date guard: review 2023-05-31 is 1177d before 2026-08-20 (preview/open) — likely different production' };
    assert.equal(explainedBy(victim, show), null);
    assert.equal(explainedBy({ ...victim, wrongProductionReason: 'Human-checked: a different production' }, show), 'wrongProduction');
    assert.equal(explainedBy({ ...victim, fullText: OLD_BODY }, show), 'wrongProduction', 'byline outside the run: the flag may be right');
  });
  test('scanCorpus finds mismatches and pending url repairs, skipping _ dirs and _ files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2770-corpus-'));
    const dir = path.join(root, 'the-story-west-end-2026');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(root, '_pending'));
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ fullText: NEW_BODY, publishDate: '2023-05-31' }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ fullText: NEW_BODY, publishDate: '2026-09-04' }));
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ fullText: NEW_BODY, publishDate: '2026-09-04', url: 'https://old', needsUrlRepair: true, bodySwapDetected: { url: 'https://old', oldBodyDate: '2023-05-31', newBodyDate: '2026-09-04' } }));
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ fullText: NEW_BODY, publishDate: '2026-09-04', url: 'https://repaired', needsUrlRepair: true, bodySwapDetected: { url: 'https://old' } }));
    fs.writeFileSync(path.join(dir, '_ingest-rejections.json'), JSON.stringify({ urls: [] }));
    fs.writeFileSync(path.join(root, '_pending', 'e.json'), JSON.stringify({ fullText: NEW_BODY, publishDate: '2023-05-31' }));
    const { files, hits, repairPending } = scanCorpus(root, { showsById: new Map([[show.id, show]]) });
    assert.equal(files, 4);
    assert.deepEqual(hits.map((h) => h.file), ['a.json']);
    assert.equal(hits[0].explainedBy, null);
    assert.deepEqual(repairPending.map((r) => r.file), ['c.json'], 'a url changed since the swap counts as repaired');
    // A cosmetic rewrite of the same url (trailing slash, https) is not a repair.
    const { isUrlRepairPending } = require('../../scripts/lib/body-date-mismatch');
    const swapped = { url: 'http://x.com/a', needsUrlRepair: true, bodySwapDetected: { url: 'http://x.com/a' } };
    assert.equal(isUrlRepairPending({ ...swapped, url: 'https://x.com/a/' }), true);
    assert.equal(isUrlRepairPending({ ...swapped, url: 'https://x.com/b' }), false);
  });
});
