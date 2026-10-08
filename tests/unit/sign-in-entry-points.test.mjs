/**
 * Sign-in entry points (BRO-4894). Three regressions from the Oct 2026
 * accounts launch, each pinned to the real source:
 *
 * 1. The menu and header promise My Shows after sign-in. They used to save
 *    '/my-shows' as the return page themselves, and signIn() then overwrote
 *    it with the current page, so nobody ever landed on My Shows. The request
 *    now travels through showSignIn(..., { returnTo }) and signIn() saves it.
 * 2. Safari restores a page from its back-forward cache with React state
 *    intact, so a sign-in box left on "Signing in..." stayed stuck after
 *    Back from Google. AuthContext resets it on pageshow.
 * 3. Apple's popup must be prepared before the tap (BRO-4615). The box does
 *    that when it opens; any other "Continue with Apple" button (My Shows
 *    signed-out view) must prepare it itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}
const srcFiles = walk(join(root, 'src'));
const rel = (p) => p.slice(root.length).replace(/\\/g, '/');

test('menu and header ask for My Shows through showSignIn, never by saving the return page themselves', () => {
  for (const f of ['src/components/HamburgerMenu.tsx', 'src/components/HeaderUserIcon.tsx']) {
    const src = read(f);
    assert.doesNotMatch(src, /saveReturnUrl\(/, `${f}: a saveReturnUrl() call here is overwritten by signIn() a moment later`);
    assert.match(src, /returnTo: '\/my-shows'/, `${f} must request My Shows with { returnTo: '/my-shows' }`);
  }
  // The menu's request has to reach AuthContext through HeaderHamburger.
  assert.match(read('src/components/HeaderHamburger.tsx'), /showSignIn\(context, 'menu', options\)/);
});

test('signIn() saves the requested return page for Google and honours it after the Apple popup', () => {
  const ctx = read('src/contexts/AuthContext.tsx');
  assert.match(ctx, /saveReturnUrl\(returnTo\)/, 'the Google path must save the requested page (current page when none)');
  assert.match(ctx, /const target = safeReturnPath\(returnTo\);[\s\S]{0,200}window\.location\.assign\(target\)/, 'the Apple path must navigate to the requested page, same-site only');
  assert.match(ctx, /signIn\(provider, modalSource, modalReturnTo \?\? undefined\)/, 'the box must pass the requested page on');
});

test('AuthContext is the only place that saves the return page', () => {
  const callers = srcFiles
    .filter((p) => /saveReturnUrl\(/.test(readFileSync(p, 'utf8')))
    .map(rel)
    .filter((p) => p !== 'src/lib/deferred-auth.ts');
  assert.deepEqual(callers, ['src/contexts/AuthContext.tsx']);
});

test('the sign-in box resets when the page comes back from the back-forward cache', () => {
  const ctx = read('src/contexts/AuthContext.tsx');
  const handler = ctx.match(/const onPageShow = \(e: PageTransitionEvent\) => \{\s*if \(e\.persisted\) setSignInLoading\(false\);/);
  assert.ok(handler, 'AuthContext must clear signInLoading when pageshow reports a persisted (bfcache) page');
  assert.match(ctx, /window\.addEventListener\('pageshow', onPageShow\)/);
});

test('every Continue with Apple outside the sign-in box prepares the popup first', () => {
  const exempt = new Set(['src/contexts/AuthContext.tsx', 'src/components/auth/SignInModal.tsx', 'src/lib/apple-auth.ts']);
  const offenders = [];
  for (const p of srcFiles) {
    const r = rel(p);
    if (exempt.has(r)) continue;
    const src = readFileSync(p, 'utf8');
    if (!/signIn\('apple'/.test(src)) continue;
    if (!/prepareAppleSignIn\(\)/.test(src)) offenders.push(r);
  }
  assert.deepEqual(offenders, [], "these files call signIn('apple') without prepareAppleSignIn(): Safari will block the popup");
  // Positive control: the My Shows signed-out view is such a caller.
  assert.match(read('src/app/my-shows/MyShowsClient.tsx'), /signIn\('apple'/);
});
