import { NextRequest } from 'next/server';
import { createRequire } from 'module';
import { reauthPage, reauthSetupPage } from './page-html';

const cjsRequire = createRequire(import.meta.url);
// BRO-3712: shared with scripts/gmail-reauth.js (design notes in the lib).
const reauth = cjsRequire('../../../../../scripts/lib/gmail-reauth') as {
  COOKIE_NAME: string;
  COOKIE_MAX_AGE_S: number;
  START_PATH: string;
  REDIRECT_URI: string;
  SITE_ORIGIN: string;
  consoleClientUrl: (clientId: string) => string;
  probeConsent: (clientId: string) => Promise<{ ok: boolean; error: string | null }>;
  verifyStartLink: (e: string | null, s: string | null, secret: string | undefined) => { ok: boolean; reason?: string };
  makeAuthRequest: () => { state: string; verifier: string; challenge: string };
  cookieValue: (r: { state: string; verifier: string }) => string;
  buildConsentUrl: (r: { clientId: string; state: string; challenge: string }) => string;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * GET /api/admin/gmail-reauth?e=<exp>&s=<sig>
 *
 * Start of the one-tap Gmail renewal. Only a link signed with
 * APPROVAL_HMAC_SECRET (minted by gmail-reauth.yml onto the Linear card) gets
 * through; it then pins a CSRF state + PKCE verifier in a short-lived cookie
 * and sends the browser to Google's consent screen for gmail.readonly.
 * If Google does not accept our callback URL yet, it shows the one-time setup
 * step instead (add the URL in Google settings, then Continue = this link).
 */
export async function GET(req: NextRequest): Promise<Response> {
  if (process.env.GMAIL_REAUTH_DISABLED === 'true') return new Response(null, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const check = reauth.verifyStartLink(sp.get('e'), sp.get('s'), process.env.APPROVAL_HMAC_SECRET);
  if (!check.ok) {
    if (check.reason === 'expired') {
      return reauthPage('Link Expired', 'This Gmail renewal link has expired. Nothing was changed. If Gmail still needs reconnecting, a new link arrives by email within a day.', 410);
    }
    if (check.reason === 'no-secret') {
      return reauthPage('Not Available', 'Gmail renewal is not set up on the site yet. Nothing was changed.', 500);
    }
    return reauthPage('Invalid Link', 'This link could not be verified. Nothing was changed.', 403);
  }

  const clientId = process.env.GMAIL_CLIENT_ID;
  if (!clientId) {
    return reauthPage('Not Available', 'Gmail renewal is not set up on the site yet. Nothing was changed.', 500);
  }

  // A probe failure (network) falls through to Google, which shows its own error.
  const probe = await reauth.probeConsent(clientId).catch(() => null);
  if (probe && probe.error === 'redirect_uri_mismatch') {
    return reauthSetupPage({
      consoleUrl: reauth.consoleClientUrl(clientId),
      redirectUri: reauth.REDIRECT_URI,
      // e and s passed verifyStartLink's digits/hex checks; nothing else is echoed.
      continueUrl: `${reauth.SITE_ORIGIN}${reauth.START_PATH}?e=${sp.get('e')}&s=${sp.get('s')}`,
    });
  }

  const request = reauth.makeAuthRequest();
  const res = new Response(null, {
    status: 302,
    headers: {
      Location: reauth.buildConsentUrl({ clientId, state: request.state, challenge: request.challenge }),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
  // lax, not strict: the cookie must ride Google's top-level redirect back.
  res.headers.append('Set-Cookie', [
    `${reauth.COOKIE_NAME}=${reauth.cookieValue(request)}`,
    `Path=${reauth.START_PATH}`,
    `Max-Age=${reauth.COOKIE_MAX_AGE_S}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; '));
  return res;
}
