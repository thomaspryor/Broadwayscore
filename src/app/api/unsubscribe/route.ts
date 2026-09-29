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

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  const market = searchParams.get('market') === 'west-end' ? 'west-end' : 'broadway';

  if (!email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 });
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
  // Redirect to the client-side unsubscribe page
  const redirectUrl = new URL('/unsubscribe', request.url);
  if (email) redirectUrl.searchParams.set('email', email);
  if (market) redirectUrl.searchParams.set('market', market);
  return NextResponse.redirect(redirectUrl);
}
