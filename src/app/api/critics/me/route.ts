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
    const res = await sbAdmin(`/rest/v1/critic_profiles?critic_slug=eq.${encodeURIComponent(slug)}&user_id=eq.${encodeURIComponent(user.id)}&select=*`);
    const row = res.ok ? (await res.json())[0] : null;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const vres = await sbAdmin(`/rest/v1/critic_page_views?critic_slug=eq.${encodeURIComponent(slug)}&day=gte.${since}&select=views`);
    const views30 = vres.ok ? ((await vres.json()) as { views: number }[]).reduce((n, r) => n + (r.views || 0), 0) : 0;
    // BRO-6984: owner-only reach (unique people on show pages featuring their reviews). Stale rows (job stopped) are dropped.
    const rres = await sbAdmin(`/rest/v1/critic_reach?critic_slug=eq.${encodeURIComponent(slug)}&select=people,computed_at`).catch(() => null);
    const reachRow = rres?.ok ? ((await rres.json()) as { people: number; computed_at: string }[])[0] : undefined;
    const reachPeople = reachRow && Date.now() - Date.parse(reachRow.computed_at) < 3 * 86_400_000 ? reachRow.people : null;
    return NextResponse.json({ state: 'owner', email: user.email, notifyOpeningNight: approved.notify_opening_night, views30, reachPeople, profile: row ? toPublicProfile(row) : null });
  }
  if (claims.some((c) => c.status === 'pending')) return NextResponse.json({ state: 'pending', email: user.email });
  return NextResponse.json({ state: 'none', email: user.email });
}
