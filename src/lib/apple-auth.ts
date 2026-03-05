/**
 * Apple Sign-In via Apple JS SDK + Supabase signInWithIdToken.
 *
 * This bypasses the GoTrue OAuth redirect flow (which has issues with
 * Apple's code exchange) and instead:
 * 1. Uses Apple's JS SDK to get an id_token directly
 * 2. Passes it to Supabase for verification via JWKS
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
 * Initiate Apple Sign-In via the JS SDK popup flow.
 * Returns the id_token and nonce needed for signInWithIdToken.
 */
export async function signInWithAppleSDK(): Promise<AppleAuthResult> {
  await loadAppleSDK();

  if (!window.AppleID) {
    throw new Error('Apple JS SDK not available');
  }

  // Generate nonce: raw nonce for Supabase, hashed nonce for Apple
  const rawNonce = generateNonce();
  const hashedNonce = await sha256(rawNonce);

  // redirectURI must be registered in Apple Developer Console.
  // With usePopup:true the redirect doesn't actually happen — Apple
  // returns the response via the popup JS bridge — but Apple still
  // validates the URI against the registered list.
  window.AppleID.auth.init({
    clientId: 'com.broadwayscorecard.web',
    scope: 'name email',
    redirectURI: 'https://tcbkoevwfemkicrwpypb.supabase.co/auth/v1/callback',
    usePopup: true,
    nonce: hashedNonce,
  });

  const response = await window.AppleID.auth.signIn();

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
