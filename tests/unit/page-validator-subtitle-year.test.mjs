import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validatePageMatchesShow } = require('../../scripts/lib/page-validator');

// Only synthetic page structure, no archived review text.
function page({ headline = 'Review Roundup: Example Show', subtitle = 'An adaptation of a 1987 film arrives on Broadway', date = '2026-04-27', modified } = {}) {
  return `<html><head><title>${headline}</title>
    <link rel="canonical" href="https://example.com/main">
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle', url: 'https://example.com/main', headline, datePublished: date, dateModified: modified,
    })}</script></head><body><h1>${headline}</h1><h2>${subtitle}</h2></body></html>`;
}

const validate = (html) => validatePageMatchesShow(html, 'Example Show', {
  openingYear: 2026, skipLlm: true, shows: [],
});

test('a current article publication date disambiguates a historical subtitle year', async () => {
  assert.equal((await validate(page())).valid, true);
});

test('a current meta publication date also disambiguates the subtitle', async () => {
  const html = page({ date: undefined }).replace(/<script[\s\S]*?<\/script>/,
    '<meta property="article:published_time" content="2026-04-27T10:00:00Z">');
  assert.equal((await validate(html)).valid, true);
});

test('an old publication date does not rescue the subtitle', async () => {
  assert.equal((await validate(page({ date: '2019-04-27' }))).valid, false);
});

test('a recent modification is not a recent publication', async () => {
  assert.equal((await validate(page({ date: '2019-04-27', modified: '2026-04-27' }))).valid, false);
});

test('undated and invalidly dated pages retain the heading-year guard', async () => {
  for (const date of [null, '', 'invalid']) {
    assert.equal((await validate(page({ date }))).valid, false);
  }
});

test('publication metadata does not override a historical main headline', async () => {
  const result = await validate(page({ headline: 'Example Show: The 1987 Production' }));
  assert.equal(result.valid, false);
});

test('a current retrospective about an old stage production is still rejected', async () => {
  for (const subtitle of ['Looking back at the 1987 Broadway production', 'The 1987 movie inspired the 2019 production']) {
    assert.equal((await validate(page({ subtitle }))).valid, false);
  }
});

test('source-material wording can include a few descriptive words', async () => {
  assert.equal((await validate(page({ subtitle: 'The 1987 cult vampire movie comes to Broadway' }))).valid, true);
});

test('a body date or unlabelled time is not publication metadata', async () => {
  const html = page({ date: null }).replace('</body>',
    '<time datetime="2026-04-27">April 27, 2026</time><div class="publish-date">April 27, 2026</div></body>');
  assert.equal((await validate(html)).valid, false);
});

test('ambiguous related article dates cannot rescue a subtitle', async () => {
  const html = page({ date: '2019-04-27' }).replace('"url":"https://example.com/main",', '').replace('</head>',
    '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-04-27"}</script></head>');
  assert.equal((await validate(html)).valid, false);
});

test('an undated or invalidly dated main article cannot borrow a related article date', async () => {
  for (const date of [null, 'invalid']) {
    const html = page({ date }).replace('</head>',
      '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://example.com/related","datePublished":"2026-04-27"}</script></head>');
    assert.equal((await validate(html)).valid, false);
  }
});

test('non-article schema dates cannot rescue the subtitle', async () => {
  assert.equal((await validate(page().replace('"NewsArticle"', '"Product"'))).valid, false);
});

test('an article without page identity cannot rescue the subtitle', async () => {
  const html = page().replace(/<link[^>]+>/, '');
  assert.equal((await validate(html)).valid, false);
});

test('the main article date wins over a current related article', async () => {
  const html = page({ date: null }).replace('</head>', `
    <link rel="canonical" href="https://example.com/main">
    <script type="application/ld+json">[
      {"@type":"NewsArticle","url":"https://example.com/main","datePublished":"2019-04-27"},
      {"@type":"NewsArticle","url":"https://example.com/related","datePublished":"2026-04-27"}
    ]</script></head>`);
  assert.equal((await validate(html)).valid, false);
});

test('a publication date cannot rescue the wrong show', async () => {
  assert.equal((await validate(page({ headline: 'Review Roundup: Unrelated Musical' }))).valid, false);
});

test('matching subtitle years and headings without years keep working', async () => {
  for (const subtitle of ['The 2026 production arrives', 'The critics weigh in']) {
    assert.equal((await validate(page({ subtitle, date: null }))).valid, true);
  }
});
