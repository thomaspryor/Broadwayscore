import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Buttondown webhook handler.
 *
 * Listens for two events:
 *   - subscriber.unsubscribed — subscriber clicked the unsubscribe link in a broadcast
 *   - subscriber.complained  — subscriber marked the email as spam
 *
 * Both are treated as unsubscribes: the email is submitted to Formspree with
 * action: 'unsubscribe' so sync-followers.js removes them on the next run.
 *
 * NOTE: Previous implementation wrote directly to data/subscribers.json on disk,
 * which silently fails on Vercel (read-only/ephemeral filesystem). Now mirrors
 * the Resend webhook approach: submit to Formspree, let sync-followers handle it.
 *
 * Buttondown signature: X-Buttondown-Signature header, HMAC-SHA256 of raw body.
 */

const WEBHOOK_SECRET = process.env.BUTTONDOWN_WEBHOOK_SECRET || '';
const FORMSPREE_BROADWAY_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';
const FORMSPREE_WESTEND_ID = process.env.NEXT_PUBLIC_FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID || '';

function verifySignature(rawBody: string, headers: Headers): boolean {
  if (!WEBHOOK_SECRET) {
    console.error('Buttondown webhook: BUTTONDOWN_WEBHOOK_SECRET not set');
    return false;
  }

  const signature = headers.get('x-buttondown-signature');
  if (!signature) return false;

  const computed = createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex');

  try {
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(computed, 'hex')
    );
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers)) {
    console.error('Buttondown webhook: invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: { event_type?: string; subscriber?: { email?: string; email_address?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { event_type, subscriber } = payload;

  const shouldUnsubscribe =
    event_type === 'subscriber.unsubscribed' ||
    event_type === 'subscriber.complained';

  if (!shouldUnsubscribe) {
    return NextResponse.json({ received: true });
  }

  const email = (subscriber?.email_address || subscriber?.email || '').toLowerCase().trim();
  if (!email) {
    console.error(`Buttondown webhook: no email in ${event_type} payload`);
    return NextResponse.json({ received: true });
  }

  const masked = email.replace(/(.{2}).*(@.*)/, '$1***$2');

  // Submit unsubscribe to both Broadway and WE Formspree forms (same approach as Resend webhook).
  // sync-followers.js will pick up the unsubscribe action on the next run.
  const formIds = [FORMSPREE_BROADWAY_ID, FORMSPREE_WESTEND_ID].filter(Boolean);
  if (formIds.length === 0) {
    console.error('Buttondown webhook: no Formspree form IDs configured');
    return NextResponse.json({ received: true });
  }

  const body = JSON.stringify({ email, action: 'unsubscribe' });
  const results = await Promise.allSettled(
    formIds.map(id =>
      fetch(`https://formspree.io/f/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    )
  );
  const failures = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
  if (failures.length === 0) {
    console.log(`Buttondown webhook: unsubscribed ${masked} via ${event_type} (${formIds.length} forms)`);
  } else {
    console.error(`Buttondown webhook: ${failures.length}/${formIds.length} Formspree submissions failed for ${event_type}`);
  }

  return NextResponse.json({ received: true });
}
