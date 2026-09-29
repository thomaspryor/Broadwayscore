import { NextRequest, NextResponse } from 'next/server';
import slugRedirects from '../data/slug-redirects-compact.json';
import { resolvePathRedirect } from './lib/slug-redirects';

const redirectMap = slugRedirects as Record<string, string>;

// /show/<slug>: versionless slug, id, or merged-row alias → canonical slug
//   ("~"-prefixed map value = 302 multi-production, otherwise 301).
// /critics/<slug>: retired critic slug → canonical slug, always 301
//   (data/critic-slug-aliases.json via scripts/build-slug-redirects.js, S5-T9).
// /creative, /theater, /west-end/theater, /off-broadway/theater, /cast:
//   pre-S7-T3 (unfolded) person/place slug → live slug, always 301, derived at
//   prebuild from the data the pages are built from
//   (scripts/lib/name-slug-redirects.js; S7-T3 follow-up).
// Nested paths (/critics/outlets/<x>) and unknown slugs fall through to the
// page, which 404s on its own. Resolution lives in src/lib/slug-redirects.ts
// so the data-*.ts slug lookups (getCriticBySlug, getUnifiedCreativeProfile,
// getTheaterBySlug, …) share it.
export function middleware(request: NextRequest) {
  const hit = resolvePathRedirect(redirectMap, request.nextUrl.pathname);
  if (!hit) return;

  const url = request.nextUrl.clone();
  url.pathname = hit.pathname;

  return NextResponse.redirect(url, hit.status);
}

// Must stay a static literal (Next analyses it at build time) — one entry per
// route resolvePathRedirect handles; tests/unit/middleware-slug-redirects.test.mjs
// asserts it matches src/lib/slug-redirects.ts NAME_ROUTE_FAMILIES.
export const config = {
  matcher: [
    '/show/:slug+',
    '/critics/:slug+',
    '/creative/:slug+',
    '/theater/:slug+',
    '/west-end/theater/:slug+',
    '/off-broadway/theater/:slug+',
    '/cast/:slug+',
  ],
};
