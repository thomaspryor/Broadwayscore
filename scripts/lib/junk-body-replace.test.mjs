// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6747: a clean refetch replaces a stored body that is a page dump (a cookie
// banner glued to the article, or a raw HTML document), lifts the old body's
// ensemble rejection, and moves a wrong-outlet junk file to its right slot.
// Fixtures are synthetic (invented prose): review text is copyrighted.
// Run: node --test scripts/lib/junk-body-replace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { junkBodyReason, isCleanReplacementForJunk } = require('./junk-body.js');

const SHOW = 'synthetic-show-west-end-2026';
const URL1 = 'https://www.whatsonstage.com/news/synthetic-show-at-example-theatre-review_100001/';
const BANNER = [
  'We value your privacy and use cookies to personalise content.',
  'By clicking accept you give consent to all cookies and tracking technologies.',
  'Our partners and vendors process your IP address and device characteristics.',
  'You can opt out of personalised advertising in your privacy settings.',
  'Third parties may build advertising profiles under legitimate interest.',
  'Read our privacy policy and data protection notice for your choices.',
  'Some vendors rely on consent, others on legitimate interest, for data processing.',
  'Manage cookies and GDPR preferences at any time.',
  'Cookies help our third party partners measure personalised content.',
  'Your consent choices apply across our vendors and partners.',
].join(' ');
const ARTICLE = 'The staging of this invented musical is brisk and the lead performance carries the evening with real warmth. '
  + 'The score leans on repetition, and the second act loses its shape before a late recovery. '
  + 'The design is handsome and the band sits well in the mix, though the book never earns its final turn. '
  + 'A mixed but watchable night at the theatre, with a few songs that stay in the head. '.repeat(14);
const HTML = '<!DOCTYPE html><html><head><title>x</title></head><body>'
  + '<div class="a"><span>menu</span><a href="/x">link</a></div>'.repeat(400) + '</body></html>';

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6747-'));
  fs.mkdirSync(path.join(dir, SHOW));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, SHOW, name), JSON.stringify({ showId: SHOW, ...data }, null, 2));
  }
  return dir;
}
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, SHOW, name), 'utf8'));

test('detector: banner and raw HTML are junk, an article is not', () => {
  assert.equal(junkBodyReason(BANNER + ' ' + ARTICLE), 'consent-banner');
  assert.equal(junkBodyReason(HTML), 'raw-html');
  assert.equal(junkBodyReason(ARTICLE), null);
  assert.equal(isCleanReplacementForJunk(BANNER + ARTICLE, ARTICLE), true);
  assert.equal(isCleanReplacementForJunk(ARTICLE, ARTICLE + ' More words follow here.'), false, 'clean never replaced by clean');
  assert.equal(isCleanReplacementForJunk(BANNER + ARTICLE, BANNER), false, 'junk never replaces junk');
});

test('a clean refetch replaces a banner-prefixed body and voids the old ensemble rejection', () => {
  const name = 'whatsonstage--jane-doe.json';
  const dir = setup({ [name]: {
    outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, publishDate: '2026-03-11',
    fullText: BANNER + ' ' + ARTICLE, contentTier: 'complete', textFetchedAt: '2026-04-19T18:27:07.386Z',
    rejectionReason: null, rejectedAt: '2026-04-27T09:50:18.718Z', rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: primarily cookie consent forms',
    llmScore: { score: 56 }, ensembleData: { claudeScore: 42 }, assignedScore: 56, scoreSource: 'llm-ensemble',
  } });
  const input = { outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, source: 'ingest-urls', fields: { fullText: ARTICLE } };
  createOrMergeReviewFile(SHOW, { ...input }, { reviewTextsDir: dir });
  assert.equal(read(dir, name).fullText, BANNER + ' ' + ARTICLE, 'plain merges still never overwrite a body');
  createOrMergeReviewFile(SHOW, { ...input, replaceBadBody: true }, { reviewTextsDir: dir });
  const d = read(dir, name);
  assert.equal(d.fullText, ARTICLE);
  assert.equal(d.rejectedAt, null);
  assert.equal(d.rejectedBy, null);
  assert.equal(d.rejectionReasoning, null);
  assert.equal(d.llmScore, null, 'score from the old body is parked');
  assert.equal(d.needsRescore, true, 'pipeline rescoring is requested');
});

test('a real stored review is never swapped, and a human rejection survives', () => {
  const name = 'whatsonstage--jane-doe.json';
  const real = ARTICLE + ' The closing number is a showstopper for those who like that sort of thing.';
  const dir = setup({ [name]: {
    outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, publishDate: '2026-03-11',
    fullText: real, contentTier: 'complete',
  } });
  createOrMergeReviewFile(SHOW, { outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, replaceBadBody: true, fields: { fullText: ARTICLE } }, { reviewTextsDir: dir });
  assert.equal(read(dir, name).fullText, real);

  const dir2 = setup({ [name]: {
    outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, publishDate: '2026-03-11',
    fullText: BANNER + ' ' + ARTICLE, contentTier: 'complete', textFetchedAt: '2026-04-19T18:27:07.386Z',
    rejectionReason: 'wrong_production', rejectedAt: '2026-04-27T09:50:18.718Z', rejectedBy: 'manual-triage-bro-71',
  } });
  createOrMergeReviewFile(SHOW, { outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, replaceBadBody: true, fields: { fullText: ARTICLE } }, { reviewTextsDir: dir2 });
  const d = read(dir2, name);
  assert.equal(d.fullText, ARTICLE);
  assert.equal(d.rejectedBy, 'manual-triage-bro-71', 'human verdict untouched');
});

test('raw-HTML body filed under the wrong outlet moves to the right slot with the clean text', () => {
  const url = 'https://1minutecritic.com/synthetic-review-cost-n-mayor/';
  const wrong = 'broadway-blog--jane-doe.json';
  const dir = setup({ [wrong]: {
    outletId: 'broadway-blog', outlet: 'Broadway Blog', criticName: 'Jane Doe', url, publishDate: '2026-10-01',
    fullText: HTML, contentTier: 'invalid', rejectionReason: 'garbage_text', rejectedBy: 'ensemble-scoreability-check',
    rejectedAt: '2026-10-02T00:00:00.000Z',
  } });
  createOrMergeReviewFile(SHOW, { outletId: 'one-minute-critic', outlet: '1 Minute Critic', criticName: 'Jane Doe', url, source: 'ingest-urls', replaceBadBody: true, fields: { fullText: ARTICLE } }, { reviewTextsDir: dir });
  const files = fs.readdirSync(path.join(dir, SHOW)).sort();
  assert.deepEqual(files, ['one-minute-critic--jane-doe.json'], 'one file for the url, in the right slot');
  const d = read(dir, 'one-minute-critic--jane-doe.json');
  assert.equal(d.outletId, 'one-minute-critic');
  assert.equal(d.fullText, ARTICLE);
  assert.equal(d.rejectionReason, null);
});

test('a teaser never replaces a banner-prefixed body that holds the full article', () => {
  const teaser = ARTICLE.slice(0, 340);
  assert.equal(isCleanReplacementForJunk(BANNER + ' ' + ARTICLE, teaser), false);
  assert.equal(isCleanReplacementForJunk(BANNER + ' ' + ARTICLE, ARTICLE), true);
});

test('an unrejected junk body still has its old score parked and a rescore requested', () => {
  const name = 'whatsonstage--jane-doe.json';
  const dir = setup({ [name]: {
    outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, publishDate: '2026-03-11',
    fullText: BANNER + ' ' + ARTICLE, contentTier: 'complete', textFetchedAt: '2026-04-19T18:27:07.386Z',
    llmScore: { score: 40 }, ensembleData: { claudeScore: 40 }, assignedScore: 40, scoreSource: 'llm-ensemble',
  } });
  createOrMergeReviewFile(SHOW, { outletId: 'whatsonstage', outlet: 'WhatsOnStage', criticName: 'Jane Doe', url: URL1, replaceBadBody: true, fields: { fullText: ARTICLE } }, { reviewTextsDir: dir });
  const d = read(dir, name);
  assert.equal(d.fullText, ARTICLE);
  assert.equal(d.llmScore, null);
  assert.equal(d.needsRescore, true);
});

test('relocation skips a different critic or a human-flagged sibling', () => {
  const url = 'https://1minutecritic.com/synthetic-review-two/';
  const dir = setup({
    'broadway-blog--other-person.json': { outletId: 'broadway-blog', criticName: 'Other Person', url, fullText: HTML, contentTier: 'invalid' },
    'broadway-blog--jane-doe.json': { outletId: 'broadway-blog', criticName: 'Jane Doe', url, fullText: HTML, contentTier: 'invalid', humanReviewScore: 50 },
  });
  createOrMergeReviewFile(SHOW, { outletId: 'one-minute-critic', outlet: '1 Minute Critic', criticName: 'Jane Doe', url, source: 'ingest-urls', replaceBadBody: true, fields: { fullText: ARTICLE } }, { reviewTextsDir: dir });
  assert.equal(read(dir, 'broadway-blog--other-person.json').fullText, HTML);
  assert.equal(read(dir, 'broadway-blog--jane-doe.json').fullText, HTML);
});

// BRO-6716: a browser error page stored as the body is junk; a real review with an error iframe is not.
test('junkBodyReason: browser error page body (TheWrap Imaginary Invalid) is junk, an embedded error in a review is not', () => {
  const { junkBodyReason, isCleanReplacementForJunk } = require('./junk-body.js');
  const frame = 'https://trinitymedia.ai/player/trinity-player.php?pageURL=https%3A%2F%2Fwww.thewrap.com%2Fx&unitType=tts-player';
  const errorBody = `The webpage at ${frame} might be temporarily down or it may have moved permanently to a new web address.`;
  assert.equal(junkBodyReason(errorBody), 'browser-error');
  assert.equal(junkBodyReason("This site can’t be reached ERR_NAME_NOT_RESOLVED"), 'browser-error');
  const review = 'Bill Irwin is a clown of genius, and his Argan in The Imaginary Invalid is a physical marvel from first wheeze to last. '.repeat(6);
  assert.equal(junkBodyReason(`${review} ${errorBody}`), null);
  assert.equal(isCleanReplacementForJunk(errorBody, review), true);
});

test('a short excerpt quoting an error code or "this site can\'t be reached" is not a browser-error body', async () => {
  const { junkBodyReason } = await import('./junk-body.js');
  assert.notEqual(junkBodyReason('The second act turns on a phone screen reading ERR_CONNECTION_REFUSED, a gag that lands.'), 'browser-error');
  assert.notEqual(junkBodyReason('"This site can\'t be reached," sighs the hero, and the audience roared.'), 'browser-error');
});

test('a "this site can\'t be reached" header does not swallow the review prose after it', () => {
  const { junkBodyReason } = require('./junk-body.js');
  const prose = 'Bill Irwin is a clown of genius, and his Argan is a physical marvel from first wheeze to last breath on stage. '.repeat(8);
  assert.notEqual(junkBodyReason(`This site can’t be reached ERR_NAME_NOT_RESOLVED\n${prose}`), 'browser-error');
});
