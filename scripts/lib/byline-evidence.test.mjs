/**
 * Tests for scripts/lib/byline-evidence.js (BRO-5232).
 * Run: node --test scripts/lib/byline-evidence.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractAuthorSignals, matchContexts, waybackTimestamp } = require('./byline-evidence.js');

const page = `<html><head><meta name="author" content="Patrick Ryan"><script type="application/ld+json">{"@type":"NewsArticle","author":[{"@type":"Person","name":"Patrick Ryan"}]}</script></head>
<body><a rel="author" href="/staff/patrick-ryan">Patrick Ryan</a><p>By Patrick Ryan USA TODAY</p><p>Tom Hiddleston is a revelation in Betrayal.</p></body></html>`;

test('collects meta, JSON-LD, rel=author and By-line author signals', () => {
  const s = extractAuthorSignals(page);
  assert.ok(s.includes('meta: Patrick Ryan'));
  assert.ok(s.includes('jsonld: Patrick Ryan'));
  assert.ok(s.includes('rel-author: Patrick Ryan'));
  assert.ok(s.some((x) => /^byline: By Patrick Ryan/.test(x)));
});

test('matchContexts returns short windows around each match, from text not markup', () => {
  const m = matchContexts(page, /Patrick Ryan/i);
  assert.ok(m.length >= 2);
  assert.ok(m.every((x) => x.length <= 60 * 2 + 'Patrick Ryan'.length && !x.includes('<')));
  assert.deepEqual(matchContexts(page, /Charles Isherwood/), []);
});

test('waybackTimestamp uses the url year, else a default', () => {
  assert.equal(waybackTimestamp('https://www.usatoday.com/story/life/theater/2019/09/05/betrayal/'), '20191231');
  assert.equal(waybackTimestamp('https://www.metro.news/theatre-review-rosmersholm/1542837/'), '20151231');
});
