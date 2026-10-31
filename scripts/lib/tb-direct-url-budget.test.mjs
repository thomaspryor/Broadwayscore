// BRO-4217 — School Girls opening night, 2026-09-28. Two things went wrong in the
// Talkin' Broadway direct-URL layer:
//   1. shortTitleCandidate() only cuts at a comma, so the semicolon-subtitled title gave
//      "School Girls; Or" → SchoolGirlsOr*.html and the real page, SchoolGirls.html, was
//      never a candidate.
//   2. With Scrapingdog failing on talkinbroadway.com every candidate cost 60-90 s, the
//      loop consumed 9 of the poller's 10 per-show minutes, and the pass was killed before
//      any review file was written. tryTbDirectUrl() now has a wall-clock budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTbCandidateUrls, tryTbDirectUrl, verifyTbPage, _internal } = require('./tb-direct-url.js');
const W = 'https://www.talkinbroadway.com/page/world/';

test('semicolon-subtitled titles get main-title variants, dated first, ahead of the comma cut', () => {
  const urls = buildTbCandidateUrls('School Girls; Or, The African Mean Girls Play', 2026);
  const i = u => urls.indexOf(W + u);
  for (const u of ['SchoolGirls2026.html', 'SchoolGirls26.html', 'schoolgirls2026.html', 'SchoolGirls.html']) {
    assert.ok(i(u) !== -1, `expected ${u} among candidates, got: ${JSON.stringify(urls)}`);
  }
  // Dated variants before the bare undated one (revival safety, same rule as the comma cut).
  assert.ok(i('SchoolGirls2026.html') < i('SchoolGirls.html'));
  assert.ok(i('SchoolGirls26.html') < i('SchoolGirls.html'));
  assert.ok(i('schoolgirls2026.html') < i('SchoolGirls.html'));
  // The main-title family comes before the comma cut ("School Girls; Or").
  assert.ok(i('SchoolGirls2026.html') < i('SchoolGirlsOr2026.html'));
  // The full-title family is still first and in its original order.
  assert.equal(urls[0], W + 'SchoolGirlsOrtheAfricanMeanGirlsPlay2026.html');
  assert.equal(urls[1], W + 'SchoolGirlsOrtheAfricanMeanGirlsPlay26.html');
  assert.equal(new Set(urls).size, urls.length, 'no duplicate candidates');
});

test('colon-subtitled titles also get main-title variants', () => {
  const urls = buildTbCandidateUrls('Titanique: The Musical', 2026);
  assert.ok(urls.includes(W + 'Titanique.html'), JSON.stringify(urls));
  assert.ok(urls.indexOf(W + 'Titanique2026.html') < urls.indexOf(W + 'Titanique.html'));
});

test('non-subtitled titles are unchanged (4 variants, original order)', () => {
  assert.deepEqual(buildTbCandidateUrls('Hadestown', 2019), [
    W + 'Hadestown2019.html',
    W + 'Hadestown19.html',
    W + 'Hadestown.html',
    W + 'hadestown2019.html',
  ]);
});

test('tryTbDirectUrl starts no new fetch once the budget is spent', async () => {
  let t = 0;
  const now = () => t;
  const calls = [];
  const fetchPage = async (url) => { calls.push(url); t += 100000; return { content: '' }; }; // each fetch "costs" 100 s
  const r = await tryTbDirectUrl({
    show: { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' },
    year: 2026, fetchPage, logger: { log() {} }, budgetMs: 150000, now,
  });
  assert.equal(r.found, false);
  assert.match(r.reason, /time budget exhausted/);
  assert.equal(calls.length, 2, 'the third candidate must not be fetched once the budget is spent');
});

test('tryTbDirectUrl with a generous budget still tries every candidate and the index fallback', async () => {
  const calls = [];
  const fetchPage = async (url) => { calls.push(url); return { content: '' }; };
  const r = await tryTbDirectUrl({
    show: { id: 'hadestown-2019', title: 'Hadestown', openingDate: '2019-04-17' },
    year: 2019, fetchPage, logger: { log() {} }, budgetMs: 240000,
  });
  assert.equal(r.found, false);
  assert.match(r.reason, /all 4 candidates \+ index fallback failed verification/);
  assert.equal(calls.length, 5, '4 candidates + index.html fallback');
  assert.ok(calls[4].endsWith('/page/world/index.html'));
});

test('BRO-6589: candidates and the index are fetched together, not one after another', async () => {
  let inFlight = 0, peak = 0;
  const fetchPage = async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 30));
    inFlight--;
    return { content: '' };
  };
  const started = Date.now();
  const r = await tryTbDirectUrl({
    show: { id: 'hadestown-2019', title: 'Hadestown', openingDate: '2019-04-17' },
    year: 2019, fetchPage, logger: { log() {} }, budgetMs: 240000,
  });
  assert.equal(r.found, false);
  assert.equal(peak, 5, 'all 4 candidates + index in flight at once');
  assert.ok(Date.now() - started < 120, 'one fetch of wall time, not five');
});

test('BRO-6589: a fetch already started when the budget runs out is awaited, not dropped', async () => {
  const calls = [];
  const fetchPage = async (url) => { calls.push(url); await new Promise(r => setTimeout(r, 40)); return { content: '' }; };
  const r = await tryTbDirectUrl({
    show: { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' },
    year: 2026, fetchPage, logger: { log() {} }, budgetMs: 20,
  });
  assert.equal(calls.length, 5, 'the first wave of 5 goes out, nothing after the budget');
  assert.match(r.reason, /time budget exhausted with 8 of 13 fetches never started/);
});

test('BRO-6589: an async override is awaited and verified even at budget 0', async () => {
  const calls = [];
  const fetchPage = async (url) => { calls.push(url); await new Promise(r => setTimeout(r, 20)); return { content: '' }; };
  const r = await tryTbDirectUrl({
    show: { id: 'x-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' },
    year: 2026, overrideUrl: W + 'SchoolGirls.html', fetchPage, logger: { log() {} }, budgetMs: 0,
  });
  assert.deepEqual(calls, [W + 'SchoolGirls.html']);
  assert.match(r.reason, /failed verification/, 'the answer was read, not reported as unanswered');
});

test('an override URL is the only candidate, budget or not', async () => {
  const calls = [];
  const fetchPage = async (url) => { calls.push(url); return { content: '' }; };
  const r = await tryTbDirectUrl({
    show: { id: 'x-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' },
    year: 2026, overrideUrl: W + 'SchoolGirls.html', fetchPage, logger: { log() {} }, budgetMs: 0,
  });
  assert.equal(r.found, false);
  assert.deepEqual(calls, [W + 'SchoolGirls.html']);
});

test('budget: explicit value wins, env is the fallback, default is 240 s', () => {
  assert.equal(_internal.tbBudgetMs(5000), 5000);
  const prev = process.env.TB_DIRECT_URL_BUDGET_MS;
  process.env.TB_DIRECT_URL_BUDGET_MS = '7000';
  assert.equal(_internal.tbBudgetMs(undefined), 7000);
  delete process.env.TB_DIRECT_URL_BUDGET_MS;
  assert.equal(_internal.tbBudgetMs(undefined), _internal.DEFAULT_TB_BUDGET_MS);
  assert.equal(_internal.DEFAULT_TB_BUDGET_MS, 240000);
  if (prev !== undefined) process.env.TB_DIRECT_URL_BUDGET_MS = prev;
});

test('budget: a blank or junk env value means unset, never a zero budget', () => {
  const prev = process.env.TB_DIRECT_URL_BUDGET_MS;
  for (const v of ['', '   ', 'abc', '-5']) {
    process.env.TB_DIRECT_URL_BUDGET_MS = v;
    assert.equal(_internal.tbBudgetMs(undefined), _internal.DEFAULT_TB_BUDGET_MS, `env ${JSON.stringify(v)}`);
  }
  process.env.TB_DIRECT_URL_BUDGET_MS = ' 9000 ';
  assert.equal(_internal.tbBudgetMs(undefined), 9000);
  if (prev !== undefined) process.env.TB_DIRECT_URL_BUDGET_MS = prev; else delete process.env.TB_DIRECT_URL_BUDGET_MS;
});

test('verifyTbPage accepts a page titled with the main title only, the same cut the candidate builder uses', () => {
  const pad = 'lorem ipsum dolor sit amet '.repeat(40);
  const page = (title) => `<html><head><title>${title}</title></head><body><p>reviewed by Matthew Murray</p><p>September 28, 2026</p><p>${pad}</p></body></html>`;
  const ok = verifyTbPage(page('School Girls'), { showTitle: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-09-28' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const ok2 = verifyTbPage(page('Titanique'), { showTitle: 'Titanique: The Musical', openingDate: '2026-09-28' });
  assert.equal(ok2.ok, true, JSON.stringify(ok2));
  // The short form still has to be substantial: "Oh" must not match "Wholesome".
  const bad = verifyTbPage(page('Wholesome Evening'), { showTitle: 'Oh: The Musical', openingDate: '2026-09-28' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /title mismatch/);
});

test('buildTbCandidateUrls tolerates a missing title instead of throwing', () => {
  assert.doesNotThrow(() => buildTbCandidateUrls(null, 2026));
  assert.doesNotThrow(() => buildTbCandidateUrls(undefined, 2026));
});
