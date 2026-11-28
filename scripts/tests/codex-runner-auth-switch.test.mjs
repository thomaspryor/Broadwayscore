// BRO-7596: the Codex runner's reviewer uses the subscription token when it is set and falls back to the API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../lib/reviewer-auth.js');
const L = require('../lib/gemini-usage-ledger.js');
const R = require('../lib/codex-runner.js');

const KEY = 'fake-api-key-not-real';
const TOK = 'fake-oauth-token-not-real';

test('token absent (today): API key, no behaviour change', () => {
  for (const env of [{ ANTHROPIC_API_KEY: KEY }, { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: '' }, { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: '  ' }]) {
    const p = A.chooseReviewerAuth(env);
    assert.equal(p.mode, 'api-key');
    assert.equal(p.env.ANTHROPIC_API_KEY, KEY);
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in p.env, false);
  }
});

test('token set: oauth, and the API key is dropped (never blanked)', () => {
  const p = A.chooseReviewerAuth({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: 'x', ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_OAUTH_TOKEN: TOK });
  assert.equal(p.mode, 'oauth');
  assert.equal(p.env.CLAUDE_CODE_OAUTH_TOKEN, TOK);
  assert.equal(p.env.ANTHROPIC_BASE_URL, 'https://example.invalid');
  assert.equal('ANTHROPIC_API_KEY' in p.env, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in p.env, false);
});

test('token only (no key): oauth; neither: none', () => {
  assert.equal(A.chooseReviewerAuth({ CLAUDE_CODE_OAUTH_TOKEN: TOK }).mode, 'oauth');
  assert.equal(A.chooseReviewerAuth({}).mode, 'none');
  assert.equal(A.chooseReviewerAuth(undefined).mode, 'none');
});

test('after a token auth failure: API key for the rest of the run', () => {
  const p = A.chooseReviewerAuth({ ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOK }, { oauthFailed: true });
  assert.equal(p.mode, 'api-key');
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in p.env, false);
  assert.equal(A.chooseReviewerAuth({ CLAUDE_CODE_OAUTH_TOKEN: TOK }, { oauthFailed: true }).mode, 'none');
});

test('isAuthFailure: rejected login yes, budget/model errors and clean runs no', () => {
  assert.equal(A.isAuthFailure({ code: 1, out: 'API Error: 401 {"type":"authentication_error","message":"invalid bearer token"}' }), true);
  assert.equal(A.isAuthFailure({ code: 1, error: 'error_during_execution', text: 'OAuth token has expired. Please run /login' }), true);
  assert.equal(A.isAuthFailure({ code: 1, out: 'Not logged in' }), true);
  assert.equal(A.isAuthFailure({ code: 0, error: 'error_max_budget_usd', text: 'budget exceeded' }), false);
  assert.equal(A.isAuthFailure({ code: 1, out: 'model overloaded 529' }), false);
  assert.equal(A.isAuthFailure({ code: 0, text: 'SHIP. mentions authentication_error in a diff' }), false);
});

test('shouldFallBack only from oauth with a key available', () => {
  assert.equal(A.shouldFallBack({ mode: 'oauth', failure: true, apiKeyAvailable: true }), true);
  assert.equal(A.shouldFallBack({ mode: 'oauth', failure: true, apiKeyAvailable: false }), false);
  assert.equal(A.shouldFallBack({ mode: 'oauth', failure: false, apiKeyAvailable: true }), false);
  assert.equal(A.shouldFallBack({ mode: 'api-key', failure: true, apiKeyAvailable: true }), false);
});

test('applyAuthToEnv removes the withheld credentials from the runner-as-itself env', () => {
  const env = { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOK, PATH: '/bin' };
  assert.deepEqual(Object.keys(A.applyAuthToEnv(env, { mode: 'oauth' })).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'PATH']);
  assert.deepEqual(Object.keys(A.applyAuthToEnv(env, { mode: 'api-key' })).sort(), ['ANTHROPIC_API_KEY', 'PATH']);
});

test('ledger row records the chosen auth, and the runner passes it', () => {
  assert.equal(L.buildClaudeCheckRow({ model: 'opus', costUsd: 0, auth: 'oauth' }).auth, 'oauth');
  assert.equal(L.buildClaudeCheckRow({ model: 'opus', costUsd: 0, auth: 'api-key' }).auth, 'api-key');
  const src = fs.readFileSync(new URL('../codex/daily-runner.js', import.meta.url), 'utf8');
  assert.match(src, /recordClaudeCheck\(\{[^}]*auth: RA\.ledgerAuth\(authPick\)/);
  assert.match(src, /chooseReviewerAuth\(process\.env, \{ oauthFailed: oauthTokenFailed \}\)/);
});

test('workflow wires the secret and keeps the API key fallback', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/codex-runner.yml', import.meta.url), 'utf8');
  assert.match(y, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(y, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
});

test('sandbox auth gate still accepts either login', () => {
  assert.equal(R.reviewerSandboxAuth({ CLAUDE_CODE_OAUTH_TOKEN: TOK }), true);
  assert.equal(R.reviewerSandboxAuth({ ANTHROPIC_API_KEY: KEY }), true);
});

test('ledgerAuth: none (stored container login) keeps the ledger default; empty token is never handed over', () => {
  assert.equal(A.ledgerAuth({ mode: 'oauth' }), 'oauth');
  assert.equal(A.ledgerAuth({ mode: 'api-key' }), 'api-key');
  assert.equal(A.ledgerAuth(A.chooseReviewerAuth({})), undefined);
  assert.equal(L.buildClaudeCheckRow({ model: 'opus', costUsd: 0, auth: A.ledgerAuth({ mode: 'none' }) }).auth, process.env.ANTHROPIC_API_KEY ? 'api-key' : 'oauth');
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in A.applyAuthToEnv({ CLAUDE_CODE_OAUTH_TOKEN: '', PATH: 'x' }, { mode: 'none' }), false);
});

test('isAuthFailure ignores a long review that merely mentions auth errors', () => {
  const longReview = 'The diff handles 401 unauthorized responses. '.repeat(40);
  assert.equal(A.isAuthFailure({ code: 1, error: 'error_max_turns', text: longReview, out: longReview }), false);
  assert.equal(A.isAuthFailure({ code: 1, error: 'success', text: 'Invalid API key · Please run /login' }), true);
});

test('CODEX_REVIEWER_AUTH=api-key forces the API key even with a token set (rollback switch)', () => {
  const p = A.chooseReviewerAuth({ ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOK, CODEX_REVIEWER_AUTH: 'api-key' });
  assert.equal(p.mode, 'api-key');
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in p.env, false);
});

test('plan-limit hits fall back; a bare 401 in unrelated output does not', () => {
  assert.equal(A.isAuthFailure({ code: 1, error: 'error_during_execution', text: 'Claude usage limit reached' }), true);
  assert.equal(A.isAuthFailure({ code: 1, out: 'git: remote returned 401 for some other thing' }), false);
});

test('workflow forwards the rollback switch; summary does not count subscription rows as spend', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/codex-runner.yml', import.meta.url), 'utf8');
  assert.match(y, /CODEX_REVIEWER_AUTH: \$\{\{ vars\.CODEX_REVIEWER_AUTH \}\}/);
  const S = require('../lib/llm-usage-summary.js');
  const t = S.summarize([{ ts: '2026-11-15T00:00:00Z', provider: 'anthropic', costUsd: 2, auth: 'oauth', calls: 1 }, { ts: '2026-11-15T00:00:00Z', provider: 'anthropic', costUsd: 1, auth: 'api-key', calls: 1 }]);
  assert.equal(t.providers.anthropic.usd, 1);
});
