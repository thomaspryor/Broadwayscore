/**
 * The iOS app must never claim a page the website's sign-in returns to
 * (BRO-4822). The association file listed /auth/callback, so on iPhones with
 * the app installed the hop back from Google opened the app and the website
 * stayed signed out. Requires the real helper and reads the real served file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_RETURN_PATHS,
  WEB_AUTH_RETURN_PATH,
  LEGACY_AUTH_RETURN_PATH,
  oauthRedirectUrl,
} from '../../src/lib/auth-redirect';

const ROOT = join(__dirname, '..', '..');
const AASA = JSON.parse(readFileSync(join(ROOT, 'public/.well-known/apple-app-site-association'), 'utf8'));

// Apple's component `/` pattern: `*` matches any run of characters (slashes
// included), `?` one character. Excluded components are not claims.
function claimed(pattern: string, path: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(path);
}

const claims: string[] = (AASA.applinks?.details ?? []).flatMap((d: { components?: { '/'?: string; exclude?: boolean }[]; paths?: string[] }) => [
  ...(d.components ?? []).filter(c => c['/'] && !c.exclude).map(c => c['/'] as string),
  ...(d.paths ?? []).filter(p => !p.startsWith('NOT ')),
]);

test('the association file still claims show pages (sanity: the parser sees claims)', () => {
  assert.ok(claims.some(c => claimed(c, '/show/hamilton')), `claims: ${claims.join(', ')}`);
});

test('no sign-in page is claimed by the iOS app', () => {
  const signInPages = [...AUTH_RETURN_PATHS, '/auth/apple-callback'];
  for (const page of signInPages) {
    for (const c of claims) assert.ok(!claimed(c, page), `"${c}" sends ${page} to the iOS app; web sign-in on iPhone would never complete`);
  }
});

test('prod returns to the never-claimed path; allow-listed hosts keep the legacy one', () => {
  assert.equal(oauthRedirectUrl('https://broadwayscorecard.com'), `https://broadwayscorecard.com${WEB_AUTH_RETURN_PATH}`);
  for (const origin of ['https://demo.broadwayscorecard.com', 'http://localhost:3000', 'https://bsc-git-x.vercel.app']) {
    assert.equal(oauthRedirectUrl(origin), `${origin}${LEGACY_AUTH_RETURN_PATH}`);
  }
});

test('every return path has a page', () => {
  for (const p of AUTH_RETURN_PATHS) {
    assert.ok(existsSync(join(ROOT, 'src/app', p, 'page.tsx')), `missing src/app${p}/page.tsx`);
  }
});
