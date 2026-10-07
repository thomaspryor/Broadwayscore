'use strict';

// email-utm.js — append UTM params to outbound-email links for GA4/PostHog
// attribution. Applied ONCE to each email's final HTML, right before the
// draft/send. Idempotent by design: a link that already carries `utm_source`
// is left untouched, so re-running (or a generator that tags some links
// inline) can never double-tag. This is what makes it safe to wire into
// generate.mjs even while another session edits that file.
//
// Resend click-tracking (links.broadwayscorecard.com) is a SEPARATE layer —
// it rewrites links for dashboard CTR and preserves the query string, so the
// UTMs added here survive the redirect and reach GA4/PostHog. See
// memory/feedback_newsletter_no_utm.md.

// Only first-party content links get tagged. These hosts are ours.
const FIRST_PARTY_HOSTS = new Set([
  'broadwayscorecard.com',
  'www.broadwayscorecard.com',
]);

// Never tag these paths — list-management links must stay clean (UTMs on an
// unsubscribe link pollute attribution and can break one-click unsubscribe
// matching). Compared case-insensitively against the URL pathname.
const SKIP_PATH_PREFIXES = [
  '/unsubscribe',
  '/unfollow',
  '/api/', // /api/unsubscribe and any other API endpoints
];

function shouldSkip(u) {
  if (!FIRST_PARTY_HOSTS.has(u.hostname.toLowerCase())) return true; // social, fonts, github, external
  if (u.searchParams.has('utm_source')) return true; // idempotent: already tagged
  const path = u.pathname.toLowerCase();
  return SKIP_PATH_PREFIXES.some(p => path.startsWith(p));
}

// Build the tagged URL. URL handles query-merge and fragment ordering for us
// (params always serialize before the #fragment), so `/x#best-musical` becomes
// `/x?utm_...#best-musical` correctly.
function tagUrl(rawUrl, { source, medium, campaign }) {
  // hrefs in email HTML are usually entity-escaped (escapeHtml turns `&` into
  // `&amp;`), so a multi-param query arrives as `?a=1&amp;b=2`. Decode to a
  // valid URL before parsing — otherwise `new URL()` reads a junk `amp;b`
  // param — then re-encode `&` → `&amp;` on the way out so the attribute stays
  // valid HTML and matches the surrounding template's escaping convention.
  const decoded = rawUrl.replace(/&amp;/g, '&');
  let u;
  try {
    u = new URL(decoded);
  } catch {
    return null; // relative URL, mailto:, tel:, {{token}}, etc. — leave as-is
  }
  if (shouldSkip(u)) return null;
  u.searchParams.set('utm_source', source);
  u.searchParams.set('utm_medium', medium);
  u.searchParams.set('utm_campaign', campaign);
  return u.toString().replace(/&/g, '&amp;');
}

/**
 * Append UTM params to every first-party content link in an email's HTML.
 * @param {string} html  Final email HTML.
 * @param {{campaign:string, source:string, medium?:string}} opts
 * @returns {string} HTML with UTMs applied (idempotently).
 */
function applyUtm(html, opts) {
  if (typeof html !== 'string') throw new TypeError('applyUtm: html must be a string');
  const { campaign, source } = opts || {};
  const medium = (opts && opts.medium) || 'email';
  if (!source || !campaign) {
    throw new Error('applyUtm: { source, campaign } are required');
  }
  const cfg = { source, medium, campaign };
  // Match the `href` attribute only — capture the quote so we re-emit it. The
  // (?<![\w-]) lookbehind keeps it from matching `data-href`, `x-href`, etc.
  // (where `href=` is a substring), which would corrupt non-link metadata.
  return html.replace(/(?<![\w-])href\s*=\s*(["'])(.*?)\1/gi, (full, quote, url) => {
    const tagged = tagUrl(url, cfg);
    return tagged ? `href=${quote}${tagged}${quote}` : full;
  });
}

module.exports = { applyUtm };
