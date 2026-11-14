'use strict';

/**
 * Owner-only signed links that ride a Linear card's DECISION NEEDED line
 * (the line emails the owner). Shared by the one-tap Gmail renewal (BRO-3712,
 * gmail-reauth.js) and the Mezzanine session-token page (BRO-5235,
 * mezzanine-token-renewal.js).
 *
 *   <origin><path>?e=<unix exp>&s=<hex HMAC-SHA256(secret, `${domain}:${exp}`)>
 *
 * Each flow passes its own `domain`, so a link minted for one flow never
 * verifies on another's route. The secret is APPROVAL_HMAC_SECRET, which Vercel
 * and GitHub Actions both hold; rotating it voids every outstanding link.
 *
 * Pure and dependency-free so the Next.js routes (via createRequire) and the
 * Actions scripts share one implementation (rule 15).
 */

const crypto = require('crypto');

const SITE_ORIGIN = 'https://broadwayscorecard.com';
const SIG_HEX_CHARS = 32; // 128 bits; hex so Linear/markdown never escapes it

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * @param {{ domain: string, path: string, ttlDays: number, origin?: string,
 *           extraLine?: RegExp }} opts
 *   extraLine matches the flow's own follow-up lines on the card, so a
 *   re-minted link replaces the whole block instead of stacking a second one.
 */
function createSignedLink({ domain, path, ttlDays, origin = SITE_ORIGIN, extraLine = null }) {
  if (!domain || !path || !ttlDays) throw new Error('owner-signed-link: domain, path and ttlDays are required');
  const base = `${origin}${path}`;

  function signature(exp, secret) {
    if (!secret) throw new Error(`${domain}: no signing secret`);
    return crypto.createHmac('sha256', String(secret)).update(`${domain}:${exp}`).digest('hex').slice(0, SIG_HEX_CHARS);
  }

  /** The owner's link, valid for `days`. */
  function buildStartLink(secret, nowMs = Date.now(), days = ttlDays) {
    const exp = Math.floor(nowMs / 1000) + Math.round(days * 86400);
    return { url: `${base}?e=${exp}&s=${signature(exp, secret)}`, exp };
  }

  /** { ok: true } or { ok: false, reason: 'malformed' | 'expired' | 'bad-signature' | 'no-secret' }. */
  function verifyStartLink(e, s, secret, nowMs = Date.now()) {
    if (!secret) return { ok: false, reason: 'no-secret' };
    if (!/^\d{9,11}$/.test(String(e || '')) || !/^[0-9a-f]+$/.test(String(s || ''))) return { ok: false, reason: 'malformed' };
    const expected = signature(e, secret);
    const given = String(s);
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return { ok: false, reason: 'bad-signature' };
    }
    if (nowMs > Number(e) * 1000) return { ok: false, reason: 'expired' };
    return { ok: true };
  }

  /** Expiry (unix seconds) of the link already on the card, or null. */
  function existingLinkExp(description) {
    const m = new RegExp(`${escapeRegExp(base)}\\?e=(\\d{9,11})&`).exec(String(description || ''));
    return m ? Number(m[1]) : null;
  }

  function isBlockLine(line) {
    return line.includes(`${base}?e=`) || Boolean(extraLine && extraLine.test(line.trim()));
  }

  function stripDecisionBlock(description) {
    return String(description || '').split('\n').filter((l) => !isBlockLine(l)).join('\n').replace(/^\n+/, '');
  }

  /** The block goes first: the notifier emails only the description's first DECISION NEEDED line. */
  function withDecisionBlock(description, block) {
    const rest = stripDecisionBlock(description);
    return rest ? `${block}\n\n${rest}` : block;
  }

  return { base, signature, buildStartLink, verifyStartLink, existingLinkExp, isBlockLine, stripDecisionBlock, withDecisionBlock };
}

module.exports = { SITE_ORIGIN, SIG_HEX_CHARS, createSignedLink };
