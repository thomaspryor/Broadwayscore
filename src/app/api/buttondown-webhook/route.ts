import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Buttondown webhook handler.
 *
 * Listens for two events:
 *   - subscriber.unsubscribed — subscriber clicked the unsubscribe link in a broadcast
 *   - subscriber.complained  — subscriber marked the email as spam
 *
 * Both are treated as unsubscribes: the email is removed from subscribers.json so
 * sync-followers.js marks them as unsubscribed in Buttondown on the next broadcast run.
 *
 * Buttondown signature: X-Buttondown-Signature header, HMAC-SHA256 of raw body.
 * Simpler than Svix (no svix-id/timestamp headers needed).
 */

const WEBHOOK_SECRET = process.env.BUTTONDOWN_WEBHOOK_SECRET || '';
const SUBSCRIBERS_PATH = join(process.cwd(), 'data', 'subscribers.json');
const SUBSCRIBERS_WESTEND_PATH = join(process.cwd(), 'data', 'subscribers-westend.json');

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

function removeFromSubscriberFile(filePath: string, email: string): boolean {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    const subscribers: string[] = data.subscribers || [];
    const before = subscribers.length;
    const updated = subscribers.filter((e: string) => e.toLowerCase() !== email.toLowerCase());
    if (updated.length === before) return false; // not found
    data.subscribers = updated;
    data._meta = { ...data._meta, lastSynced: new Date().toISOString(), totalSubscribers: updated.length };
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
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

  // Remove from Broadway subscribers
  const removedBroadway = removeFromSubscriberFile(SUBSCRIBERS_PATH, email);
  // Remove from West End subscribers
  const removedWestEnd = removeFromSubscriberFile(SUBSCRIBERS_WESTEND_PATH, email);

  if (removedBroadway || removedWestEnd) {
    const markets = [removedBroadway && 'broadway', removedWestEnd && 'west-end'].filter(Boolean).join('+');
    console.log(`Buttondown webhook: unsubscribed ${masked} from ${markets} via ${event_type}`);
  } else {
    // Return 200 — subscriber may have already been removed or not in our lists
    console.log(`Buttondown webhook: ${masked} not found in subscriber files (${event_type})`);
  }

  return NextResponse.json({ received: true });
}
