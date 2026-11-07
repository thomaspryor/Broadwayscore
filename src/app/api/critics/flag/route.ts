import { NextRequest, NextResponse } from 'next/server';
import { getCriticBySlug } from '@/lib/data-reviews';
import { sanitizeFlagInput, SLUG_RE } from '@/lib/critic-claim';
import { criticBackendReady, getRequestUser, approvedClaimFor, sbAdmin, emailOwner, escHtml } from '@/lib/critic-server';
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
 * "Flag a score": an approved critic tells us a score on their page looks
 * wrong. Stores a request row and emails the owner. It never reads or writes a
 * score; the owner decides whether anything changes.
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

  const own = new Map(critic.reviews.map((r) => [`${r.showSlug}-${getReviewKey(r)}`, r]));
  const input = sanitizeFlagInput(body, new Set(own.keys()));
  if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
  const review = own.get(input.reviewKey)!;

  const ins = await sbAdmin('/rest/v1/critic_requests', {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ critic_slug: slug, user_id: user.id, kind: 'score_flag', payload: { reviewKey: input.reviewKey, note: input.note, show: review.showTitle, outlet: review.outlet, score: review.reviewScore } }),
  });
  if (!ins.ok) return NextResponse.json({ error: 'Could not send that. Please try again.' }, { status: 502 });

  await emailOwner(`Critic flagged a score: ${critic.name} on ${review.showTitle}`,
    `<p><b>${escHtml(critic.name)}</b> flagged the score for <b>${escHtml(review.showTitle)}</b> (${escHtml(review.outlet)}), currently ${review.reviewScore}.</p>
<p>${escHtml(input.note)}</p>
<p>Account: ${escHtml(user.email)}. Reply to reach them. Nothing was changed.</p>`, user.email);
  return NextResponse.json({ ok: true });
}
