/**
 * Apple Sign-In callback page.
 *
 * With the Apple JS SDK popup flow (usePopup: true), Apple uses
 * response_mode=web_message and delivers the auth response via
 * postMessage to the opener window. This page exists so the
 * redirectURI is a valid, registered URL on our domain.
 *
 * In the normal popup flow, the user never sees this page —
 * the SDK handles everything in the popup window. This page
 * is only shown if someone navigates here directly.
 */
export default function AppleCallbackPage() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
      <p>Completing sign-in...</p>
    </div>
  );
}
