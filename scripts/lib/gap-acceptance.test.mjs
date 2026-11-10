// gap-acceptance.js (BRO-7171): the one gate every review-text recovery route
// goes through. The adapter tests at the bottom drive
// browser-recovery-helpers.processRecoveredText, so they fail on the pre-gate
// helper (which overwrote person-owned records and paywall pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-accept-')));
const SHOWS = path.join(TMP, 'shows.json');
fs.writeFileSync(SHOWS, JSON.stringify([
  { id: 'joe-turners-come-and-gone-2026', title: "Joe Turner's Come and Gone", previewsStartDate: '2026-03-01', openingDate: '2026-03-15' },
  { id: 'equus-off-west-end-2026', title: 'Equus', venue: 'Menier Chocolate Factory', previewsStartDate: '2026-05-08', openingDate: '2026-05-18' },
  { id: 'love-story-off-west-end-2026', title: 'Love Story', venue: 'Hampstead Theatre', openingDate: '2026-04-10', cast: [{ name: 'Jane Smithers' }] },
  { id: 'man-to-man-west-end-2026', title: 'Man to Man', venue: 'Wyndhams Theatre', openingDate: '2026-02-10' },
]));
process.env.SHOWS_JSON_PATH = SHOWS;
process.env.REVIEW_TEXTS_LOCK_PATH = path.join(TMP, 'review-texts.lock');

const gate = require('./gap-acceptance.js');
const { acceptRecoveredText, landedAsRecovered, llmIdentityVerdict, deriveShowTitle } = gate;

const SHOW_ID = 'joe-turners-come-and-gone-2026';
const GOOD = `Joe Turner's Come and Gone returned to the stage this week in a production that finds new urgency in August Wilson's text. `.repeat(30);
const base = (extra = {}) => ({
  showId: SHOW_ID, outletId: 'nytimes', criticName: 'Jesse Green',
  url: 'https://www.nytimes.com/2026/03/16/theater/joe-turners-review.html',
  fullText: 'Short excerpt.', contentTier: 'excerpt', ...extra,
});
const ctx = { showId: SHOW_ID };

test('accepts a longer, on-topic text and reports the tier change', () => {
  const d = acceptRecoveredText(base(), { rawText: GOOD }, ctx);
  assert.equal(d.accept, true, d.reason);
  assert.equal(d.urlChanged, false);
  assert.ok(d.cleanedText.length > 300);
});

test('refuses records a person or a verdict owns', () => {
  assert.equal(acceptRecoveredText(base({ _locked: true }), { rawText: GOOD }, ctx).code, 'locked');
  assert.equal(acceptRecoveredText(base({ manualContentTier: 'excerpt' }), { rawText: GOOD }, ctx).code, 'manual_tier');
  assert.equal(acceptRecoveredText(base({ wrongProduction: true }), { rawText: GOOD }, ctx).code, 'excluded_record');
  assert.equal(acceptRecoveredText(base(), { rawText: GOOD }, { ...ctx, blocklisted: true }).code, 'blocklisted');
});

test('refuses short, paywalled, off-topic and not-longer texts with the old stats phrases', () => {
  const short = acceptRecoveredText(base(), { rawText: 'Joe Turner. Too short.' }, ctx);
  assert.equal(short.code, 'too_short');
  assert.match(short.reason, /too short/);

  const wall = acceptRecoveredText(base(), { rawText: `To read the full review, subscribe now. ${GOOD}` }, ctx);
  assert.equal(wall.code, 'paywall');
  assert.match(wall.reason, /garbage/);

  const other = acceptRecoveredText(base(), { rawText: 'A lovely evening of something else entirely, with no title in sight. '.repeat(10) }, ctx);
  assert.equal(other.code, 'show_not_mentioned');
  assert.match(other.reason, /not mentioned/);

  const notLonger = acceptRecoveredText(base({ fullText: GOOD + ' extra words here.', contentTier: 'complete' }), { rawText: GOOD }, ctx);
  assert.equal(notLonger.code, 'not_longer');
  assert.match(notLonger.reason, /not longer/);

  // same tier, a few characters more (first nightly: 2487 -> 2489): not a recovery
  const tiny = acceptRecoveredText(base({ fullText: GOOD, contentTier: 'complete' }), { rawText: GOOD + ' More.' }, ctx);
  assert.equal(tiny.code, 'not_materially_longer');
});

test('date-implausible publishDate is refused (task #915 class)', () => {
  const show = { id: SHOW_ID, title: "Joe Turner's Come and Gone", previewsStartDate: '2026-03-01', openingDate: '2026-03-15' };
  const d = acceptRecoveredText(base({ publishDate: '2015-04-15' }), { rawText: GOOD }, { ...ctx, show });
  assert.equal(d.code, 'date_implausible');
});

test('a new url needs identity proof: excerpt overlap, or outlet domain + critic named + LLM verdict', () => {
  const newUrl = 'https://www.nytimes.com/2026/03/17/theater/joe-turner-review-moved.html';
  const noProof = acceptRecoveredText(base(), { rawText: GOOD, url: newUrl }, { ...ctx, outletDomains: ['nytimes.com'] });
  assert.equal(noProof.code, 'identity_unproven');
  assert.equal(noProof.urlChanged, true);

  const named = `${GOOD} Review by Jesse Green.`;
  const llm = acceptRecoveredText(base(), { rawText: named, url: newUrl }, { ...ctx, outletDomains: ['nytimes.com'], llmIdentityVerified: true });
  assert.equal(llm.accept, true, llm.reason);

  const offDomain = acceptRecoveredText(base(), { rawText: named, url: 'https://someblog.example/joe-turner' }, { ...ctx, outletDomains: ['nytimes.com'], llmIdentityVerified: true });
  assert.equal(offDomain.code, 'identity_unproven');

  const excerpt = GOOD.slice(0, 240);
  const viaExcerpt = acceptRecoveredText(base({ dtliExcerpt: excerpt }), { rawText: GOOD, url: newUrl }, { ...ctx, outletDomains: [] });
  assert.equal(viaExcerpt.accept, true, viaExcerpt.reason);

  const refused = acceptRecoveredText(base(), { rawText: named, url: newUrl }, { ...ctx, urlChangeRefusal: 'skippedCrossOutletMerge', llmIdentityVerified: true, outletDomains: ['nytimes.com'] });
  assert.equal(refused.code, 'url_change_refused');
});

test('landedAsRecovered catches a write that rolled the text or url back', () => {
  assert.deepEqual(landedAsRecovered({ fullText: 'x', url: 'u' }, { text: 'x', url: 'u' }), { ok: true });
  assert.equal(landedAsRecovered({ fullText: 'old', url: 'u' }, { text: 'x', url: 'u' }).ok, false);
  assert.equal(landedAsRecovered({ fullText: 'x', url: 'old' }, { text: 'x', url: 'u' }).ok, false);
  assert.equal(landedAsRecovered({ fullText: 'x', url: 'u', wrongShow: true }, { text: 'x', url: 'u' }).ok, false);
});

test('llmIdentityVerdict trusts only a confident model verdict with no flags', () => {
  assert.equal(llmIdentityVerdict({ isValid: true, confidence: 'high', verifiedBy: 'claude-opus' }), true);
  assert.equal(llmIdentityVerdict({ isValid: true, confidence: 'medium', verifiedBy: 'claude-opus' }), false);
  assert.equal(llmIdentityVerdict({ isValid: true, confidence: 'high', verifiedBy: 'heuristic' }), false);
  assert.equal(llmIdentityVerdict({ isValid: true, confidence: 'high', verifiedBy: 'x', wrongProduction: true }), false);
  assert.equal(llmIdentityVerdict(null), false);
});

test('deriveShowTitle strips -off-west-end before -west-end', () => {
  assert.equal(deriveShowTitle('360-allstars-off-west-end-2026'), '360 allstars');
  assert.equal(deriveShowTitle('hamlet-west-end-2025'), 'hamlet');
});

// ── Through the browser-recovery adapter (red on the pre-gate helper) ──────

function candidateFile(extra) {
  const dir = fs.mkdtempSync(path.join(TMP, `${SHOW_ID}-`));
  const showDir = path.join(dir, SHOW_ID);
  fs.mkdirSync(showDir);
  const filePath = path.join(showDir, 'nytimes--jesse-green.json');
  fs.writeFileSync(filePath, JSON.stringify(base(extra), null, 2) + '\n');
  return { filePath, showId: SHOW_ID, url: base().url, reviewId: `${SHOW_ID}/nytimes--jesse-green.json` };
}
const LABELS = { fetchMethod: 'test-browser', sourceMethod: 'test-recovery' };

test('adapter: a hand-locked record is never overwritten by a browser recovery', () => {
  const { processRecoveredText } = require('./browser-recovery-helpers.js');
  const c = candidateFile({ _locked: true, manualContentTier: 'excerpt' });
  const before = fs.readFileSync(c.filePath, 'utf8');
  const r = processRecoveredText(c, GOOD, LABELS);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(c.filePath, 'utf8'), before, 'file untouched');
});

test('adapter: a paywall page is not written as recovered text', () => {
  const { processRecoveredText } = require('./browser-recovery-helpers.js');
  const c = candidateFile({});
  const r = processRecoveredText(c, `To read the full review, subscribe now. ${GOOD}`, LABELS);
  assert.equal(r.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(c.filePath, 'utf8')).fullText, 'Short excerpt.');
});

test('a recovery clears the stale dead-candidate stamp, including on a second recovery', () => {
  const c = candidateFile({ contentTier: 'truncated', incompleteReason: 'wrong_content', incompleteDetail: 'nyt-browser-recovery: old stamp' });
  const labels = { fetchMethod: 'test-browser', sourceMethod: 'test-recovery' };
  const r = gate.recoverReviewText({ filePath: c.filePath, rawText: GOOD, labels });
  assert.equal(r.ok, true, r.reason);
  let onDisk = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  assert.equal(onDisk.incompleteReason, undefined, 'merge-mode safeWriteReview must not copy the old stamp back');
  assert.equal(onDisk.incompleteDetail, undefined);
  // Re-stamped dead later, then recovered again: the clear must work again.
  onDisk.incompleteReason = 'bot_blocked';
  fs.writeFileSync(c.filePath, JSON.stringify(onDisk, null, 2) + '\n');
  const r2 = gate.recoverReviewText({ filePath: c.filePath, rawText: `${GOOD} ${REVIEW} ${MORE}`, labels }); // new prose, not a repeated line (Stage 4 novel-prose bar)
  assert.equal(r2.ok, true, r2.reason);
  onDisk = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  assert.equal(onDisk.incompleteReason, undefined);
});

test('adapter: an accepted recovery records priorFullTextHash for rollback', () => {
  const { processRecoveredText } = require('./browser-recovery-helpers.js');
  const c = candidateFile({});
  const r = processRecoveredText(c, GOOD, LABELS);
  assert.equal(r.ok, true, r.reason);
  const onDisk = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  assert.ok(onDisk.fullText.startsWith("Joe Turner's Come and Gone"));
  assert.equal(onDisk.textRecoveryProvenance.priorFullTextHash, gate.sha256('Short excerpt.'));
  assert.equal(onDisk.textRecoveryProvenance.priorContentTier, 'excerpt');
});

test('adapter: the record url moved while the browser fetched the old one: refused, file untouched', () => {
  const { processRecoveredText } = require('./browser-recovery-helpers.js');
  const c = candidateFile({});
  const moved = { ...JSON.parse(fs.readFileSync(c.filePath, 'utf8')), url: 'https://www.nytimes.com/2026/03/20/theater/corrected-url.html' };
  fs.writeFileSync(c.filePath, JSON.stringify(moved, null, 2) + '\n');
  const before = fs.readFileSync(c.filePath, 'utf8');
  const r = processRecoveredText(c, GOOD, LABELS); // c.url is the url the browser loaded
  assert.equal(r.ok, false);
  assert.equal(r.code, 'url_moved_during_fetch');
  assert.equal(fs.readFileSync(c.filePath, 'utf8'), before, 'old-page text not written under the new url');
});

test('a url move stamps the caller urlDiscoveryMethod (and drops a stale one); tracker gets the landing key', () => {
  const { createWriteTracker, landingKey } = require('./review-texts-checkpoint.js');
  const c = candidateFile({ dtliExcerpt: GOOD.slice(0, 240), urlDiscoveryMethod: 'http-redirect' });
  const newUrl = 'https://www.nytimes.com/2026/03/17/theater/joe-turner-review-moved.html';
  const tracker = createWriteTracker();
  const r = gate.recoverReviewText({ filePath: c.filePath, rawText: GOOD, url: newUrl, expectUrl: c.url, labels: { ...LABELS, urlDiscoveryMethod: 'google-serp' }, tracker });
  assert.equal(r.ok, true, r.reason);
  const onDisk = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  assert.equal(onDisk.url, newUrl);
  assert.equal(onDisk.urlDiscoveryMethod, 'google-serp');
  assert.equal(tracker.expected.get(path.resolve(c.filePath)), landingKey(onDisk));

  const c2 = candidateFile({ dtliExcerpt: GOOD.slice(0, 240), urlDiscoveryMethod: 'http-redirect' });
  const r2 = gate.recoverReviewText({ filePath: c2.filePath, rawText: GOOD, url: newUrl.replace('moved', 'moved-2'), labels: LABELS });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(JSON.parse(fs.readFileSync(c2.filePath, 'utf8')).urlDiscoveryMethod, 'test-recovery', 'stale method replaced by the recovery method');
});

test('an invented-url row (fabricatedEntry) whose real review is accepted gets the flag cleared, or the rebuild keeps skipping it (BRO-7171)', () => {
  const c = candidateFile({ fabricatedEntry: true, fabricatedReason: 'Legacy web-search row (BRO-7171): url answered 404', source: 'web-search', httpStatus: 404, dtliExcerpt: GOOD.slice(0, 240) });
  const newUrl = 'https://www.nytimes.com/2026/03/17/theater/joe-turner-review-real.html';
  const r = gate.recoverReviewText({ filePath: c.filePath, rawText: GOOD, url: newUrl, expectUrl: c.url, labels: LABELS });
  assert.equal(r.ok, true, r.reason);
  const onDisk = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  assert.equal(onDisk.url, newUrl);
  assert.equal(onDisk.fabricatedEntry, false, 'merge-mode write must not copy the flag back');
  assert.equal(onDisk.fabricatedReason, null);
  assert.match(onDisk.fabricatedClearedReason, /joe-turner-review-real.*was: Legacy web-search row/);
  // At the invented STORED url, a page proves nothing without the identity
  // rule (review: a Wayback capture of the guessed url could be another critic).
  const c3 = candidateFile({ fabricatedEntry: true, source: 'web-search' });
  const r3 = gate.recoverReviewText({ filePath: c3.filePath, rawText: GOOD, labels: LABELS });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'identity_unproven');
  assert.equal(JSON.parse(fs.readFileSync(c3.filePath, 'utf8')).fabricatedEntry, true);
  // A refused text leaves the flag alone.
  const c2 = candidateFile({ fabricatedEntry: true, source: 'web-search' });
  assert.equal(gate.recoverReviewText({ filePath: c2.filePath, rawText: 'too short', labels: LABELS }).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(c2.filePath, 'utf8')).fabricatedEntry, true);
});

// ── recoverReviewTextVerified: the shared async wrapper (recover-serp-text + gap-recovery driver) ──

test('verified wrapper: dry run at a new url with only the LLM proof missing asks for it, writes nothing', async () => {
  const c = candidateFile({});
  const before = fs.readFileSync(c.filePath, 'utf8');
  const r = await gate.recoverReviewTextVerified({
    filePath: c.filePath, rawText: `${GOOD} Review by Jesse Green.`, url: 'https://www.nytimes.com/2026/03/17/theater/joe-turner-elsewhere.html',
    expectUrl: c.url, labels: LABELS, dryRun: true,
  });
  assert.equal(r.code, 'dry_run_needs_llm');
  assert.equal(fs.readFileSync(c.filePath, 'utf8'), before);
});

test('verified wrapper: live write runs prepareWrite outside the gate and lands its fields', async () => {
  const c = candidateFile({});
  let prepared = 0;
  const r = await gate.recoverReviewTextVerified({
    filePath: c.filePath, rawText: GOOD, url: c.url, expectUrl: c.url, labels: LABELS,
    prepareWrite: async (decision) => { prepared++; assert.ok(decision.cleanedText.length > 300); return (data) => { data.testScoreField = 77; }; },
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(prepared, 1);
  assert.equal(JSON.parse(fs.readFileSync(c.filePath, 'utf8')).testScoreField, 77);
});

test('verified wrapper: a refused text never reaches prepareWrite', async () => {
  const c = candidateFile({});
  let prepared = 0;
  const r = await gate.recoverReviewTextVerified({
    filePath: c.filePath, rawText: 'Too short.', url: c.url, expectUrl: c.url, labels: LABELS,
    prepareWrite: async () => { prepared++; return null; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_short');
  assert.equal(prepared, 0);
});

// BRO-7171 Stage 2b: The Stage's body often never names the show; the page's
// own headline (og:title / h1, never the url) may stand in, for thestage only.
test('headline identity: The Stage page headline names the show -> accepted; other outlets and wrong headlines refused', () => {
  const gt = require('./generic-title-matching.js');
  gt._resetCachesForTest(new Map());
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
    const equus = shows.find((s) => s.id === 'equus-off-west-end-2026');
    const body = 'Powerful and precise revival of Peter Shaffer’s equine psychodrama, staged with real control and a fine central performance. '.repeat(12);
    const rec = (extra = {}) => ({ showId: equus.id, outletId: 'thestage', criticName: 'Holly OMahony', url: 'https://www.thestage.co.uk/reviews/equus-review-menier', fullText: 'Short.', contentTier: 'excerpt', ...extra });
    const c = { showId: equus.id, show: equus };
    const html = '<html><head><meta property="og:title" content="Equus review at the Menier Chocolate Factory, London"></head><body><h1>x</h1></body></html>';
    const headline = gate.pageHeadline(html);
    assert.equal(headline, 'Equus review at the Menier Chocolate Factory, London');
    assert.equal(gate.pageHeadline('<h1 class="t">Hamlet <em>review</em></h1>'), 'Hamlet review');

    const ok = acceptRecoveredText(rec(), { rawText: body, headline }, c);
    assert.equal(ok.accept, true, ok.reason);
    // The page evidence is carried out of the gate so the write can persist it; the weekly
    // show-mention backfill (evaluateShowMentionGuard) honours it instead of re-flagging the
    // body that omits the title (ship-check P1, BRO-7171 Stage 2b).
    assert.equal(ok.identityHeadline, headline);
    const { evaluateShowMentionGuard } = require('./review-guards.js');
    const longBody = 'word '.repeat(400);
    const noTitle = { valid: false, confidence: 'high', reason: 'show title not found in text' };
    assert.equal(evaluateShowMentionGuard({}, longBody, 400, noTitle).action, 'null-text', 'without the field the guard flags');
    assert.equal(evaluateShowMentionGuard({ showIdentityHeadline: headline }, longBody, 400, noTitle).action, 'skip');
    // no headline, wrong-show headline, or another outlet: still refused
    assert.equal(acceptRecoveredText(rec(), { rawText: body }, c).code, 'show_not_mentioned');
    const wrong = acceptRecoveredText(rec(), { rawText: body, headline: 'Hamlet review at Shakespeare’s Globe, London' }, c);
    assert.equal(wrong.code, 'show_not_mentioned');
    assert.match(wrong.reason, /does not name the show/);
    assert.equal(acceptRecoveredText(rec({ outletId: 'guardian' }), { rawText: body, headline }, c).code, 'show_not_mentioned');
    // whole-phrase match, not a loose substring: "Man to Man" is not in "Mansfield to Manchester"
    const mtm = shows.find((s) => s.id === 'man-to-man-west-end-2026');
    const mtmRec = rec({ showId: mtm.id, url: 'https://www.thestage.co.uk/reviews/x' });
    assert.equal(acceptRecoveredText(mtmRec, { rawText: body, headline: 'Mansfield to Manchester review' }, { showId: mtm.id, show: mtm }).code, 'show_not_mentioned');
    assert.equal(acceptRecoveredText(mtmRec, { rawText: body, headline: 'Man to Man review at Wyndham’s Theatre' }, { showId: mtm.id, show: mtm }).accept, true);
    // The Stage brackets part of a title ("Tartuffe (Remixed)"); normalizeTitle drops bracketed
    // text, so the headline is also read with the brackets unwrapped (2b pilot false refusal).
    const tr = { ...mtm, id: 'tartuffe-remixed-off-west-end-2026', title: 'Tartuffe Remixed' };
    const trRec = rec({ showId: tr.id, url: 'https://www.thestage.co.uk/reviews/y' });
    assert.equal(acceptRecoveredText(trRec, { rawText: body, headline: 'Tartuffe (Remixed) at Marylebone Theatre: The cast radiates' }, { showId: tr.id, show: tr }).accept, true);
    assert.equal(acceptRecoveredText(trRec, { rawText: body, headline: 'Tartuffe at the National Theatre (review)' }, { showId: tr.id, show: tr }).code, 'show_not_mentioned', 'plain Tartuffe is another show');
  } finally { gt._resetCachesForTest(null); }
});

test('headline identity keeps the generic-title gate: a generic title needs venue/cast/creative in the headline', () => {
  const gt = require('./generic-title-matching.js');
  gt._resetCachesForTest(new Map([['love', 12], ['story', 12]]));
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
    const ls = shows.find((s) => s.id === 'love-story-off-west-end-2026');
    const body = 'A tender two-hander that earns its tears, with a warm central performance and smart staging throughout. '.repeat(12);
    const rec = { showId: ls.id, outletId: 'thestage', criticName: 'Sam Marlowe', url: 'https://www.thestage.co.uk/reviews/ls', fullText: 'Short.', contentTier: 'excerpt' };
    const c = { showId: ls.id, show: ls };
    const bare = acceptRecoveredText(rec, { rawText: body, headline: 'Love Story review: a sweet romance' }, c);
    assert.equal(bare.code, 'show_not_mentioned');
    assert.match(bare.reason, /generic-title-uncorroborated/);
    const withVenue = acceptRecoveredText(rec, { rawText: body, headline: 'Love Story review at Hampstead Theatre, London' }, c);
    assert.equal(withVenue.accept, true, withVenue.reason);
  } finally { gt._resetCachesForTest(null); }
});

test('pageHeadline keeps apostrophes inside a double-quoted og:title', () => {
  const { pageHeadline } = require('./gap-acceptance.js');
  assert.equal(pageHeadline('<meta property="og:title" content="Peter Shaffer\'s Equus review">'), "Peter Shaffer's Equus review");
  assert.equal(pageHeadline("<meta content='A \"quoted\" title' property='og:title'>"), 'A "quoted" title');
});

// BRO-7171 Stage 4: same-tier gains must be new PROSE. Fixtures shaped on real
// accepts from the first nightly (londonlivinglarge listing block, Guardian
// related headline, Islington Tribune related-articles teaser).
const REVIEW = [
  "Joe Turner's Come and Gone opens in a Pittsburgh boarding house where every lodger is waiting for someone who may never come back.",
  'The director keeps the long first act at a low simmer, so that when Herald Loomis finally breaks the floorboards seem to give way under the whole audience.',
  'Seth and Bertha argue about biscuits and rent with the ease of a couple who have rehearsed the same quarrel for twenty years.',
  'Bynum, the conjure man, is played with a sly, unhurried warmth that makes his talk of binding songs sound like plain common sense.',
].join(' ');
const MORE = [
  'The second act belongs to Loomis, whose search for his wife has hardened into something closer to a curse than a hope.',
  'When he finally stands in the doorway with Martha, the reunion the play has promised all evening turns out to be a release rather than a homecoming.',
  'It is a demanding, generous evening, and the cast never lets the poetry of the text harden into speechifying.',
].join(' ');
const LISTING = 'Joe Turner’s Come and Gone Barrymore Theatre | Mar 1 - Jun 21, 2026 Get link Facebook X Pinterest Email Other Apps (c) Photo by Joan Marcus Tue - Sat: 7 pm, Wed & Sat: 2 pm Barrymore Theatre Nearest station: 50 St Map & Location: 243 W 47th St, New York, NY 10036 March Activities April Activities Theatre Get link Facebook X Pinterest Email Other Apps';
const RELATED = 'Share this story Categories Theatre Related articles Canonbury low traffic neighbourhood plans continue to divide residents and businesses as the council prepares a final consultation on the scheme next month';

test('novel prose: a chrome or related-article gain is not prose; new review paragraphs are', () => {
  assert.equal(gate.novelProseChars(REVIEW, `${REVIEW} ${LISTING}`), 0);
  assert.equal(gate.novelProseChars(REVIEW, `${REVIEW} ${RELATED}`), 0);
  assert.equal(gate.novelProseChars(REVIEW, `${REVIEW} Giant step back in elections: Trump says he was only kidding.`), 0);
  assert.ok(gate.novelProseChars(REVIEW, `${REVIEW} ${MORE}`) >= 300);
});

test('same-tier refetch that only gains page chrome is refused; one that gains the missing paragraphs is accepted', () => {
  const prior = base({ fullText: REVIEW, contentTier: 'truncated' });
  const chrome = acceptRecoveredText(prior, { rawText: `${REVIEW} ${LISTING} ${RELATED}` }, ctx);
  assert.equal(chrome.code, 'not_materially_longer', chrome.reason);
  const real = acceptRecoveredText(prior, { rawText: `${REVIEW} ${MORE}` }, ctx);
  assert.equal(real.accept, true, real.reason);
});

test('ship-check: a tier-up made of chrome is refused too, and the rollback uses the same bar', () => {
  // real shape: londonpubtheatres accepts gained an iubenda cookie banner that
  // ends in a full stop, so the "truncated" file classified complete.
  const cut = `${REVIEW} London pub theatres magazine is published in Rickmansworth by London Pub Theatres Magazine Ltd ISSN 2977-6724`;
  const banner = 'We and selected third parties use cookies or similar technologies for technical purposes and, with your consent, for other purposes as specified in the cookie policy . Use the “Accept” button to consent. Use the “Reject” button to continue without accepting.';
  const prior = base({ fullText: cut, contentTier: 'truncated' });
  const d = acceptRecoveredText(prior, { rawText: `${cut}\n\n${banner}` }, ctx);
  assert.equal(d.code, 'not_materially_longer', d.reason);
  // a real ending still passes on a tier-up
  assert.equal(acceptRecoveredText(prior, { rawText: `${cut} ${MORE}` }, ctx).accept, true);
  const v = gate.novelProseVerdict(cut, `${cut}\n\n${banner}`);
  assert.equal(v.ok, false);
  const { chromeRollbackDecision } = require('./gap-rollback.js');
  const src = require('node:fs').readFileSync(new URL('./gap-rollback.js', import.meta.url), 'utf8');
  assert.match(src, /novelProseVerdict\(prior\.fullText, current\.fullText\)/);
  assert.equal(typeof chromeRollbackDecision, 'function');
});

test('show-mention uses the shows.json title, not the slug (tour / punctuated titles, Stage 4 WaPo batch)', () => {
  const show = { id: 'life-of-pi-tour-2024', title: 'Life of Pi', openingDate: '2024-12-20' };
  const body = 'Life of Pi arrives at the Kennedy Center with its tiger puppet intact, and the touring company finds real wonder in the lifeboat scenes. '.repeat(6);
  const rec = { showId: show.id, outletId: 'washpost', criticName: 'Chris Klimek', url: 'https://www.washingtonpost.com/x/life-of-pi-tour-kennedy-center-review/', fullText: 'Short.', contentTier: 'excerpt' };
  assert.equal(deriveShowTitle(show.id), 'life of pi tour', 'the slug form no review prints');
  const d = acceptRecoveredText(rec, { rawText: body }, { showId: show.id, show });
  assert.equal(d.accept, true, d.reason);
  // without the shows.json entry the slug fallback still applies
  assert.equal(acceptRecoveredText(rec, { rawText: body }, { showId: show.id }).code, 'show_not_mentioned');
});

// BRO-7171 owner challenge 2026-11-09: 463 no-url reviews hold Theatre Record
// print text; Telegraph / Mail bodies never print the critic's name, so the
// outlet-domain + critic + LLM proof could never pass. The stored print text
// inside the found page proves it is the same article.
test('identity: stored Theatre Record / no-url text inside the new page proves the review', () => {
  const para = (n) => Array.from({ length: n }, (_, i) => `Sentence ${i} about Vanessa Kirby and the production of Julie at the Lyttelton, scene ${i * 7} turns sour.`).join(' ');
  const prior = para(10); // ~900 chars of print text
  const page = `${para(10)} ${Array.from({ length: 25 }, (_, i) => `Further paragraph ${i} on design, music and the ending that lands ${i} ways.`).join(' ')}`;
  const tr = { showId: 'julie-west-end-2018', outletId: 'telegraph', criticName: 'Dominic Cavendish', url: null, source: 'theatre-record', fullText: prior };
  const ok = gate.proveIdentity(tr, page, 'https://www.telegraph.co.uk/theatre/what-to-see/julie/', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' });
  assert.equal(ok.proven, true);
  assert.match(ok.via, /stored theatre-record text/);
  // a different article does not cover the stored text
  const other = Array.from({ length: 40 }, (_, i) => `Unrelated line ${i} about a football match and weather ${i}.`).join(' ');
  assert.equal(gate.proveIdentity(tr, other, 'https://www.telegraph.co.uk/sport/x/', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, false);
  // text fetched from a web url (not print) is not trusted as a fingerprint
  const web = { ...tr, url: 'https://www.telegraph.co.uk/old/', source: 'web-search' };
  assert.equal(gate.proveIdentity(web, page, 'https://www.telegraph.co.uk/theatre/what-to-see/julie/', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, false);
  // a pull quote is too short to be a fingerprint
  assert.equal(gate.proveIdentity({ ...tr, fullText: prior.slice(0, 200) }, page, 'https://www.telegraph.co.uk/theatre/what-to-see/julie/', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, false);
});

test('identity: a Theatre Record scan polluted by a neighbouring column still proves the review (real Julie case, coverage 0.41)', () => {
  const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}${i % 97}x${Math.floor(i / 97)}`).join(' ');
  const review = words('kirby', 120);
  const neighbour = words('othercritic', 150); // another review merged in by the scan
  const tr = { showId: 'julie-west-end-2018', outletId: 'telegraph', criticName: 'Dominic Cavendish', url: null, source: 'theatre-record', fullText: `${review} theatre record 01 30 june 2018 ${neighbour}` };
  const page = `${review} ${words('rest', 900)}`;
  const r = gate.proveIdentity(tr, page, 'https://www.telegraph.co.uk/theatre/what-to-see/julie/', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' });
  assert.equal(r.proven, true, JSON.stringify(r));
  assert.match(r.via, /shared 5-word runs/);
  // a page sharing a short pull quote only is not proof
  const quote = `${words('kirby', 20)} ${words('rest', 900)}`;
  assert.equal(gate.proveIdentity(tr, quote, 'https://www.telegraph.co.uk/theatre/what-to-see/julie/', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, false);
  // the relaxed bar is for print scans only, not a no-url web text
  assert.equal(gate.proveIdentity({ ...tr, source: 'manual' }, page, 'https://www.telegraph.co.uk/theatre/what-to-see/julie/', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, false);
});

test('identity: stored text never proves a page off the outlet site, owned by another show, or from a once-web no-url file (review 2026-11-10)', () => {
  const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}${i % 97}x${Math.floor(i / 97)}`).join(' ');
  const review = words('kirby', 150);
  const tr = { showId: 'julie-west-end-2018', outletId: 'telegraph', criticName: 'Dominic Cavendish', url: null, source: 'theatre-record', fullText: review };
  const page = `${review} ${words('rest', 900)}`;
  const tel = 'https://www.telegraph.co.uk/theatre/what-to-see/julie/';
  assert.equal(gate.proveIdentity(tr, page, tel, { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, true);
  // a copy on another site (SERP is not host-limited)
  assert.equal(gate.proveIdentity(tr, page, 'https://www.pressreader.com/uk/x/julie', { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, false);
  // another show's file already holds this url
  assert.equal(gate.proveIdentity(tr, page, tel, { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish', crossShowOwners: [{ showId: 'miss-julie-2003', file: 'telegraph--x.json' }] }).proven, false);
  // a no-url file whose text came from a web page (url later dropped) is no fingerprint
  for (const source of ['web-search', 'outlet-serp-discovery', 'ingest-urls']) {
    assert.equal(gate.proveIdentity({ ...tr, source }, page, tel, { outletDomains: ['telegraph.co.uk'], pageByline: 'Dominic Cavendish' }).proven, false, source);
  }
});

// Ship-check P0 (2026-11-10): a scan merges the neighbouring column, so a page
// holding ONLY the neighbour's review (same domain: telegraph and
// sunday-telegraph share telegraph.co.uk) covered 0.54 of the stored text and
// was "proven". The page's own byline must name this critic.
test('identity: the neighbouring critic\'s page is not proven by a merged scan; the page byline must name the critic', () => {
  const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}${i % 97}x${Math.floor(i / 97)}`).join(' ');
  const mine = words('walker', 120);
  const neighbour = words('cavendish', 150);
  const tr = { showId: 'passion-play-west-end-2013', outletId: 'sunday-telegraph', criticName: 'Tim Walker', url: null, source: 'theatre-record', fullText: `${mine} theatre record ${neighbour}` };
  const neighbourPage = `${neighbour} ${words('rest', 600)}`;
  const tel = 'https://www.telegraph.co.uk/culture/theatre/x/';
  const dom = { outletDomains: ['telegraph.co.uk'] };
  assert.equal(gate.proveIdentity(tr, neighbourPage, tel, { ...dom, pageByline: 'Dominic Cavendish' }).proven, false, 'another critic\'s byline');
  assert.equal(gate.proveIdentity(tr, neighbourPage, tel, dom).proven, false, 'no byline on the page');
  const minePage = `${mine} ${words('rest', 600)}`;
  assert.equal(gate.proveIdentity(tr, minePage, tel, { ...dom, pageByline: 'Tim Walker' }).proven, true);
  // the byline is read from the page html (JSON-LD author)
  assert.equal(gate.pageByline('<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Tim Walker"}}</script>', 'sunday-telegraph'), 'Tim Walker');
});

test('page date: a later revival\'s review is refused for a closed old production (macbeth-1982 <- 2022 page)', () => {
  const macbeth = { id: 'macbeth-1982', title: 'Macbeth', openingDate: '1982-01-28', closingDate: '1982-02-14', status: 'closed' };
  const rec = { showId: 'macbeth-1982', outletId: 'nypost', criticName: 'Johnny Oleksinski', url: null };
  assert.match(gate.pageDateRefusal('2022-04-29', rec, macbeth), /after the show closed/);
  assert.equal(gate.pageDateRefusal('1982-01-29', rec, macbeth), null);
  assert.equal(gate.pageDateRefusal(null, rec, macbeth), null);
  // a declared prior run / a still-running show is not refused
  assert.equal(gate.pageDateRefusal('2022-04-29', rec, { ...macbeth, status: 'open' }), null);
  // and the page date reaches the gate
  const body = Array.from({ length: 30 }, (_, i) => `Macbeth scene ${i} at the Longacre turns ${i * 3} ways, Daniel Craig act ${i}.`).join(' ');
  const d = acceptRecoveredText({ ...rec, fullText: 'short' }, { rawText: body, url: 'https://nypost.com/2022/04/29/macbeth-broadway-review/', pageDate: '2022-04-29' },
    { showId: 'macbeth-1982', show: macbeth, outletDomains: ['nypost.com'] });
  assert.equal(d.code, 'date_implausible');
  // the page's own html date is read (JSON-LD), never the url
  assert.equal(gate.pagePublishDate('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2022-04-29T15:00:00Z"}</script>', 'https://x.com/a'), '2022-04-29');
});

test('surname: run-together scan names split (AndrzejLukowski -> Lukowski); real names untouched', () => {
  assert.equal(gate.surnameOf('AndrzejLukowski'), 'Lukowski');
  assert.equal(gate.surnameOf('MichaelArditti'), 'Arditti');
  assert.equal(gate.surnameOf('Dominic Cavendish'), 'Cavendish');
  assert.equal(gate.surnameOf('Ian McKellen'), 'McKellen');
  assert.equal(gate.surnameOf('Charles McNulty (LA Times)'), 'McNulty');
});

test('a no-url print record gets its first proven url even when the page adds few characters (Nine Night +19, Strictly Ballroom +49)', () => {
  const body = Array.from({ length: 30 }, (_, i) => `Joe Turner's Come and Gone scene ${i} finds August Wilson's boarders ${i * 3} ways to wait, and act ${i} lands.`).join(' ');
  const rec = { showId: SHOW_ID, outletId: 'nytimes', criticName: 'Jesse Green', url: null, source: 'theatre-record', fullText: body, contentTier: 'complete' };
  const url = 'https://www.nytimes.com/2026/03/16/theater/joe-turners-review.html';
  const c = { ...ctx, outletDomains: ['nytimes.com'] };
  const d = acceptRecoveredText(rec, { rawText: `${body} Through Sunday.`, url, pageByline: 'Jesse Green' }, c);
  assert.equal(d.accept, true, d.reason);
  assert.match(d.reason, /first url for a no-url record/);
  // a record that already has a url still needs a material gain
  const has = acceptRecoveredText({ ...rec, url }, { rawText: `${body} Through Sunday.`, url, pageByline: 'Jesse Green' }, c);
  assert.equal(has.code, 'not_materially_longer');
  // and the first url still has to be proven (another site, same text)
  assert.equal(acceptRecoveredText(rec, { rawText: `${body} Through Sunday.`, url: 'https://copy.example.com/x', pageByline: 'Jesse Green' }, c).code, 'identity_unproven');
});

// BRO-7171 item (b): the collector's SERP discovery cleared fabricatedEntry the
// moment a search result came back, before any fetch or identity proof. The
// clear now goes through the same identity proof as acceptRecoveredText.
test('fabricatedFlagClearDecision: an invented-url flag clears only on the gap-acceptance identity proof (BRO-7171)', () => {
  assert.equal(typeof gate.fabricatedFlagClearDecision, 'function');
  const realUrl = 'https://www.nytimes.com/2026/03/16/theater/joe-turner-review-real.html';
  const named = `${GOOD} Review by Jesse Green.`;
  // excerpt coverage proves it
  const c1 = candidateFile({ fabricatedEntry: true, source: 'web-search', url: null, dtliExcerpt: GOOD.slice(0, 240) });
  const pre1 = JSON.parse(fs.readFileSync(c1.filePath, 'utf8'));
  const d1 = gate.fabricatedFlagClearDecision({ filePath: c1.filePath, preDiscovery: pre1, fetchedText: GOOD, url: realUrl, llmVerified: false });
  assert.equal(d1.clear, true, JSON.stringify(d1));
  assert.match(d1.via, /excerpt coverage/);
  // outlet domain + critic named + LLM verdict proves it
  const c2 = candidateFile({ fabricatedEntry: true, source: 'web-search', url: null });
  const pre2 = JSON.parse(fs.readFileSync(c2.filePath, 'utf8'));
  assert.equal(gate.fabricatedFlagClearDecision({ filePath: c2.filePath, preDiscovery: pre2, fetchedText: named, url: realUrl, llmVerified: true }).clear, true);
  // ... but not without the LLM verdict, not off the outlet's domain, not unnamed
  assert.equal(gate.fabricatedFlagClearDecision({ filePath: c2.filePath, preDiscovery: pre2, fetchedText: named, url: realUrl, llmVerified: false }).clear, false);
  assert.equal(gate.fabricatedFlagClearDecision({ filePath: c2.filePath, preDiscovery: pre2, fetchedText: named, url: 'https://someblog.example/joe-turner', llmVerified: true }).clear, false);
  assert.equal(gate.fabricatedFlagClearDecision({ filePath: c2.filePath, preDiscovery: pre2, fetchedText: GOOD, url: realUrl, llmVerified: true }).clear, false);
  // not flagged: nothing to decide
  assert.equal(gate.fabricatedFlagClearDecision({ filePath: c2.filePath, preDiscovery: { ...pre2, fabricatedEntry: false }, fetchedText: named, url: realUrl, llmVerified: true }).clear, false);
});

// Second-opinion P1 (2026-11-10): the decision ran only proveIdentity and
// ignored the refusals acceptRecoveredText checks first. Excerpt coverage alone
// then cleared the flag on a url another critic's file already owns.
test('fabricatedFlagClearDecision applies the url-change and date refusals before the identity proof', () => {
  const realUrl = 'https://www.nytimes.com/2026/03/16/theater/joe-turner-review-real.html';
  const c = candidateFile({ fabricatedEntry: true, source: 'web-search', url: null, dtliExcerpt: GOOD.slice(0, 240) });
  const pre = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  // another critic's file in the same show already holds this url
  fs.writeFileSync(path.join(path.dirname(c.filePath), 'nytimes--maya-phillips.json'),
    JSON.stringify(base({ criticName: 'Maya Phillips', url: realUrl }), null, 2) + '\n');
  const owned = gate.fabricatedFlagClearDecision({ filePath: c.filePath, preDiscovery: pre, fetchedText: GOOD, url: realUrl, llmVerified: true });
  assert.equal(owned.clear, false, JSON.stringify(owned));
  assert.match(owned.reason, /url change refused/);
  // a page dated years before the production
  const c3 = candidateFile({ fabricatedEntry: true, source: 'web-search', url: null, dtliExcerpt: GOOD.slice(0, 240) });
  const pre3 = JSON.parse(fs.readFileSync(c3.filePath, 'utf8'));
  const oldHtml = '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2009-04-17T15:00:00Z"}</script>';
  const dated = gate.fabricatedFlagClearDecision({ filePath: c3.filePath, preDiscovery: pre3, fetchedText: GOOD, url: realUrl, html: oldHtml, llmVerified: true });
  assert.equal(dated.clear, false, JSON.stringify(dated));
  assert.match(dated.reason, /date implausible/);
});

// Class guard (BRO-7171 item b): an invented-url flag clears ONLY behind the
// gap-acceptance identity proof. Any new writer that sets it false/undefined/
// null or deletes it fails here until it routes through fabricatedFlagClearDecision
// or acceptRecoveredText.
test('class guard: fabricatedEntry is cleared only behind the identity proof', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const ALLOWED = new Map([
    ['lib/gap-acceptance.js', ['data.fabricatedEntry = false;']],
    ['collect-review-texts.js', ['review.fabricatedEntry = false; // prevent re-triggering SERP on retry', 'post.fabricatedEntry = false;']],
  ]);
  const CLEAR = /fabricatedEntry\s*:\s*(undefined|false|null)\b|\.fabricatedEntry\s*=\s*(undefined|false|null)\b|delete\s+[\w.[\]'"]+\.fabricatedEntry\b|\[['"]fabricatedEntry['"]\]\s*=\s*(undefined|false|null)\b/;
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'fixtures', '__fixtures__'].includes(e.name)) walk(p); continue; }
      if (!/\.(c?js|mjs|ts)$/.test(e.name) || /\.test\.|test-/.test(e.name)) continue;
      const rel = path.relative(root, p);
      const allow = ALLOWED.get(rel) || [];
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (CLEAR.test(line) && !allow.includes(line.trim())) bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
  const collector = fs.readFileSync(path.join(root, 'collect-review-texts.js'), 'utf8');
  assert.ok(collector.includes('fabricatedFlagClearDecision('), 'collector clear must go through fabricatedFlagClearDecision');
  assert.ok(collector.includes('post.fabricatedEntry === true && post.url === review.url'),
    'collector clears only when the stored url is the proven one (the invariant can refuse the move)');
});

// BRO-7171 item (a): a review excluded on a saved error page is recovered, and
// the write voids the verdicts with the errorPageVerdictVoid breadcrumb.
test('recoverReviewText: real text replacing a saved error page voids the verdicts judged on it (BRO-7171)', async () => {
  const USAT_404 = 'Page Not Found (404) | USA TODAY Skip to main content Home U.S. Sports Entertainment Life Money Tech Travel Opinion '
    + 'Sorry, we can\'t find the page you are looking for. '.repeat(3);
  const c = candidateFile({ fullText: USAT_404, contentTier: 'invalid', isNonReview: true, nonReviewType: 'news', nonReviewClassifiedBy: 'gemini', wrongShow: true, wrongShowReason: '404 page - not a review' });
  const pre = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  assert.equal(acceptRecoveredText(pre, { rawText: GOOD }, ctx).accept, true);
  const r = await gate.recoverReviewTextVerified({ filePath: c.filePath, rawText: GOOD, url: c.url, expectUrl: c.url, labels: LABELS, show: null, ctxOpts: {} });
  assert.equal(r.ok, true, `${r.code} ${r.reason}`);
  const onDisk = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
  assert.equal(onDisk.isNonReview, null);
  assert.equal(onDisk.wrongShow, null);
  assert.equal(onDisk.errorPageVerdictVoid.prior.isNonReview, true);
  assert.equal(onDisk.errorPageVerdictVoid.prior.wrongShowReason, '404 page - not a review');
  // a non-body verdict still refuses
  const keep = candidateFile({ fullText: USAT_404, contentTier: 'invalid', wrongProduction: true, wrongProductionNote: 'Cross-market: US outlet reviewing London show' });
  assert.equal(acceptRecoveredText(JSON.parse(fs.readFileSync(keep.filePath, 'utf8')), { rawText: GOOD }, ctx).code, 'excluded_record');
});
