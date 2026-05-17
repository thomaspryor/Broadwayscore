import { NextRequest } from 'next/server';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - Broadway Scorecard</title>
<style>body{margin:0;padding:40px 20px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;}
h1{font-size:24px;margin-bottom:16px;}p{color:rgba(255,255,255,0.7);font-size:16px;line-height:1.6;max-width:480px;margin:0 auto 16px;}
a{color:#d4a574;}.success{color:#22c55e;}</style></head><body>${body}</body></html>`;
}

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function verifyToken(token: string, shows: string, market: string, dateStr: string, secret: string): boolean {
  const payload = `broadcast:${shows}:${market}:${dateStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
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
  const token = searchParams.get('token');
  const shows = searchParams.get('shows');
  const market = searchParams.get('market');
  const lookback = searchParams.get('lookback');
  const names = searchParams.get('names');

  const html = (title: string, body: string, status = 200) =>
    new Response(htmlPage(title, body), { status, headers: { 'Content-Type': 'text/html' } });

  if (!token || !shows || !market) {
    return html('Invalid Link',
      '<h1>Invalid Link</h1><p>This approval link is incomplete or malformed.</p>', 400);
  }

  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>Approval system is not configured.</p>', 500);
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const validToday = verifyToken(token, shows, market, todayStr, secret);
  const validYesterday = verifyToken(token, shows, market, yesterdayStr, secret);

  if (!validToday && !validYesterday) {
    return html('Link Expired',
      '<h1>Link Expired</h1>' +
      '<p>This approval link has expired (valid for ~48 hours from generation).</p>' +
      '<p>The next cron run will send a fresh approval email if the show still needs broadcasting.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>', 410);
  }

  const ghToken = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';

  if (!ghToken) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>GitHub integration is not configured.</p>', 500);
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
        approved_shows: shows || '',
        approved_market: market || '',
      }
    }, ghToken);
  } catch (err) {
    const msg = (err as Error).message;
    console.error('Workflow dispatch failed:', msg);
    return html('Dispatch Failed',
      `<h1>Something Went Wrong</h1><p>Could not trigger the broadcast workflow. Error: ${escapeHtml(msg)}</p>` +
      `<p>You can try manually from <a href="https://github.com/${repo}/actions">GitHub Actions</a>.</p>`, 502);
  }

  return html('Broadcast Dispatched!',
    '<h1 class="success">Broadcast Dispatched!</h1>' +
    `<p>The ${marketLabel} opening night broadcast for <strong>${escapeHtml(showNames).replace(/,/g, ', ')}</strong> is now being sent to all subscribers.</p>` +
    '<p>You\'ll see it land in your inbox shortly along with everyone else.</p>' +
    '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>');
}
