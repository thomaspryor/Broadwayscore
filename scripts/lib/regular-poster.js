'use strict';

/**
 * regular-poster.js (BRO-5795) - the owner rule for small blogs.
 *
 * Owner rule 2026-10-20: small blogs that regularly post Broadway/Off-Broadway reviews are
 * included and count at T4 weight (0.20) through the tier system. Inclusion itself needs no
 * gate (an unregistered outlet is included at the tier default); what was wrong was the tier.
 * The rebuild auto-registered every new outlet at T3 (0.40, double the T4 weight), 40+ of them
 * single-author blogs on hosted platforms. newOutletTier is the tier a fresh auto-registration
 * starts at: T4 for a blog-platform domain, else the T3 default. Outlets already registered
 * keep their tier (moves go through the BRO-4907 tier audit).
 *
 * Pure, no I/O (CLAUDE.md section 15).
 */

const BLOG_PLATFORM_DOMAIN_RE = /(^|\.)(blogspot\.[a-z.]+|wordpress\.com|substack\.com|wixsite\.com|weebly\.com|tumblr\.com|medium\.com|typepad\.com|livejournal\.com|ghost\.io|squarespace\.com)$/i;

const T4 = 4;
const DEFAULT_NEW_OUTLET_TIER = 3;

function hostOf(domainOrUrl) {
  const s = String(domainOrUrl || '').trim().toLowerCase();
  if (!s) return '';
  try {
    return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** True when the domain/URL sits on a hosted blog platform (a single-author blog). */
function isBlogPlatformDomain(domainOrUrl) {
  const host = hostOf(domainOrUrl);
  return !!host && BLOG_PLATFORM_DOMAIN_RE.test(host);
}

/** Tier a newly auto-registered outlet starts at: T4 for a blog platform, else the T3 default. */
function newOutletTier(domainOrUrl) {
  return isBlogPlatformDomain(domainOrUrl) ? T4 : DEFAULT_NEW_OUTLET_TIER;
}

module.exports = { isBlogPlatformDomain, newOutletTier };
