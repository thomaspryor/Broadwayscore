import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanSourceForDirectProviderCalls, computeNewViolators } = require('./direct-provider-detector.js');

test('flags a direct ScrapingBee content-fetch call', () => {
  const src = `const apiUrl = \`https://app.scrapingbee.com/api/v1/?api_key=\${key}&url=\${encodeURIComponent(url)}\`;`;
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provider, 'scrapingbee');
  assert.equal(hits[0].line, 1);
});

test('does not flag the ScrapingBee usage/credit-check endpoint', () => {
  const src = `httpsGet(\`https://app.scrapingbee.com/api/v1/usage?api_key=\${key}\`);`;
  assert.equal(scanSourceForDirectProviderCalls(src).length, 0);
});

test('does not flag the ScrapingBee Google-search endpoint under the content-fetch pattern', () => {
  // The base /api/v1 pattern excludes store/google on purpose — it's a
  // different capability (SERP), caught by its own dedicated pattern below.
  const src = `const apiUrl = \`https://app.scrapingbee.com/api/v1/store/google?api_key=\${key}&search=\${q}\`;`;
  const hits = scanSourceForDirectProviderCalls(src);
  assert.deepEqual(hits.map(h => h.provider), ['scrapingbee-serp']);
});

test('flags a direct ScrapingBee store/google SERP call (task #1005)', () => {
  const src = `\`https://app.scrapingbee.com/api/v1/store/google?api_key=\${key}&search=\${q}&search_type=news\`;`;
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provider, 'scrapingbee-serp');
  assert.equal(hits[0].line, 1);
});

test('flags direct Bright Data SERP calls (serp/req and serp/get_result), not billing', () => {
  const src = [
    `fetch('https://api.brightdata.com/serp/req?customer=x&zone=y', opts);`,
    `fetch('https://api.brightdata.com/serp/get_result?response_id=1', opts);`,
    `fetch('https://api.brightdata.com/zone/cost?zone=x');`,
  ].join('\n');
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 2);
  assert.ok(hits.every(h => h.provider === 'brightdata-serp'));
  assert.deepEqual(hits.map(h => h.line), [1, 2]);
});

test('flags a direct Scrapingdog google/ SERP call, not /account', () => {
  const src = [
    `axios.get('https://api.scrapingdog.com/google/', { params });`,
    `axios.get('https://api.scrapingdog.com/account', { params });`,
  ].join('\n');
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provider, 'scrapingdog-serp');
  assert.equal(hits[0].line, 1);
});

test('flags a direct Bright Data /request page-fetch call', () => {
  const src = `https.request('https://api.brightdata.com/request', options);`;
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provider, 'brightdata');
});

test('does not flag Bright Data billing endpoints', () => {
  const src = [
    `'https://api.brightdata.com/zone/cost?zone=x'`,
    `'https://api.brightdata.com/customer/balance'`,
    `'https://api.brightdata.com/zone?zone=x'`,
  ].join('\n');
  assert.equal(scanSourceForDirectProviderCalls(src).length, 0);
});

test('flags a direct Scrapingdog /scrape call, not /account', () => {
  const src = [
    `const apiUrl = \`https://api.scrapingdog.com/scrape?api_key=\${key}&url=\${url}\`;`,
    `httpsGet(\`https://api.scrapingdog.com/account?api_key=\${key}\`);`,
  ].join('\n');
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provider, 'scrapingdog');
  assert.equal(hits[0].line, 1);
});

test('flags a direct Browserbase session-create call (api. or www. host)', () => {
  const src = [
    `https.request('https://api.browserbase.com/v1/sessions', opts);`,
    `https.request('https://www.browserbase.com/v1/sessions', opts);`,
  ].join('\n');
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 2);
  assert.ok(hits.every(h => h.provider === 'browserbase'));
});

test('flags a Browserbase /v1 API base held in a constant (split-URL session create)', () => {
  // Regression: newspapers-browserbase-login.js escaped the gate entirely because
  // it built the create URL as `${API}${endpoint}` — the /v1/sessions-only regex
  // never saw a contiguous "/v1/sessions" literal, so a file that really does
  // POST /sessions scored zero hits.
  const src = [
    `const API = 'https://api.browserbase.com/v1';`,
    `const session = await bb('POST', '/sessions', { projectId });`,
  ].join('\n');
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provider, 'browserbase');
  assert.equal(hits[0].line, 1);
});

test('flags an api.browserbase.com HOST constant split above /v1', () => {
  // The split-URL hole one level up from the /v1 case: fixing only `/v1` would
  // still miss a caller that keeps the bare host in a constant.
  const src = [
    `const HOST = 'https://api.browserbase.com';`,
    `await fetch(HOST + '/v1/sessions', { method: 'POST' });`,
  ].join('\n');
  const hits = scanSourceForDirectProviderCalls(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provider, 'browserbase');
  assert.equal(hits[0].line, 1);
});

test('does not flag the www.browserbase.com human dashboard link', () => {
  // test-paywalled-access.js console.logs this debug URL while creating its
  // session correctly via createBbSession(). Host-only matching on www would
  // flag that correct file — and allowlisting it would blind the gate to a
  // future real direct call in the same file.
  const src = `console.log(\`Debug URL: https://www.browserbase.com/sessions/\${bbSessionId}\`);`;
  assert.equal(scanSourceForDirectProviderCalls(src).length, 0);
});

test('does not flag the Browserbase CDP connect URL (different host, no /v1)', () => {
  const src = `const browser = await chromium.connectOverCDP('wss://connect.browserbase.com?apiKey=' + key);`;
  assert.equal(scanSourceForDirectProviderCalls(src).length, 0);
});

test('flags Browserbase session-list reads too — the file-level allowlist, not the regex, carves those out', () => {
  const src = `axios.get(BROWSERBASE_SESSIONS_URL, { params: { projectId } });`;
  // BROWSERBASE_SESSIONS_URL isn't a literal in this line, so nothing matches —
  // confirms the detector only sees literal URL text, same as the other providers.
  assert.equal(scanSourceForDirectProviderCalls(src).length, 0);
});

test('flags a bare-host constant for scrapingbee/brightdata/scrapingdog (same split defeat)', () => {
  // The /v1 fix was Browserbase-only; the identical technique defeated the other
  // three, whose patterns are path-aware precisely so they can exempt the
  // billing/SERP siblings. Verified escaping 2026-08-02 before this was added.
  const cases = [
    [`const SB = 'https://app.scrapingbee.com';\nfetch(SB + '/api/v1/?url=' + u);`, 'scrapingbee'],
    [`const BD = 'https://api.brightdata.com';\nhttps.request(BD + '/request', o);`, 'brightdata'],
    [`const SD = 'https://api.scrapingdog.com';\nfetch(SD + '/scrape?api_key=' + k);`, 'scrapingdog'],
    [`const BB = 'https://www.browserbase.com';\nfetch(BB + '/v1/sessions');`, 'browserbase'],
  ];
  for (const [src, provider] of cases) {
    const hits = scanSourceForDirectProviderCalls(src);
    assert.equal(hits.length, 1, `${provider} bare-host constant should be flagged`);
    assert.equal(hits[0].provider, provider);
  }
});

test('bare-host patterns do NOT re-flag the intentionally-exempt billing endpoints', () => {
  // These are excluded by path on purpose (billing/usage — not store/google,
  // which now has its own dedicated SERP pattern and is no longer blanket-exempt);
  // a literal carrying any path must not match the bare-host patterns, or the
  // billing exemptions silently die.
  const exempt = [
    `httpsGet('https://app.scrapingbee.com/api/v1/usage?api_key=' + k);`,
    `const c = 'https://api.brightdata.com/zone/cost?zone=x';`,
    `httpsGet('https://api.scrapingdog.com/account?api_key=' + k);`,
    `console.log('https://www.browserbase.com/sessions/' + id);`,
  ];
  for (const src of exempt) {
    assert.equal(scanSourceForDirectProviderCalls(src).length, 0, `should stay exempt: ${src}`);
  }
});

test('reports correct line numbers for multiple hits across lines', () => {
  const src = [
    '// comment',
    `const a = 'https://app.scrapingbee.com/api/v1/?url=x';`,
    '',
    `const b = 'https://api.brightdata.com/request';`,
  ].join('\n');
  const hits = scanSourceForDirectProviderCalls(src);
  assert.deepEqual(hits.map(h => h.line), [2, 4]);
});

// computeNewViolators() — the --strict CI gate's diff logic (task #1005).
// Fixture proving the guard fires on the exact bug class both #998 and #1005
// are about: a script already baselined for a content-fetch violation grows
// a NEW, different-capability SERP violation on the SAME file.

test('computeNewViolators: fires on a sibling SERP hit added to an already-baselined file', () => {
  // fetch-square-images.js shape: baselined for its content-fetch 'scrapingbee'
  // hit (task #66 debt), then regresses a raw store/google SERP call too.
  const violators = [
    { file: 'scripts/fetch-square-images.js', providers: ['scrapingbee', 'scrapingbee-serp'] },
  ];
  const baselineFiles = {
    'scripts/fetch-square-images.js': { providers: ['scrapingbee'], cronReachable: false },
  };
  const result = computeNewViolators(violators, baselineFiles);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'scripts/fetch-square-images.js');
  assert.deepEqual(result[0].providers, ['scrapingbee-serp']);
});

test('computeNewViolators: stays silent when a file only repeats already-baselined providers', () => {
  const violators = [
    { file: 'scripts/fetch-square-images.js', providers: ['scrapingbee'] },
  ];
  const baselineFiles = {
    'scripts/fetch-square-images.js': { providers: ['scrapingbee'], cronReachable: false },
  };
  assert.deepEqual(computeNewViolators(violators, baselineFiles), []);
});

test('computeNewViolators: flags a brand-new file with all its providers', () => {
  const violators = [
    { file: 'scripts/new-script.js', providers: ['scrapingbee-serp'] },
  ];
  assert.deepEqual(computeNewViolators(violators, {}), [
    { file: 'scripts/new-script.js', providers: ['scrapingbee-serp'] },
  ]);
});
