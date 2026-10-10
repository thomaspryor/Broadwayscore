import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildMonitorPassEnv, SCRAPER_ENV_KEYS } = require('../../scripts/lib/opening-night-monitor.js');

const SRC = {
  SCRAPINGBEE_API_KEY: 'sb', BRIGHTDATA_TOKEN: 'bd', BRIGHTDATA_ZONE: 'z',
  BROWSERBASE_API_KEY: 'bb', BROWSERBASE_PROJECT_ID: 'p',
  RESEND_API_KEY: 'r', OWNER_EMAIL: 'o@x.com', ANTHROPIC_API_KEY: 'a',
  GITHUB_TOKEN: 'gh', SUPABASE_SERVICE_ROLE_KEY: 'sup', NOTION_TOKEN: 'n',
};

test('scraper keys are forwarded to the monitor pass', () => {
  const env = buildMonitorPassEnv(SRC, { authMode: 'oauth' });
  for (const k of ['SCRAPINGBEE_API_KEY', 'BRIGHTDATA_TOKEN', 'BRIGHTDATA_ZONE', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID']) {
    assert.equal(env[k], SRC[k], k);
  }
  assert.equal(env.RESEND_API_KEY, 'r');
  assert.equal(env.OWNER_EMAIL, 'o@x.com');
});

test('stays an allow-list: unrelated secrets are never forwarded', () => {
  const env = buildMonitorPassEnv(SRC, { authMode: 'oauth' });
  for (const k of ['GITHUB_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'NOTION_TOKEN']) assert.equal(k in env, false, k);
  for (const k of Object.keys(env)) {
    assert.ok(SCRAPER_ENV_KEYS.includes(k) || ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'OWNER_EMAIL'].includes(k), k);
  }
});

test('ANTHROPIC_API_KEY cleared on oauth, forwarded on api-key; absent scraper keys omitted', () => {
  assert.equal(buildMonitorPassEnv(SRC, { authMode: 'oauth' }).ANTHROPIC_API_KEY, '');
  assert.equal(buildMonitorPassEnv(SRC, { authMode: 'api-key' }).ANTHROPIC_API_KEY, 'a');
  assert.equal('SCRAPINGBEE_API_KEY' in buildMonitorPassEnv({}, {}), false);
});

test('launcher wires the pass env through buildMonitorPassEnv (no inline 3-key literal)', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  assert.match(src, /env:\s*buildMonitorPassEnv\(process\.env/);
});

test('kill switch and budget tunables are forwarded when set, never defaulted', () => {
  const env = buildMonitorPassEnv({ BROWSERBASE_KILL_SWITCH: 'true', SB_CREDIT_BUDGET: '100', BRIGHTDATA_SERP_ZONE: 'sz', BRIGHTDATA_CUSTOMER: 'c', SCRAPINGDOG_API_KEY: 'sd' }, {});
  assert.equal(env.BROWSERBASE_KILL_SWITCH, 'true');
  assert.equal(env.SB_CREDIT_BUDGET, '100');
  assert.equal(env.BRIGHTDATA_SERP_ZONE, 'sz');
  assert.equal(env.BRIGHTDATA_CUSTOMER, 'c');
  assert.equal(env.SCRAPINGDOG_API_KEY, 'sd');
  assert.equal('BD_OPENING_NIGHT' in buildMonitorPassEnv({}, {}), false);
});

test('a child spawned with the real strippedEnv(buildMonitorPassEnv(...)) sees the scraper key', () => {
  const { strippedEnv } = require('../../scripts/lib/claude-cli.js');
  const env = strippedEnv(buildMonitorPassEnv({ SCRAPINGBEE_API_KEY: 'sentinel' }, {}));
  const r = spawnSync(process.execPath, ['-e', 'console.log(Boolean(process.env.SCRAPINGBEE_API_KEY))'], { env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'true');
});
