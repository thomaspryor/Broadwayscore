import { NextRequest, NextResponse } from 'next/server';
import { SLUG_RE } from '@/lib/critic-claim';
import { criticBackendReady, sbAdmin, getPublicCriticProfile } from '@/lib/critic-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const hits = new Map<string, { n: number; t: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60_000) { hits.set(ip, { n: 1, t: now }); return false; }
  return ++h.n > 30;
}

/** Page-view beacon for verified critic pages. Counts per day; stores no visitor data. */
export async function POST(req: NextRequest) {
  if (!criticBackendReady()) return new NextResponse(null, { status: 204 });
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (limited(ip)) return new NextResponse(null, { status: 204 });
  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!SLUG_RE.test(slug) || !(await getPublicCriticProfile(slug))) return new NextResponse(null, { status: 204 });
  await sbAdmin('/rest/v1/rpc/bump_critic_page_view', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ p_slug: slug }) }).catch(() => null);
  return new NextResponse(null, { status: 204 });
}
