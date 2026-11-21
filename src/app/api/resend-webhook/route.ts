import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';

/**
 * Resend webhook handler.
 *
 * Listens for two events:
 *   - contact.updated (unsubscribed: true) — subscriber clicked the broadcast footer link
 *   - email.complained                     — subscriber marked the email as spam
 *
 * Both are treated as unsubscribes: the email is submitted to Formspree so
 * sync-followers.js removes them from our list on the next broadcast run.
 *
 * This keeps the Formspree subscriber list in sync with Resend, which means
 * re-subscribing via the signup form works correctly (they get re-added on
 * the next sync).
 *
 * Signature validation uses Svix (the library Resend uses internally):
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 */

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';
const FORMSPREE_BROADWAY_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';
const FORMSPREE_WESTEND_ID = process.env.NEXT_PUBLIC_FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID || '';

function verifySignature(rawBody: string, headers: Headers): boolean {
  if (!WEBHOOK_SECRET) return false;

  const svixId = headers.get('svix-id');
  const svixTimestamp = headers.get('svix-timestamp');
  const svixSignature = headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Reject timestamps older than 5 minutes (replay attack protection)
  const ts = parseInt(svixTimestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  // Secret is base64-encoded after the "whsec_" prefix
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');

  // Signed content: "{svix-id}.{svix-timestamp}.{rawBody}"
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const computed = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // svix-signature is a space-separated list of "v1,{base64sig}" (multiple for key rotation)
  return svixSignature.split(' ').some(s => {
    const comma = s.indexOf(',');
    return comma !== -1 && s.slice(0, comma) === 'v1' && s.slice(comma + 1) === computed;
  });
}

function extractEmail(type: string, data: Record<string, unknown>): string | null {
  if (type === 'contact.updated' || type === 'contact.created') {
    const contact = data?.contact as Record<string, unknown> | undefined;
    return (contact?.email as string) ?? null;
  }
  if (type === 'email.complained' || type === 'email.bounced') {
    // Resend email events: data.email.to is an array
    const email = data?.email as Record<string, unknown> | undefined;
    const to = email?.to as string[] | string | undefined;
    if (Array.isArray(to)) return to[0] ?? null;
    if (typeof to === 'string') return to;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers)) {
    console.error('Resend webhook: invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: { type: string; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type, data = {} } = payload;

  const shouldUnsubscribe =
    (type === 'contact.updated' && (data?.contact as Record<string, unknown>)?.unsubscribed === true) ||
    type === 'email.complained';

  if (!shouldUnsubscribe) {
    return NextResponse.json({ received: true });
  }

  const email = extractEmail(type, data);
  if (!email) {
    console.error(`Resend webhook: no email found in ${type} payload`);
    return NextResponse.json({ received: true });
  }

  // Submit unsubscribe to both Broadway and WE forms — we don't know which market
  // the subscriber came from, so we signal both. sync-followers.js ignores unknown emails.
  const formIds = [FORMSPREE_BROADWAY_ID, FORMSPREE_WESTEND_ID].filter(Boolean);
  if (formIds.length === 0) {
    console.error('Resend webhook: no Formspree form IDs configured');
    return NextResponse.json({ received: true });
  }

  const body = JSON.stringify({ email: email.toLowerCase().trim(), action: 'unsubscribe' });
  const masked = email.replace(/(.{2}).*(@.*)/, '$1***$2');
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
    console.log(`Resend webhook: unsubscribed ${masked} via ${type} (${formIds.length} forms)`);
  } else {
    // Return 200 anyway — Resend retries on non-2xx, and we don't want a retry loop
    console.error(`Resend webhook: ${failures.length}/${formIds.length} Formspree submissions failed for ${type}`);
  }

  return NextResponse.json({ received: true });
}
