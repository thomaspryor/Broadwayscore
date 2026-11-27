// BRO-6956: a Muck Rack block/challenge page must be a failed fetch, never "0 articles".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const muckrack = require('./author-pages/muckrack.js');

const pad = 'x'.repeat(6000);
// Shapes seen live 2026-11-27: the Playwright tier's block page, Cloudflare's challenge, a real profile.
const BLOCK = `<html><head><title>Technical Issue | Muck Rack</title></head><body><h1 class="mr-front-heading">We're sorry! There has been a technical issue.</h1>${pad}</body></html>`;
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body>${pad}</body></html>`;
const article = (i) => `<h4 class="news-story-title"><a href="https://www.wrap.com/review-${i}" target="_blank">Broadway Review number ${i}</a></h4>`;
const PROFILE = (n) => `<html><head><title>Articles by Robert Hofler's Profile | The Wrap Journalist | Muck Rack</title></head><body>${Array.from({ length: n }, (_, i) => article(i)).join('')}${pad}</body></html>`;

test('page-1 block page throws instead of returning []', async () => {
  for (const html of [BLOCK, CHALLENGE]) {
    await assert.rejects(muckrack.fetch('robert-hofler', 2, { fetchHtml: async () => html }), /not a profile page/);
  }
});

test('page-1 fetch error and short body throw', async () => {
  await assert.rejects(muckrack.fetch('x', 2, { fetchHtml: async () => { throw new Error('All scraping methods failed'); } }), /All scraping methods failed/);
  await assert.rejects(muckrack.fetch('x', 2, { fetchHtml: async () => '<html></html>' }), /got 13 bytes/);
});

test('real profile page parses articles; a page-2 block page just stops paging', async () => {
  const urls = [];
  const arts = await muckrack.fetch('robert-hofler', 2, { fetchHtml: async (u) => { urls.push(u); return u.includes('page=2') ? BLOCK : PROFILE(12); } });
  assert.equal(arts.length, 12);
  assert.equal(arts[0].source, 'muckrack');
  assert.equal(urls.length, 2);
});

test('profile page with zero articles is a legit empty result', async () => {
  assert.deepEqual(await muckrack.fetch('quiet-critic', 2, { fetchHtml: async () => PROFILE(0) }), []);
});

test('isProfilePage', () => {
  assert.equal(muckrack.isProfilePage(PROFILE(1)), true);
  assert.equal(muckrack.isProfilePage(BLOCK), false);
  assert.equal(muckrack.isProfilePage(CHALLENGE), false);
  assert.equal(muckrack.isProfilePage(null), false);
});
