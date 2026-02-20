const crypto = require('crypto');
const https = require('https');

function htmlPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - Broadway Scorecard</title>
<style>body{margin:0;padding:40px 20px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;}
h1{font-size:24px;margin-bottom:16px;}p{color:rgba(255,255,255,0.7);font-size:16px;line-height:1.6;max-width:480px;margin:0 auto 16px;}
a{color:#d4a574;}</style></head><body>${body}</body></html>`;
}

module.exports = async (req, res) => {
  const { issue, token, expires, action } = req.query;

  // Validate params
  if (!issue || !token || !expires) {
    return res.status(400).send(htmlPage('Invalid Link',
      '<h1>Invalid Link</h1><p>This approval link is incomplete or malformed.</p>'));
  }

  // Check expiry
  const expiresMs = parseInt(expires) * 1000;
  if (isNaN(expiresMs) || Date.now() > expiresMs) {
    return res.status(410).send(htmlPage('Link Expired',
      '<h1>Link Expired</h1><p>This approval link has expired. The fix was not applied.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>'));
  }

  // Verify HMAC
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) {
    return res.status(500).send(htmlPage('Configuration Error',
      '<h1>Server Error</h1><p>Approval system is not configured. Please contact the admin.</p>'));
  }

  const actionType = action === 'reject' ? 'reject' : 'approve';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${actionType}:${issue}:${expires}`)
    .digest('hex');

  if (token.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))) {
    return res.status(403).send(htmlPage('Invalid Token',
      '<h1>Invalid Link</h1><p>This approval link could not be verified.</p>'));
  }

  // Handle rejection
  if (actionType === 'reject') {
    // Comment on the issue to note rejection
    // Extract numeric issue number for GitHub API (e.g., "133-systematic" → 133)
    const ghIssueNumber = parseInt(issue);
    const isSystematic = String(issue).includes('-systematic');
    const ghToken = process.env.GH_DISPATCH_TOKEN;
    const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
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
        console.error('Failed to update issue:', err.message);
      }
    }
    return res.status(200).send(htmlPage('Fix Rejected',
      '<h1>Fix Rejected</h1><p>The proposed fix has been cancelled. The issue will remain open for manual review.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>'));
  }

  // Dispatch the execute workflow
  const ghToken = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';

  if (!ghToken) {
    return res.status(500).send(htmlPage('Configuration Error',
      '<h1>Server Error</h1><p>GitHub integration is not configured.</p>'));
  }

  try {
    await githubApi(`/repos/${repo}/actions/workflows/execute-approved-fix.yml/dispatches`, 'POST', {
      ref: 'main',
      inputs: { issue_number: String(issue) }
    }, ghToken);
  } catch (err) {
    console.error('Workflow dispatch failed:', err.message);
    return res.status(502).send(htmlPage('Dispatch Failed',
      `<h1>Something Went Wrong</h1><p>Could not trigger the fix workflow. Error: ${err.message}</p>` +
      `<p>You can try again or manually trigger the workflow from <a href="https://github.com/${repo}/actions">GitHub Actions</a>.</p>`));
  }

  const isSystematicApproval = String(issue).includes('-systematic');
  return res.status(200).send(htmlPage('Fix Approved',
    '<h1>Fix Approved!</h1>' +
    `<p>The ${isSystematicApproval ? 'systematic ' : ''}fix for issue #${parseInt(issue)} is now being applied. You'll get a confirmation email once it's done.</p>` +
    '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>'));
};

function githubApi(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'BroadwayScorecard-Approval',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body ? JSON.parse(body) : {});
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
