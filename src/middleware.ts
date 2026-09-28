import { NextRequest, NextResponse } from 'next/server';
import slugRedirects from '../data/slug-redirects-compact.json';
import { resolvePathRedirect } from './lib/slug-redirects';

const redirectMap = slugRedirects as Record<string, string>;

// /show/<slug>: versionless slug, id, or merged-row alias → canonical slug
//   ("~"-prefixed map value = 302 multi-production, otherwise 301).
// /critics/<slug>: retired critic slug → canonical slug, always 301
//   (data/critic-slug-aliases.json via scripts/build-slug-redirects.js, S5-T9).
// Nested paths (/critics/outlets/<x>) and unknown slugs fall through to the
// page, which 404s on its own. Resolution lives in src/lib/slug-redirects.ts
// so data-reviews.ts getCriticBySlug() shares it.
export function middleware(request: NextRequest) {
  const hit = resolvePathRedirect(redirectMap, request.nextUrl.pathname);
  if (!hit) return;

  const url = request.nextUrl.clone();
  url.pathname = hit.pathname;

  return NextResponse.redirect(url, hit.status);
}

export const config = {
  matcher: ['/show/:slug+', '/critics/:slug+'],
};
