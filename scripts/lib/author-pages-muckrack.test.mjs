// BRO-6956: Muck Rack reads must say what they got. A block/challenge page is a failed
// fetch, never "0 articles"; a missing profile fails that critic only; only blocks
// switch the host off for the run; reads are serialized and rate limits retried.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const muckrack = require('./author-pages/muckrack.js');

const pad = 'x'.repeat(6000);
const page = (title, body = '') => `<html><head><title>${title}</title></head><body>${body}${pad}</body></html>`;
// Title shapes seen live 2026-11-27.
const BLOCK = page('Technical Issue | Muck Rack', '<h1>We\'re sorry! There has been a technical issue.</h1>');
const CHALLENGE = page('Just a moment...');
const RATE = page('Rate limited | Muck Rack');
const MISSING = page('(404) Page Not Found | Muck Rack');
const article = (i, host = 'www.thewrap.com') => `<h4 class="news-story-title">\n<a target="_blank" rel="noreferrer" href="https://${host}/review-${i}/">Broadway Review number ${i}</a>\n</h4>`;
const PROFILE = (n, host) => page("Articles by Robert Hofler's Profile | The Wrap Journalist | Muck Rack", Array.from({ length: n }, (_, i) => article(i, host)).join(''));
const DRIFT = page("Articles by Robert Hofler's Profile | The Wrap Journalist | Muck Rack", '<h4 class="news-story-title"><div><a href="https://x.com/a">nested markup now</a></div></h4>');
const by = (map) => async (u) => { const v = map(u); if (v instanceof Error) throw v; return v; };
const err = (status, msg = `${status}`) => Object.assign(new Error(msg), { status });

beforeEach(() => muckrack._resetForTest(by(() => { throw new Error('test did not install a reader'); })));

test('classifyPage', () => {
  assert.equal(muckrack.classifyPage(PROFILE(1)), 'profile');
  assert.equal(muckrack.classifyPage(BLOCK), 'blocked');
  assert.equal(muckrack.classifyPage(CHALLENGE), 'blocked');
  assert.equal(muckrack.classifyPage(RATE), 'rate-limited');
  assert.equal(muckrack.classifyPage(MISSING), 'missing');
});

test('page-1 block page, challenge, short body and fetch error all throw', async () => {
  for (const r of [BLOCK, CHALLENGE, '<html></html>', new Error('All scraping methods failed')]) {
    muckrack._resetForTest(by(() => r));
    await assert.rejects(muckrack.fetch('robert-hofler'), /muckrack https:\/\/muckrack.com\/robert-hofler\/articles/);
  }
});

test('missing profile throws a per-critic error naming the override', async () => {
  for (const r of [MISSING, err(404, '404 not found')]) {
    muckrack._resetForTest(by(() => r));
    await assert.rejects(muckrack.fetch('dominic-cavendish'), /no Muck Rack profile at this slug/);
  }
});

test('profile page parses; a page-2 block just stops paging', async () => {
  const seen = [];
  muckrack._resetForTest(by((u) => { seen.push(u); return u.includes('page=2') ? BLOCK : PROFILE(12); }));
  const arts = await muckrack.fetch('robert-hofler');
  assert.equal(arts.length, 12);
  assert.equal(arts[0].source, 'muckrack');
  assert.equal(seen.length, 2);
});

test('zero articles: empty profile is [], headings that no longer parse is drift', async () => {
  muckrack._resetForTest(by(() => PROFILE(0)));
  assert.deepEqual(await muckrack.fetch('quiet-critic'), []);
  muckrack._resetForTest(by(() => PROFILE(3, 'gossipbucket.com')));
  assert.deepEqual(await muckrack.fetch('syndicated-only'), []);
  muckrack._resetForTest(by(() => DRIFT));
  await assert.rejects(muckrack.fetch('robert-hofler'), /structural drift/);
});

test('missing profiles never trip the run-wide latch', async () => {
  let calls = 0;
  muckrack._resetForTest(by((u) => { calls++; return u.includes('/real/') ? PROFILE(1) : MISSING; }));
  for (let i = 0; i < 6; i++) await assert.rejects(muckrack.fetch(`nobody-${i}`), /no Muck Rack profile/);
  assert.equal((await muckrack.fetch('real')).length, 1);
  assert.equal(calls, 7);
});

test('3 consecutive blocked reads switch the host off without more network calls, even for queued reads', async () => {
  let calls = 0;
  muckrack._resetForTest(by(() => { calls++; return BLOCK; }));
  const results = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => muckrack.fetch(`c${i}`)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(calls, 3);
  assert.match(results[5].reason.message, /blocked this run/);
});

test('a good read resets the block streak', async () => {
  let n = 0;
  muckrack._resetForTest(by(() => (++n % 3 === 0 ? PROFILE(1) : BLOCK)));
  const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => muckrack.fetch(`c${i}`)));
  assert.equal(n, 9);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
});

test('a rate-limit page is retried, and reads never overlap', async () => {
  let calls = 0, inFlight = 0, maxInFlight = 0;
  muckrack._resetForTest(async () => {
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return calls === 1 ? RATE : PROFILE(1);
  });
  const got = await Promise.all([0, 1, 2, 3].map((i) => muckrack.fetch(`c${i}`)));
  assert.ok(got.every((a) => a.length === 1));
  assert.equal(calls, 5);
  assert.equal(maxInFlight, 1);
});

test('close() is final and safe without a session', async () => {
  await muckrack.close();
  await muckrack.close();
  assert.equal(muckrack._isClosed(), true);
});
