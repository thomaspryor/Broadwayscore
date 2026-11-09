import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchPage } = require('../../scripts/lib/scraper');
const { laneFetchPage } = require('../../scripts/lib/opening-night-lane/browserbase-fetch');

test('free index fetch uses one bounded HTTP request and bypasses Browserbase even for a routed host', async (t) => {
  const url = 'https://www.talkinbroadway.com/page/index.html';
  const content = `<html><body><main>${'Theatre review index. '.repeat(50)}</main></body></html>`;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (target, opts) => {
    calls++;
    assert.equal(target, url);
    assert.ok(opts.signal instanceof AbortSignal);
    return { ok: true, url, text: async () => content };
  });
  const lane = laneFetchPage({ fetchPage, browserbase: { available: () => true, fetch: () => assert.fail('paid route') } });
  const result = await lane(url, { directOnly: true });
  assert.equal(result.content, content);
  assert.equal(result.source, 'direct');
  assert.equal(calls, 1);
});

test('free index failures never fall through to paid providers or browsers', async (t) => {
  const url = 'https://www.nytimes.com/section/theater';
  for (const response of [
    { ok: false, status: 403 },
    { ok: true, text: async () => '' },
    { ok: true, text: async () => '<title>Just a moment...</title>challenge-platform' },
    new Error('network timeout'),
  ]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async target => {
      calls++;
      assert.equal(target, url);
      if (response instanceof Error) throw response;
      return response;
    });
    await assert.rejects(fetchPage(url, { directOnly: true }), /Direct fetch|network timeout/);
    assert.equal(calls, 1);
    mock.mock.restore();
  }
});

test('free fetch names itself: a site that serves a nameless client an empty page (The Stage) answers it (BRO-6872)', async () => {
  const http = require('node:http');
  const body = `<html><body><main>${'Theatre reviews listing. '.repeat(50)}</main></body></html>`;
  // thestage.co.uk/reviews: 200 with 0 bytes for undici's default "node" agent, the full page for a named one.
  const srv = http.createServer((q, r) => r.end(/^BroadwayScorecard\//.test(q.headers['user-agent'] || '') ? body : ''));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const result = await fetchPage(`http://127.0.0.1:${srv.address().port}/reviews`, { directOnly: true });
    assert.equal(result.content, body);
    assert.equal(result.source, 'direct');
  } finally { srv.close(); }
});
