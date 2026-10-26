'use strict';

// BRO-6262: digest-autofix refreshes a card's notes by posting them as a COMMENT
// every day (refreshNotesOnReattach). Those comments are the filer's, not a
// person's answer, but they start with "## Problem", which no machine pattern
// matched, so cloud-worker-pick read each one as the owner replying: it reset the
// MAX_PAUSES / awaiting-owner memory and BRO-5489 was paused 11 times.
//
// One marker feeds both writers and readers so they cannot drift apart:
//   digest-autofix.js        prefixes the refresh comment with FILER_REFRESH_MARKER
//   cloud-worker-pick.js     treats a comment that starts with it as machine output
// LEGACY_REFRESH_RE covers the unmarked refresh comments already on the board
// (anchored on the exact opening, so a person's own "## Problem" note is not caught).
const FILER_REFRESH_MARKER = '<!-- digest-autofix-refresh -->';
const LEGACY_REFRESH_RE = /^## Problem\s*\r?\nThe daily health check \(`node scripts\/health-check\.js`\) reports\b/;

function isFilerRefreshComment(body) {
  const text = String(body || '').trimStart();
  return text.startsWith(FILER_REFRESH_MARKER) || LEGACY_REFRESH_RE.test(text);
}

module.exports = { FILER_REFRESH_MARKER, LEGACY_REFRESH_RE, isFilerRefreshComment };
