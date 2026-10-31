import { NextRequest } from 'next/server';
import { createRequire } from 'module';
import { reauthPage } from '../page-html';

const cjsRequire = createRequire(import.meta.url);
// BRO-3712: shared with scripts/gmail-reauth.js (design notes in the lib).
const reauth = cjsRequire('../../../../../../scripts/lib/gmail-reauth') as {
  COOKIE_NAME: string;
  START_PATH: string;
  parseCookieValue: (v: string | undefined) => { state: string; verifier: string } | null;
  statesMatch: (a: string | null, b: string) => boolean;
  grantedScopeOk: (scope: string | null) => boolean;
  sealGrant: (g: { code: string; verifier: string }, secret: string) => string;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

const REPO = 'thomaspryor/Broadwayscore';
const WORKFLOW = 'gmail-reauth.yml';
const ISSUE = 'BRO-3712';

function clearCookie(res: Response): Response {
  res.headers.append('Set-Cookie', `${reauth.COOKIE_NAME}=; Path=${reauth.START_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return res;
}

/**
 * GET /api/admin/gmail-reauth/callback?code=...&state=...&scope=...
 *
 * Google sends the owner back here after Allow. Checks the state against the
 * cookie the start route set (so only a flow begun from a signed link counts),
 * seals the code + PKCE verifier and hands them to gmail-reauth.yml, which
 * holds the client secret, checks the account is the owner's and saves the key.
 */
export async function GET(req: NextRequest): Promise<Response> {
  if (process.env.GMAIL_REAUTH_DISABLED === 'true') return new Response(null, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const pending = reauth.parseCookieValue(req.cookies.get(reauth.COOKIE_NAME)?.value);
  if (!pending || !reauth.statesMatch(sp.get('state'), pending.state)) {
    return clearCookie(reauthPage('Could Not Verify', 'This approval could not be matched to your renewal link. Nothing was changed. Tap the link again.', 400));
  }
  if (sp.get('error')) {
    return clearCookie(reauthPage('Not Approved', 'Google reported that access was not allowed. Nothing was changed. Tap the link again and press Allow.', 200));
  }
  const code = sp.get('code');
  if (!code) {
    return clearCookie(reauthPage('Could Not Verify', 'Google did not send an approval. Nothing was changed. Tap the link again.', 400));
  }
  if (!reauth.grantedScopeOk(sp.get('scope'))) {
    return clearCookie(reauthPage('Gmail Not Ticked', 'Google did not grant read access to Gmail. Tap the link again and leave the Gmail box ticked.', 200));
  }

  const secret = process.env.APPROVAL_HMAC_SECRET;
  const ghToken = process.env.GH_DISPATCH_TOKEN;
  if (!secret || !ghToken) {
    return clearCookie(reauthPage('Not Available', 'Gmail renewal is not set up on the site yet. Nothing was changed.', 500));
  }

  const sealed = reauth.sealGrant({ code, verifier: pending.verifier }, secret);
  let ok = false;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${ghToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-gmail-reauth',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode: 'complete', sealed, issue: ISSUE } }),
      cache: 'no-store',
    });
    ok = res.ok;
    if (!ok) console.error(`gmail-reauth dispatch failed: HTTP ${res.status}`);
  } catch (err) {
    console.error('gmail-reauth dispatch failed:', (err as Error).message);
  }
  if (!ok) {
    return clearCookie(reauthPage('Something Went Wrong', 'Your approval could not be handed on. Nothing was changed. Please tap the link again in a few minutes.', 502));
  }
  return clearCookie(reauthPage('Thank You', 'Gmail is reconnecting. It finishes by itself in a few minutes. Nothing else is needed.'));
}
