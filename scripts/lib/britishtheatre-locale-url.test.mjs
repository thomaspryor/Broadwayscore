import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { canonicalBritishTheatreUrl: c, hasBritishTheatreLocalePrefix: h } = createRequire(import.meta.url)('./britishtheatre-locale-url.js');
test('rewrites every locale', () => {
  for (const l of ['ar','ko','fr','es','de','ja','zh','pt','it','da','cs','pl','nl','sv','tr','hi','pt-br'])
    assert.equal(c(`https://www.britishtheatre.com/${l}/posts/review-x`), 'https://www.britishtheatre.com/posts/review-x');
});
test('leaves canonical, shows, other hosts alone', () => {
  for (const u of ['https://www.britishtheatre.com/posts/a','https://www.britishtheatre.com/pt/shows/skylight','https://x.com/fr/posts/a'])
    assert.equal(c(u), u);
  assert.equal(h('https://www.britishtheatre.com/es/posts/a'), true);
  assert.equal(h('https://www.britishtheatre.com/posts/a'), false);
});
