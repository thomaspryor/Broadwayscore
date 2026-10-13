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
  });
});
