import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { CONFIRM_FIELD_HTML, isConfirmedPost } from '@/lib/confirm-post';

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

/** Strip HTML-significant characters and cap length for safe echoing into pages. */
function sanitize(input: string, maxLen = 200): string {
  return input.replace(/[<>&"]/g, '').slice(0, maxLen);
}

type HtmlFn = (title: string, body: string, status?: number) => Response;

interface ApprovalLink {
  issue: string;
  token: string;
  expires: string;
  planId: string;
  actionType: 'approve' | 'reject';
}

// Shared by GET and POST so the confirm page only ever shows a button for a
// link that would actually work when tapped.
function validateLink(req: NextRequest, html: HtmlFn): ApprovalLink | Response {
  const searchParams = req.nextUrl.searchParams;
  const issue = searchParams.get('issue');
  const token = searchParams.get('token');
  const expires = searchParams.get('expires');
  const action = searchParams.get('action');
  // planId binds this link to the exact generated plan. Without it, a
  // regenerated plan for the same issue would execute under an old link.
  const planId = searchParams.get('plan');

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

  // HMAC message must match scripts/lib/approval-link.js generateApprovalUrl.
  const actionType = action === 'reject' ? 'reject' : 'approve';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${actionType}:${issue}:${expires}:${planId}`)
    .digest('hex');

  let tokenValid = false;
  // Require exactly 64 lowercase hex chars: Buffer.from(_, 'hex') silently
  // truncates at the first non-hex char (same guard as autonomous-action).
  // Lowercased first: the signer emits lowercase, but a mail client that
  // changes case must not break a link the old check accepted.
  const tokenHex = token.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(tokenHex)) {
    try {
      tokenValid = crypto.timingSafeEqual(Buffer.from(tokenHex, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      // invalid hex
    }
  }
  if (!tokenValid) {
    return html('Invalid Token',
      '<h1>Invalid Link</h1><p>This approval link could not be verified.</p>', 403);
  }

  return { issue, token, expires, planId, actionType };
}

function makeHtml(): HtmlFn {
  return (title, body, status = 200) =>
    new Response(htmlPage(title, body), { status, headers: { 'Content-Type': 'text/html' } });
}

// GET never mutates (BRO-5262): mail-security link scanners and preview
// fetchers open every URL in an email, so a state-changing GET let a robot
// approve or reject a fix with nobody tapping. GET renders a one-button
// confirm form; only the POST it submits acts. The emailed link format is
// unchanged, so links already sent keep working (one extra tap).
export async function GET(req: NextRequest): Promise<Response> {
  const html = makeHtml();
  const link = validateLink(req, html);
  if (link instanceof Response) return link;

  const qs = new URLSearchParams({
    issue: link.issue, token: link.token, expires: link.expires, action: link.actionType, plan: link.planId,
  });
  const isSystematic = link.issue.includes('-systematic');
  const issueLabel = `issue #${sanitize(String(parseInt(link.issue)), 20)}`;
  const isReject = link.actionType === 'reject';
  const heading = isReject ? 'Reject this fix?' : 'Approve this fix?';
  const detail = isReject
    ? `Pressing the button cancels the proposed ${isSystematic ? 'systematic ' : ''}fix for ${issueLabel}. The issue stays open for manual review.`
    : `Pressing the button applies the proposed ${isSystematic ? 'systematic ' : ''}fix for ${issueLabel}. You'll get a confirmation email once it's done.`;
  const color = isReject ? '#dc2626' : '#16a34a';
  return html(isReject ? 'Confirm Reject' : 'Confirm Fix',
    `<h1>${heading}</h1><p>${detail}</p>` +
    // Disable on submit so a double tap cannot dispatch twice.
    `<form method="POST" action="/api/approve-fix?${qs.toString()}" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Working…';">` +
    CONFIRM_FIELD_HTML +
    `<button type="submit" style="background:${color};color:#fff;border:0;font-size:17px;font-weight:700;padding:14px 36px;border-radius:10px;cursor:pointer;">${isReject ? 'Reject fix' : 'Approve fix'}</button>` +
    '</form>' +
    '<p style="margin-top:24px;font-size:14px;">Nothing has happened yet. To do nothing, just close this page.</p>' +
    '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>');
}

export async function POST(req: NextRequest): Promise<Response> {
  const html = makeHtml();
  const link = validateLink(req, html);
  if (link instanceof Response) return link;
  if (!(await isConfirmedPost(req))) {
    return html('Not Confirmed',
      '<h1>Nothing Was Changed</h1><p>Open the link from your email and press the button on that page.</p>', 400);
  }
  const { issue, planId, actionType } = link;

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
      `<h1>Something Went Wrong</h1><p>Could not trigger the fix workflow. Error: ${sanitize(msg)}</p>` +
      `<p>You can try again or manually trigger the workflow from <a href="https://github.com/${repo}/actions">GitHub Actions</a>.</p>`, 502);
  }

  const isSystematicApproval = String(issue).includes('-systematic');
  return html('Fix Approved',
    '<h1>Fix Approved!</h1>' +
    `<p>The ${isSystematicApproval ? 'systematic ' : ''}fix for issue #${parseInt(issue)} is now being applied. You'll get a confirmation email once it's done.</p>` +
    '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>');
}
