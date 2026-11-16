/**
 * verify-codex-check-oauth-live.test.mjs: the RECHECK-AFTER acceptance command for BRO-7596.
 * Asserts against LIVE data: once the owner stores the CLAUDE_CODE_OAUTH_TOKEN repo secret, the
 * Codex runner's Claude checks must record rows with auth=oauth in the usage ledger. A red run
 * before the token is stored (or if the token was rejected and the runner fell back to the API
 * key) is the signal this stamp exists to produce, not a code regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, '..', 'data', 'audit', 'gemini-usage-ledger.jsonl');
const SINCE = Date.parse('2026-11-16T00:00:00Z');
const CHECKABLE_FROM = Date.parse('2026-11-23T00:00:00Z');

test('the Codex runner recorded at least one Claude check billed through the subscription (auth=oauth)', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before the RECHECK-AFTER date 2026-11-23',
}, () => {
  const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const checks = rows.filter((r) => r.provider === 'anthropic' && r.script === 'scripts/codex/daily-runner.js' && Date.parse(r.ts) >= SINCE);
  const oauth = checks.filter((r) => r.auth === 'oauth');
  assert.ok(oauth.length > 0, `no auth=oauth Claude check rows since 2026-11-16 (${checks.length} check rows, auth values: ${[...new Set(checks.map((r) => r.auth))].join(',') || 'none'}). The owner has not stored CLAUDE_CODE_OAUTH_TOKEN yet, or the token was rejected and the runner fell back to the API key.`);
});
