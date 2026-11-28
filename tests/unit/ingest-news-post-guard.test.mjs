/**
 * BRO-7874: ingest-urls.js wrote four news posts as review files, because no guard asked what the
 * page was before createOrMergeReviewFile:
 *   FRC  /2022/01/to-kill-a-mockingbird-sets-closing-and-opening-dates/  (body links "Read opening night reviews here.")
 *   TP   /assassins-cancels-remaining-performances-due-to-covid/        (no text extracted at all)
 *   TP   /patti-lupone-back-in-company/                                  (news-free slug)
 *   TP   /aint-too-proud-bows-to-closing-nite-audience/                  (news-free slug)
 *
 * The real texts are private (data/review-texts, data/aggregator-archive). Where present they are
 * read at test time and never copied here; where absent those cases skip and short paraphrases of the
 * same notices (written for this test, not outlet text) still run.
 *
 * Run: node --test tests/unit/ingest-news-post-guard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { classifyNewsPost } = require('../../scripts/lib/news-post-guard.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RT = path.join(ROOT, 'data/review-texts');
const ARCHIVE = path.join(ROOT, 'data/aggregator-archive/front-row-center');

const FRC_MOCKINGBIRD = 'https://thefrontrowcenter.com/2022/01/to-kill-a-mockingbird-sets-closing-and-opening-dates/';
const TP_ASSASSINS = 'https://theaterpizzazz.com/assassins-cancels-remaining-performances-due-to-covid/';
const TP_LUPONE = 'https://theaterpizzazz.com/patti-lupone-back-in-company/';
const TP_AINT = 'https://theaterpizzazz.com/aint-too-proud-bows-to-closing-nite-audience/';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&rsquo;/g, '’').replace(/&#8220;|&#8221;/g, '"').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}
/** The FRC post body from the WordPress API archive, or null. */
function frcArchiveText(link) {
  if (!fs.existsSync(ARCHIVE)) return null;
  for (const f of fs.readdirSync(ARCHIVE)) {
    const page = readJson(path.join(ARCHIVE, f));
    if (!Array.isArray(page)) continue;
    const post = page.find((p) => p && p.link === link);
    if (post) {
      const body = stripHtml(post.content && post.content.rendered).replace(/\s*Share this:.*$/s, '');
      return `${stripHtml(post.title && post.title.rendered)} ${body}`.trim();
    }
  }
  return null;
}
function storedText(rel) { const j = readJson(path.join(RT, rel)); return j ? { url: j.url, text: j.fullText } : null; }

test('real FRC Mockingbird closing/opening-dates post is refused (its "Read opening night reviews here." link is not a review signal)', (t) => {
  const text = frcArchiveText(FRC_MOCKINGBIRD);
  if (!text) return t.skip('data/aggregator-archive/front-row-center not present');
  assert.match(text, /Read opening night reviews here/);
  assert.equal(classifyNewsPost({ url: FRC_MOCKINGBIRD, text }).news, true);
});

test('real Theater Pizzazz notices are refused', (t) => {
  const cases = [
    ['company-2021/theater-pizzazz--unknown.json', TP_LUPONE],
    ['aint-too-proud-2019/theater-pizzazz--unknown.json', TP_AINT],
  ];
  let ran = 0;
  for (const [rel, url] of cases) {
    const got = storedText(rel);
    if (!got || got.url !== url || !got.text) continue;
    ran++;
    const r = classifyNewsPost(got);
    assert.equal(r.news, true, `${url}: ${JSON.stringify(r)}`);
  }
  if (!ran) t.skip('data/review-texts not present');
});

test('Assassins cancellation with no extracted text is refused on its slug (the real file holds no text)', () => {
  assert.equal(classifyNewsPost({ url: TP_ASSASSINS, text: null }).news, true);
  assert.equal(classifyNewsPost({ url: TP_ASSASSINS, text: '' }).news, true);
});

test('paraphrased notices refuse without private data', () => {
  assert.equal(classifyNewsPost({ url: FRC_MOCKINGBIRD, text: 'The adaptation will play its final performance at the Shubert in January and will reopen at the Belasco in June. The production recouped in 19 weeks. Read opening night reviews here.' }).news, true);
  assert.equal(classifyNewsPost({ url: TP_LUPONE, text: 'Patti LuPone Back in Company. LuPone returned to the show after a brief absence while she recovered from COVID, and spoke at the stage door after the curtain call.' }).news, true);
  assert.equal(classifyNewsPost({ url: TP_AINT, text: "Ain't Too Proud played its final Broadway performance Sunday. The musical played 488 performances; the evening ended with curtain call speeches." }).news, true);
});

test('real FRC reviews pass', (t) => {
  const sweeney = storedText('sweeney-todd-the-demon-barber-of-fleet-street-regional-2022/front-row-center--tulis-mccall.json');
  if (!sweeney || !sweeney.text) return t.skip('data/review-texts not present');
  assert.match(sweeney.url, /sweeney-todd-the-demon-barber-of-fleet-street/);
  assert.equal(classifyNewsPost(sweeney).news, false);
  // Every stored FRC review the scorers kept passes too (the Yellow Face FRC review is not in this corpus).
  let n = 0;
  for (const d of fs.readdirSync(RT)) {
    const dp = path.join(RT, d);
    let files; try { files = fs.readdirSync(dp); } catch { continue; }
    for (const f of files.filter((x) => x.startsWith('front-row-center--'))) {
      const j = readJson(path.join(dp, f));
      if (!j || !j.url || j.rejectionReason === 'not_a_review') continue;
      n++;
      assert.equal(classifyNewsPost({ url: j.url, text: j.fullText }).news, false, `${d}/${f}`);
    }
  }
  if (n <= 10) return t.skip(`only ${n} FRC reviews present`);
});

test('WSJ and Broadway News paywall teasers of real reviews are never refused', (t) => {
  if (!fs.existsSync(RT)) return t.skip('data/review-texts not present');
  let n = 0;
  for (const d of fs.readdirSync(RT)) {
    const dp = path.join(RT, d);
    let files; try { files = fs.readdirSync(dp); } catch { continue; }
    for (const f of files.filter((x) => /^(?:wsj|broadwaynews)--/.test(x))) {
      const j = readJson(path.join(dp, f));
      if (!j || !j.url || !j.fullText || j.fullText.length > 1500 || j.rejectionReason === 'not_a_review') continue;
      n++;
      assert.equal(classifyNewsPost({ url: j.url, text: j.fullText }).news, false, `${d}/${f}`);
    }
  }
  // CI's review-texts checkout can hold none of these outlets: data availability is not a failure.
  if (n <= 10) return t.skip(`only ${n} WSJ / Broadway News teasers present`);
});

test('a review with an announcement-shaped slug but no announcement phrase passes (Theatre Reviews Limited)', () => {
  assert.equal(classifyNewsPost({
    url: 'http://www.theatrereviews.com/the-woodsman-at-new-world-stages-tickets-on-sale-through-sunday-may-29-2016/',
    text: 'It is an inventive, magical journey told with sparse dialogue, haunting music and captivating puppets. Mr. Ortiz is superb.',
  }).news, false);
});

test('ingest-urls.js refuses news posts before createOrMergeReviewFile, with or without text', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ingest-urls.js'), 'utf8');
  const guard = src.indexOf('classifyNewsPost({ url, text: fullText })');
  const write = src.indexOf('createOrMergeReviewFile(showId, input');
  assert.ok(guard > 0 && write > guard, 'the guard must run before the review file write');
  assert.match(src.slice(guard, write), /if \(news\.news\) \{[\s\S]{0,400}continue;/);
  assert.doesNotMatch(src, /if \(fullText\) \{\s*const news = classifyNewsPost/);
});

test('ingest-review-from-url.js runs the same guard before its write, with a classified skip reason', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ingest-review-from-url.js'), 'utf8');
  const guard = src.indexOf("require('./lib/news-post-guard').classifyNewsPost({ url, text })");
  const write = src.indexOf('const result = createOrMergeReviewFile(showId, {');
  assert.ok(guard > 0 && write > guard, 'the guard must run before the review file write');
  assert.match(src, /Skipped: news-post/);
  const { classifyIngestSkip } = require('../../scripts/lib/ingest-skip-classify.js');
  assert.equal(classifyIngestSkip('⚠️  Skipped: news-post — x').kind, 'expected');
});
