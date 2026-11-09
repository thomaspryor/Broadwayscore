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
  const r2 = gate.recoverReviewText({ filePath: c.filePath, rawText: `${GOOD} A closing line that makes this text longer still.`, labels });
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
