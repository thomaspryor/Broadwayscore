'use strict';
/**
 * What GitHub treats as a CI-skip marker in a pushed head commit's message
 * (it then starts no push-triggered workflow). One source of truth, kept
 * dependency-free so hook code (land-preflight.mjs, BRO-7353) can use it
 * without loading landing-ci-coverage.js's gh/fetch code (BRO-4643).
 */
const SKIP_MARKER = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i;

function hasSkipCiMarker(message) {
  return SKIP_MARKER.test(String(message || ''));
}

module.exports = { SKIP_MARKER, hasSkipCiMarker };
