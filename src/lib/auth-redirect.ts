/**
 * Where Supabase sends a web Google sign-in back to (BRO-4822).
 *
 * The iOS app's Universal Links (public/.well-known/apple-app-site-association)
 * claimed /auth/callback. On an iPhone with the app installed, the hop back
 * from Google opened the app instead of Safari, so the website never received
 * its session: the visitor "signed in" and stayed signed out. Prod now returns
 * to /auth/complete, a path the app has never claimed, so sign-in works even
 * on phones still holding a cached copy of the old association file (iOS
 * refreshes it on its own schedule).
 *
 * Other hosts keep /auth/callback. GoTrue allows any path on the site_url host
 * (broadwayscorecard.com), but demo, Vercel previews and localhost are
 * allow-listed by exact URL (scripts/lib/auth-redirect-allowlist.mjs), and
 * none of them is in the app's associated domains.
 *
 * tests/unit/auth-return-paths.test.ts fails if the association file ever
 * claims one of these paths again.
 */
export const WEB_AUTH_RETURN_PATH = '/auth/complete';
export const LEGACY_AUTH_RETURN_PATH = '/auth/callback';
/** Every page that receives OAuth tokens in its URL hash. */
export const AUTH_RETURN_PATHS = [WEB_AUTH_RETURN_PATH, LEGACY_AUTH_RETURN_PATH] as const;

/** The site_url host: the only host whose Universal Links the iOS app holds. */
const APP_LINKED_HOST = 'broadwayscorecard.com';

export function oauthRedirectUrl(origin: string): string {
  let host = '';
  try { host = new URL(origin).hostname; } catch { /* keep the legacy path */ }
  return origin + (host === APP_LINKED_HOST ? WEB_AUTH_RETURN_PATH : LEGACY_AUTH_RETURN_PATH);
}
