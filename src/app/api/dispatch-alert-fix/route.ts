import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GH_API_BASE = 'https://api.github.com';
const REPO_OWNER = 'thomaspryor';
const REPO_NAME = 'Broadwayscore';

// Whitelist of safe fix IDs → workflow dispatch targets.
// Never accept arbitrary workflow names from the token — this prevents
// a token forgery from dispatching arbitrary workflows.
// BSC Daily health-check uses workflow filenames directly as fixId.
const FIX_WORKFLOWS: Record<string, { workflow: string; inputs?: Record<string, string> }> = {
  redeploy: {
    workflow: 'vercel-deploy.yml',
    inputs: { reason: 'approve-fix: operator-approved redeploy' },
  },
  'rebuild-reviews.yml': { workflow: 'rebuild-reviews.yml' },
  'update-show-status.yml': { workflow: 'update-show-status.yml' },
  'update-lottery-rush.yml': { workflow: 'update-lottery-rush.yml' },
};

interface TokenPayload {
  fixId: string;
  alertTitle: string;
  expiry: number;
}

function validateToken(token: string): TokenPayload {
  const secret = process.env.ALERT_TOKEN_SECRET;
  if (!secret) throw new Error('Server misconfiguration: ALERT_TOKEN_SECRET not set');

  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) throw new Error('Malformed token');

  const encoded = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);

  if (!/^[0-9a-f]+$/.test(sig)) throw new Error('Invalid signature format');

  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid signature');
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as TokenPayload;
  } catch {
    throw new Error('Malformed token payload');
  }

  if (!payload.fixId || !payload.alertTitle || !payload.expiry) {
    throw new Error('Incomplete token payload');
  }

  if (Date.now() > payload.expiry) throw new Error('Token expired');

  return payload;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return htmlResponse(errorHtml('Missing token'), 400);
  }

  let payload: TokenPayload;
  try {
    payload = validateToken(token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid token';
    return htmlResponse(errorHtml(msg), 400);
  }

  const fix = FIX_WORKFLOWS[payload.fixId];
  if (!fix) {
    return htmlResponse(errorHtml(`Unknown fix: ${payload.fixId}`), 400);
  }

  const ghToken = process.env.REVIEW_TEXTS_TOKEN;
  if (!ghToken) {
    return htmlResponse(errorHtml('Server misconfiguration'), 500);
  }

  const res = await fetch(
    `${GH_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${fix.workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${ghToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-approve-fix',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: fix.inputs ?? {} }),
      cache: 'no-store',
    },
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('[approve-fix] GH dispatch failed:', res.status, err);
    return htmlResponse(errorHtml(`Dispatch failed (${res.status})`), 502);
  }

  const runUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${fix.workflow}`;
  return htmlResponse(successHtml(payload.alertTitle, fix.workflow, runUrl), 200);
}

function htmlResponse(body: string, status: number) {
  return new NextResponse(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function successHtml(alertTitle: string, workflow: string, runUrl: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Fix Approved — Broadway Scorecard</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; }
    .icon { font-size: 52px; margin-bottom: 12px; }
    h1 { color: #27ae60; font-size: 22px; margin-bottom: 8px; }
    p { color: #555; line-height: 1.6; margin: 6px 0; }
    .detail { color: #888; font-size: 13px; }
    a { color: #3498db; }
  </style>
</head>
<body>
  <div class="icon">&#x2705;</div>
  <h1>Fix approved and running</h1>
  <p>${escapeHtml(alertTitle)}</p>
  <p class="detail">Running: <strong>${escapeHtml(workflow)}</strong></p>
  <p class="detail">You'll receive a confirmation email when complete.</p>
  <p style="margin-top:24px;"><a href="${escapeHtml(runUrl)}">View workflow run &rarr;</a></p>
</body>
</html>`;
}

function errorHtml(message: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Error — Broadway Scorecard</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; }
    .icon { font-size: 52px; margin-bottom: 12px; }
    h1 { color: #e74c3c; font-size: 22px; margin-bottom: 8px; }
    p { color: #555; }
  </style>
</head>
<body>
  <div class="icon">&#x274C;</div>
  <h1>Could not approve fix</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
