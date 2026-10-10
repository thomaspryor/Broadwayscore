/**
 * Unknown-twin URL loss (2026-09-24): Theatre Record ingest wrote a URL-less
 * named file (british-theatre--vera-liber.json, url null) beside the
 * URL-bearing Unknown-byline twin of the same review
 * (british-theatre--unknown.json), and the rebuild's unknown-critic dedup
 * dropped the twin — 27 reviews.json rows across 22 shows shipped url:null.
 *
 * Covers the pure decisions in scripts/lib/review-text-identity.js:
 *  - resolveTheatreRecordWriteTarget / mergeTheatreRecordIntoExisting (ingest)
 *  - decideUnknownTwinUrlCarry (rebuild fallback)
 *
 * Run: node --test tests/unit/review-text-identity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  textsShareVerbatimPassage,
  resolveTheatreRecordWriteTarget,
  mergeTheatreRecordIntoExisting,
  decideUnknownTwinUrlCarry,
  decideDuplicateTwinUrlCarry,
} = require('../../scripts/lib/review-text-identity.js');

// Real shape: the outlet copy carries a page header prefix; the TR copy is the
// clean body. Prefix fingerprints differ, shared prose does not.
const BODY = 'Many foreign friends find the English hard to understand, not because of language and accents but because of circumspect replies, especially amongst the upper classes. Works well if you are in the secret civil service. Alan Ayckbourn took this essential English characteristic and ran with it in 1969, weaving two living rooms into one set so that the dinner parties of two couples overlap on stage at the same time, which is a trick that still delights a modern audience more than fifty years later.';
const OUTLET_TEXT = 'How the Other Half Loves Alan Ayckbourn Old Vic Theatre 29 July to 19 September 2026 Listing details and ticket info... ' + BODY;
const TR_TEXT = BODY + ' Vera Liber.';
const OTHER_REVIEW = 'Tim Hochstrasser reviews Hadestown, the Tony Award-winning Broadway musical which is now playing at the Lyric Theatre in a production that fizzes with energy from the first note of the band to the final bow, with a cast whose voices carry the old myth into a modern depression-era setting with real conviction and wit.';
const URL = 'https://www.britishtheatreguide.info/reviews/how-the-other-h-old-vic-theatre-25823';

test('textsShareVerbatimPassage: same article with different page chrome → true', () => {
  assert.equal(textsShareVerbatimPassage(OUTLET_TEXT, TR_TEXT), true);
  assert.equal(textsShareVerbatimPassage(TR_TEXT, OUTLET_TEXT), true);
});

test('textsShareVerbatimPassage: different reviews / missing text → false', () => {
  assert.equal(textsShareVerbatimPassage(OTHER_REVIEW, TR_TEXT), false);
  assert.equal(textsShareVerbatimPassage('', TR_TEXT), false);
  assert.equal(textsShareVerbatimPassage(TR_TEXT, null), false);
});

// ─── Ingest ───

test('ingest: exact filename exists → merge into it', () => {
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--vera-liber.json', exactExists: true, variant: null, incomingCritic: 'Vera Liber', incomingText: TR_TEXT });
  assert.deepEqual([r.action, r.path, r.fillCritic], ['merge', '/d/bt--vera-liber.json', false]);
});

test('ingest: no existing file → create', () => {
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--vera-liber.json', exactExists: false, variant: null, incomingCritic: 'Vera Liber', incomingText: TR_TEXT });
  assert.equal(r.action, 'create');
});

test('ingest: URL-bearing Unknown twin of the same article → merge into it and fill critic (the bug)', () => {
  const variant = { path: '/d/bt--unknown.json', data: { criticName: 'Unknown', url: URL, fullText: OUTLET_TEXT } };
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--vera-liber.json', exactExists: false, variant, incomingCritic: 'Vera Liber', incomingText: TR_TEXT });
  assert.deepEqual([r.action, r.path, r.fillCritic], ['merge', '/d/bt--unknown.json', true]);
});

test('ingest: Unknown variant with DIFFERENT text → create (never relabel another review)', () => {
  const variant = { path: '/d/bt--unknown.json', data: { criticName: 'Unknown', url: URL, fullText: OTHER_REVIEW } };
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--vera-liber.json', exactExists: false, variant, incomingCritic: 'Vera Liber', incomingText: TR_TEXT });
  assert.equal(r.action, 'create');
  assert.equal(r.reason, 'unknown-variant-text-unverified');
});

test('ingest: Unknown variant with no text (unverifiable) → create', () => {
  const variant = { path: '/d/bt--unknown.json', data: { criticName: 'Unknown', url: URL } };
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--vera-liber.json', exactExists: false, variant, incomingCritic: 'Vera Liber', incomingText: TR_TEXT });
  assert.equal(r.action, 'create');
});

test('ingest: exclusion-flagged variant → create', () => {
  const variant = { path: '/d/bt--unknown.json', data: { criticName: 'Unknown', url: URL, fullText: OUTLET_TEXT, wrongProduction: true } };
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--vera-liber.json', exactExists: false, variant, incomingCritic: 'Vera Liber', incomingText: TR_TEXT });
  assert.equal(r.action, 'create');
  assert.equal(r.reason, 'variant-exclusion-flagged');
});

test('ingest: same named critic under an accent/alias variant slug → merge, no critic fill', () => {
  const variant = { path: '/d/bt--vera-liber-2.json', data: { criticName: 'Vera Liber', url: URL } };
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--vera-liber.json', exactExists: false, variant, incomingCritic: 'Vera Liber', incomingText: TR_TEXT });
  assert.deepEqual([r.action, r.path, r.fillCritic], ['merge', '/d/bt--vera-liber-2.json', false]);
});

test('ingest merge: keeps url/score/text, fills critic + TR fields', () => {
  const existing = { criticName: 'Unknown', url: URL, fullText: OUTLET_TEXT, assignedScore: 71, contentTier: 'complete', source: 'outlet-listing-poller', sources: ['outlet-listing-poller'] };
  const reviewData = { criticName: 'Vera Liber', url: null, fullText: TR_TEXT, textWordCount: 90, contentTier: 'complete', contentTierReason: 'Full review text from Theatre Record', theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/8/40746', publishDate: '2026-08-14' };
  const merged = mergeTheatreRecordIntoExisting(existing, reviewData, { fillCritic: true });
  assert.equal(merged.url, URL);
  assert.equal(merged.fullText, OUTLET_TEXT);
  assert.equal(merged.assignedScore, 71);
  assert.equal(merged.criticName, 'Vera Liber');
  assert.equal(merged.theatreRecordUrl, reviewData.theatreRecordUrl);
  assert.deepEqual(merged.sources, ['outlet-listing-poller', 'theatre-record']);
  assert.deepEqual(existing.sources, ['outlet-listing-poller'], 'input not mutated');
});

test('ingest merge: without fillCritic a named critic is never overwritten', () => {
  const merged = mergeTheatreRecordIntoExisting({ criticName: 'Someone Else', url: URL }, { criticName: 'Vera Liber', fullText: TR_TEXT }, { fillCritic: false });
  assert.equal(merged.criticName, 'Someone Else');
  const merged2 = mergeTheatreRecordIntoExisting({ criticName: 'Someone Else', url: URL }, { criticName: 'Vera Liber' }, { fillCritic: true });
  assert.equal(merged2.criticName, 'Someone Else');
});

// ─── Rebuild fallback ───

const dropped = (over = {}) => ({ url: URL, fullText: OUTLET_TEXT, data: { criticName: 'Unknown', url: URL }, urlOwnedByOutlet: true, urlAlreadyKept: false, ...over });

test('rebuild: URL-less named twin with the same text → carry url onto it', () => {
  const r = decideUnknownTwinUrlCarry(dropped(), [{ url: null, fullText: TR_TEXT }]);
  assert.deepEqual([r.carry, r.index, r.url], [true, 0, URL]);
});

test('rebuild: picks the matching twin among several named critics at the outlet', () => {
  const r = decideUnknownTwinUrlCarry(dropped(), [{ url: null, fullText: OTHER_REVIEW }, { url: null, fullText: TR_TEXT }]);
  assert.deepEqual([r.carry, r.index], [true, 1]);
});

test('rebuild: no carry when the kept entry already has a url', () => {
  assert.equal(decideUnknownTwinUrlCarry(dropped(), [{ url: 'https://x/other', fullText: TR_TEXT }]).carry, false);
});

test('rebuild: no carry when text differs or is missing', () => {
  assert.equal(decideUnknownTwinUrlCarry(dropped(), [{ url: null, fullText: OTHER_REVIEW }]).carry, false);
  assert.equal(decideUnknownTwinUrlCarry(dropped({ fullText: '' }), [{ url: null, fullText: TR_TEXT }]).carry, false);
});

test('rebuild: no carry from flagged / roundup / foreign-domain / already-used urls', () => {
  for (const flag of [{ wrongProduction: true }, { wrongShow: true }, { isRoundupArticle: true }, { isNonReview: true }, { duplicateOf: 'x.json' }]) {
    assert.equal(decideUnknownTwinUrlCarry(dropped({ data: { criticName: 'Unknown', ...flag } }), [{ url: null, fullText: TR_TEXT }]).carry, false, JSON.stringify(flag));
  }
  assert.equal(decideUnknownTwinUrlCarry(dropped({ urlOwnedByOutlet: false }), [{ url: null, fullText: TR_TEXT }]).carry, false);
  assert.equal(decideUnknownTwinUrlCarry(dropped({ urlAlreadyKept: true }), [{ url: null, fullText: TR_TEXT }]).carry, false);
  assert.equal(decideUnknownTwinUrlCarry(dropped({ url: null }), [{ url: null, fullText: TR_TEXT }]).carry, false);
});

test('rebuild: ambiguous (two URL-less same-text twins) → no carry', () => {
  const r = decideUnknownTwinUrlCarry(dropped(), [{ url: null, fullText: TR_TEXT }, { url: null, fullText: TR_TEXT }]);
  assert.equal(r.carry, false);
  assert.equal(r.reason, 'ambiguous-multiple-twins');
});

// ─── Adversarial review 2026-09-24 ───

// A long review body and a second, DIFFERENT review sharing one synopsis sentence.
const SYNOPSIS = 'The play follows two couples whose dinner parties overlap on one stage across a single long evening in suburban London.';
const REVIEW_A = `${SYNOPSIS} Alan Ayckbourn wrote this comedy in 1969 and the director has trusted its clockwork completely, letting the overlapping scenes breathe instead of rushing them for laughs. The cast is uniformly sharp, with the lead couple finding real melancholy under the farce, and the set design lets both living rooms share every piece of furniture without a moment of confusion. By the second act the evening has become a small masterpiece of timing, and the audience around me was helpless with laughter at the final collision of the two dinners. It is the best revival of the play in a generation and deserves a transfer.`;
const REVIEW_B = `${SYNOPSIS} This production never finds its rhythm, and the performers seem to be acting in separate plays rather than one shared machine of comic misunderstanding. Much of the first half drags, the jokes are signposted well before they land, and the famous double dinner scene feels more like a technical exercise than a comic climax. There are pleasures in the supporting cast, but a revival this tentative makes the old farce look dated rather than timeless, and I left wondering why the theatre chose it at all this season.`;

test('P1-c: identical article → true; one shared synopsis sentence → false', () => {
  assert.equal(textsShareVerbatimPassage(REVIEW_A, 'Header junk. ' + REVIEW_A + ' Footer.'), true);
  assert.equal(textsShareVerbatimPassage(REVIEW_A, REVIEW_B), false);
  assert.equal(textsShareVerbatimPassage(REVIEW_B, REVIEW_A), false);
});

test("P1-c: a review that QUOTES another review's passage → false (quotes stripped on BOTH sides)", () => {
  const quoted = REVIEW_A.split('. ').slice(1, 3).join('. ');
  const quoting = `${REVIEW_B} As another critic put it, "${quoted}." I cannot agree.`;
  assert.equal(textsShareVerbatimPassage(quoting, REVIEW_A), false);
  assert.equal(textsShareVerbatimPassage(REVIEW_A, quoting), false);
});

test('P1-c: one ~20-word shared passage cannot count twice (non-overlapping windows)', () => {
  const shared = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';
  assert.equal(textsShareVerbatimPassage(`${shared} ${REVIEW_A}`, `${shared} ${REVIEW_B}`), false);
});

test('P1-c: punctuation / apostrophe-style differences do not break a true match', () => {
  const variant = REVIEW_A.replace(/,/g, ' ,').replace(/'/g, '’');
  assert.equal(textsShareVerbatimPassage(REVIEW_A, variant), true);
});

test('P1-a: variant whose STORED critic is a different named person is never a merge target (Bob vs Alice in "--unknown")', () => {
  const variant = { path: '/d/bt--unknown.json', data: { criticName: 'Alice Smith', url: URL, fullText: OUTLET_TEXT } };
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--bob-jones.json', exactExists: false, variant, incomingCritic: 'Bob Jones', incomingText: TR_TEXT });
  assert.equal(r.action, 'create');
  assert.equal(r.reason, 'variant-different-stored-critic');
});

test("P1-a: exact filename whose stored critic differs → skip (never merge into another critic's review)", () => {
  const r = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--unknown.json', exactExists: true, exactData: { criticName: 'Alice Smith', fullText: OUTLET_TEXT }, variant: null, incomingCritic: 'Bob Jones', incomingText: TR_TEXT });
  assert.equal(r.action, 'skip');
});

test('P1-a: unattributed TR review vs "--unknown" file now holding Alice → merge only with same text', () => {
  const same = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--unknown.json', exactExists: true, exactData: { criticName: 'Alice Smith', fullText: OUTLET_TEXT }, variant: null, incomingCritic: 'Unknown', incomingText: TR_TEXT });
  assert.equal(same.action, 'merge');
  const diff = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--unknown.json', exactExists: true, exactData: { criticName: 'Alice Smith', fullText: REVIEW_B }, variant: null, incomingCritic: 'Unknown', incomingText: TR_TEXT });
  assert.equal(diff.action, 'skip');
});

test('P1-a: named variant + unattributed incoming → merge only with same text, never fill critic', () => {
  const variant = { path: '/d/bt--alice-smith.json', data: { criticName: 'Alice Smith', url: URL, fullText: OUTLET_TEXT } };
  const same = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--unknown.json', exactExists: false, variant, incomingCritic: 'Unknown', incomingText: TR_TEXT });
  assert.deepEqual([same.action, same.fillCritic], ['merge', false]);
  const diff = resolveTheatreRecordWriteTarget({ exactPath: '/d/bt--unknown.json', exactExists: false, variant: { ...variant, data: { ...variant.data, fullText: REVIEW_B } }, incomingCritic: 'Unknown', incomingText: TR_TEXT });
  assert.equal(diff.action, 'create');
});

// ─── P1-b: within-show identical-text duplicate exit ───

test('P1-b: identical URL-bearing twin dropped at the fingerprint exit → carry url onto the kept URL-less match', () => {
  const r = decideDuplicateTwinUrlCarry(dropped({ fullText: TR_TEXT, data: { criticName: 'Vera Liber', url: URL } }), [{ url: null, fullText: TR_TEXT, file: 'bt--vera-liber.json' }], 'bt--vera-liber.json');
  assert.deepEqual([r.carry, r.index, r.url], [true, 0, URL]);
});

test('P1-b: guards — flagged, foreign domain, already-kept, not the fingerprint match, ambiguous, kept has url', () => {
  const kept = [{ url: null, fullText: TR_TEXT, file: 'bt--vera-liber.json' }];
  const d = (o) => dropped({ fullText: TR_TEXT, ...o });
  assert.equal(decideDuplicateTwinUrlCarry(d({ data: { wrongShow: true } }), kept, 'bt--vera-liber.json').carry, false);
  assert.equal(decideDuplicateTwinUrlCarry(d({ urlOwnedByOutlet: false }), kept, 'bt--vera-liber.json').carry, false);
  assert.equal(decideDuplicateTwinUrlCarry(d({ urlAlreadyKept: true }), kept, 'bt--vera-liber.json').carry, false);
  assert.equal(decideDuplicateTwinUrlCarry(d({}), kept, 'bt--someone-else.json').carry, false);
  const two = [...kept, { url: null, fullText: REVIEW_A, file: 'bt--other.json' }];
  assert.equal(decideDuplicateTwinUrlCarry(d({}), two, 'bt--vera-liber.json').reason, 'ambiguous-multiple-urlless');
  assert.equal(decideDuplicateTwinUrlCarry(d({}), [{ url: 'https://x/y', fullText: TR_TEXT, file: 'bt--vera-liber.json' }], 'bt--vera-liber.json').carry, false);
});
