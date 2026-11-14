import { NextRequest, NextResponse } from 'next/server';
import { getCriticBySlug, getOutletBySlug, getOutletSlugById } from '@/lib/data-reviews';
import { sanitizeClaimInput, signClaimLink, claimHints, claimLimitVerdict, ownerEmailPlan, rateLimitAllow, claimsDisabled } from '@/lib/critic-claim';
import { criticBackendReady, getRequestUser, sbAdmin, emailOwner, escHtml, getClaimsForUser } from '@/lib/critic-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SITE = 'https://broadwayscorecard.com';
const userHits = new Map<string, { n: number; t: number }>();
const ipHits = new Map<string, { n: number; t: number }>();
function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(req: NextRequest) {
  if (claimsDisabled() || !criticBackendReady()) return NextResponse.json({ error: 'Claiming is not available right now.' }, { status: 503 });
  const body = await req.json().catch(() => null);
  // Honeypot: real people never see this field. Accept silently and drop.
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>)._gotcha === 'string' && (body as Record<string, string>)._gotcha) {
    return NextResponse.json({ ok: true, status: 'pending' });
  }
  if (!rateLimitAllow(ipHits, clientIp(req), 10, 3600_000)) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
  if (!rateLimitAllow(userHits, user.id, 5, 3600_000)) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });

  const input = sanitizeClaimInput(body);
  if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
  const critic = getCriticBySlug(input.slug);
  if (!critic) return NextResponse.json({ error: 'Unknown critic page.' }, { status: 404 });

  const existing = await getClaimsForUser(user.id, input.slug);
  if (existing.some((c) => c.status === 'pending' || c.status === 'approved')) {
    return NextResponse.json({ ok: true, status: existing.find((c) => c.status === 'approved') ? 'approved' : 'pending' });
  }

  const mine = await sbAdmin(`/rest/v1/critic_claims?user_id=eq.${encodeURIComponent(user.id)}&select=status,critic_slug,created_at&order=created_at.desc&limit=50`);
  const verdict = claimLimitVerdict(mine.ok ? await mine.json() : [], input.slug);
  if (!verdict.ok) return NextResponse.json({ error: verdict.message }, { status: 429 });

  const ins = await sbAdmin('/rest/v1/critic_claims', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ critic_slug: input.slug, user_id: user.id, contact_email: input.contactEmail, work_url: input.workUrl, social_links: input.socials, note: input.note }),
  });
  if (!ins.ok) {
    console.error('[critics/claim] insert failed', ins.status);
    // 409: someone else already holds this page, or a racing duplicate request.
    return NextResponse.json({ error: ins.status === 409 ? 'This page already has a request in progress.' : 'Could not save your request. Please try again.' }, { status: ins.status === 409 ? 409 : 502 });
  }
  const row = (await ins.json())[0];

  const secret = process.env.APPROVAL_HMAC_SECRET;
  const link = (action: 'approve' | 'decline') => {
    const p = signClaimLink(secret || '', action, row.id);
    return `${SITE}/api/critics/decide?${new URLSearchParams({ c: p.c, a: p.a, e: String(p.e), s: p.s })}`;
  };
  const others = await sbAdmin(`/rest/v1/critic_claims?critic_slug=eq.${encodeURIComponent(input.slug)}&id=neq.${row.id}&status=in.(pending,approved)&select=status,owner_emailed_at`);
  const otherClaims = others.ok ? ((await others.json()) as { status: string; owner_emailed_at: string | null }[]) : [];
  const otherClaimStatuses = otherClaims.map((r) => r.status);
  const plan = ownerEmailPlan(otherClaims);
  const outletSlug = getOutletSlugById(critic.primaryOutletId);
  const outletDomain = (outletSlug && getOutletBySlug(outletSlug)?.logoDomain) || null;
  const hints = claimHints({ contactEmail: input.contactEmail, accountEmail: user.email, outletDomain, otherClaimStatuses });
  const recent = [...critic.reviews]
    .map((r) => ({ r, t: (r as { parsedDate?: number | null }).parsedDate ?? Date.parse((r as { publishDate?: string }).publishDate || '') }))
    .filter((x) => Number.isFinite(x.t))
    .sort((x, y) => (y.t as number) - (x.t as number))
    .slice(0, 3);
  const socialHtml = input.socials.map((l) => `<a href="${escHtml(l.url)}">${escHtml(l.url)}</a>`).join('<br>');
  const first = critic.name.split(' ')[0];
  const reply = `Hi ${first}, thanks for claiming your page on Broadway Scorecard. To confirm it's you, could you send a quick DM to @bwayscorecard from ${input.socials[0].url}? Once I see it I'll switch your page on.`;
  const html = `<p><b>${escHtml(critic.name)}</b> asked to claim <a href="${SITE}/critics/${input.slug}">${SITE}/critics/${input.slug}</a></p>
<p>Social accounts they gave:<br>${socialHtml}</p>
<p><b>What we already know</b><br>Outlets: ${escHtml(critic.outlets.join(', ') || critic.primaryOutlet)}<br>Reviews on file: ${critic.reviewCount}<br>Most recent:<br>${recent.map(({ r }) => { const rv = r as { url?: string; showTitle?: string; outlet?: string }; return rv.url ? `<a href="${escHtml(rv.url)}">${escHtml(rv.showTitle || rv.url)}</a> (${escHtml(rv.outlet || '')})` : escHtml(rv.showTitle || ''); }).join('<br>') || 'none'}</p>
<p><b>Hints</b> (information only, nothing is approved for you)<br>${hints.map((h) => `&bull; ${escHtml(h)}`).join('<br>') || 'none'}</p>
<p>Contact: ${escHtml(input.contactEmail)} (signed in as ${escHtml(user.email)})<br>
Work link: ${input.workUrl ? `<a href="${escHtml(input.workUrl)}">${escHtml(input.workUrl)}</a>` : 'not given'}<br>
Note: ${escHtml(input.note || 'none')}</p>
<p><b>Reply you can paste</b> (this email is reply-to them):<br><i>${escHtml(reply)}</i></p>
<p><a href="${link('approve')}">Approve</a> &nbsp;|&nbsp; <a href="${link('decline')}">Decline</a></p>
<p style="color:#888;font-size:12px">Each link opens a confirm page first; nothing changes until you press the button there.</p>`;
  let sent = false;
  if (plan === 'full') sent = secret ? await emailOwner(`Critic page claim: ${critic.name}`, html, input.contactEmail) : false;
  else if (plan === 'note') sent = await emailOwner(`Another claim came in: ${critic.name}`, `<p>Another request came in for <a href="${SITE}/critics/${input.slug}">${SITE}/critics/${input.slug}</a> while one is already waiting. Only one claim email per page is sent while a request is pending, and the new one is stored. Contact: ${escHtml(input.contactEmail)}<br>Socials:<br>${socialHtml}</p><p><a href="${link('approve')}">Approve this one</a> &nbsp;|&nbsp; <a href="${link('decline')}">Decline this one</a></p>`);
  if (plan !== 'none' && !sent) console.error('[critics/claim] owner email not sent for claim', row.id);
  if (sent) await sbAdmin(`/rest/v1/critic_claims?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ owner_emailed_at: new Date().toISOString() }) });
  return NextResponse.json({ ok: true, status: 'pending' });
}
