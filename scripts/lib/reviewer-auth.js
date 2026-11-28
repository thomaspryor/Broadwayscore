// BRO-7596: which Claude login the Codex runner's reviewer (`claude -p`) uses. Pure, no I/O.
// The subscription token (CLAUDE_CODE_OAUTH_TOKEN) is used whenever it is set; the pay-as-you-go
// ANTHROPIC_API_KEY is then withheld from the reviewer, because the CLI ranks the API key above
// the token when both are present (empty-string behaviour is undocumented, so a variable is
// dropped, never blanked). If the token fails on auth, the runner falls back to the key.

const has = (v) => typeof v === 'string' && v.trim() !== '';
// Credentials that outrank (or replace) the subscription token inside the CLI.
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * Pick the reviewer's login.
 * @param {object} env process env (only presence is read here)
 * @param {{oauthFailed?: boolean}} [state] oauthFailed: the token already failed on auth this run
 * @returns {{mode: 'oauth'|'api-key'|'none', env: object}} env holds only the auth variables to hand over
 */
function chooseReviewerAuth(env, { oauthFailed = false } = {}) {
  const e = env || {};
  const endpoint = Object.fromEntries(Object.entries(e).filter(([k, v]) => /^ANTHROPIC_/.test(k) && !KEY_VARS.includes(k) && has(v)));
  // CODEX_REVIEWER_AUTH=api-key: one-variable rollback to pay-as-you-go without editing the workflow.
  if (has(e.CLAUDE_CODE_OAUTH_TOKEN) && !oauthFailed && String(e.CODEX_REVIEWER_AUTH || '').trim() !== 'api-key') {
    return { mode: 'oauth', env: { ...endpoint, CLAUDE_CODE_OAUTH_TOKEN: e.CLAUDE_CODE_OAUTH_TOKEN } };
  }
  const keys = Object.fromEntries(KEY_VARS.filter((k) => has(e[k])).map((k) => [k, e[k]]));
  if (has(e.ANTHROPIC_API_KEY)) return { mode: 'api-key', env: { ...endpoint, ...keys } };
  return { mode: 'none', env: {} };
}

// What a rejected login (or an exhausted subscription plan, which the API key can still serve) looks like in the CLI's JSON result or output (not a budget or model error).
const AUTH_FAILURE = /(authentication[_ ]error|invalid (bearer )?token|invalid[_ ]api[_ ]key|oauth token (has )?(expired|revoked)|token (has )?(expired|been revoked)|not logged in|please run \/login|api error:? 401|401 unauthorized|usage limit|limit reached|rate limit reached|credit balance is too low)/i;

/**
 * True when a failed check reads as a rejected login. A clean run is never an auth failure, and the
 * reviewer's own prose is not searched: a real review is long, a login error is a one-line message,
 * so result text counts only when it is short; raw output counts only when no JSON result came back.
 */
const SHORT_ERROR_TEXT = 500;
function isAuthFailure({ code = 0, error = null, text = '', out = '' } = {}) {
  if (code === 0 && !error) return false;
  const t = String(text || '');
  const parts = [String(error || '')];
  if (t.length > 0 && t.length <= SHORT_ERROR_TEXT) parts.push(t);
  if (t.length === 0) parts.push(String(out || '').slice(0, 2000));
  return AUTH_FAILURE.test(parts.join('\n'));
}

/** True when the failed oauth attempt should be retried on the API key (once). */
function shouldFallBack({ mode, failure, apiKeyAvailable }) {
  return mode === 'oauth' && Boolean(failure) && Boolean(apiKeyAvailable);
}

/** For the runner-as-itself path: the scrubbed env with the credentials this pick withholds removed. */
function applyAuthToEnv(env, pick) {
  const out = { ...env };
  if (pick && pick.mode === 'oauth') for (const k of KEY_VARS) delete out[k];
  if (!pick || pick.mode !== 'oauth') delete out.CLAUDE_CODE_OAUTH_TOKEN; // api-key or none: never hand over a token (or an empty one)
  return out;
}

/** The ledger's auth label for a pick. 'none' (a stored container login) -> undefined so the ledger's own default applies, as before. */
function ledgerAuth(pick) {
  if (pick && pick.mode === 'oauth') return 'oauth';
  if (pick && pick.mode === 'api-key') return 'api-key';
  return undefined;
}

module.exports = { applyAuthToEnv, ledgerAuth, chooseReviewerAuth, isAuthFailure, shouldFallBack, KEY_VARS };
