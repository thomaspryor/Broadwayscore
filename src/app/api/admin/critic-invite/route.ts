import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getCriticBySlug } from '@/lib/data-reviews';
import { SLUG_RE } from '@/lib/critic-claim';
import { signInvite, inviteUrl, INVITE_TTL_SECONDS } from '@/lib/critic-invite';
import { approvedOwnerOf, criticBackendReady } from '@/lib/critic-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SITE = 'https://broadwayscorecard.com';

/** BRO-7087: owner-only. Makes a signed invite link for one critic page. Nothing is stored. */
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) return NextResponse.json({ error: 'Invite links are not set up (APPROVAL_HMAC_SECRET missing).' }, { status: 500 });
  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Pick a critic.' }, { status: 400 });
  const critic = getCriticBySlug(slug);
  if (!critic || critic.slug !== slug) return NextResponse.json({ error: 'Unknown critic page.' }, { status: 404 });
  if (criticBackendReady()) {
    const owner = await approvedOwnerOf(slug);
    if (owner === 'error') return NextResponse.json({ error: 'Could not check who owns this page. Try again in a minute.' }, { status: 502 });
    if (owner) return NextResponse.json({ error: `${critic.name}'s page already has an owner.` }, { status: 409 });
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Could not check who owns this page. Try again in a minute.' }, { status: 503 });
  }
  const now = Date.now();
  const token = signInvite(secret, slug, now);
  return NextResponse.json({ url: inviteUrl(SITE, slug, token), name: critic.name, expiresAt: new Date(now + INVITE_TTL_SECONDS * 1000).toISOString() });
}
