import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanSourceForDirectProviderCalls } = require('./direct-provider-detector.js');

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

test('does not flag the ScrapingBee Google-search endpoint', () => {
  const src = `\`https://app.scrapingbee.com/api/v1/store/google?api_key=\${key}&search=\${q}\`;`;
  assert.equal(scanSourceForDirectProviderCalls(src).length, 0);
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
