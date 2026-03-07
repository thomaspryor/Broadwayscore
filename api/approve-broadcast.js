const crypto = require('crypto');
const https = require('https');

function htmlPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - Broadway Scorecard</title>
<style>body{margin:0;padding:40px 20px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;}
h1{font-size:24px;margin-bottom:16px;}p{color:rgba(255,255,255,0.7);font-size:16px;line-height:1.6;max-width:480px;margin:0 auto 16px;}
a{color:#d4a574;}.success{color:#22c55e;}</style></head><body>${body}</body></html>`;
}

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

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function verifyToken(token, shows, market, dateStr, secret) {
  const payload = `broadcast:${shows}:${market}:${dateStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).send(htmlPage('Method Not Allowed',
      '<h1>Method Not Allowed</h1><p>Use the approval link from your email.</p>'));
  }

  const { token, shows, market, lookback, names } = req.query;

  if (!token || !shows || !market) {
    return res.status(400).send(htmlPage('Invalid Link',
      '<h1>Invalid Link</h1><p>This approval link is incomplete or malformed.</p>'));
  }

  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) {
    return res.status(500).send(htmlPage('Configuration Error',
      '<h1>Server Error</h1><p>Approval system is not configured.</p>'));
  }

  // 48-hour window: try today's date and yesterday's date (UTC)
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const validToday = verifyToken(token, shows, market, todayStr, secret);
  const validYesterday = verifyToken(token, shows, market, yesterdayStr, secret);

  if (!validToday && !validYesterday) {
    return res.status(410).send(htmlPage('Link Expired',
      '<h1>Link Expired</h1>' +
      '<p>This approval link has expired (valid for ~48 hours from generation).</p>' +
      '<p>The next cron run will send a fresh approval email if the show still needs broadcasting.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>'));
  }

  // Dispatch the workflow
  const ghToken = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';

  if (!ghToken) {
    return res.status(500).send(htmlPage('Configuration Error',
      '<h1>Server Error</h1><p>GitHub integration is not configured.</p>'));
  }

  const lookbackDays = lookback || '2';
  const showNames = names || shows;
  const marketLabel = market === 'west-end' ? 'West End' : 'Broadway';

  try {
    await githubApi(`/repos/${repo}/actions/workflows/opening-night-broadcast.yml/dispatches`, 'POST', {
      ref: 'main',
      inputs: {
        send_to_all: 'true',
        lookback_days: lookbackDays,
      }
    }, ghToken);
  } catch (err) {
    console.error('Workflow dispatch failed:', err.message);
    return res.status(502).send(htmlPage('Dispatch Failed',
      `<h1>Something Went Wrong</h1><p>Could not trigger the broadcast workflow. Error: ${escapeHtml(err.message)}</p>` +
      `<p>You can try manually from <a href="https://github.com/${repo}/actions">GitHub Actions</a>.</p>`));
  }

  return res.status(200).send(htmlPage('Broadcast Dispatched!',
    '<h1 class="success">Broadcast Dispatched!</h1>' +
    `<p>The ${marketLabel} opening night broadcast for <strong>${escapeHtml(showNames).replace(/,/g, ', ')}</strong> is now being sent to all subscribers.</p>` +
    '<p>You\'ll see it land in your inbox shortly along with everyone else.</p>' +
    '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>'));
};
