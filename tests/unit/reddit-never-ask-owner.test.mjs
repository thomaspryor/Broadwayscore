// BRO-7337/BRO-7348: Reddit outage and missing-credentials messages must say plainly not to ask
// the owner to create a Reddit app. Fails if the sentence is removed from any of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NEVER_ASK_REDDIT_APP } = require('../../scripts/lib/reddit-owner-guard.js');
const api = require('../../scripts/lib/reddit-api.js');
const MEMORY = 'cloud-memory/feedback_reddit_app_creation_broken.md';

test('guard sentence says not to ask the owner for an app or REDDIT_CLIENT_ID, and names the memory file', () => {
  assert.match(NEVER_ASK_REDDIT_APP, /Do NOT ask the owner to create a Reddit app/);
  assert.match(NEVER_ASK_REDDIT_APP, /REDDIT_CLIENT_ID/);
  assert.ok(NEVER_ASK_REDDIT_APP.includes(MEMORY));
  assert.ok(fs.existsSync(MEMORY), 'the memory file the message points at must exist');
});

test('credentials-missing message carries the guard', () => {
  assert.ok(api.missingOauthCredsMessage().includes(NEVER_ASK_REDDIT_APP));
});

test('outage + stale alert descriptions and the OAuth failure error carry the guard', () => {
  const freshness = fs.readFileSync('scripts/check-reddit-freshness.js', 'utf8');
  assert.equal((freshness.match(/NEVER_ASK_REDDIT_APP/g) || []).length >= 3, true, 'require + outage + stale description');
  assert.ok(/outage[\s\S]*NEVER_ASK_REDDIT_APP[\s\S]*BRO-7337/.test(freshness));
  const src = fs.readFileSync('scripts/lib/reddit-api.js', 'utf8');
  assert.match(src, /Reddit OAuth token \$\{res\.statusCode\}[^\n]*NEVER_ASK_REDDIT_APP/);
});

test('no message tells anyone to check/mint the Reddit client secrets as an action', () => {
  const freshness = fs.readFileSync('scripts/check-reddit-freshness.js', 'utf8');
  assert.doesNotMatch(freshness, /Check the scrape step log and\s*'?\s*\+?\s*'?the REDDIT_CLIENT_ID/);
});
