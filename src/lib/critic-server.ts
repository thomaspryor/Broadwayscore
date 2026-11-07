import 'server-only';
import type { NextRequest } from 'next/server';

// BRO-6895: server-side plumbing for critic claiming. All writes use the
// service role AFTER the caller's Supabase JWT is verified.

const SB_URL = () => process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const CRITIC_PHOTO_BUCKET = 'critic-photos';

export function criticBackendReady(): boolean {
  return !!(SB_URL() && SERVICE() && ANON());
}

export async function sbAdmin(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
  const { prefer, ...rest } = init;
  return fetch(`${SB_URL()}${path}`, {
    ...rest,
    cache: 'no-store',
    headers: {
      apikey: SERVICE(),
      Authorization: `Bearer ${SERVICE()}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(10000),
  });
}

/** The signed-in user behind `Authorization: Bearer <access token>`, verified by Supabase Auth. */
export async function getRequestUser(req: NextRequest): Promise<{ id: string; email: string } | null> {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.get('authorization') || '');
  if (!m || !criticBackendReady()) return null;
  try {
    const res = await fetch(`${SB_URL()}/auth/v1/user`, {
      headers: { apikey: ANON(), Authorization: `Bearer ${m[1]}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u?.id ? { id: String(u.id), email: String(u.email || '') } : null;
  } catch { return null; }
}

export interface ClaimRow {
  id: string; critic_slug: string; user_id: string; contact_email: string;
  work_url: string | null; note: string | null; status: 'pending' | 'approved' | 'declined';
  notify_opening_night: boolean; created_at: string;
}

export async function getClaimsForUser(userId: string, slug: string): Promise<ClaimRow[]> {
  const res = await sbAdmin(`/rest/v1/critic_claims?user_id=eq.${encodeURIComponent(userId)}&critic_slug=eq.${encodeURIComponent(slug)}&select=*&order=created_at.desc`);
  return res.ok ? await res.json() : [];
}

export async function approvedClaimFor(userId: string, slug: string): Promise<ClaimRow | null> {
  return (await getClaimsForUser(userId, slug)).find((c) => c.status === 'approved') || null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
export { esc as escHtml };

/** Plain transactional email to the owner (OWNER_EMAIL), reply-to the critic when given. Never a broadcast. */
export async function emailOwner(subject: string, html: string, replyTo?: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.OWNER_EMAIL;
  if (!key || !to) { console.error('[critics] RESEND_API_KEY or OWNER_EMAIL missing'); return false; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Broadway Scorecard <critics@broadwayscorecard.com>',
        to: [to], subject, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error('[critics] owner email refused', res.status);
    return res.ok;
  } catch (e) { console.error('[critics] owner email failed', e instanceof Error ? e.message : e); return false; }
}

import type { PublicCriticProfile } from './critic-server-types';
export type { PublicCriticProfile };

export function photoUrlFor(path: string | null): string | null {
  return path ? `${SB_URL()}/storage/v1/object/public/${CRITIC_PHOTO_BUCKET}/${path}` : null;
}

export function toPublicProfile(r: Record<string, any>): PublicCriticProfile {
  return {
    slug: r.critic_slug, photoUrl: photoUrlFor(r.photo_path || null), jobTitle: r.job_title || null, bio: r.bio || null,
    outlets: r.outlets || [], links: r.links || [], picks: r.picks || {}, pinnedReviewKey: r.pinned_review_key || null,
  };
}

/** Public profile for a page render. Cached by tag; null when unclaimed or the backend is down. */
export async function getPublicCriticProfile(slug: string): Promise<PublicCriticProfile | null> {
  if (!criticBackendReady()) return null;
  try {
    const res = await fetch(`${SB_URL()}/rest/v1/critic_profiles?critic_slug=eq.${encodeURIComponent(slug)}&select=*`, {
      headers: { apikey: SERVICE(), Authorization: `Bearer ${SERVICE()}` },
      cache: 'force-cache',
      next: { tags: ['critic-profiles', `critic-profile:${slug}`] },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] ? toPublicProfile(rows[0]) : null;
  } catch { return null; }
}

/** Slugs of verified (claimed and approved) critics, for the /critics Verified filter. Cached by tag. */
export async function getVerifiedCriticSlugs(): Promise<string[]> {
  if (!criticBackendReady()) return [];
  try {
    const res = await fetch(`${SB_URL()}/rest/v1/critic_profiles?select=critic_slug&limit=2000`, {
      headers: { apikey: SERVICE(), Authorization: `Bearer ${SERVICE()}` },
      cache: 'force-cache',
      next: { tags: ['critic-profiles'] },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as { critic_slug: string }[];
    return rows.map((r) => r.critic_slug);
  } catch { return []; }
}
