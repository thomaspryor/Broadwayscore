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

export const MAX_SOCIALS = 3;
export type SocialPlatform = 'instagram' | 'x' | 'bluesky' | 'threads' | 'tiktok' | 'linkedin' | 'facebook';
export interface SocialLink { platform: SocialPlatform; url: string }

/** Hosts accepted per platform, and how a bare @handle becomes a profile URL. */
const SOCIAL_RULES: Record<SocialPlatform, { hosts: string[]; build: (h: string) => string }> = {
  instagram: { hosts: ['instagram.com'], build: (h) => `https://instagram.com/${h}` },
  x: { hosts: ['x.com', 'twitter.com'], build: (h) => `https://x.com/${h}` },
  bluesky: { hosts: ['bsky.app'], build: (h) => `https://bsky.app/profile/${h.includes('.') ? h : `${h}.bsky.social`}` },
  threads: { hosts: ['threads.net', 'threads.com'], build: (h) => `https://threads.net/@${h}` },
  tiktok: { hosts: ['tiktok.com'], build: (h) => `https://tiktok.com/@${h}` },
  linkedin: { hosts: ['linkedin.com'], build: (h) => `https://linkedin.com/in/${h}` },
  facebook: { hosts: ['facebook.com', 'fb.com'], build: (h) => `https://facebook.com/${h}` },
};
export const SOCIAL_PLATFORMS = Object.keys(SOCIAL_RULES) as SocialPlatform[];

/**
 * One social account: a profile URL on that platform's own host, or an
 * @handle (the profile URL is built for it). Anything else returns null.
 */
export function cleanSocialLink(platform: unknown, value: unknown): SocialLink | null {
  if (typeof platform !== 'string' || !Object.prototype.hasOwnProperty.call(SOCIAL_RULES, platform)) return null;
  const rule = SOCIAL_RULES[platform as SocialPlatform];
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 200) return null;
  if (/^https?:\/\//i.test(v)) {
    const url = cleanUrl(v);
    if (!url) return null;
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
    if (!rule.hosts.includes(host)) return null;
    if (new URL(url).pathname.replace(/\//g, '') === '') return null; // bare homepage is not a profile
    return { platform: platform as SocialPlatform, url };
  }
  const handle = v.replace(/^@/, '');
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(handle)) return null;
  return { platform: platform as SocialPlatform, url: rule.build(handle) };
}

export interface ClaimInput { slug: string; contactEmail: string; socials: SocialLink[]; workUrl: string | null; note: string | null }

/**
 * Claim form input. At least one (up to MAX_SOCIALS) primary social account
 * is required; link to work and note stay optional.
 */
export function sanitizeClaimInput(body: unknown): ClaimInput | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const slug = typeof b.slug === 'string' ? b.slug : '';
  if (!SLUG_RE.test(slug)) return { error: 'Unknown critic page.' };
  const email = typeof b.contactEmail === 'string' ? b.contactEmail.trim() : '';
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return { error: 'Please enter an email address we can reach you at.' };
  const socials: SocialLink[] = [];
  const raw = Array.isArray(b.socials) ? b.socials.slice(0, MAX_SOCIALS) : [];
  for (const item of raw) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof o.value === 'string' && !o.value.trim()) continue; // untouched empty row
    const link = cleanSocialLink(o.platform, o.value);
    if (!link) return { error: 'One of your social links is not valid. Use a profile link or an @handle.' };
    if (!socials.some((x) => x.url === link.url)) socials.push(link);
  }
  if (socials.length === 0) return { error: 'Please add at least one social account so we can confirm it is you.' };
  const rawUrl = typeof b.workUrl === 'string' ? b.workUrl.trim() : '';
  const workUrl = rawUrl ? cleanUrl(rawUrl) : null;
  if (rawUrl && !workUrl) return { error: 'The link to your work must start with https://.' };
  const note = cleanText(b.note, 1000);
  if (note && countUrls(note) > MAX_NOTE_URLS) return { error: 'Please keep the note to two links at most.' };
  return { slug, contactEmail: email, socials, workUrl, note };
}

export const MAX_NOTE_URLS = 2;
/** Counts http(s) links and bare www. links in free text. */
export function countUrls(text: string): number {
  return (text.match(/(?:https?:\/\/|www\.)\S+/gi) || []).length;
}

// ---- Anti-spam: limits are pure so tests can require() the real rules ----
export const MAX_CLAIMS_PER_DAY = 3;
export interface AccountClaim { status: string; critic_slug: string; created_at: string }
export type LimitVerdict = { ok: true } | { ok: false; reason: 'pending-elsewhere' | 'daily-cap'; message: string };

/**
 * Per-account limits for a NEW claim on `slug`: one pending claim per
 * account at a time (which also covers one pending per critic page), and at
 * most MAX_CLAIMS_PER_DAY claims per account per rolling day.
 */
export function claimLimitVerdict(accountClaims: readonly AccountClaim[], slug: string, now = Date.now()): LimitVerdict {
  const pending = accountClaims.find((c) => c.status === 'pending' && c.critic_slug !== slug);
  if (pending) return { ok: false, reason: 'pending-elsewhere', message: 'You already have a request waiting for review. We will be in touch by email, and you can claim another page after that.' };
  const dayAgo = now - 86_400_000;
  const recent = accountClaims.filter((c) => Date.parse(c.created_at) > dayAgo).length;
  if (recent >= MAX_CLAIMS_PER_DAY) return { ok: false, reason: 'daily-cap', message: 'You have sent several requests today. Please try again tomorrow.' };
  return { ok: true };
}

export interface PageClaim { status: string; owner_emailed_at: string | null }
export type OwnerEmailPlan = 'full' | 'note' | 'none';

/**
 * One full email to the owner per page while a claim is pending. Later claims
 * on that page send at most one short "another claim came in" note per day
 * (nothing if any email about this page went out in the last 24 hours).
 */
export function ownerEmailPlan(otherClaimsOnPage: readonly PageClaim[], now = Date.now()): OwnerEmailPlan {
  if (!otherClaimsOnPage.some((c) => c.status === 'pending')) return 'full';
  const dayAgo = now - 86_400_000;
  const emailedRecently = otherClaimsOnPage.some((c) => c.owner_emailed_at && Date.parse(c.owner_emailed_at) > dayAgo);
  return emailedRecently ? 'none' : 'note';
}

/** Sliding fixed-window counter. Returns true when the call is allowed. */
export function rateLimitAllow(map: Map<string, { n: number; t: number }>, key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const h = map.get(key);
  if (!h || now - h.t > windowMs) { map.set(key, { n: 1, t: now }); return true; }
  h.n++;
  return h.n <= limit;
}

/** CRITIC_CLAIMS_DISABLED=true turns claiming off (prompt hidden, endpoint 503). */
export function claimsDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CRITIC_CLAIMS_DISABLED || '').trim().toLowerCase() === 'true';
}

export interface HintInput {
  contactEmail: string;
  accountEmail: string;
  /** Domain of the critic's outlet (for example nytimes.com), when known. */
  outletDomain?: string | null;
  /** Statuses of OTHER claims on the same page. */
  otherClaimStatuses: string[];
}

const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'hey.com', 'fastmail.com', 'gmx.com']);

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/**
 * Hints for the owner's manual check. They are information only: nothing here
 * approves or declines a claim.
 */
export function claimHints(i: HintInput): string[] {
  const hints: string[] = [];
  const d = domainOf(i.contactEmail);
  const od = (i.outletDomain || '').toLowerCase().replace(/^www\./, '');
  if (od && d && (d === od || d.endsWith(`.${od}`))) hints.push(`Email domain matches their outlet (${d})`);
  else if (PERSONAL_DOMAINS.has(d)) hints.push('Personal email (gmail etc.)');
  else if (d) hints.push(`Email domain is ${d}, which is not a known personal provider and does not match their outlet`);
  if (i.accountEmail && i.accountEmail.trim().toLowerCase() !== i.contactEmail.trim().toLowerCase()) hints.push('Signed-in account email differs from contact email');
  if (i.otherClaimStatuses.includes('approved')) hints.push('Another claim on this page is approved');
  else if (i.otherClaimStatuses.includes('pending')) hints.push('Another claim on this page is pending');
  return hints;
}

export const FLAG_NOTE_MAX = 600;

/** What a critic can say is wrong with one of their reviews (BRO-6984). */
export const FLAG_REASONS = {
  wrong_score: 'Wrong score',
  not_mine: 'Not my review',
  wrong_show: 'Wrong show',
  other: 'Something else',
} as const;
export type FlagReason = keyof typeof FLAG_REASONS;

export interface ScoreFlagInput { slug: string; reviewKey: string; reason: FlagReason; note: string | null }

/**
 * "Flag a problem" request. A flag is only ever a message to the owner: it
 * names one of the critic's own reviews, a reason from FLAG_REASONS and a
 * note, and nothing in it is read back into a score or a review. Unknown
 * review keys and reasons are rejected. A missing reason means the older
 * "Flag a score" form (wrong score). The note is optional except for "other".
 */
export function sanitizeFlagInput(body: unknown, ownReviewKeys: ReadonlySet<string>): ScoreFlagInput | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const slug = typeof b.slug === 'string' && SLUG_RE.test(b.slug) ? b.slug : null;
  if (!slug) return { error: 'Unknown page.' };
  const reviewKey = typeof b.reviewKey === 'string' && ownReviewKeys.has(b.reviewKey) ? b.reviewKey : null;
  if (!reviewKey) return { error: 'Pick one of your reviews.' };
  const rawReason = b.reason === undefined || b.reason === null || b.reason === '' ? 'wrong_score' : b.reason;
  if (typeof rawReason !== 'string' || !Object.prototype.hasOwnProperty.call(FLAG_REASONS, rawReason)) return { error: 'Pick what is wrong.' };
  const reason = rawReason as FlagReason;
  const note = cleanText(b.note, FLAG_NOTE_MAX);
  if (!note && reason === 'other') return { error: 'Tell us what looks wrong.' };
  if (note && countUrls(note) > MAX_NOTE_URLS) return { error: 'Please keep the note to two links at most.' };
  return { slug, reviewKey, reason, note };
}

export interface MissingReviewInput { slug: string; reviewUrl: string; note: string | null }

/** "Missing a review? Tell us": one review link plus an optional short note. */
export function sanitizeMissingReviewInput(body: unknown): MissingReviewInput | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const slug = typeof b.slug === 'string' && SLUG_RE.test(b.slug) ? b.slug : null;
  if (!slug) return { error: 'Unknown page.' };
  const reviewUrl = cleanUrl(b.reviewUrl);
  if (!reviewUrl) return { error: 'Please paste a full link to the review (starting with https://).' };
  const note = cleanText(b.note, FLAG_NOTE_MAX);
  if (note && countUrls(note) > MAX_NOTE_URLS) return { error: 'Please keep the note to two links at most.' };
  return { slug, reviewUrl, note };
}

export interface NoticeReview { showSlug: string; showTitle: string; parsedDate: number | null }

/**
 * Which of a critic's reviews should trigger an opening-night "your review is
 * in" email: published within `windowDays` of now (and not in the future), and
 * not already in the sent ledger. One entry per show, newest review wins.
 */
export function selectNoticeReviews(reviews: NoticeReview[], alreadySent: ReadonlySet<string>, nowMs: number, windowDays = 3): NoticeReview[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const byShow = new Map<string, NoticeReview>();
  for (const r of reviews) {
    if (!r.parsedDate || r.parsedDate < cutoff || r.parsedDate > nowMs) continue;
    if (alreadySent.has(r.showSlug)) continue;
    const prev = byShow.get(r.showSlug);
    if (!prev || (r.parsedDate || 0) > (prev.parsedDate || 0)) byShow.set(r.showSlug, r);
  }
  return [...byShow.values()];
}
