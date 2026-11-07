import { NextRequest } from 'next/server';
import { createRequire } from 'module';
import { tokenPage, tokenFormPage, tokenSavedPage } from './page-html';

const cjsRequire = createRequire(import.meta.url);
// BRO-5235: shared with scripts/mezzanine-token.js (design notes in the lib).
const renewal = cjsRequire('../../../../../scripts/lib/mezzanine-token-renewal') as {
  START_PATH: string;
  SITE_ORIGIN: string;
  MAX_FORM_BYTES: number;
  PROXYMAN_APP_URL: string;
  SETUP_STEPS: string[];
  CAPTURE_STEPS: string[];
  CLEANUP_STEPS: string[];
  verifyStartLink: (e: string | null, s: string | null, secret: string | undefined) => { ok: boolean; reason?: string };
  extractToken: (pasted: string) => string | null;
  isSameOriginPost: (h: { origin: string | null; secFetchSite: string | null }) => boolean;
  sealToken: (token: string, secret: string) => string;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

const REPO = 'thomaspryor/Broadwayscore';
const WORKFLOW = 'mezzanine-token.yml';
const ISSUE = 'BRO-5235';

function disabled(): boolean {
  return process.env.MEZZANINE_TOKEN_FORM_DISABLED === 'true';
}

function linkProblem(reason: string | undefined): Response {
  if (reason === 'expired') {
    return tokenPage('Link Expired', 'This Mezzanine renewal link has expired. Nothing was changed. If Mezzanine still needs reconnecting, a new link arrives by email within a week.', 410);
  }
  if (reason === 'no-secret') {
    return tokenPage('Not Available', 'Mezzanine renewal is not set up on the site yet. Nothing was changed.', 500);
  }
  return tokenPage('Invalid Link', 'This link could not be verified. Nothing was changed.', 403);
}

function form(e: string, s: string, error?: string, status = 200): Response {
  return tokenFormPage({
    // e and s passed verifyStartLink's digits/hex checks; nothing else is echoed.
    action: `${renewal.SITE_ORIGIN}${renewal.START_PATH}`,
    e,
    s,
    appUrl: renewal.PROXYMAN_APP_URL,
    setup: renewal.SETUP_STEPS,
    capture: renewal.CAPTURE_STEPS,
    cleanup: renewal.CLEANUP_STEPS,
    error,
  }, status);
}

/**
 * GET /api/admin/mezzanine-token?e=<exp>&s=<sig>
 *
 * The owner's renewal page: iPhone steps for copying the Mezzanine session
 * token with Proxyman, and a box to paste it. Only a link signed with
 * APPROVAL_HMAC_SECRET (minted by mezzanine-token.yml onto the Linear card)
 * gets through.
 */
export async function GET(req: NextRequest): Promise<Response> {
  if (disabled()) return new Response(null, { status: 404 });
  const sp = req.nextUrl.searchParams;
  const check = renewal.verifyStartLink(sp.get('e'), sp.get('s'), process.env.APPROVAL_HMAC_SECRET);
  if (!check.ok) return linkProblem(check.reason);
  return form(String(sp.get('e')), String(sp.get('s')));
}

/**
 * POST /api/admin/mezzanine-token (form fields e, s, token)
 *
 * Re-checks the signed link and that the POST came from our own page, pulls
 * the token out of the paste, seals it and hands it to mezzanine-token.yml,
 * which checks it against Parse and saves MEZZANINE_SESSION_TOKEN. The token
 * is never logged and never leaves this function unsealed.
 */
export async function POST(req: NextRequest): Promise<Response> {
  if (disabled()) return new Response(null, { status: 404 });

  if (!renewal.isSameOriginPost({ origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site') })) {
    return tokenPage('Could Not Verify', 'This form has to be sent from the renewal page itself. Nothing was changed. Open the link from your email again.', 403);
  }
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    return tokenPage('Could Not Verify', 'The form arrived in an unexpected format. Nothing was changed.', 415);
  }
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > renewal.MAX_FORM_BYTES) return tokenPage('Too Long', 'That paste was too long. Nothing was changed. Copy only the code and try again.', 413);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > renewal.MAX_FORM_BYTES) return tokenPage('Too Long', 'That paste was too long. Nothing was changed. Copy only the code and try again.', 413);
  const fields = new URLSearchParams(raw);

  const secret = process.env.APPROVAL_HMAC_SECRET;
  const e = fields.get('e');
  const s = fields.get('s');
  const check = renewal.verifyStartLink(e, s, secret);
  if (!check.ok) return linkProblem(check.reason);

  const token = renewal.extractToken(fields.get('token') || '');
  if (!token) {
    return form(String(e), String(s), 'No Mezzanine code was found in what you pasted. It starts with r: and sits on the X-Parse-Session-Token line. Please try again.', 400);
  }

  const ghToken = process.env.GH_DISPATCH_TOKEN;
  if (!secret || !ghToken) return tokenPage('Not Available', 'Mezzanine renewal is not set up on the site yet. Nothing was changed.', 500);

  const sealed = renewal.sealToken(token, secret);
  let ok = false;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${ghToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-mezzanine-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode: 'complete', sealed, issue: ISSUE } }),
      cache: 'no-store',
    });
    ok = res.ok;
    if (!ok) console.error(`mezzanine-token dispatch failed: HTTP ${res.status}`);
  } catch (err) {
    console.error('mezzanine-token dispatch failed:', (err as Error).name);
  }
  if (!ok) {
    return form(String(e), String(s), 'The code could not be handed on just now. Nothing was changed. Please tap Save again in a few minutes.', 502);
  }
  return tokenSavedPage(renewal.CLEANUP_STEPS);
}
