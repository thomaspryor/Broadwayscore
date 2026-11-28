import { NextRequest, NextResponse } from 'next/server';
import { getCriticBySlug } from '@/lib/data-reviews';
import { rateLimitAllow, claimsDisabled } from '@/lib/critic-claim';
import { acceptInvite, grantOwnership, type RecordResult } from '@/lib/critic-ownership';
import { criticBackendReady, getRequestUser, sbAdmin, emailOwner, escHtml, approvedOwnerOf, ownershipDeps } from '@/lib/critic-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SITE = 'https://broadwayscorecard.com';
const userHits = new Map<string, { n: number; t: number }>();
const ipHits = new Map<string, { n: number; t: number }>();
function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

/**
 * BRO-7087: a critic opens the owner's invite link and signs in; this makes
 * that account the page's approved owner (no claim form, no email approval).
 * Logic lives in acceptInvite (critic-ownership.ts); this wires real I/O.
 */
export async function POST(req: NextRequest) {
  if (claimsDisabled() || !criticBackendReady()) return NextResponse.json({ error: 'Not available right now.' }, { status: 503 });
  if (!rateLimitAllow(ipHits, clientIp(req), 20, 3600_000)) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
  if (!rateLimitAllow(userHits, user.id, 10, 3600_000)) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
  const body = await req.json().catch(() => null);

  const recordApproval = async (slug: string, userId: string, email: string): Promise<RecordResult> => {
    const decided = new Date().toISOString();
    // An open "Claim this page" request from this account becomes the approved row.
    const upd = await sbAdmin(`/rest/v1/critic_claims?user_id=eq.${encodeURIComponent(userId)}&critic_slug=eq.${encodeURIComponent(slug)}&status=eq.pending`, {
      method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({ status: 'approved', decided_at: decided }),
    });
    if (upd.status === 409) return 'conflict';
    if (upd.ok) {
      const rows = (await upd.json().catch(() => [])) as unknown[];
      if (Array.isArray(rows) && rows.length > 0) return 'ok';
    }
    const ins = await sbAdmin('/rest/v1/critic_claims', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({ critic_slug: slug, user_id: userId, contact_email: (email || 'unknown@invalid').slice(0, 254), note: 'Joined with an invite link', status: 'approved', decided_at: decided }),
    });
    if (ins.status === 409) return 'conflict';
    if (!ins.ok) { console.error('[critics/accept-invite] insert failed', ins.status); return 'error'; }
    return 'ok';
  };

  const result = await acceptInvite(body, {
    secret: process.env.APPROVAL_HMAC_SECRET,
    now: Date.now(),
    user,
    criticName: (slug) => getCriticBySlug(slug)?.name ?? null,
    currentOwner: approvedOwnerOf,
    recordApproval,
    grant: (slug, userId) => grantOwnership(slug, userId, ownershipDeps),
    emailOwner: (subject, html) => emailOwner(subject, html),
    escHtml,
    site: SITE,
  });
  return NextResponse.json(result.body, { status: result.status });
}
