import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_COOKIE_NAME } from '@/lib/admin-auth';

/**
 * Admin login: sets the admin_token cookie and redirects.
 *
 * GET /api/admin/login?token=XXX&redirect=/admin/affiliate
 *
 * - If token matches ADMIN_TOKEN env var: sets cookie, 302s to redirect path
 * - Otherwise: returns 404 (no feedback — don't advertise the surface)
 *
 * Redirect path is sanitized: must start with /admin/ to prevent open-redirect.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const expected = process.env.ADMIN_TOKEN;

  if (!token || !expected || token !== expected) {
    return new NextResponse(null, { status: 404 });
  }

  const requestedRedirect = searchParams.get('redirect') || '/admin/affiliate';
  const safeRedirect = requestedRedirect.startsWith('/admin/') ? requestedRedirect : '/admin/affiliate';

  const response = NextResponse.redirect(new URL(safeRedirect, request.url), 302);
  response.cookies.set(ADMIN_COOKIE_NAME, expected, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return response;
}
