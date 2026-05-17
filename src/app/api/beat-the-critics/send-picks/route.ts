import { NextRequest, NextResponse } from 'next/server';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = 'Broadway Scorecard <noreply@broadwayscorecard.com>';

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
        <div style="font-size:13px;font-weight:700;color:#ff1368;margin-bottom:6px;">Can you beat the critics?</div>
        <div style="font-size:12px;color:#4b5563;">Ceremony: June 7, 2026 &middot; CBS</div>
        <div style="margin-top:16px;">
          <a href="https://broadwayscorecard.com/beat-the-critics" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#ff1368,#d4106a);color:#ffffff;text-decoration:none;border-radius:10px;font-size:13px;font-weight:700;">View Your Ballot &rarr;</a>
        </div>
      </div>
    </div>
    <div style="text-align:center;padding:20px 0 0;font-size:11px;color:#374151;">
      You picked ${pickCount} categor${pickCount === 1 ? 'y' : 'ies'}. Come back after June 7 to see how you did.<br>
      <a href="https://broadwayscorecard.com" style="color:#4b5563;text-decoration:none;">broadwayscorecard.com</a>
    </div>
  </div>
</body>
</html>`;

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
      return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('send-picks error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
