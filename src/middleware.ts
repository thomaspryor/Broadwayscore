import { NextRequest, NextResponse } from 'next/server';
import slugRedirects from '../data/slug-redirects-compact.json';

const redirectMap = slugRedirects as Record<string, string>;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only handle /show/<slug> where slug doesn't contain a slash
  if (!pathname.startsWith('/show/')) return;

  const rawSlug = pathname.slice('/show/'.length).replace(/\/$/, '');
  if (!rawSlug || rawSlug.includes('/')) return;

  const entry = redirectMap[rawSlug.toLowerCase()];
  if (!entry) return; // Unknown slug — fall through to 404

  // "~" prefix = temporary (302, multi-production); otherwise permanent (301)
  const isTemporary = entry.startsWith('~');
  const targetSlug = isTemporary ? entry.slice(1) : entry;

  const url = request.nextUrl.clone();
  url.pathname = `/show/${targetSlug}`;

  return NextResponse.redirect(url, isTemporary ? 302 : 301);
}

export const config = {
  matcher: ['/show/:slug+'],
};
