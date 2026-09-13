'use strict';
/**
 * Pure helpers for diagnosing the BRO-3213 "90s push transport hang" class:
 * push-with-retry.sh's git_push() times out at GIT_NET_TIMEOUT_SEC (default
 * 90s) with rc=124/137/143 and NO git-printed error, because `timeout` kills
 * the process mid-transport. BRO-2373 added `--progress` to distinguish local
 * pack generation (CPU) from the Writing-objects network phase, but a live
 * measured hang (Opening Night Express run 34694172162, 2026-09-12) showed
 * ZERO bytes of --progress output for the full 90s — ruling out BOTH of those
 * phases (pack generation prints "Enumerating objects" near-instantly; the
 * transfer phase prints byte/throughput progress). The hang is stalling
 * earlier, in the connection/TLS/ref-advertisement round trip, before
 * pack-objects is even invoked. GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1
 * (verified against a real `git fetch` locally, format below) exposes that
 * phase; these two functions redact and classify its output.
 */

// Ported from the shell `_redact_creds()` in push-with-retry.sh so both
// call sites (bash's own stderr capture, and this JS layer for curl-trace
// capture) apply the identical threat model rather than drifting apart, PLUS
// extra passes _redact_creds() doesn't need (adversarial review, BRO-3213):
// GIT_TRACE_CURL dumps arbitrary request/response headers, not just the
// Authorization line _redact_creds() was written for, so Cookie/
// Set-Cookie/Proxy-Authorization and any query-string token/key/secret param
// are stripped too. This is still a denylist, not a formal allowlist parser
// — a genuinely novel credential-bearing header name could still slip
// through — but it covers every credential-carrying mechanism this repo's
// own git config and GitHub's endpoints actually use.
// Verified live: a `git fetch https://x-access-token:TOKEN@github.com/...`
// under GIT_TRACE_CURL leaks the full credential-bearing URL in
// "== Info: [HTTP/2] [N] OPENED stream for <url>" lines — no Authorization
// header is ever sent for this repo's URL-embedded-token auth style, so the
// URL-userinfo pass below is the one that actually fires in practice.
function redactCurlTrace(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/:\/\/[^/@\s]*@/g, '://***@')
    .replace(/(authorization:? *)((?:basic|bearer) +)?[A-Za-z0-9+/=_.-]{8,}/gi, '$1[REDACTED]')
    // Follow-up adversarial review (BRO-3213): the first cut of this pass only
    // matched Title-Case/lower-case header names ([Aa]uthorization etc.) — an
    // ALL-CAPS "AUTHORIZATION:"/"COOKIE:" line (a real curl trace never emits
    // this, but a hostile or unusual client/proxy could) survived untouched.
    // Case-insensitive now; \b (not ^) — real curl trace lines are prefixed
    // with a timestamp + source-file marker before "=> Send header: ", so
    // the header name is never at the actual start of the line (an earlier
    // draft anchored on ^ and silently failed to redact Cookie/Set-Cookie as
    // a result — caught by this file's own test suite before shipping).
    .replace(/\b((?:proxy-)?authorization:|cookie:|set-cookie:)[^\n]*/gi, '$1 [REDACTED]')
    // Substring match on the PARAM NAME (not `[?&]exact=`) — the first cut
    // missed compound names like api_key=, client_secret=, oauth_token=
    // because none of them are an exact "key"/"secret"/"token" match
    // immediately after ? or & (follow-up adversarial review).
    .replace(/([?&][a-z0-9_]*(?:token|key|secret|auth|password)[a-z0-9_]*=)[^&\s]+/gi, '$1[REDACTED]');
}

// Ordered, monotonically-increasing checkpoints a SINGLE git-over-HTTP
// request/response cycle passes through, from GIT_TRACE_CURL's own output —
// confirmed against a real captured trace (see file header).
const STAGES = [
  { name: 'pre-connect', test: /Trying \S+\.\.\.|was resolved\.$/m },
  { name: 'connect-tls', test: /Connected to \S+|SSL connection using|ALPN: server accepted/ },
  { name: 'sending-request', test: /=> Send header/ },
  { name: 'request-sent-awaiting-response', test: /Request completely sent off|upload completely sent off/ },
  { name: 'response-received-then-stalled', test: /<= Recv header: HTTP\// },
];

// A git push is (at least) TWO sequential HTTP exchanges over the same
// connection — an info/refs GET, then a git-receive-pack POST (verified
// live: both start with their own "=> Send header, N bytes (...)" byte-count
// line). Naively scanning the WHOLE trace for the furthest-reached marker
// (the first cut of this classifier) meant a completed first exchange's
// "<= Recv header: HTTP/" permanently forced response-received-then-stalled
// even when the SECOND exchange was the one that actually hung mid-connect
// — confidently wrong (adversarial review, BRO-3213). Splitting on this
// marker and classifying only the LAST segment fixes it.
const REQUEST_BOUNDARY = /^.*=> Send header, \d+ bytes.*$/m;

/**
 * @param {string} traceText GIT_TRACE_CURL_NO_DATA=1 output captured from a
 *   single push attempt (redacted or raw — caller's choice, this function
 *   only classifies, it never echoes its input).
 * @returns {string} one of: 'no-trace' | 'pre-connect' | 'connect-tls' |
 *   'sending-request' | 'request-sent-awaiting-response' |
 *   'response-received-then-stalled' | 'unrecognized'
 */
function classifyStallPhase(traceText) {
  if (typeof traceText !== 'string' || !traceText.trim()) return 'no-trace';

  // Isolate the LAST request cycle: everything from the last "=> Send
  // header, N bytes" line onward. A trace with no such line yet (killed
  // before any request was ever sent) has nothing to split — classify the
  // whole thing.
  const boundaries = traceText.match(new RegExp(REQUEST_BOUNDARY, 'gm'));
  let segment = traceText;
  if (boundaries && boundaries.length > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    const idx = traceText.lastIndexOf(lastBoundary);
    segment = traceText.slice(idx);
  }

  let reached = null;
  for (const stage of STAGES) {
    if (stage.test.test(segment)) reached = stage.name;
  }
  // A non-empty trace that matched NONE of the known markers is a format we
  // don't recognize (different git/curl version, HTTP/1.1 wording, a
  // protocol this classifier was never taught) — NOT evidence the stall is
  // in the earliest phase. Conflating "unrecognized" with "pre-connect"
  // would assert a specific, unearned diagnosis (adversarial review,
  // BRO-3213).
  return reached || 'unrecognized';
}

module.exports = { redactCurlTrace, classifyStallPhase };
