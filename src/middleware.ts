import { NextRequest, NextResponse } from 'next/server';
import slugRedirects from '../data/slug-redirects-compact.json';
import { resolvePathRedirect } from './lib/slug-redirects';
import { AD_REGION_COOKIE, adRegionForCountry } from './lib/ads';

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
//
// Ad region (BRO-5893, sprint-plan-adsense.md B-T9): on /show/* requests that
// don't redirect, set `bwsc_ad_region` from Vercel's x-vercel-ip-country so
// AdSlot can skip UK/EEA/CH visitors. No identifier, only a yes/no. Written
// only when the value changes. An absent cookie already reads as no-ads, so a
// no-ads visitor (UK/EEA/CH, or a missing header: never on Vercel, always in
// local runs) only gets a write when downgrading an existing cookie; the
// fall-through stays `undefined`.
export function middleware(request: NextRequest) {
  const hit = resolvePathRedirect(redirectMap, request.nextUrl.pathname);
  if (!hit) {
    if (!request.nextUrl.pathname.startsWith('/show/')) return;
    const country = request.headers.get('x-vercel-ip-country');
    const current = request.cookies.get(AD_REGION_COOKIE)?.value;
    const region = adRegionForCountry(country);
    if (current === region || (current === undefined && region === 'no-ads')) return;
    const res = NextResponse.next();
    res.cookies.set(AD_REGION_COOKIE, region, { path: '/', maxAge: 86400, sameSite: 'lax' });
    return res;
  }

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
