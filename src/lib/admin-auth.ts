import 'server-only';
import { cookies } from 'next/headers';

/**
 * Admin auth primitive.
 *
 * The admin dashboard is gated by a shared-secret cookie, not real auth.
 * This is fine for a single-user internal tool; do not reuse for multi-user
 * surfaces.
 *
 * Setup flow:
 *   1. User visits /api/admin/login?token=XXX once
 *   2. Route handler validates token against ADMIN_TOKEN env var and sets
 *      the `admin_token` cookie (httpOnly, secure, sameSite: lax)
 *   3. Subsequent visits to /admin/* read the cookie and allow access
 *
 * Rotate by changing ADMIN_TOKEN in Vercel env vars.
 */

export const ADMIN_COOKIE_NAME = 'admin_token';

/**
 * Returns true if the current request carries a valid admin_token cookie.
 * Reads process.env.ADMIN_TOKEN — if unset, returns false (deny-by-default).
 */
export function isAdmin(): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const cookieStore = cookies();
  const actual = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!actual) return false;
  return constantTimeEqual(actual, expected);
}

/**
 * Timing-safe string comparison. Shared-secret is low stakes, but avoiding
 * early-exit comparison costs us nothing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
