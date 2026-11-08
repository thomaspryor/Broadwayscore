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
