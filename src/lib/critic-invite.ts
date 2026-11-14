// BRO-7087: signed critic invite links. The owner already knows the critic,
// so an invite skips the claim form and the email approval. Pure (no I/O, no
// framework imports) so tests require() the real functions (CLAUDE.md §15).
//
// Token: `<slug>.<expiresUnixSeconds>.<hmac-sha256 hex>`. Stateless: nothing
// is stored when a link is made. "Works once" comes from the database rule of
// one approved owner per page (critic_claims_one_approved).
import crypto from 'crypto';
import { SLUG_RE } from './critic-claim';

export const INVITE_TTL_SECONDS = 14 * 24 * 3600;
export const INVITE_TTL_DAYS = INVITE_TTL_SECONDS / 86_400;

function mac(secret: string, slug: string, expires: number): string {
  return crypto.createHmac('sha256', secret).update(`critic-invite:${slug}:${expires}`).digest('hex');
}

/** A signed invite token for one critic page, valid for 14 days from `now`. */
export function signInvite(secret: string, slug: string, now = Date.now()): string {
  if (!secret) throw new Error('signInvite: missing secret');
  if (!SLUG_RE.test(slug)) throw new Error('signInvite: bad slug');
  const e = Math.floor(now / 1000) + INVITE_TTL_SECONDS;
  return `${slug}.${e}.${mac(secret, slug, e)}`;
}

export type InviteVerdict =
  | { ok: true; slug: string; expiresAt: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad-signature' | 'no-secret' };

/** Checks a token from signInvite. Constant-time compare; strict format. */
export function verifyInvite(secret: string | undefined, token: unknown, now = Date.now()): InviteVerdict {
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (typeof token !== 'string' || token.length > 200) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [slug, e, sigRaw] = parts;
  const sig = sigRaw.toLowerCase();
  const expires = Number(e);
  if (!SLUG_RE.test(slug) || !/^\d{1,12}$/.test(e) || !Number.isInteger(expires) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'malformed' };
  if (now > expires * 1000) return { ok: false, reason: 'expired' };
  const good = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mac(secret, slug, expires), 'hex'));
  return good ? { ok: true, slug, expiresAt: expires * 1000 } : { ok: false, reason: 'bad-signature' };
}

/** The link the owner sends: the critic's own page with the token attached. */
export function inviteUrl(site: string, slug: string, token: string): string {
  return `${site.replace(/\/$/, '')}/critics/${slug}?invite=${encodeURIComponent(token)}`;
}

/** Plain-English reason for a bad token, shown to the critic. */
export function inviteErrorMessage(reason: Exclude<InviteVerdict, { ok: true }>['reason']): string {
  if (reason === 'expired') return 'This invite link has expired. Ask for a new one.';
  if (reason === 'no-secret') return 'Invites are not available right now.';
  return 'This invite link is not valid. Ask for a new one.';
}

/** "Jesse Green" -> "Jesse". Falls back to the full name when there is nothing to split. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
