/**
 * BRO-6486: Exeunt NYC reviews came back as 0-char stubs. The fetch and the
 * extractor were fine; the stub files pointed at WordPress photo-attachment
 * pages (<review>/attachment/<photo>/), which hold a photo and no review.
 * - The extractor reads a saved Exeunt review page (fixture: the real page's
 *   markup with every paragraph replaced by placeholder words, no review text).
 * - wordpressAttachmentParentUrl maps an attachment page to its article.
 * - The shared writer stores the article url, never the attachment url.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractArticleText } = require('./article-extractor.js');
const { wordpressAttachmentParentUrl, classifyReviewUrl } = require('./non-review-url-patterns.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const REVIEW = 'https://exeuntnyc.com/reviews/review-prince-faggot-at-playwrights-horizons/';

test('extractor reads the body of a saved Exeunt NYC review page', () => {
  const html = fs.readFileSync(new URL('./fixtures/exeunt-nyc-review-page.html', import.meta.url), 'utf8');
  const text = extractArticleText(html, 'exeuntnyc.com');
  assert.ok(text && text.length > 3000, `extracted ${text && text.length} chars`);
  assert.match(text, /Fixture paragraph 1\./);
  assert.match(text, /Fixture paragraph 14\./);
  // Sidebar and footer chrome after the article stay out.
  assert.doesNotMatch(text, /Most Popular Articles/);
  assert.doesNotMatch(text, /Fixture paragraph 2[0-6]\./);
});

test('attachment pages map to their parent article', () => {
  assert.equal(wordpressAttachmentParentUrl('https://exeuntnyc.com/reviews/review-fish-at-wp-theater/attachment/alyssa-may-gold-yasmin-ranz-lind_fish_wp-theater_by-joan-0164-scaled/'),
    'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/');
  assert.equal(wordpressAttachmentParentUrl('https://exeuntnyc.com/reviews/review-king-of-the-yees-at-pershing-square-signature-center/attachment/hanjie_sig_koty_productionfinals_21'),
    'https://exeuntnyc.com/reviews/review-king-of-the-yees-at-pershing-square-signature-center/');
});

test('ordinary review urls are left alone', () => {
  for (const u of [REVIEW, 'https://www.nytimes.com/2026/10/20/theater/review.html', 'https://example.com/attachment/', 'not a url',
    'https://forum.example.com/threads/123/attachment/456', 'https://example.com/post/attachment/photo.jpg',
    'https://example.com/a/attachment/x/attachment/y/']) {
    assert.equal(wordpressAttachmentParentUrl(u), null, u);
  }
  assert.equal(classifyReviewUrl(REVIEW).ok, true);
});

test('the shared writer stores the article url, not the attachment url', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exeunt-attachment-'));
  const showId = 'fish-off-broadway-2026';
  fs.mkdirSync(path.join(dir, showId));
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  let r;
  try {
    r = createOrMergeReviewFile(showId, {
      outletId: 'exeunt-magazine', outlet: 'Exeunt Magazine', criticName: 'Nicole Serratore', source: 'ingest-urls',
      url: 'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/attachment/dsc00744/',
    }, { reviewTextsDir: dir });
  } finally { console.warn = w; console.log = l; }
  assert.equal(r.action, 'new', JSON.stringify(r));
  const files = fs.readdirSync(path.join(dir, showId)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, showId, files[0]), 'utf8'));
  assert.equal(saved.url, 'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/');
});

test('gather-reviews createReviewFile stores the article url, not the attachment url', { skip: !fs.existsSync(new URL('../../data/shows.json', import.meta.url)) && 'needs data/shows.json' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exeunt-attachment-gather-'));
  const script = `
    const { createReviewFile } = require(${JSON.stringify(new URL('../gather-reviews.js', import.meta.url).pathname)});
    const res = createReviewFile('fish-off-broadway-2026', {
      outlet: 'Exeunt Magazine', outletId: 'exeunt-magazine', criticName: 'Nicole Serratore', source: 'ingest-urls',
      url: 'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/attachment/dsc00744/',
    }, { allowOffBroadway: true });
    process.stdout.write('\\nRESULT=' + JSON.stringify(res));`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, REVIEW_TEXTS_DIR: dir, BSC_STAGE_LATENCY_MUTE: '1' }, encoding: 'utf8' });
  const showDir = path.join(dir, 'fish-off-broadway-2026');
  const files = fs.existsSync(showDir) ? fs.readdirSync(showDir).filter((f) => f.endsWith('.json')) : [];
  assert.ok(files.length >= 1, `no file written: ${out.slice(-400)}`);
  for (const f of files) {
    const saved = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
    assert.equal(saved.url, 'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/', f);
  }
});

test('ingest-review-from-url ingests an attachment url as its article, and a second ingest merges cleanly', { skip: !fs.existsSync(new URL('../../data/shows.json', import.meta.url)) && 'needs data/shows.json' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exeunt-attachment-ingest-'));
  const script = new URL('../ingest-review-from-url.js', import.meta.url).pathname;
  const fixture = new URL('./fixtures/exeunt-nyc-review-page.html', import.meta.url).pathname;
  const argv = [script, '--show=fish-off-broadway-2026', '--url=https://exeuntnyc.com/reviews/review-fish-at-wp-theater/attachment/dsc00744/',
    // The fixture is a June 2025 page for another show; its byline date (read since
    // BRO-6588) would rightly quarantine it here, and this test is about the url.
    '--outlet=exeunt-magazine', '--critic=Nicole Serratore', `--html-file=${fixture}`, '--publish-date=2026-10-12'];
  for (const run of [1, 2]) {
    const r = spawnSync(process.execPath, argv, { env: { ...process.env, REVIEW_TEXTS_DIR: dir, BSC_STAGE_LATENCY_MUTE: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, `run ${run}: ${(r.stdout + r.stderr).slice(-600)}`);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'fish-off-broadway-2026', 'exeunt-magazine--nicole-serratore.json'), 'utf8'));
  assert.equal(saved.url, 'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/');
});

test('SERP url discovery hands back the article, never the attachment page', () => {
  const { toArticleUrl } = require('./url-discovery.js');
  const att = 'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/attachment/dsc00744/';
  const parent = 'https://exeuntnyc.com/reviews/review-fish-at-wp-theater/';
  assert.equal(toArticleUrl(att), parent);
  assert.deepEqual(toArticleUrl({ url: att, serpTitle: 't' }), { url: parent, serpTitle: 't' });
  for (const v of [null, '__SERP_UNAVAILABLE__', REVIEW]) assert.equal(toArticleUrl(v), v);
});
