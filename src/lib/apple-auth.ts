/**
 * Apple Sign-In via Apple JS SDK + Supabase signInWithIdToken.
 *
 * This bypasses the GoTrue OAuth redirect flow (which has issues with
 * Apple's code exchange) and instead:
 * 1. Uses Apple's JS SDK to get an id_token directly (popup mode with web_message)
 * 2. Passes it to Supabase for verification via JWKS
 *
 * IMPORTANT: With usePopup:true, Apple uses response_mode=web_message which sends
 * the auth response via postMessage to the redirectURI origin. The redirectURI MUST
 * be on the same origin as the calling page, and the domain + return URL must be
 * registered in Apple Developer Console under the Services ID configuration.
 */

declare global {
  interface Window {
    AppleID?: {
      auth: {
        init: (config: {
          clientId: string;
          scope: string;
          redirectURI: string;
          usePopup: boolean;
          nonce?: string;
        }) => void;
        signIn: () => Promise<{
          authorization: {
            id_token: string;
            code: string;
            state?: string;
          };
          user?: {
            name?: { firstName?: string; lastName?: string };
            email?: string;
          };
        }>;
      };
    };
  }
}

import { reportUgcError } from './ugc-analytics';

let sdkLoaded = false;
let sdkLoading: Promise<void> | null = null;

function loadAppleSDK(): Promise<void> {
  if (sdkLoaded) return Promise.resolve();
  if (sdkLoading) return sdkLoading;

  sdkLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    script.onload = () => {
      sdkLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load Apple JS SDK'));
    document.head.appendChild(script);
  });

  return sdkLoading;
}

/** Generate a random nonce string */
function generateNonce(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

/** SHA-256 hash a string and return hex */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface AppleAuthResult {
  idToken: string;
  nonce: string;
  user?: {
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

/**
 * Load the SDK and set up a fresh nonce BEFORE the click (call when the sign-in
 * box opens). Safari, iOS above all, blocks a popup that opens after an await,
 * because the tap no longer counts as the cause: every Apple attempt on the web
 * failed with popup_blocked_by_browser until the setup moved here.
 */
let prepared: { rawNonce: string } | null = null;
let preparing: Promise<void> | null = null;

export function prepareAppleSignIn(): Promise<void> {
  if (prepared) return Promise.resolve();
  if (preparing) return preparing;
  preparing = (async () => {
    await loadAppleSDK();
    if (!window.AppleID) throw new Error('Apple JS SDK not available');
    // Raw nonce for Supabase, hashed nonce for Apple.
    const rawNonce = generateNonce();
    const hashedNonce = await sha256(rawNonce);
    // redirectURI origin MUST match the calling page origin for web_message to work.
    // The domain + return URL must be registered in Apple Developer Console.
    // With usePopup:true, Apple uses response_mode=web_message (postMessage),
    // NOT form_post — the redirectURI page doesn't actually receive a request.
    window.AppleID.auth.init({
      clientId: 'com.broadwayscorecard.web',
      scope: 'name email',
      redirectURI: `${window.location.origin}/auth/apple-callback`,
      usePopup: true,
      nonce: hashedNonce,
    });
    prepared = { rawNonce };
  })().finally(() => {
    preparing = null;
  });
  return preparing;
}

/**
 * Initiate Apple Sign-In via the JS SDK popup flow.
 * Returns the id_token and nonce needed for signInWithIdToken.
 * When prepareAppleSignIn() already ran, the popup opens with no await before
 * it, inside the tap.
 */
export async function signInWithAppleSDK(): Promise<AppleAuthResult> {
  if (!prepared) {
    // Late: the browser may block this popup. Counted so a new Continue
    // with Apple button that skips prepareAppleSignIn() shows up in the
    // accounts dashboard instead of failing quietly (BRO-4894).
    reportUgcError('auth.apple_sign_in', { message: 'popup prepared after the tap; caller skipped prepareAppleSignIn()', code: 'apple_late_prepare' });
    await prepareAppleSignIn();
  }
  if (!prepared || !window.AppleID) {
    throw new Error('Apple JS SDK not available');
  }
  const { rawNonce } = prepared;
  prepared = null; // a nonce is single-use
  const pending = window.AppleID.auth.signIn();
  // Ready for a retry once this attempt settles.
  pending.then(() => {}, () => {}).finally(() => { prepareAppleSignIn().catch(() => {}); });
  const response = await pending;

  return {
    idToken: response.authorization.id_token,
    nonce: rawNonce,
    user: response.user
      ? {
          firstName: response.user.name?.firstName,
          lastName: response.user.name?.lastName,
          email: response.user.email,
        }
      : undefined,
  };
}
