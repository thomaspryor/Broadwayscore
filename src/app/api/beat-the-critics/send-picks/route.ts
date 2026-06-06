import { NextRequest, NextResponse } from 'next/server';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const REVIEW_TEXTS_TOKEN = process.env.REVIEW_TEXTS_TOKEN || '';
const SUBMISSIONS_REPO = 'thomaspryor/broadway-scorecard-data';
const SUBMISSIONS_PATH = 'data/beat-the-critics-submissions.jsonl';
const FAILED_PATH = 'data/beat-the-critics-failed.jsonl';
const FROM_EMAIL = 'Broadway Scorecard <noreply@broadwayscorecard.com>';

// In-memory rate limit: max 3 submissions per IP per 10 minutes.
// Resets on cold start — good enough for casual spam prevention without Redis.
const ipRateLimit = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 3;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipRateLimit.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    ipRateLimit.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

// Append submission to private repo JSONL. Retries up to 12× on SHA conflicts
// with jitter so concurrent submissions don't collide on the same retry window.
// Throws on unrecoverable failure so the caller can return a 500 and let the
// user retry rather than silently losing the entry.
async function storeSubmission(record: {
  email: string;
  picks: Record<string, string>;
  ceremonyYear: number;
  submittedAt: string;
}): Promise<void> {
  if (!REVIEW_TEXTS_TOKEN) throw new Error('REVIEW_TEXTS_TOKEN not configured');
  const apiBase = `https://api.github.com/repos/${SUBMISSIONS_REPO}/contents/${SUBMISSIONS_PATH}`;
  const headers = {
    Authorization: `Bearer ${REVIEW_TEXTS_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  };

  const MAX_RETRIES = 12;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Jitter: 150–600ms so concurrent retries don't re-collide
      await new Promise(r => setTimeout(r, 150 + Math.random() * 450));
    }

    const getRes = await fetch(apiBase, { headers });
    let currentContent = '';
    let sha: string | undefined;

    if (getRes.ok) {
      const data = await getRes.json() as { content: string; sha: string };
      currentContent = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      sha = data.sha;
    } else if (getRes.status !== 404) {
      throw new Error(`GitHub GET failed: ${getRes.status}`);
    }

    const newLine = JSON.stringify(record) + '\n';
    const newContent = Buffer.from(currentContent + newLine).toString('base64');

    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `feat: Beat the Critics submission [skip ci]`,
        content: newContent,
        ...(sha ? { sha } : {}),
      }),
    });

    if (putRes.ok) return;
    if (putRes.status === 409) continue; // SHA conflict from concurrent write — retry
    const body = await putRes.text();
    throw new Error(`GitHub PUT failed: ${putRes.status} ${body}`);
  }
  throw new Error(`storeSubmission failed after ${MAX_RETRIES} retries (SHA conflicts)`);
}

// Dead-letter: if storeSubmission exhausts retries, write to a separate file
// so the entry isn't lost entirely. Best-effort — does not throw.
async function storeFailedSubmission(record: {
  email: string;
  picks: Record<string, string>;
  ceremonyYear: number;
  submittedAt: string;
  failedAt: string;
}): Promise<void> {
  if (!REVIEW_TEXTS_TOKEN) return;
  const apiBase = `https://api.github.com/repos/${SUBMISSIONS_REPO}/contents/${FAILED_PATH}`;
  const headers = {
    Authorization: `Bearer ${REVIEW_TEXTS_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  };
  try {
    const getRes = await fetch(apiBase, { headers });
    let currentContent = '';
    let sha: string | undefined;
    if (getRes.ok) {
      const data = await getRes.json() as { content: string; sha: string };
      currentContent = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      sha = data.sha;
    }
    const newContent = Buffer.from(currentContent + JSON.stringify(record) + '\n').toString('base64');
    await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `fix: dead-letter BTC submission [skip ci]`,
        content: newContent,
        ...(sha ? { sha } : {}),
      }),
    });
  } catch { /* silently ignore — primary store already failed */ }
}

export async function POST(req: NextRequest) {
  try {
    const { email, picks, ceremonyYear } = await req.json() as {
      email: string;
      picks: Record<string, string>;
      ceremonyYear: number;
    };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
             ?? req.headers.get('x-real-ip')
             ?? 'unknown';
    if (!checkRateLimit(ip)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    if (!RESEND_API_KEY) {
      return NextResponse.json({ error: 'Email service unavailable' }, { status: 503 });
    }

    const picksHtml = Object.entries(picks)
      .map(([cat, pick]) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #1f1f1f;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">${cat.replace('Best ', '')}</td>
          <td style="padding:8px 0;border-bottom:1px solid #1f1f1f;color:#ffffff;font-size:14px;font-weight:700;text-align:right;">${pick}</td>
        </tr>`)
      .join('');

    const pickCount = Object.keys(picks).length;

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:32px 16px;">
    <div style="background:#111111;border:1px solid #1f1f1f;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,rgba(255,19,104,0.1),rgba(0,85,255,0.06));padding:28px 28px 20px;border-bottom:1px solid #1f1f1f;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Broadway Scorecard</div>
        <div style="font-size:24px;font-weight:900;color:#ffffff;letter-spacing:-0.03em;">My Tony Picks</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px;">Beat the Critics &middot; ${ceremonyYear}</div>
      </div>
      <div style="padding:20px 28px;">
        <table style="width:100%;border-collapse:collapse;">
          ${picksHtml}
        </table>
      </div>
      <div style="padding:16px 28px 24px;text-align:center;">
        <div style="font-size:13px;font-weight:700;color:#ff1368;margin-bottom:6px;">You're entered — can you beat the critics?</div>
        <div style="font-size:12px;color:#4b5563;margin-bottom:4px;">Ceremony: June 7, 2026 &middot; CBS</div>
        <div style="font-size:12px;color:#4b5563;margin-bottom:6px;">We'll email you after the ceremony with your results.</div>
        <div style="font-size:12px;font-weight:700;color:#f59e0b;">🎟️ Beat a critic? You're entered in the $100 TodayTix prize draw.</div>
        <div style="margin-top:16px;">
          <a href="https://broadwayscorecard.com/beat-the-critics" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#ff1368,#d4106a);color:#ffffff;text-decoration:none;border-radius:10px;font-size:13px;font-weight:700;">View Your Ballot &rarr;</a>
        </div>
      </div>
    </div>
    <div style="text-align:center;padding:20px 0 0;font-size:11px;color:#374151;">
      You picked ${pickCount} categor${pickCount === 1 ? 'y' : 'ies'}. After June 7, we'll email you with how you compared to the critics.<br>
      <a href="https://broadwayscorecard.com" style="color:#4b5563;text-decoration:none;">broadwayscorecard.com</a>
    </div>
  </div>
</body>
</html>`;

    // Store submission first — this is the critical path for prize-draw eligibility.
    // If it fails, write to dead-letter file and return 500 so the user can retry.
    const submittedAt = new Date().toISOString();
    try {
      await storeSubmission({ email, picks, ceremonyYear, submittedAt });
    } catch (err) {
      console.error('storeSubmission failed:', err);
      // Dead-letter: preserve the entry even if the main store failed
      await storeFailedSubmission({ email, picks, ceremonyYear, submittedAt, failedAt: new Date().toISOString() });
      return NextResponse.json({ error: 'Failed to save your picks. Please try again.' }, { status: 500 });
    }

    // Confirmation email — best-effort; entry is already stored above.
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject: `Your ${ceremonyYear} Tony Award Picks`,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('Resend error:', res.status, body);
      // Entry is stored — still return success. User is entered even without email.
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('send-picks error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
