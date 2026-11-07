import { NextRequest, NextResponse } from 'next/server';
import { getCriticBySlug } from '@/lib/data-reviews';
import { SLUG_RE } from '@/lib/critic-claim';
import { submitCorrection } from '@/lib/critic-corrections';
import { criticBackendReady, getRequestUser, approvedClaimFor, sbAdmin, emailOwner } from '@/lib/critic-server';
import { getReviewKey } from '../../../../../scripts/lib/review-list-key';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const hits = new Map<string, { n: number; t: number }>();
function limited(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.t > 3600_000) { hits.set(key, { n: 1, t: now }); return false; }
  return ++h.n > 10;
}

/**
 * "Flag a problem" / "Missing a review? Tell us" (BRO-6984; started as "Flag a
 * score", BRO-6895): an approved critic tells us something on their page looks
 * wrong. Stores a critic_requests row and emails the owner (the same emailOwner
 * path claims use). It never reads or writes a score and never emails the critic.
 */
export async function POST(req: NextRequest) {
  if (!criticBackendReady()) return NextResponse.json({ error: 'Not available right now.' }, { status: 503 });
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 });
  if (limited(user.id)) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Unknown page.' }, { status: 400 });
  if (!(await approvedClaimFor(user.id, slug))) return NextResponse.json({ error: 'This page is not linked to your account.' }, { status: 403 });
  const critic = getCriticBySlug(slug);
  if (!critic) return NextResponse.json({ error: 'Unknown page.' }, { status: 404 });

  const result = await submitCorrection(body, {
    slug,
    criticName: critic.name,
    user,
    ownReviews: new Map(critic.reviews.map((r) => [`${r.showSlug}-${getReviewKey(r)}`, r])),
    insert: async (row) => (await sbAdmin('/rest/v1/critic_requests', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) })).ok,
    emailOwner,
  });
  return NextResponse.json(result.body, { status: result.status });
}
