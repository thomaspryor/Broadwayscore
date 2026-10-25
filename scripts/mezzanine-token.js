#!/usr/bin/env node
'use strict';

/**
 * BRO-5235: the Actions half of the Mezzanine session-token renewal (design
 * notes in scripts/lib/mezzanine-token-renewal.js). Run by
 * .github/workflows/mezzanine-token.yml and update-mezzanine.yml.
 *
 *   node scripts/mezzanine-token.js link --issue=BRO-N [--problem="<plain words>"] [--fresh] [--dry-run]
 *       Writes the owner's signed renewal link onto the Linear card as a
 *       DECISION NEEDED line (which emails the owner). A link with more than
 *       7 days left is kept (no second email) unless --fresh.
 *   node scripts/mezzanine-token.js check-expiry --issue=BRO-N [--dry-run]
 *       Asks Parse when MEZZANINE_SESSION_TOKEN expires (/parse/sessions/me).
 *       Expired: posts the link, exit 3. Within 30 days: posts the link with
 *       the date, exit 0. Unknown (Parse down, odd reply): warns, exit 0.
 *   node scripts/mezzanine-token.js complete --out=<file> [--issue=BRO-N]
 *       Opens the sealed paste in $MEZZANINE_TOKEN_SEALED, checks it against
 *       Parse, refuses an expired token or (with MEZZANINE_OWNER_USER_ID set)
 *       another user's, and writes it to <file> (mode 0600) for
 *       `gh secret set`. On a refusal it re-posts a fresh link with the reason.
 *   node scripts/mezzanine-token.js done --issue=BRO-N --result=success|failure [--run-url=<url>]
 *       After the secret is saved and update-mezzanine.yml has run: removes
 *       the card's link and comments the outcome.
 *
 * Env: MEZZANINE_APP_ID (check-expiry, complete), MEZZANINE_SESSION_TOKEN
 * (check-expiry), APPROVAL_HMAC_SECRET (link, check-expiry, complete),
 * LINEAR_API_KEY (any --issue write). Never prints a session token: Actions
 * logs of this repo are public, and the token is ::add-mask::ed before use.
 */

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const m = require('./lib/mezzanine-token-renewal');
const card = require('./lib/owner-link-card');

function arg(argv, name) {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function mask(value) {
  if (value && process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`);
}

function day(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function writeLink(identifier, problem, { fresh = false, dryRun = false, nowMs = Date.now() } = {}) {
  const { url, exp } = m.buildStartLink(process.env.APPROVAL_HMAC_SECRET, nowMs);
  const block = m.decisionBlock({ url, exp, problem });
  if (dryRun) {
    console.log(`would write the DECISION NEEDED link to ${identifier} (valid until ${day(exp * 1000)})${problem ? `: ${problem}` : ''}`);
    return 'dry-run';
  }
  return card.writeLinkBlock(identifier, m.LINK, block, { keepExisting: !fresh, nowMs });
}

/**
 * Asks Parse about a session token. Falls back to a one-row query when
 * /sessions/me is not available, so a missing endpoint never reads as expired.
 * @returns {Promise<{ state: 'ok'|'expired'|'unknown', expiresAtMs?: number|null, userId?: string|null, detail?: string }>}
 */
async function checkSession(token, appId, { fetchImpl = fetch, queryImpl } = {}) {
  let session;
  try {
    const res = await fetchImpl(m.SESSION_ME_URL, {
      headers: { 'X-Parse-Application-Id': appId, 'X-Parse-Session-Token': token },
      signal: AbortSignal.timeout(20000),
    });
    session = m.classifySession(res.status, await res.text());
  } catch (e) {
    session = { state: 'unknown', detail: `sessions/me unreachable (${e.name})` };
  }
  if (session.state !== 'unknown') return session;

  const query = queryImpl || require('./lib/mezzanine-parse-client').queryParse;
  try {
    await query('Production', { limit: 1, _method: 'GET' }, { appId, sessionToken: token });
    return { state: 'ok', expiresAtMs: null, userId: null, detail: `${session.detail}; a query worked` };
  } catch (e) {
    if (e && e.authFailed) return { state: 'expired', detail: 'Parse refused the token' };
    return { state: 'unknown', detail: `${session.detail}; query failed too` };
  }
}

/**
 * Opens and checks the pasted token.
 * @returns {Promise<{ ok: true, token: string, expiresAtMs: number|null, userId: string|null, note?: string }
 *                 | { ok: false, reason: string }>}  reason is plain English (shown to the owner).
 */
async function completeToken(env, deps = {}, nowMs = Date.now()) {
  const opened = m.openToken(env.MEZZANINE_TOKEN_SEALED, env.APPROVAL_HMAC_SECRET, nowMs);
  if (opened.error === 'expired') return { ok: false, reason: 'The code took too long to process. Please paste it again.' };
  if (opened.error) return { ok: false, reason: 'The code could not be read. Please paste it again.' };
  const { token } = opened;
  mask(token);
  if (!env.MEZZANINE_APP_ID) return { ok: false, reason: 'The site is missing its Mezzanine app setting, so nothing was saved.' };

  const session = await checkSession(token, env.MEZZANINE_APP_ID, deps);
  if (session.state === 'expired') {
    return { ok: false, reason: 'Mezzanine did not accept the code you pasted. Open a show in Mezzanine and copy the newest code again.' };
  }
  if (session.state === 'ok' && session.expiresAtMs && session.expiresAtMs <= nowMs) {
    return { ok: false, reason: 'The code you pasted has already expired. Copy the newest one again.' };
  }
  // The old code is still live during the 30-day warning; saving it again
  // would clear the card and still expire on schedule.
  if (session.state === 'ok' && session.expiresAtMs && session.expiresAtMs - nowMs <= m.WARN_DAYS * 86400 * 1000) {
    return { ok: false, reason: 'That is the old code, which expires soon. Sign out of Mezzanine, sign back in with Apple, and copy the new code.' };
  }
  const owner = env.MEZZANINE_OWNER_USER_ID;
  if (owner && session.userId && session.userId !== owner) {
    return { ok: false, reason: 'That code belongs to a different Mezzanine account. Use your own account on your iPhone.' };
  }
  if (owner && !session.userId) {
    return { ok: false, reason: 'Mezzanine could not confirm which account the code belongs to. Please try again in an hour.' };
  }
  // 'unknown' (Parse down) still saves: the current token is already dead,
  // and update-mezzanine.yml right after is the real test.
  return { ok: true, token, expiresAtMs: session.expiresAtMs || null, userId: session.userId || null, note: session.state === 'unknown' ? session.detail : undefined };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const mode = argv[0];
  const issue = arg(argv, 'issue');
  const dryRun = argv.includes('--dry-run');
  if (!['link', 'check-expiry', 'complete', 'done'].includes(mode)) {
    console.error('usage: mezzanine-token.js link --issue=BRO-N | check-expiry --issue=BRO-N | complete --out=<file> [--issue=BRO-N] | done --issue=BRO-N --result=success|failure');
    return 2;
  }

  if (mode === 'link') {
    if (!issue) { console.error('link needs --issue=BRO-N'); return 2; }
    await writeLink(issue, arg(argv, 'problem'), { fresh: argv.includes('--fresh'), dryRun });
    return 0;
  }

  if (mode === 'done') {
    const result = arg(argv, 'result');
    if (!issue || !['success', 'failure'].includes(result)) { console.error('done needs --issue=BRO-N --result=success|failure'); return 2; }
    const runUrl = arg(argv, 'run-url');
    const note = result === 'success'
      ? `Mezzanine token renewed by the owner and saved ${new Date().toISOString()}: MEZZANINE_SESSION_TOKEN replaced by mezzanine-token.yml; update-mezzanine.yml re-run succeeded${runUrl ? ` (${runUrl})` : ''}.`
      : `Mezzanine token renewed by the owner and saved ${new Date().toISOString()}, but the update-mezzanine.yml re-run did not succeed${runUrl ? ` (${runUrl})` : ''}. If it was an auth failure that run re-posts the link; otherwise the token is fine and the failure is in the scrape (agent work, not owner work).`;
    if (dryRun) { console.log(`would clear the link on ${issue} and comment: ${note}`); return 0; }
    await card.clearLinkBlock(issue, m.LINK, note);
    return 0;
  }

  if (mode === 'check-expiry') {
    const token = process.env.MEZZANINE_SESSION_TOKEN;
    const appId = process.env.MEZZANINE_APP_ID;
    if (!token || !appId) { console.error('::warning::MEZZANINE_APP_ID / MEZZANINE_SESSION_TOKEN not set; skipping the expiry check'); return 0; }
    mask(token);
    const session = await checkSession(token, appId, deps);
    const action = m.expiryAction(session);
    if (session.state === 'unknown') {
      console.error(`::warning::could not read the Mezzanine session (${session.detail}); no owner ask`);
      return 0;
    }
    if (session.expiresAtMs) {
      setOutput('expires_at', day(session.expiresAtMs));
      console.log(`MEZZANINE_SESSION_TOKEN expires ${day(session.expiresAtMs)}`);
    } else if (session.state === 'ok') {
      console.log('MEZZANINE_SESSION_TOKEN works (expiry date not reported)');
    }
    if (action === 'none') return 0;
    if (!issue) { console.error('check-expiry needs --issue=BRO-N to post the link'); return 2; }
    const problem = action === 'expired'
      ? 'The Mezzanine sign-in code has expired, so ratings are paused.'
      : `The Mezzanine sign-in code expires on ${day(session.expiresAtMs)}.`;
    console.log(action === 'expired' ? 'token expired: posting the renewal link' : 'token expires within 30 days: posting the renewal link');
    await writeLink(issue, problem, { dryRun });
    return action === 'expired' ? 3 : 0;
  }

  const out = arg(argv, 'out');
  if (!out) { console.error('complete needs --out=<file>'); return 2; }
  const result = await completeToken(process.env, deps);
  if (!result.ok) {
    console.error(`renewal refused: ${result.reason}`);
    if (issue) {
      try {
        // The owner just acted, so a fresh link (and email) with the reason.
        await writeLink(issue, result.reason, { fresh: true, dryRun });
      } catch (e) {
        console.error(`could not re-post the link: ${e.message}`);
      }
    }
    return 1;
  }
  fs.writeFileSync(out, result.token, { mode: 0o600 });
  if (result.note) console.error(`::warning::saving without a Parse check: ${result.note}`);
  const expires = result.expiresAtMs ? day(result.expiresAtMs) : 'unknown';
  setOutput('expires_at', expires);
  if (result.userId) setOutput('user_id', result.userId);
  console.log(`token accepted (value masked); expires ${expires}; Parse user ${result.userId || 'unknown'}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { checkSession, completeToken, main };
