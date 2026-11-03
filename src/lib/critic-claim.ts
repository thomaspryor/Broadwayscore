// BRO-6895: pure helpers for critic page claiming. No I/O, no framework
// imports, so tests require() the real functions (CLAUDE.md §15).
import crypto from 'crypto';

export type ClaimAction = 'approve' | 'decline';

export const CLAIM_LINK_TTL_SECONDS = 14 * 24 * 3600;
export const BIO_MAX = 300;
export const TITLE_MAX = 100;
export const MAX_LINKS = 6;
export const MAX_OUTLETS = 6;
export const PICK_MAX = 120;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(secret: string, action: ClaimAction, claimId: string, expires: number): string {
  return crypto.createHmac('sha256', secret).update(`critic-claim:${action}:${claimId}:${expires}`).digest('hex');
}

/** Signed query params for one action on one claim. */
export function signClaimLink(secret: string, action: ClaimAction, claimId: string, now = Date.now()): { c: string; a: ClaimAction; e: number; s: string } {
  const e = Math.floor(now / 1000) + CLAIM_LINK_TTL_SECONDS;
  return { c: claimId, a: action, e, s: mac(secret, action, claimId, e) };
}

export type VerifyResult =
  | { ok: true; action: ClaimAction; claimId: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad-signature' | 'no-secret' };

/** Verifies params from signClaimLink. Constant-time compare; strict hex. */
export function verifyClaimLink(secret: string | undefined, p: { c?: string | null; a?: string | null; e?: string | null; s?: string | null }, now = Date.now()): VerifyResult {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const action = p.a === 'approve' || p.a === 'decline' ? p.a : null;
  const claimId = p.c || '';
  const expires = Number(p.e);
  const sig = (p.s || '').toLowerCase();
  if (!action || !UUID_RE.test(claimId) || !Number.isInteger(expires) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'malformed' };
  if (now > expires * 1000) return { ok: false, reason: 'expired' };
  const good = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mac(secret, action, claimId, expires), 'hex'));
  return good ? { ok: true, action, claimId } : { ok: false, reason: 'bad-signature' };
}

/** http(s) URL only, trimmed, max 300 chars; null when unusable. */
export function cleanUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 300) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch { return null; }
}

function cleanText(input: unknown, max: number): string | null {
  if (typeof input !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = input.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (!s) return null;
  return s.slice(0, max);
}

export interface CriticLink { label: string; url: string }
export interface CriticPicks { bestEver?: string; thisSeason?: string }
export interface CriticProfileEdit {
  jobTitle: string | null;
  bio: string | null;
  outlets: string[];
  links: CriticLink[];
  picks: CriticPicks;
  pinnedReviewKey: string | null;
}

/**
 * The ONLY path from a request body to a stored profile. Reads a fixed
 * allow-list of fields and ignores everything else, so a body carrying
 * score, avgScore, rank, reviews, reviewScore, etc. changes nothing
 * (hard rule: critics never edit scores, rank, averages or reviews).
 * `ownReviewKeys` are the review keys on this critic's own page; a pinned
 * review outside that set is dropped.
 */
export function sanitizeProfileEdit(body: unknown, ownReviewKeys: ReadonlySet<string>): CriticProfileEdit {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const links: CriticLink[] = [];
  if (Array.isArray(b.links)) {
    for (const l of b.links.slice(0, MAX_LINKS)) {
      const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
      const url = cleanUrl(o.url);
      const label = cleanText(o.label, 40);
      if (url && label) links.push({ label, url });
    }
  }
  const outlets = Array.isArray(b.outlets)
    ? b.outlets.map((o) => cleanText(o, 80)).filter((o): o is string => !!o).slice(0, MAX_OUTLETS)
    : [];
  const p = (b.picks && typeof b.picks === 'object' ? b.picks : {}) as Record<string, unknown>;
  const picks: CriticPicks = {};
  const best = cleanText(p.bestEver, PICK_MAX);
  const season = cleanText(p.thisSeason, PICK_MAX);
  if (best) picks.bestEver = best;
  if (season) picks.thisSeason = season;
  const pinned = typeof b.pinnedReviewKey === 'string' && ownReviewKeys.has(b.pinnedReviewKey) ? b.pinnedReviewKey : null;
  return {
    jobTitle: cleanText(b.jobTitle, TITLE_MAX),
    bio: cleanText(b.bio, BIO_MAX),
    outlets,
    links,
    picks,
    pinnedReviewKey: pinned,
  };
}

/** Claim form input; null fields mean invalid. */
export function sanitizeClaimInput(body: unknown): { slug: string; contactEmail: string; workUrl: string | null; note: string | null } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const slug = typeof b.slug === 'string' ? b.slug : '';
  if (!SLUG_RE.test(slug)) return { error: 'Unknown critic page.' };
  const email = typeof b.contactEmail === 'string' ? b.contactEmail.trim() : '';
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return { error: 'Please enter an email address we can reach you at.' };
  const rawUrl = typeof b.workUrl === 'string' ? b.workUrl.trim() : '';
  const workUrl = rawUrl ? cleanUrl(rawUrl) : null;
  if (rawUrl && !workUrl) return { error: 'The link to your work must start with https://.' };
  return { slug, contactEmail: email, workUrl, note: cleanText(b.note, 1000) };
}
