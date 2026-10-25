import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scraper = require('../../scripts/lib/scraper.js');
const sources = ['muckrack', 'bww', 'nysun', 'nysr'];
const healthy = html => html.padEnd(5000, ' ');

// Replace only transport, exercising the exported production fetch and parser.
async function run(t, source, pages) {
  const calls = [];
  const warnings = [];
  const transport = t.mock.method(scraper, 'fetchPage', async url => {
    calls.push(url);
    assert.ok(calls.length <= pages.length, 'unexpected extra fetch');
    const content = pages[calls.length - 1];
    if (content instanceof Error) throw content;
    return { content };
  });
  const warn = t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const modulePath = require.resolve(`../../scripts/lib/author-pages/${source}.js`);
  const previous = require.cache[modulePath];
  delete require.cache[modulePath];
  try {
    const articles = await require(modulePath).fetch('test-critic');
    assert.equal(calls.length, pages.length, 'fetch count changed');
    return { articles, calls, warnings };
  } finally {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
    transport.mock.restore();
    warn.mock.restore();
  }
}

const listing = {
  muckrack: '<h2><a href="https://example.com/review">A theatre review</a></h2>',
  bww: '<title>Theater Critic Reviews | BroadwayWorld</title><div class="one-feed">'
    + '<p style="font-weight:bold">A theatre review</p>'
    + '<strong>From:</strong> Example &nbsp;|&nbsp; <strong>Date:</strong> 10/17/2026'
    + '<a href="https://example.com/review" target="_blank" class="review-action-btn review-action-primary">Read This Review</a>',
  nysun: '<title>Test Critic | The New York Sun</title>'
    + '<article><a href="/article/a-review"><h3>A theatre review</h3></a>'
    + '<time dateTime="2026-10-17T12:00:00Z"></time></article>',
  nysr: '<article class="post"><h2><a class="entry-title-link" '
    + 'href="https://nystagereview.com/2026/10/17/a-review/">A theatre review</a></h2></article>',
};

for (const source of sources) {
  test(`${source}: healthy HTML with zero parsed articles warns with context`, async t => {
    const html = healthy('<title>Test Critic | Reviews</title><main>Changed listing markup</main>');
    const result = await run(t, source, [html]);
    assert.deepEqual(result.articles, []);
    assert.equal(result.calls.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(`[${source}] WARN:`));
    assert.ok(result.warnings[0].includes(result.calls[0]));
    assert.match(result.warnings[0], /5000 bytes/);
    assert.match(result.warnings[0], /0 articles parsed/);
  });

  test(`${source}: short, empty and failed fetches stay quiet`, async t => {
    for (const content of ['x'.repeat(4999), '', null, new Error('network failure')]) {
      const result = await run(t, source, [content]);
      assert.deepEqual(result.articles, []);
      assert.equal(result.warnings.length, 0);
      assert.equal(result.calls.length, 1);
    }
  });

  test(`${source}: valid listings preserve article fields without warning`, async t => {
    const pages = [healthy(listing[source])];
    if (source === 'bww') pages.push('');
    const result = await run(t, source, pages);
    assert.equal(result.articles.length, 1);
    assert.deepEqual(result.articles[0], {
      url: source === 'nysun' ? 'https://www.nysun.com/article/a-review'
        : source === 'nysr' ? 'https://nystagereview.com/2026/10/17/a-review/'
          : 'https://example.com/review',
      title: 'A theatre review',
      source,
      ...(source !== 'muckrack' ? { date: '2026-10-17' } : {}),
      ...(source === 'bww' ? { outlet: 'Example' } : {}),
    });
    assert.deepEqual(result.warnings, []);
  });
}

for (const [source, html] of [
  ['bww', '<title>BroadwayWorld</title>'],
  ['nysun', '<title>The New York Sun</title>'],
  ['nysun', '<main>Missing title</main>'],
  ['nysr', '<main>No posts found.</main>'],
]) {
  test(`${source}: healthy-length soft-404 (${html}) warns before returning`, async t => {
    const result = await run(t, source, [healthy(html)]);
    assert.deepEqual(result.articles, []);
    assert.equal(result.calls.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(`[${source}] WARN:`));
    assert.ok(result.warnings[0].includes(result.calls[0]));
    assert.match(result.warnings[0], /5000 bytes/);
  });
}

for (const source of ['muckrack', 'bww', 'nysr']) {
  test(`${source}: empty later page warns and preserves earlier articles`, async t => {
    const first = source === 'muckrack' ? listing[source].repeat(10)
      : listing[source] + (source === 'nysr' ? '<a href="/author/test-critic/page/2/">Next</a>' : '');
    const result = await run(t, source, [healthy(first), healthy('<title>Test Critic | Reviews</title>')]);
    assert.equal(result.calls.length, 2);
    assert.equal(result.articles.length, source === 'muckrack' ? 10 : 1);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(result.calls[1]));
  });
}
