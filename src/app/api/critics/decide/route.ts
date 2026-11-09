import { NextRequest } from 'next/server';
import { CONFIRM_FIELD_HTML, readConfirmedForm } from '@/lib/confirm-post';
import { verifyClaimLink } from '@/lib/critic-claim';
import { sbAdmin, escHtml, criticBackendReady, ownershipDeps, type ClaimRow } from '@/lib/critic-server';
import { grantOwnership } from '@/lib/critic-ownership';

// BRO-6895: the owner's Approve / Decline links. GET only shows a confirm
// button (mail scanners open every link); the POST behind it acts.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="robots" content="noindex"><title>${escHtml(title)} - Broadway Scorecard</title>
<style>body{margin:0;padding:40px 20px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center}h1{font-size:24px}p{color:rgba(255,255,255,.7);line-height:1.6;max-width:480px;margin:0 auto 16px}button{font-size:16px;font-weight:600;border:0;border-radius:8px;padding:12px 24px;background:#d4a574;color:#1a1208}a{color:#d4a574}</style></head><body>${body}</body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function gate(p: Record<string, string | null>) {
  const v = verifyClaimLink(process.env.APPROVAL_HMAC_SECRET, p);
  if (v.ok) return v;
  if (v.reason === 'expired') return page('Link expired', '<h1>Link expired</h1><p>Nothing was changed.</p>', 410);
  if (v.reason === 'no-secret') return page('Not set up', '<h1>Not set up</h1><p>Nothing was changed.</p>', 500);
  return page('Link not valid', '<h1>Link not valid</h1><p>This link could not be verified. Nothing was changed.</p>', 400);
}

async function loadClaim(id: string): Promise<ClaimRow | null> {
  const res = await sbAdmin(`/rest/v1/critic_claims?id=eq.${encodeURIComponent(id)}&select=*`);
  const rows = res.ok ? await res.json() : [];
  return rows[0] || null;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const params = { c: q.get('c'), a: q.get('a'), e: q.get('e'), s: q.get('s') };
  const g = gate(params);
  if (g instanceof Response) return g;
  if (!criticBackendReady()) return page('Unavailable', '<h1>Unavailable</h1><p>Nothing was changed.</p>', 503);
  const claim = await loadClaim(g.claimId);
  if (!claim) return page('Not found', '<h1>Request not found</h1><p>Nothing was changed.</p>', 404);
  if (claim.status !== 'pending' && !(claim.status === 'approved' && g.action === 'approve')) return page('Already handled', `<h1>Already ${escHtml(claim.status)}</h1><p>Nothing changes if you tap again.</p>`);
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${k}" value="${escHtml(v || '')}">`).join('');
  return page(g.action === 'approve' ? 'Approve claim' : 'Decline claim',
    `<h1>${g.action === 'approve' ? 'Approve' : 'Decline'} this claim?</h1><p>Page: <a href="/critics/${escHtml(claim.critic_slug)}">${escHtml(claim.critic_slug)}</a><br>Contact: ${escHtml(claim.contact_email)}</p>
<form method="POST" action="/api/critics/decide">${hidden}${CONFIRM_FIELD_HTML}<button type="submit">${g.action === 'approve' ? 'Approve' : 'Decline'}</button></form><p style="font-size:13px">Nothing is saved until you press the button.</p>`);
}

export async function POST(req: NextRequest) {
  const form = await readConfirmedForm(req);
  if (!form) return page('Not confirmed', '<h1>Not confirmed</h1><p>Open the link from your email and press the button. Nothing was changed.</p>', 400);
  const get = (k: string) => String(form.get(k) || '');
  const g = gate({ c: get('c'), a: get('a'), e: get('e'), s: get('s') });
  if (g instanceof Response) return g;
  if (!criticBackendReady()) return page('Unavailable', '<h1>Unavailable</h1><p>Nothing was changed.</p>', 503);
  const claim = await loadClaim(g.claimId);
  if (!claim) return page('Not found', '<h1>Request not found</h1><p>Nothing was changed.</p>', 404);
  // Retrying an approve whose profile row failed last time is allowed: the profile upsert below is idempotent.
  const retryApprove = claim.status === 'approved' && g.action === 'approve';
  if (claim.status !== 'pending' && !retryApprove) return page('Already handled', `<h1>Already ${escHtml(claim.status)}</h1><p>Nothing changed.</p>`);

  const status = g.action === 'approve' ? 'approved' : 'declined';
  const upd = retryApprove ? new Response('[]', { status: 200 }) : await sbAdmin(`/rest/v1/critic_claims?id=eq.${g.claimId}&status=eq.pending`, {
    method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ status, decided_at: new Date().toISOString() }),
  });
  if (!upd.ok) {
    return page('Could not record', upd.status === 409
      ? '<h1>Another account already owns this page</h1><p>Nothing was changed.</p>'
      : '<h1>Could not record that</h1><p>Nothing was changed. Tap the link again in a minute.</p>', upd.status === 409 ? 409 : 502);
  }
  if (!retryApprove) {
    const changed = (await upd.json().catch(() => [])) as unknown[];
    if (!Array.isArray(changed) || changed.length !== 1) return page('Already handled', '<h1>Already handled</h1><p>Someone else decided this a moment ago. Nothing changed.</p>', 409);
  }
  if (g.action === 'approve') {
    if (!(await grantOwnership(claim.critic_slug, claim.user_id, ownershipDeps))) return page('Partly done', '<h1>Approved, but the profile row failed</h1><p>Tap the link again in a minute.</p>', 502);
  }
  return page('Recorded', `<h1>${g.action === 'approve' ? 'Approved' : 'Declined'}</h1><p>${escHtml(claim.critic_slug)} is recorded as ${status}.</p>`);
}
