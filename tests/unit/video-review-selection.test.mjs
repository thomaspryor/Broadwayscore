// BRO-6091: Kate Reinking (@theatreislife) reviews were missed, the wrong
// video was picked, and an explicit "10 out of 10" was scored 77.
// require()s the real rules (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  inProductionWindow, indexShowsByTitle, rematchCandidates, isDeadEnd, selectionCandidates,
  candidateSetKey, deterministicPick, transcriptExcerpt, parsePickerReply, parseRematchReply,
  planSelection, fallbackPick, isPublishable, nextSelectedRecord, publishedRecord, titleMatches,
} = require('../../scripts/lib/video-review-selection.js');
const { parseRating, ratingBand, anchorScore, mentionsRating, videoBucketForScore } = require('../../scripts/lib/video-review-rating.js');

const godot2025 = { id: 'waiting-for-godot-2025', title: 'Waiting for Godot', category: 'broadway', previewsStartDate: '2025-09-13', openingDate: '2025-09-28', closingDate: '2026-01-04' };
const godot2009 = { id: 'waiting-for-godot-2009', title: 'Waiting for Godot', category: 'broadway', openingDate: '2009-04-30', closingDate: '2009-07-12' };
const notebook = { id: 'the-notebook-2024', title: 'The Notebook', category: 'broadway', previewsStartDate: '2024-02-10', openingDate: '2024-03-14', closingDate: '2024-12-15' };
const notebookTour = { id: 'the-notebook-tour-2025', title: 'The Notebook', category: 'tour', openingDate: '2025-09-06' };
const notebookWE = { id: 'the-notebook-west-end-2026', title: 'The Notebook', category: 'west-end', openingDate: '2025-09-01' };

test('re-match: the run the video was posted during, not other revivals of the title', () => {
  const idx = indexShowsByTitle([godot2025, godot2009]);
  const c = { showTitle: 'Waiting for Godot', date: '20251009' };
  assert.deepEqual(rematchCandidates(c, idx).map(s => s.id), ['waiting-for-godot-2025']);
});

test('re-match: classifier qualifiers in parentheses still match the title', () => {
  const idx = indexShowsByTitle([notebook, notebookTour]);
  assert.deepEqual(rematchCandidates({ showTitle: 'The Notebook (national tour)', date: '20251222' }, idx).map(s => s.id), ['the-notebook-tour-2025']);
});

test('re-match: London runs are candidates too (BRO-6095), alongside an overlapping New York run', () => {
  const idx = indexShowsByTitle([notebook, notebookTour, notebookWE]);
  assert.deepEqual(rematchCandidates({ showTitle: 'The Notebook', date: '20251222' }, idx).map(s => s.id).sort(),
    ['the-notebook-tour-2025', 'the-notebook-west-end-2026']);
});

test('re-match: unknown post date or run start gives no candidates', () => {
  const idx = indexShowsByTitle([godot2025, { id: 'x-2026', title: 'X', category: 'broadway' }]);
  assert.deepEqual(rematchCandidates({ showTitle: 'Waiting for Godot', date: 'NA' }, idx), []);
  assert.deepEqual(rematchCandidates({ showTitle: 'X', date: '20260101' }, idx), []);
});

test('production window: a week before previews to two weeks after closing', () => {
  assert.equal(inProductionWindow('20250908', godot2025), true);
  assert.equal(inProductionWindow('20250901', godot2025), false);
  assert.equal(inProductionWindow('20260115', godot2025), true);
  assert.equal(inProductionWindow('20260125', godot2025), false);
  assert.equal(inProductionWindow('NA', godot2025), true);
});

test('production window: no previews date assumes previews began 30 days before opening', () => {
  assert.equal(inProductionWindow('20090405', godot2009), true);
  assert.equal(inProductionWindow('20090320', godot2009), false);
});

test('dead ends: rejected, flagged or paid picks move on', () => {
  assert.equal(isDeadEnd({ scoreable: false }), true);
  assert.equal(isDeadEnd({ wrongProduction: true, wrongProductionReason: 'London run' }), true);
  assert.equal(isDeadEnd({ title: 'loved it #ad', transcript: '' }), true);
  assert.equal(isDeadEnd({ score: 80, title: 'loved it', transcript: 'great' }), false);
});

test('selection candidates: reviews of 100+ words in the run, minus excluded videos', () => {
  const cs = [
    { videoId: 'a', reviewType: 'review', wordCount: '1230', date: '20241028' },
    { videoId: 'b', reviewType: 'review', wordCount: '60', date: '20241030' },
    { videoId: 'c', reviewType: 'commentary', wordCount: '900', date: '20241030' },
    { videoId: 'd', reviewType: 'review', wordCount: '422', date: '20241119' },
    { videoId: 'e', reviewType: 'review', wordCount: '700', date: '20220101' },
  ];
  const show = { id: 'tammy-faye-2024', previewsStartDate: '2024-10-15', openingDate: '2024-11-14', closingDate: '2024-12-08' };
  assert.deepEqual(selectionCandidates(cs, show).map(c => c.videoId), ['a', 'd']);
  assert.deepEqual(selectionCandidates(cs, show, new Set(['a'])).map(c => c.videoId), ['d']);
  assert.deepEqual(selectionCandidates([...cs, { videoId: 'ad', reviewType: 'review', wordCount: '800', date: '20241101', title: 'thanks for the tickets #ad' }], show).map(c => c.videoId), ['a', 'd']);
});

test('fallback pick: first full-length review, not the clip nearest opening night', () => {
  const tammy = [
    { videoId: 'clip', wordCount: '422', date: '20241119' },
    { videoId: 'review', wordCount: '1230', date: '20241028' },
  ];
  assert.equal(deterministicPick(tammy).videoId, 'review');
  const shortOnly = [{ videoId: 's1', wordCount: '150', date: '20240101' }, { videoId: 's2', wordCount: '280', date: '20240201' }];
  assert.equal(deterministicPick(shortOnly).videoId, 's2');
  assert.equal(deterministicPick([]), null);
});

test('candidate set key ignores order and changes when a video is added', () => {
  const a = [{ videoId: '2' }, { videoId: '1' }];
  assert.equal(candidateSetKey(a), candidateSetKey([{ videoId: '1' }, { videoId: '2' }]));
  assert.notEqual(candidateSetKey(a), candidateSetKey([...a, { videoId: '3' }]));
});

test('transcript excerpt keeps the closing verdict', () => {
  const t = 'intro '.repeat(200) + '10 out of 10, would recommend';
  const ex = transcriptExcerpt(t);
  assert.ok(ex.includes('[...]'));
  assert.ok(ex.endsWith('10 out of 10, would recommend'));
  assert.equal(transcriptExcerpt('short one'), 'short one');
});

test('picker and re-match replies: valid numbers only', () => {
  const cands = [{ videoId: 'a' }, { videoId: 'b' }];
  assert.equal(parsePickerReply('{"pick": 2, "reason": "full review"}', cands).pick.videoId, 'b');
  assert.equal(parsePickerReply('```json\n{"pick": 1}\n```', cands).pick.videoId, 'a');
  assert.equal(parsePickerReply('{"pick": 3}', cands), null);
  assert.equal(parsePickerReply('no idea', cands), null);
  const shows = [godot2025];
  assert.equal(parseRematchReply('{"match": 1, "reason": "Hudson Theatre"}', shows).show.id, 'waiting-for-godot-2025');
  assert.deepEqual(parseRematchReply('{"match": 0, "reason": "ART Boston"}', shows), { ok: true, show: null, reason: 'ART Boston' });
  assert.equal(parseRematchReply('{"match": 4}', shows).ok, false);
  assert.equal(parseRematchReply('garbage', shows).ok, false);
});

test('ratings: parse the forms creators say', () => {
  assert.equal(parseRating('10/10'), 1);
  assert.equal(parseRating('9 out of 10'), 0.9);
  assert.equal(parseRating('4.5/5'), 0.9);
  assert.equal(parseRating('4 stars'), 0.8);
  assert.equal(parseRating('four stars'), 0.8);
  assert.equal(parseRating('4.5 stars out of 5'), 0.9);
  assert.equal(parseRating('4 out of 5 stars'), 0.8);
  assert.equal(parseRating(null), null);
  assert.equal(parseRating('none'), null);
  assert.equal(parseRating('11/10'), null);
  assert.equal(parseRating('7/8'), null);
});

test('ratings: star bands match the text-review bands (CLAUDE.md §3)', () => {
  assert.deepEqual(ratingBand(1), { min: 91, max: 100 });
  assert.deepEqual(ratingBand(0.8), { min: 71, max: 90 });
  assert.deepEqual(ratingBand(0.6), { min: 51, max: 70 });
  assert.deepEqual(ratingBand(0.4), { min: 31, max: 50 });
});

test('ratings: Heathers "10 out of 10" scored 77 is pulled up into the Rave band', () => {
  assert.deepEqual(anchorScore(77, 'Positive', '10/10'), { score: 91, bucket: 'Rave', anchored: true, rating: 1 });
  assert.deepEqual(anchorScore(95, 'Rave', '10/10'), { score: 95, bucket: 'Rave', anchored: false, rating: 1 });
  assert.deepEqual(anchorScore(75, 'Positive', null), { score: 75, bucket: 'Positive', anchored: false, rating: null });
  assert.equal(anchorScore(40, 'Negative', '4 stars').score, 71);
  // the label always follows the score (model returned 68 "Positive")
  assert.equal(anchorScore(68, 'Positive', null).bucket, 'Mixed');
});

test('ratings: rescore pre-filter and bucket table', () => {
  assert.equal(mentionsRating('make it a two show day. 10 out of 10, would recommend'), true);
  assert.equal(mentionsRating('on paper this is a five star musical'), true);
  assert.equal(mentionsRating('I loved it'), false);
  assert.deepEqual([95, 83, 82, 70, 69, 55, 54, 35, 34].map(videoBucketForScore),
    ['Rave', 'Rave', 'Positive', 'Positive', 'Mixed', 'Mixed', 'Negative', 'Negative', 'Pan']);
});

const vid = (videoId, extra = {}) => ({ videoId, creatorId: 'theatreislife', platform: 'tiktok', title: 't', transcript: 'x', wordCount: '500', date: '20241028', ...extra });
const published = (videoId, extra = {}) => ({ ...vid(videoId), score: 72, bucket: 'Positive', keyQuote: 'q', ...extra });

test('plan: a settled pick with the same candidates is left alone', () => {
  const cands = [vid('a'), vid('b')];
  const existing = published('a', { selection: { method: 'llm', candidateKey: candidateSetKey(cands) } });
  assert.equal(planSelection(existing, cands).action, 'unchanged');
});

test('plan: a fallback pick is re-asked even with the same candidates', () => {
  const cands = [vid('a'), vid('b')];
  for (const method of ['kept', 'first-full-review']) {
    const existing = published('a', { selection: { method, candidateKey: candidateSetKey(cands) } });
    assert.deepEqual(planSelection(existing, cands), { action: 'ask', candidateKey: candidateSetKey(cands), existingValid: true });
  }
});

test('plan: a new video re-opens a settled pick; one candidate needs no picker; none left is none', () => {
  const existing = published('a', { selection: { method: 'llm', candidateKey: 'a' } });
  assert.equal(planSelection(existing, [vid('a'), vid('c')]).action, 'ask');
  assert.equal(planSelection(null, [vid('a')]).pick.videoId, 'a');
  assert.equal(planSelection(existing, []).action, 'none');
});

test('fallback: keeps a valid current pick, else the first full review', () => {
  const cands = [vid('clip', { wordCount: '422', date: '20241119' }), vid('full', { wordCount: '1230', date: '20241028' })];
  assert.deepEqual(fallbackPick(published('clip'), cands, true), { pick: cands[0], method: 'kept' });
  assert.deepEqual(fallbackPick(null, cands, false), { pick: cands[1], method: 'first-full-review' });
});

test('new pick over a published review keeps it live as previousPick, with its thumbnail', () => {
  const sel = { excludedVideoIds: [], selection: { method: 'llm' } };
  const { record, deleteThumbnail } = nextSelectedRecord(published('old', { transcript: 'long', productionCheck: {} }), vid('new'), sel);
  assert.equal(record.videoId, 'new');
  assert.equal(record.videoUrl, 'https://www.tiktok.com/@theatreislife/video/new');
  assert.equal(record.previousPick.videoId, 'old');
  assert.equal(record.previousPick.score, 72);
  assert.equal(record.previousPick.transcript, undefined);
  assert.equal(deleteThumbnail, false);
});

test('first pick for a creator and show: no previous pick, nothing to delete', () => {
  const { record, deleteThumbnail } = nextSelectedRecord(null, vid('new'), { excludedVideoIds: [], selection: { method: 'single' } });
  assert.equal(record.videoId, 'new');
  assert.equal(record.previousPick, undefined);
  assert.equal(deleteThumbnail, false);
  // an unscored, unpublished current file is replaced without a previous pick
  assert.equal(nextSelectedRecord(vid('pending'), vid('new'), { excludedVideoIds: [], selection: {} }).record.previousPick, undefined);
});

test('new pick over a dead end: nothing published stays, so the stale thumbnail goes', () => {
  const sel = { excludedVideoIds: ['old'], selection: { method: 'single' } };
  const { record, deleteThumbnail } = nextSelectedRecord(published('old', { wrongProduction: true, wrongProductionReason: 'London' }), vid('new'), sel);
  assert.equal(record.previousPick, undefined);
  assert.deepEqual(record.excludedVideoIds, ['old']);
  assert.equal(deleteThumbnail, true);
  // a still-pending previous pick carries over when the pick changes again
  const pending = { ...vid('mid'), previousPick: { videoId: 'old', score: 72 } };
  assert.equal(nextSelectedRecord(pending, vid('new'), sel).record.previousPick.videoId, 'old');
});

test('re-pick before the replacement was verified keeps the verified live pick, not the unverified one', () => {
  const sel = { excludedVideoIds: [], selection: { method: 'llm' } };
  const a = { videoId: 'A', score: 80, thumbnail: '/images/video-reviews/x.jpg' };
  const bScoredUnverified = { ...published('B'), previousPick: a };
  const { record, deleteThumbnail } = nextSelectedRecord(bScoredUnverified, vid('C'), sel);
  assert.equal(record.previousPick.videoId, 'A');
  assert.equal(deleteThumbnail, false);
  const bVerified = { ...published('B'), previousPick: a, productionCheck: { verdict: 'same' } };
  assert.equal(nextSelectedRecord(bVerified, vid('C'), sel).record.previousPick.videoId, 'B');
});

test('build: publishes the new pick only once scored and verified, else the previous pick', () => {
  const prev = { videoId: 'old', score: 72 };
  assert.deepEqual(publishedRecord({ ...vid('new'), previousPick: prev }), { record: prev, retirePrevious: false });
  assert.deepEqual(publishedRecord({ ...published('new'), previousPick: prev }), { record: prev, retirePrevious: false });
  const verified = { ...published('new'), previousPick: prev, productionCheck: { verdict: 'same' } };
  assert.deepEqual(publishedRecord(verified), { record: verified, retirePrevious: true });
  const rejected = { ...vid('new'), scoreable: false, previousPick: prev };
  assert.equal(publishedRecord(rejected).record, prev);
  assert.equal(publishedRecord(published('a')).record.videoId, 'a');
  assert.equal(publishedRecord(vid('a')).record, null);
  assert.equal(isPublishable({ ...published('a'), wrongProduction: true }), false);
});

// BRO-6172: near-miss titles. Broadway Ben's "John Proctor as the Villain" and
// the classifier's "The Wild Party" for City Center's "Encores! The Wild Party".
const jpv = { id: 'john-proctor-is-the-villain-2025', title: 'John Proctor Is the Villain', category: 'broadway', previewsStartDate: '2025-03-14', openingDate: '2025-04-24', closingDate: '2025-08-24' };
const wild = { id: 'encores-the-wild-party-off-broadway-2026', title: 'Encores! The Wild Party', category: 'off-broadway', previewsStartDate: '2026-03-11', openingDate: '2026-03-18', closingDate: '2026-03-29' };
const elevenToMidnight = { id: '11-to-midnight-off-broadway-2026', title: '11 to Midnight', category: 'off-broadway', previewsStartDate: '2026-02-20', openingDate: '2026-03-05', closingDate: '2026-04-12' };

test('re-match: a close title is a candidate when no exact title matches', () => {
  const idx = indexShowsByTitle([jpv, wild, elevenToMidnight]);
  assert.deepEqual(rematchCandidates({ showTitle: 'John Proctor as the Villain', date: '20250719' }, idx).map(s => s.id), ['john-proctor-is-the-villain-2025']);
  assert.deepEqual(rematchCandidates({ showTitle: 'The Wild Party', date: '20260320' }, idx).map(s => s.id), ['encores-the-wild-party-off-broadway-2026']);
});

test('re-match: close titles still need the run dates, and unrelated titles never match', () => {
  const idx = indexShowsByTitle([jpv, wild, elevenToMidnight]);
  assert.deepEqual(rematchCandidates({ showTitle: 'John Proctor as the Villain', date: '20240101' }, idx), []);
  assert.deepEqual(rematchCandidates({ showTitle: 'Some Fringe Show', date: '20260320' }, idx), []);
  // a wrong close title (a Todrick Hall "Midnight" workshop) is only a candidate:
  // the model confirm in classify-reviews.js is what refuses it
  assert.deepEqual(rematchCandidates({ showTitle: 'Midnight (Todrick Hall workshop)', date: '20260308' }, idx).map(s => s.id), ['11-to-midnight-off-broadway-2026']);
});

test('titleMatches: exact first, otherwise close titles', () => {
  const idx = indexShowsByTitle([jpv, wild]);
  assert.deepEqual(titleMatches('Encores! The Wild Party', idx).map(s => s.id), ['encores-the-wild-party-off-broadway-2026']);
  assert.deepEqual(titleMatches('The Wild Party', idx).map(s => s.id), ['encores-the-wild-party-off-broadway-2026']);
  assert.deepEqual(titleMatches('Hamlet', idx), []);
  assert.deepEqual(titleMatches('', idx), []);
});

test('re-match: an exact title whose run does not fit the date falls back to close titles', () => {
  // real data: "The Wild Party" is an exact title (the 2000 Broadway run), which
  // used to hide City Center's 2026 Encores! run from the re-match
  const wild2000 = { id: 'the-wild-party-2000', title: 'The Wild Party', category: 'broadway', previewsStartDate: '2000-03-21', openingDate: '2000-04-13', closingDate: '2000-06-11' };
  const idx = indexShowsByTitle([wild2000, wild, jpv]);
  assert.deepEqual(rematchCandidates({ showTitle: 'The Wild Party', date: '20260320' }, idx).map(s => s.id), ['encores-the-wild-party-off-broadway-2026']);
  // and the exact run still wins when it fits
  assert.deepEqual(rematchCandidates({ showTitle: 'The Wild Party', date: '20000420' }, idx).map(s => s.id), ['the-wild-party-2000']);
});
