// The OAuth return page on broadwayscorecard.com (BRO-4822): the same handler
// as /auth/callback, on a path the iOS app's Universal Links never claimed.
// See src/lib/auth-redirect.ts.
export { default } from '../callback/page';
