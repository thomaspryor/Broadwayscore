import { NextRequest, NextResponse } from 'next/server';
import { getCriticBySlug } from '@/lib/data-reviews';
import { sanitizeClaimInput, signClaimLink } from '@/lib/critic-claim';
import { criticBackendReady, getRequestUser, sbAdmin, emailOwner, escHtml, getClaimsForUser } from '@/lib/critic-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SITE = 'https://broadwayscorecard.com';
const hits = new Map<string, { n: number; t: number }>();
function limited(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.t > 3600_000) { hits.set(key, { n: 1, t: now }); return false; }
  return ++h.n > 5;
}

export async function POST(req: NextRequest) {
  if (!criticBackendReady()) return NextResponse.json({ error: 'Claiming is not available right now.' }, { status: 503 });
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
  if (limited(user.id)) return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });

  const input = sanitizeClaimInput(await req.json().catch(() => null));
  if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
  const critic = getCriticBySlug(input.slug);
  if (!critic) return NextResponse.json({ error: 'Unknown critic page.' }, { status: 404 });

  const existing = await getClaimsForUser(user.id, input.slug);
  if (existing.some((c) => c.status === 'pending' || c.status === 'approved')) {
    return NextResponse.json({ ok: true, status: existing.find((c) => c.status === 'approved') ? 'approved' : 'pending' });
  }

  const ins = await sbAdmin('/rest/v1/critic_claims', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ critic_slug: input.slug, user_id: user.id, contact_email: input.contactEmail, work_url: input.workUrl, note: input.note }),
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
  const html = `<p><b>${escHtml(critic.name)}</b> (${escHtml(critic.primaryOutlet)}) asked to claim <a href="${SITE}/critics/${input.slug}">${SITE}/critics/${input.slug}</a>.</p>
<p>Contact: ${escHtml(input.contactEmail)} (sign-in account: ${escHtml(user.email)})<br>
Work: ${input.workUrl ? `<a href="${escHtml(input.workUrl)}">${escHtml(input.workUrl)}</a>` : 'not given'}<br>
Note: ${escHtml(input.note || 'none')}</p>
<p>Reply to this email to reach them. When you are satisfied it is them:</p>
<p><a href="${link('approve')}">Approve</a> &nbsp;|&nbsp; <a href="${link('decline')}">Decline</a></p>
<p style="color:#888;font-size:12px">Each link opens a confirm page first; nothing changes until you press the button there.</p>`;
  const sent = secret ? await emailOwner(`Critic page claim: ${critic.name}`, html, input.contactEmail) : false;
  if (!sent) console.error('[critics/claim] owner email not sent for claim', row.id);
  return NextResponse.json({ ok: true, status: 'pending' });
}
