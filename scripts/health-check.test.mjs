import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
let response;
let failure;
let calls = [];

// health-check captures execSync on import. Stub it first so these tests run
// the real checkAPICredits -> runCheck -> JSON.parse path without network I/O.
const execMock = mock.method(childProcess, 'execSync', (command) => {
  assert.match(command, /^curl /);
  assert.match(command, /api\.(scrapingdog|browserbase)\.com\//);
  calls.push(command);
  if (failure) throw failure;
  return response;
});
const { checkAPICredits } = require('./health-check.js');
execMock.mock.restore();

const envKeys = ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY',
  'BRIGHTDATA_TOKEN', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  calls = [];
  failure = undefined;
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

for (const [provider, keys, prefix, healthy] of [
  ['ScrapingDog', ['SCRAPINGDOG_API_KEY'], 'account', { requestLimit: 1000, requestUsed: 100 }],
  ['Browserbase', ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'], 'usage', { browserMinutes: 0 }],
]) {
  function check(body) {
    for (const key of keys) process.env[key] = 'test-only';
    response = body;
    const row = checkAPICredits().find(row => row.name === `Credits: ${provider}`);
    assert.equal(calls.length, 1, 'only the selected provider is fetched');
    return row;
  }

  for (const body of ['null', '{}', '[]', 'false', '"unavailable"']) {
    test(`${provider}: JSON ${body} yields a clean contract warning through runCheck`, () => {
      const row = check(body);
      assert.equal(row.status, 'warn');
      assert.equal(row.message, `Unexpected ${prefix} response: ${body}`);
      assert.doesNotMatch(row.message, /Check crashed/);
    });
  }

  test(`${provider}: valid response still passes`, () => {
    const row = check(JSON.stringify(healthy));
    assert.equal(row.status, 'pass');
    assert.equal(row.message, provider === 'ScrapingDog'
      ? '1k credits left (90%)' : '0 browser minutes used (cumulative)');
  });

  test(`${provider}: invalid JSON stays a warning`, () => {
    const row = check('not json');
    assert.equal(row.status, 'warn');
    assert.match(row.message, /^API check failed:/);
  });

  test(`${provider}: curl failure stays a warning`, () => {
    failure = new Error('provider unavailable');
    const row = check('');
    assert.equal(row.status, 'warn');
    assert.equal(row.message, 'API check failed: provider unavailable');
  });
}

test('ScrapingDog: exhausted credits still report error', () => {
  process.env.SCRAPINGDOG_API_KEY = 'test-only';
  response = JSON.stringify({ requestLimit: 1000, requestUsed: 1000 });
  const row = checkAPICredits().find(row => row.name === 'Credits: ScrapingDog');
  assert.equal(row.status, 'error');
  assert.equal(row.message, '0k credits left (0%)');
});

// BRO-6105: validate-data.js writes baseline.totalReviews as reviews[].length;
// the drift check must count the same way (_meta.stats.totalReviews differs).
test('baseline drift check counts reviews like validate-data baseline writer', async () => {
  const { readFileSync } = await import('node:fs');
  const hc = readFileSync(new URL('./health-check.js', import.meta.url), 'utf8');
  const block = hc.slice(hc.indexOf("runCheck('Sync: baseline drift'"));
  assert.match(block.slice(0, 1500), /const currentReviews = reviews\.reviews\.length;/);
  const vd = readFileSync(new URL('./validate-data.js', import.meta.url), 'utf8');
  assert.match(vd, /return reviews\.length;/);
});
