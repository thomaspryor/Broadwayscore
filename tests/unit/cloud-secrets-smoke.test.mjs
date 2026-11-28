import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { GROUPS, judgeScrape, judgeApi, selectChecks, summarize } = require('../../scripts/lib/cloud-secrets-smoke.js');

test('judgeScrape: accepts real page text, rejects blocks and short bodies', () => {
  const page = '<html><body><h1>Example Domain</h1>' + 'x'.repeat(300) + '</body></html>';
  assert.equal(judgeScrape({ content: page, source: 'scrapingdog' }).ok, true);
  assert.equal(judgeScrape({ content: 'blocked', source: 'x' }).ok, false);
  assert.equal(judgeScrape({ content: 'y'.repeat(500), source: 'x' }).ok, false);
  assert.equal(judgeScrape(null).ok, false);
});

test('judgeApi: non-200 always fails; per-group shape checks', () => {
  assert.equal(judgeApi('resend', 403, null).ok, false);
  assert.equal(judgeApi('resend', 200, { data: [{ status: 'verified' }] }).ok, true);
  assert.equal(judgeApi('resend', 200, { data: [{ status: 'pending' }] }).ok, false);
  assert.equal(judgeApi('bing', 200, { d: [{}] }).ok, true);
  assert.equal(judgeApi('bing', 200, { d: [] }).ok, false);
  assert.equal(judgeApi('impact', 200, { Actions: [] }).ok, true);
  assert.equal(judgeApi('impact', 200, {}).ok, false);
  assert.equal(judgeApi('formspree', 200, { submissions: [] }).ok, true);
  assert.equal(judgeApi('browserbase', 200, {}).ok, true);
  assert.equal(judgeApi('browserbase', 200, null).ok, false);
});

test('selectChecks: reports missing keys per group and honours --only', () => {
  const env = { RESEND_API_KEY: 'k' };
  const all = selectChecks(env);
  assert.equal(all.find((c) => c.group === 'resend').missing.length, 0);
  assert.deepEqual(all.find((c) => c.group === 'impact').missing, GROUPS.impact);
  assert.deepEqual(selectChecks(env, ['bing']).map((c) => c.group), ['bing']);
});

test('summarize: counts failures', () => {
  const s = summarize([{ group: 'a', ok: true, detail: 'fine' }, { group: 'b', ok: false, detail: 'bad' }]);
  assert.equal(s.failed, 1);
  assert.match(s.lines[1], /✗ b/);
});

test('ScrapingBee failure reports the transport proxy status', async () => {
  const scraperPath = require.resolve('../../scripts/lib/scraper.js');
  const original = require.cache[scraperPath];
  require.cache[scraperPath] = { id: scraperPath, filename: scraperPath, loaded: true, exports: { fetchPage: async () => { throw new Error('HTTP 403'); } } };
  const previous = process.env.CLAUDE_CODE_REMOTE;
  delete process.env.CLAUDE_CODE_REMOTE;
  try {
    const { runSmoke } = require('../../scripts/lib/cloud-secrets-smoke.js');
    const [result] = await runSmoke({ SCRAPINGBEE_API_KEY: 'test' }, { only: ['scrapingbee'] });
    assert.match(result.detail, /HTTP 403/);
    assert.match(result.detail, /CLAUDE_CODE_REMOTE/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_REMOTE; else process.env.CLAUDE_CODE_REMOTE = previous;
    if (original) require.cache[scraperPath] = original; else delete require.cache[scraperPath];
  }
});
