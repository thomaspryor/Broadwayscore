import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';
import { getCriticBySlug } from '@/lib/data-reviews';
import { sanitizeProfileEdit, SLUG_RE } from '@/lib/critic-claim';
import { criticBackendReady, getRequestUser, approvedClaimFor, sbAdmin } from '@/lib/critic-server';
import { getReviewKey } from '../../../../../scripts/lib/review-list-key';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Save profile fields. Only the approved owner of the page; only allow-listed fields (sanitizeProfileEdit). */
export async function PUT(req: NextRequest) {
  if (!criticBackendReady()) return NextResponse.json({ error: 'Not available right now.' }, { status: 503 });
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Unknown page.' }, { status: 400 });
  const claim = await approvedClaimFor(user.id, slug);
  if (!claim) return NextResponse.json({ error: 'This page is not linked to your account.' }, { status: 403 });
  const critic = getCriticBySlug(slug);
  if (!critic) return NextResponse.json({ error: 'Unknown page.' }, { status: 404 });

  const own = new Set(critic.reviews.map((r) => `${r.showSlug}-${getReviewKey(r)}`));
  const e = sanitizeProfileEdit(body, own);
  const patch: Record<string, unknown> = {
    job_title: e.jobTitle, bio: e.bio, outlets: e.outlets, links: e.links, picks: e.picks,
    pinned_review_key: e.pinnedReviewKey, updated_at: new Date().toISOString(),
  };
  const up = await sbAdmin(`/rest/v1/critic_profiles?critic_slug=eq.${encodeURIComponent(slug)}&user_id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch) });
  if (!up.ok || ((await up.json().catch(() => [])) as unknown[]).length !== 1) return NextResponse.json({ error: 'Could not save. Please try again.' }, { status: 502 });
  if (typeof body?.notifyOpeningNight === 'boolean') {
    await sbAdmin(`/rest/v1/critic_claims?id=eq.${claim.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ notify_opening_night: body.notifyOpeningNight }) });
  }
  revalidateTag(`critic-profile:${slug}`, { expire: 0 });
  revalidatePath(`/critics/${slug}`);
  return NextResponse.json({ ok: true });
}
