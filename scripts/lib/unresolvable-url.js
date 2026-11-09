'use strict';

/**
 * Google's opaque redirect/AMP cache URLs can't be resolved to an article.
 * SERP results sometimes return /goto?url=CAE... (relative) or
 * webcache.googleusercontent.com wrappers instead of the destination. They
 * break dedup (each redirect is unique), owner filtering (no hostname) and
 * fetching (no tier can load a relative path). Shared by brand-mention-serp
 * and review-file-writer (BRO-4458).
 */
function isUnresolvableRedirectUrl(url) {
  if (!url) return true;
  const s = String(url);
  if (s.startsWith('/')) return true;
  if (/^https?:\/\/(?:webcache\.googleusercontent\.com|(?:www\.)?google\.com\/amp)/i.test(s)) return true;
  if (isOpaqueGoogleRedirect(s)) return true;
  try {
    const parsed = new URL(s);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * BRO-7171 Stage 2b: Google now serves scraped SERPs click-tracking tokens instead
 * of result URLs: absolute google.<tld>/url?q=CAES... (Scrapingdog `link`) and
 * relative /goto?url=CAES... or /url?q=CAES... (Bright Data `link`). The token is
 * not the target (probe 2026-11-09: fetching one returns a 200 JavaScript
 * interstitial, no Location header, no target href). A google /url wrapper whose
 * q/url param IS an http(s) URL is not opaque: it unwraps.
 */
function isOpaqueGoogleRedirect(url) {
  if (!url) return false;
  const s = String(url);
  let parsed;
  try {
    parsed = new URL(s, 'https://www.google.com');
  } catch {
    return false;
  }
  const relative = s.startsWith('/');
  const googleHost = /(^|\.)google\.[a-z.]+$/i.test(parsed.hostname);
  if (!relative && !googleHost) return false;
  if (!/^\/(url|goto)$/.test(parsed.pathname)) return false;
  return !unwrapGoogleRedirect(s);
}

/** The http(s) target inside a google /url?q=https://... wrapper, else null. */
function unwrapGoogleRedirect(url) {
  let parsed;
  try {
    parsed = new URL(String(url), 'https://www.google.com');
  } catch {
    return null;
  }
  for (const k of ['q', 'url']) {
    const v = parsed.searchParams.get(k);
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

/**
 * Rebuild a result URL from Google's breadcrumb display ("https://site.com › a › b").
 * Only an untruncated breadcrumb with a scheme and at least one path segment is
 * trusted; Google elides long ones with "..." / "…", and a host alone is not a page.
 * The rebuilt URL may lack a file extension or trailing slash, so callers fetch
 * and validate it like any other candidate.
 */
function urlFromDisplayedLink(displayed) {
  if (!displayed || typeof displayed !== 'string') return null;
  const s = displayed.trim();
  if (/\.\.\.|…/.test(s)) return null;
  const parts = s.split(/\s*›\s*/).filter(Boolean);
  if (parts.length < 2) return null;
  const origin = parts[0].replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/i.test(origin)) return null;
  if (parts.slice(1).some((p) => /\s/.test(p))) return null;
  try {
    return new URL(`${origin}/${parts.slice(1).join('/')}`).toString();
  } catch {
    return null;
  }
}

/**
 * The page URL of one SERP result, or null when only an opaque token is known.
 * Order: a real `link`, the target inside a google /url?q=https wrapper, a real
 * `redirect_link`, then the untruncated breadcrumb (reconstructed: true).
 * @param {{link?:string, url?:string, redirect_link?:string, displayed_link?:string}} r
 * @returns {{url:string, reconstructed:boolean}|null}
 */
function resolveSerpLink(r) {
  for (const raw of [r && (r.link || r.url), r && r.redirect_link]) {
    if (!raw) continue;
    const unwrapped = /^\/|google\./i.test(raw) ? unwrapGoogleRedirect(raw) : null;
    if (unwrapped) return { url: unwrapped, reconstructed: false };
    if (!isUnresolvableRedirectUrl(raw)) return { url: raw, reconstructed: false };
  }
  const rebuilt = urlFromDisplayedLink(r && r.displayed_link);
  return rebuilt ? { url: rebuilt, reconstructed: true } : null;
}

/**
 * Drop results whose url is an unresolvable token (any provider, cached or live).
 * @returns {{results: Array, dropped: number}}
 */
function dropUnresolvableSerpResults(results) {
  if (!Array.isArray(results)) return { results, dropped: 0 };
  const kept = results.filter((r) => r && !isUnresolvableRedirectUrl(r.url));
  return { results: kept, dropped: results.length - kept.length };
}

module.exports = {
  isUnresolvableRedirectUrl,
  isOpaqueGoogleRedirect,
  unwrapGoogleRedirect,
  urlFromDisplayedLink,
  resolveSerpLink,
  dropUnresolvableSerpResults,
};
