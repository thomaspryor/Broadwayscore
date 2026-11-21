import { NextRequest, NextResponse } from 'next/server';

/**
 * RFC 8058 one-click unsubscribe endpoint.
 *
 * Gmail/Yahoo POST to this URL when the user clicks the header unsubscribe button.
 * The POST body is: List-Unsubscribe=One-Click
 * We extract the email from the query string and submit to Formspree.
 *
 * GET requests redirect to the client-side /unsubscribe page.
 */

const FORMSPREE_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';
const FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID || '';

// Profitability Scorecard sign-ups (BRO-6309) live in Supabase, not Formspree.
// The SECURITY DEFINER RPC only stamps unsubscribed_at, so the anon key is enough.
async function unsubscribeMoney(email: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Money unsubscribe skipped: Supabase env vars missing');
    return false;
  }
  try {
    const res = await fetch(`${url}/rest/v1/rpc/money_scorecard_unsubscribe`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_email: email }),
    });
    if (!res.ok) console.error(`Money unsubscribe RPC failed: ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error('Money unsubscribe RPC errored:', (err as Error).message);
    return false;
  }
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function moneyConfirmPage(email: string): string {
  const safe = escapeHtml(email.toLowerCase().trim());
  const action = `/api/unsubscribe?list=money&email=${encodeURIComponent(email.toLowerCase().trim())}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe</title></head><body style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center;color:#222"><h1 style="font-size:22px">Unsubscribe?</h1><p>You will stop getting email from the Profitability Scorecard.</p><p style="color:#666;font-size:14px">${safe}</p><form method="post" action="${escapeHtml(action)}"><button type="submit" style="padding:12px 24px;font-size:16px;border:0;border-radius:8px;background:#c0392b;color:#fff">Yes, unsubscribe</button></form></body></html>`;
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  const market = searchParams.get('market') === 'west-end' ? 'west-end' : 'broadway';

  if (!email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 });
  }

  if (searchParams.get('list') === 'money') {
    if (!(await unsubscribeMoney(email))) {
      // Not recorded: tell the person (and one-click mail clients) so nobody believes they are off the list.
      return new NextResponse('<!doctype html><meta charset="utf-8"><body style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center"><h1 style="font-size:22px">Something went wrong</h1><p>We could not record your unsubscribe. Please reply to any email from us and we will remove you by hand.</p></body>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    // Browser form posts get a readable page; one-click mail clients only need the 200.
    return new NextResponse(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center"><h1 style="font-size:22px">Unsubscribed</h1><p>You will not get any more email from the Profitability Scorecard.</p></body>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  const formId = market === 'west-end' && FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID
    ? FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID
    : FORMSPREE_SUBSCRIBER_FORM_ID;

  if (!formId) {
    // Accept the unsubscribe request even if Formspree isn't configured
    // (better to show the button than fail silently)
    return new NextResponse(null, { status: 200 });
  }

  try {
    const res = await fetch(`https://formspree.io/f/${formId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        action: 'unsubscribe',
      }),
    });
    // Still return 200 either way — RFC 8058 requires it for Gmail/Yahoo to
    // show the one-click button — but a rejected unsubscribe with no record
    // anywhere means the user silently keeps getting mail. Log it so it's at
    // least visible in ops (same swallowed-failure class as BRO-3382).
    if (!res.ok) {
      console.error(`Unsubscribe forward to Formspree failed: ${res.status} ${res.statusText} (market=${market})`);
    }
  } catch (err) {
    console.error(`Unsubscribe forward to Formspree errored (market=${market}):`, (err as Error).message);
    // Still return 200 — Gmail requires it to show the button
  }

  return new NextResponse(null, { status: 200 });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email') || '';
  const market = searchParams.get('market') || '';
  if (searchParams.get('list') === 'money') {
    // GET never changes data (link scanners prefetch): show a confirm form that POSTs.
    if (!email) return NextResponse.json({ error: 'Missing email' }, { status: 400 });
    return new NextResponse(moneyConfirmPage(email), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  // Redirect to the client-side unsubscribe page
  const redirectUrl = new URL('/unsubscribe', request.url);
  if (email) redirectUrl.searchParams.set('email', email);
  if (market) redirectUrl.searchParams.set('market', market);
  return NextResponse.redirect(redirectUrl);
}
