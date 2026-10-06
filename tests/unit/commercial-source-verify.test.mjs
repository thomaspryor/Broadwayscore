import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { verifyFigure, createSourceVerifier } = require('../../scripts/lib/commercial-source-verify');
const { buildCommercialEntry } = require('../../scripts/lib/commercial-apply-gate');
const show = { title: 'Example', openingDate: '2025-04-01' };
const source = { type: 'trade', url: 'https://variety.com/example', date: '2025-03-01' };
const entry = { capitalization: 12500000, weeklyRunningCost: 700000, capitalizationSource: 'GPT Deep Research: budget', confidence: 'high', sources: [source] };

for (const format of ['$12.5 million', '$12,500,000', '$12.5M', '12.5 million']) {
  test(`number format ${format} is verified and applies as fact`, async () => {
    const verify = createSourceVerifier({ fetchPage: async () => ({ content: `Example's 2025 capitalization was ${format}.` }) });
    const evidence = await verify(entry, show);
    const result = buildCommercialEntry(entry, null, { figureEvidence: evidence });
    assert.equal(result.isEstimate.capitalization, false);
    assert.match(result.capitalizationSource, /Example/);
    assert.equal(result.sources[0].url, source.url);
  });
}
test('silent, failed, missing and wrong-production sources default to estimates', async () => {
  for (const content of ['', 'Example opened in 2025.', 'Example had a $12.5 million capitalization in 2012.', 'Other Show had a $12.5 million capitalization in 2025.']) {
    const verify = createSourceVerifier({ fetchPage: async () => ({ content }) });
    const result = buildCommercialEntry(entry, null, { figureEvidence: await verify(entry, show) });
    assert.equal(result.isEstimate.capitalization, true);
    assert.equal(result.isEstimate.weeklyRunningCost, true);
    assert.equal(result.capitalizationSource, undefined);
    assert.equal(result.costMethodology, 'deep-research');
  }
  const verify = createSourceVerifier({ fetchPage: async () => { throw Error('403'); } });
  assert.deepEqual(await verify(entry, show), {});
  assert.equal(buildCommercialEntry(entry, null).isEstimate.capitalization, true);
});
test('SEC Form D XML amounts verify as fact without computing midpoints', async () => {
  const xml = '<form><issuerName>Example</issuerName><year>2025</year><totalAmountSold>12500000</totalAmountSold><totalOfferingAmount>15000000</totalOfferingAmount></form>';
  for (const amount of [12500000, 15000000]) assert.equal(verifyFigure(amount, xml).found, true);
  assert.equal(verifyFigure(13750000, xml).found, false);
  const secSource = { ...source, type: 'sec', url: 'https://www.sec.gov/Archives/example.xml' };
  const verify = createSourceVerifier({ fetchPage: async () => ({ content: xml }) });
  const evidence = await verify({ ...entry, sources: [secSource] }, show);
  assert.equal(buildCommercialEntry(entry, null, { figureEvidence: evidence }).isEstimate.capitalization, false);
});
test('year-only dates and named months match, wrong month/year do not', () => {
  assert.equal(verifyFigure('2022', 'Recouped in December 2022').found, true);
  assert.equal(verifyFigure('2022-12', 'December 14, 2022').found, true);
  assert.equal(verifyFigure('2021-12', 'December 2022').found, false);
  assert.equal(verifyFigure('2022-11', 'December 2022').found, false);
});
test('numeric boundaries and invisible page content cannot verify a figure', () => {
  for (const page of ['$112.5 million', '$12,500,000,000', '$12.51 million', '<script>Budget $12.5 million</script>', 'Document identifier 12500000']) {
    assert.equal(verifyFigure(12500000, page).found, false);
  }
});
test('SEC fetchPage keeps XML and sends the site admin User-Agent', async () => {
  const { fetchPage } = require('../../scripts/lib/scraper');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://www.sec.gov/Archives/example.xml');
      assert.match(options.headers['User-Agent'], /contact@broadwayscorecard.com/);
      assert.equal(options.redirect, 'error');
      return { ok: true, text: async () => '<totalAmountSold>12500000</totalAmountSold>' };
    };
    const result = await fetchPage('https://www.sec.gov/Archives/example.xml');
    assert.match(result.content, /<totalAmountSold>/);
    assert.equal(result.source, 'sec');
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(fetchPage('https://www.sec.gov/Archives/example.xml'), /403/);
  } finally { globalThis.fetch = originalFetch; }
});
test('weekly cost evidence, explicit estimates and independent flags survive', async () => {
  const verify = createSourceVerifier({ fetchPage: async () => ({ content: 'Example in 2025 has a weekly running cost of $700,000.' }) });
  const evidence = await verify(entry, show);
  const result = buildCommercialEntry(entry, null, { figureEvidence: evidence });
  assert.equal(result.isEstimate.capitalization, true);
  assert.equal(result.isEstimate.weeklyRunningCost, false);
  assert.equal(result.costMethodology, 'trade-reported');
  assert.match(result.weeklyRunningCostSource, /700,000/);
  assert.equal(buildCommercialEntry({ ...entry, isEstimate: { weeklyRunningCost: true } }, null, { figureEvidence: evidence }).isEstimate.weeklyRunningCost, true);
});
test('fetch cache and cap include failures and reject untrusted hosts', async () => {
  let calls = 0;
  const verify = createSourceVerifier({ maxFetches: 1, fetchPage: async () => { calls++; throw Error('offline'); } });
  await verify(entry, show);
  await verify(entry, show);
  await verify({ ...entry, sources: [{ ...source, url: 'https://deadline.com/other' }] }, show);
  await verify({ ...entry, sources: [{ ...source, url: 'https://variety.com.evil.test/other' }] }, show);
  assert.equal(calls, 1);
});
test('fixture apply CLI dry run marks high-confidence unverified figures as estimates', () => {
  const dir = fs.mkdtempSync(path.resolve('tests/.bro4758-'));
  try {
    fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ shows: { example: { ...entry, sources: [] } } }));
    fs.writeFileSync(path.join(dir, 'commercial.json'), JSON.stringify({ shows: {} }));
    fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows: [{ ...show, id: 'example-2025', slug: 'example', category: 'broadway', status: 'open' }] }));
    const output = execFileSync(process.execPath, ['scripts/apply-commercial-pending.js', '--all', '--min-confidence=high', '--dry-run', `--pending-file=${dir}/pending.json`, `--commercial-file=${dir}/commercial.json`, `--shows-file=${dir}/shows.json`], { encoding: 'utf8' });
    assert.match(output, /"isEstimate":\{"capitalization":true,"weeklyRunningCost":true\}/);
    assert.match(output, /would apply 1, skip 0/);
    console.log(output.trim());
    fs.writeFileSync(path.join(dir, 'commercial.json'), JSON.stringify({ shows: { example: entry } }));
    const report = execFileSync(process.execPath, ['scripts/verify-commercial-sources.js', '--max-fetches=0', `--commercial-file=${dir}/commercial.json`, `--shows-file=${dir}/shows.json`], { encoding: 'utf8' });
    assert.equal(JSON.parse(report).fields.capitalization.proposedIsEstimate, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
