#!/usr/bin/env node
'use strict';

/**
 * BRO-3712: the Actions half of the one-tap Gmail renewal (design notes in
 * scripts/lib/gmail-reauth.js). Run by .github/workflows/gmail-reauth.yml.
 *
 *   node scripts/gmail-reauth.js probe
 *       Asks Google whether it accepts our client id + callback URL (no sign-in
 *       involved). Exit 0 accepted, 1 refused (prints the OAuth error name).
 *   node scripts/gmail-reauth.js link --issue=BRO-N [--problem="<plain words>"] [--dry-run]
 *       Probes first, then writes the owner's signed one-tap link onto the
 *       Linear card as a DECISION NEEDED line (which emails the owner). If
 *       Google refuses our callback URL it writes no link and exits 1.
 *   node scripts/gmail-reauth.js complete --out=<file> [--issue=BRO-N]
 *       Opens the sealed grant in $GMAIL_REAUTH_SEALED, exchanges it for a
 *       refresh token, refuses any account but the owner's, and writes the
 *       token to <file> (mode 0600) for `gh secret set`. On failure it
 *       re-mints the card's link with a one-line reason so the owner hears.
 *   node scripts/gmail-reauth.js done --issue=BRO-N
 *       After the secret is saved: removes the card's link and comments.
 *   node scripts/gmail-reauth.js token-status
 *       Asks Google whether GMAIL_REFRESH_TOKEN still works (a refresh, no
 *       Gmail read). Exit 0 works, 3 revoked (invalid_grant), 1 anything
 *       else. finance-ingest.yml runs it after a failure and mints the
 *       owner's link only on 3, so a Gmail outage never asks for a renewal.
 *
 * Env: GMAIL_CLIENT_ID (all), GMAIL_CLIENT_SECRET (complete, token-status),
 * GMAIL_REFRESH_TOKEN (token-status),
 * APPROVAL_HMAC_SECRET (link, complete), LINEAR_API_KEY (link, complete --issue).
 * Never prints a code, verifier, access token or refresh token: Actions logs
 * of this repo are public, and each value is ::add-mask::ed before use.
 */

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const g = require('./lib/gmail-reauth');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

function arg(argv, name) {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function mask(value) {
  if (value && process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`);
}

const card = require('./lib/owner-link-card');

async function writeLink(identifier, problem, { dryRun = false, setup = false, nowMs = Date.now() } = {}) {
  const { url, exp } = g.buildStartLink(process.env.APPROVAL_HMAC_SECRET, nowMs);
  const block = g.decisionBlock({ url, exp, problem, setup });
  if (dryRun) {
    console.log(`would write the DECISION NEEDED link to ${identifier} (valid until ${new Date(exp * 1000).toISOString().slice(0, 10)})`);
    return;
  }
  // A problem note (a failed reconnect) always re-mints so the owner sees the reason.
  await card.writeLinkBlock(identifier, g.LINK, block, { keepExisting: !problem, nowMs });
}

async function clearLink(identifier, note) {
  await card.clearLinkBlock(identifier, g.LINK, note);
}

/**
 * Exchanges a sealed grant for the owner's refresh token.
 * @returns {Promise<{ ok: true, refreshToken: string } | { ok: false, reason: string }>}
 *   reason is plain English (it may be shown to the owner).
 */
async function completeGrant(env, fetchImpl = fetch, nowMs = Date.now()) {
  const grant = g.openGrant(env.GMAIL_REAUTH_SEALED, env.APPROVAL_HMAC_SECRET, nowMs);
  if (grant.error === 'expired') return { ok: false, reason: 'The approval took too long to process.' };
  if (grant.error) return { ok: false, reason: 'The approval could not be read.' };
  mask(grant.code);
  mask(grant.verifier);

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      code: grant.code,
      code_verifier: grant.verifier,
      grant_type: 'authorization_code',
      redirect_uri: g.REDIRECT_URI,
    }).toString(),
  });
  let tok = {};
  try { tok = await res.json(); } catch { /* handled below */ }
  mask(tok.access_token);
  mask(tok.refresh_token);
  mask(tok.id_token);
  if (!res.ok || !tok.access_token) {
    // error code only, never the body (it can echo the request)
    console.error(`token exchange refused: HTTP ${res.status} ${String(tok.error || '').slice(0, 60)}`);
    return { ok: false, reason: 'Google did not accept the approval.' };
  }
  if (!tok.refresh_token) return { ok: false, reason: 'Google did not return a long-lived key.' };
  if (tok.scope && !g.grantedScopeOk(tok.scope)) return { ok: false, reason: 'Gmail read access was not granted.' };

  const prof = await fetchImpl(PROFILE_URL, { signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${tok.access_token}` } });
  let profile = {};
  try { profile = await prof.json(); } catch { /* handled below */ }
  if (!prof.ok) {
    console.error(`gmail profile check failed: HTTP ${prof.status}`);
    return { ok: false, reason: 'The new key could not read Gmail.' };
  }
  if (!g.isOwnerAccount(profile.emailAddress)) {
    console.error('refused: the approving Google account is not the owner mailbox');
    return { ok: false, reason: `It was approved with a different Google account than ${g.OWNER_ACCOUNT}.` };
  }
  return { ok: true, refreshToken: tok.refresh_token };
}

/**
 * Whether the stored refresh token still mints an access token.
 * @returns {Promise<'ok' | 'revoked' | 'unknown'>}
 */
async function tokenStatus(env, fetchImpl = fetch) {
  if (!env.GMAIL_REFRESH_TOKEN) return 'revoked';
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  let body = {};
  try { body = await res.json(); } catch { /* handled below */ }
  mask(body.access_token);
  if (res.ok && body.access_token) return 'ok';
  return body.error === 'invalid_grant' ? 'revoked' : 'unknown';
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  const issue = arg(argv, 'issue');
  const clientId = process.env.GMAIL_CLIENT_ID;
  if (!['probe', 'link', 'complete', 'done', 'token-status'].includes(mode)) {
    console.error('usage: gmail-reauth.js probe | link --issue=BRO-N | complete --out=<file> [--issue=BRO-N] | done --issue=BRO-N | token-status');
    return 2;
  }
  if (mode === 'done') {
    if (!issue) { console.error('done needs --issue=BRO-N'); return 2; }
    await clearLink(issue, `Gmail renewal approved by the owner and saved ${new Date().toISOString()}: GMAIL_REFRESH_TOKEN replaced by gmail-reauth.yml, finance-ingest.yml re-dispatched.`);
    return 0;
  }
  if (!clientId) { console.error('GMAIL_CLIENT_ID is not set'); return 2; }

  if (mode === 'token-status') {
    const status = await tokenStatus(process.env);
    console.log(`GMAIL_REFRESH_TOKEN: ${status}`);
    return { ok: 0, revoked: 3 }[status] ?? 1;
  }

  if (mode === 'probe' || mode === 'link') {
    const verdict = await g.probeConsent(clientId).catch((e) => ({ ok: false, error: `probe-failed (${e.name})` }));
    // redirect_uri_mismatch is the one refusal the owner can fix: the start
    // page then walks them through adding our callback in Google settings.
    // A client error (bad or deleted client id) can't be fixed by a tap, so
    // no link. Anything else unexpected still gets a link: the start page
    // re-asks Google live, and a missing link costs the owner more.
    const setup = verdict.error === 'redirect_uri_mismatch';
    if (!verdict.ok) {
      console.error(`Google refused the consent request: ${verdict.error} (redirect ${g.REDIRECT_URI})`);
      if (mode === 'probe' || /client/.test(verdict.error)) return 1;
      if (!setup) console.error('::warning::unexpected Google answer; writing the link anyway');
      else console.error(`the link will show the one-time setup step (${g.consoleClientUrl(clientId).split('?')[0].replace(/oauthclient\/.*/, 'oauthclient/...')})`);
    } else {
      console.log(`Google accepts the consent request (client id + ${g.REDIRECT_URI}, scope ${g.SCOPE})`);
    }
    if (mode === 'probe') return 0;
    if (!issue) { console.error('link needs --issue=BRO-N'); return 2; }
    await writeLink(issue, arg(argv, 'problem'), { dryRun: argv.includes('--dry-run'), setup });
    return 0;
  }

  const out = arg(argv, 'out');
  if (!out) { console.error('complete needs --out=<file>'); return 2; }
  const result = await completeGrant(process.env);
  if (!result.ok) {
    console.error(`renewal failed: ${result.reason}`);
    if (issue) {
      try {
        await writeLink(issue, `Gmail reconnect did not finish: ${result.reason}`);
      } catch (e) {
        console.error(`could not re-post the link: ${e.message}`);
      }
    }
    return 1;
  }
  fs.writeFileSync(out, result.refreshToken, { mode: 0o600 });
  console.log('refresh token minted for the owner mailbox (value masked)');
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { completeGrant, tokenStatus, main };
