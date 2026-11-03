import { NextRequest, NextResponse } from 'next/server';
import { criticBackendReady, getRequestUser, getClaimsForUser, sbAdmin, toPublicProfile } from '@/lib/critic-server';
import { SLUG_RE } from '@/lib/critic-claim';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** What the signed-in account may do on this critic page. */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug') || '';
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'bad slug' }, { status: 400 });
  if (!criticBackendReady()) return NextResponse.json({ state: 'unavailable' });
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ state: 'signed-out' }, { status: 401 });
  const claims = await getClaimsForUser(user.id, slug);
  const approved = claims.find((c) => c.status === 'approved');
  if (approved) {
    const res = await sbAdmin(`/rest/v1/critic_profiles?critic_slug=eq.${slug}&user_id=eq.${user.id}&select=*`);
    const row = res.ok ? (await res.json())[0] : null;
    return NextResponse.json({ state: 'owner', email: user.email, notifyOpeningNight: approved.notify_opening_night, profile: row ? toPublicProfile(row) : null });
  }
  if (claims.some((c) => c.status === 'pending')) return NextResponse.json({ state: 'pending', email: user.email });
  return NextResponse.json({ state: 'none', email: user.email });
}
