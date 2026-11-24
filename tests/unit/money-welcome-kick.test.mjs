// BRO-7704: DB-trigger kick path. Real functions, real route, real migration text (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const kick = require('../../src/lib/money-welcome-kick.js');

test('isAuthorized: only the exact non-empty secret passes', () => {
  assert.equal(kick.isAuthorized('s3cret', 's3cret'), true);
  assert.equal(kick.isAuthorized('s3cret ', 's3cret'), false);
  assert.equal(kick.isAuthorized('', ''), false, 'empty secret never authorizes');
  assert.equal(kick.isAuthorized(null, 's3cret'), false);
  assert.equal(kick.isAuthorized('x', undefined), false);
});

const mig = fs.readFileSync(new URL('../../supabase/migrations/20261123c_money_signup_kick_trigger.sql', import.meta.url), 'utf8');
test('migration: AFTER INSERT trigger posts the secret header to /api/money-welcome-kick, never blocks the insert', () => {
  assert.match(mig, /AFTER INSERT ON public\.money_scorecard_signups/);
  assert.match(mig, /net\.http_post/);
  assert.match(mig, /'x-kick-secret', cfg\.secret/);
  assert.match(mig, /api\/money-welcome-kick/);
  assert.match(mig, /EXCEPTION WHEN OTHERS/, 'a failed kick must not roll back the sign-up');
  assert.match(mig, /ENABLE ROW LEVEL SECURITY/);
  assert.match(mig, /REVOKE ALL ON public\.money_welcome_kick_config FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(mig, /INSERT INTO public\.money_welcome_kick_config[^\n]*'[0-9a-f]{20,}'/, 'no real secret committed');
});

test('workflow keeps the hourly cron backstop and the welcomed_at claim', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/money-welcome.yml', import.meta.url), 'utf8');
  assert.match(wf, /cron: '17 \* \* \* \*'/);
  assert.match(wf, /workflow_dispatch:/);
  const send = fs.readFileSync(new URL('../../scripts/lib/money-welcome.js', import.meta.url), 'utf8');
  assert.match(send, /welcomed_at/);
});
// Route behavior (401 / dispatch / queued skip) is in src/app/api/__tests__/money-welcome-kick-route.test.mjs (tsx manifest).
