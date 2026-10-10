import { NextRequest } from 'next/server';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - Broadway Scorecard</title>
<style>body{margin:0;padding:40px 20px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;}
h1{font-size:24px;margin-bottom:16px;}p{color:rgba(255,255,255,0.7);font-size:16px;line-height:1.6;max-width:480px;margin:0 auto 16px;}
a{color:#d4a574;}</style></head><body>${body}</body></html>`;
}

async function githubApi(path: string, method: string, body: object, token: string): Promise<object> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'BroadwayScorecard-Approval',
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export async function GET(req: NextRequest): Promise<Response> {
  const searchParams = req.nextUrl.searchParams;
  const issue = searchParams.get('issue');
  const token = searchParams.get('token');
  const expires = searchParams.get('expires');
  const action = searchParams.get('action');
  // planId binds this link to the exact generated plan. Without it, a
  // regenerated plan for the same issue would execute under an old link.
  const planId = searchParams.get('plan');

  const html = (title: string, body: string, status = 200) =>
    new Response(htmlPage(title, body), { status, headers: { 'Content-Type': 'text/html' } });

  if (!issue || !token || !expires || !planId) {
    return html('Invalid Link',
      '<h1>Invalid Link</h1><p>This approval link is incomplete or malformed.</p>', 400);
  }

  const expiresMs = parseInt(expires) * 1000;
  if (isNaN(expiresMs) || Date.now() > expiresMs) {
    return html('Link Expired',
      '<h1>Link Expired</h1><p>This approval link has expired. The fix was not applied.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>', 410);
  }

  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>Approval system is not configured. Please contact the admin.</p>', 500);
  }

  const actionType = action === 'reject' ? 'reject' : 'approve';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${actionType}:${issue}:${expires}:${planId}`)
    .digest('hex');

  let tokenValid = false;
  try {
    tokenValid = token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    // invalid hex
  }
  if (!tokenValid) {
    return html('Invalid Token',
      '<h1>Invalid Link</h1><p>This approval link could not be verified.</p>', 403);
  }

  const ghToken = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';

  if (actionType === 'reject') {
    const ghIssueNumber = parseInt(issue);
    const isSystematic = String(issue).includes('-systematic');
    if (ghToken && !isNaN(ghIssueNumber)) {
      try {
        await githubApi(`/repos/${repo}/issues/${ghIssueNumber}/comments`, 'POST', {
          body: isSystematic
            ? '## Systematic Fix Rejected\n\nThe proposed systematic fix was rejected by the admin via email approval link.'
            : '## Fix Rejected\n\nThe proposed fix was rejected by the admin via email approval link.\n\nThis issue needs manual attention.'
        }, ghToken);
        await githubApi(`/repos/${repo}/issues/${ghIssueNumber}/labels`, 'POST', {
          labels: [isSystematic ? 'systematic-fix-rejected' : 'fix-rejected']
        }, ghToken);
      } catch (err) {
        console.error('Failed to update issue:', (err as Error).message);
      }
      // Also mark the persisted plan rejected — without this, an unexpired
      // Approve link would still execute a plan the admin just rejected.
      try {
        await githubApi(`/repos/${repo}/actions/workflows/execute-approved-fix.yml/dispatches`, 'POST', {
          ref: 'main',
          inputs: { issue_number: String(issue), plan_id: planId, mode: 'reject' }
        }, ghToken);
      } catch (err) {
        console.error('Failed to dispatch reject persistence:', (err as Error).message);
      }
    }
    return html('Fix Rejected',
      '<h1>Fix Rejected</h1><p>The proposed fix has been cancelled. The issue will remain open for manual review.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>');
  }

  if (!ghToken) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>GitHub integration is not configured.</p>', 500);
  }

  try {
    await githubApi(`/repos/${repo}/actions/workflows/execute-approved-fix.yml/dispatches`, 'POST', {
      ref: 'main',
      inputs: { issue_number: String(issue), plan_id: planId, mode: 'apply' }
    }, ghToken);
  } catch (err) {
    const msg = (err as Error).message;
    console.error('Workflow dispatch failed:', msg);
    return html('Dispatch Failed',
      `<h1>Something Went Wrong</h1><p>Could not trigger the fix workflow. Error: ${msg}</p>` +
      `<p>You can try again or manually trigger the workflow from <a href="https://github.com/${repo}/actions">GitHub Actions</a>.</p>`, 502);
  }

  const isSystematicApproval = String(issue).includes('-systematic');
  return html('Fix Approved',
    '<h1>Fix Approved!</h1>' +
    `<p>The ${isSystematicApproval ? 'systematic ' : ''}fix for issue #${parseInt(issue)} is now being applied. You'll get a confirmation email once it's done.</p>` +
    '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>');
}
