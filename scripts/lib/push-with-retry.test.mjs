// BRO-3213: unit tests for push-diagnostics.js's pure functions, which
// push-with-retry.sh's git_push_traced() shells out to (via
// scripts/push-diagnostics-cli.js) on a timeout-classified push failure.
// For real bash-level integration coverage (the actual retry loop, a REAL
// killed git_push against a non-routable remote, credential-leakage check
// against the live wiring) see push-with-retry.stall-diagnostics.test.sh
// alongside this file — node:test cannot exercise bash control flow
// directly, so that coverage lives in the shell-script test family instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactCurlTrace, classifyStallPhase } from './push-diagnostics.js';

test('redactCurlTrace strips an embedded URL-userinfo token', () => {
  // Real line captured via `GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git fetch
  // https://x-access-token:FAKESECRETTOKEN1234@github.com/...` (2026-09-13).
  const line =
    '12:49:49.378448 http.c:889              == Info: [HTTP/2] [1] OPENED stream for https://x-access-token:FAKESECRETTOKEN1234@github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack';
  const redacted = redactCurlTrace(line);
  assert.ok(!redacted.includes('FAKESECRETTOKEN1234'), 'token must not survive redaction');
  assert.ok(redacted.includes('https://***@github.com'), 'userinfo replaced with ***');
});

test('redactCurlTrace strips an Authorization header value', () => {
  const line = '=> Send header: Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0';
  const redacted = redactCurlTrace(line);
  assert.ok(!redacted.includes('eC1hY2Nlc3MtdG9rZW46c2VjcmV0'));
  assert.match(redacted, /Authorization:? \[REDACTED\]/);
});

test('redactCurlTrace leaves non-credential lines untouched', () => {
  const line = '<= Recv header: content-type: application/x-git-upload-pack-advertisement';
  assert.equal(redactCurlTrace(line), line);
});

test('redactCurlTrace on empty/undefined input returns empty string', () => {
  assert.equal(redactCurlTrace(''), '');
  assert.equal(redactCurlTrace(undefined), '');
});

test('classifyStallPhase: empty capture is no-trace (the historical case — this instrumentation did not exist yet)', () => {
  assert.equal(classifyStallPhase(''), 'no-trace');
  assert.equal(classifyStallPhase('   \n  '), 'no-trace');
});

test('classifyStallPhase: only a Trying line is pre-connect', () => {
  const trace = '12:49:24.333121 http.c:889              == Info:   Trying 140.82.114.4:443...';
  assert.equal(classifyStallPhase(trace), 'pre-connect');
});

test('classifyStallPhase: connected but no request sent yet is connect-tls', () => {
  const trace = [
    '== Info:   Trying 140.82.114.4:443...',
    '== Info: Connected to github.com (140.82.114.4) port 443',
    '== Info: ALPN: curl offers h2,http/1.1',
  ].join('\n');
  assert.equal(classifyStallPhase(trace), 'connect-tls');
});

test('classifyStallPhase: request fully sent with no response is request-sent-awaiting-response — this is the phase the live 2026-09-12 measurement points to', () => {
  // Real sequence captured locally (GET /info/refs, then the request
  // completes with no subsequent "<= Recv header: HTTP/" line — i.e. the
  // process was killed while still waiting on the server's first response
  // byte).
  const trace = [
    '== Info: Connected to github.com (140.82.114.4) port 443',
    '== Info: SSL connection using TLSv1.3 / AEAD-CHACHA20-POLY1305-SHA256 / [blank] / UNDEF',
    '=> Send header, 0000000203 bytes (0x000000cb)',
    '=> Send header: GET /octocat/Hello-World.git/info/refs?service=git-upload-pack HTTP/2',
    '=> Send header:',
    '== Info: Request completely sent off',
  ].join('\n');
  assert.equal(classifyStallPhase(trace), 'request-sent-awaiting-response');
});

test('classifyStallPhase: a POST body upload with no response is also request-sent-awaiting-response', () => {
  const trace = [
    '== Info: Connected to github.com (140.82.114.4) port 443',
    '=> Send header: POST /octocat/Hello-World.git/git-receive-pack HTTP/2',
    '== Info: upload completely sent off: 4200 bytes',
  ].join('\n');
  assert.equal(classifyStallPhase(trace), 'request-sent-awaiting-response');
});

test('classifyStallPhase: response headers arrived then trace goes silent is response-received-then-stalled', () => {
  const trace = [
    '== Info: Request completely sent off',
    '<= Recv header, 0000000013 bytes (0x0000000d)',
    '<= Recv header: HTTP/2 200',
    '<= Recv header: server: GitHub-Babel/3.0',
  ].join('\n');
  assert.equal(classifyStallPhase(trace), 'response-received-then-stalled');
});

test('classifyStallPhase never throws on garbage input', () => {
  assert.doesNotThrow(() => classifyStallPhase(null));
  assert.doesNotThrow(() => classifyStallPhase(12345));
  assert.equal(classifyStallPhase(null), 'no-trace');
});

test('classifyStallPhase: an unrecognized non-empty trace is "unrecognized", not silently "pre-connect" (adversarial review finding — conflating the two asserts an unearned diagnosis)', () => {
  assert.equal(classifyStallPhase('some totally unfamiliar output format'), 'unrecognized');
});

test('classifyStallPhase: a completed info/refs GET followed by a receive-pack POST that only got its headers sent is sending-request, NOT response-received-then-stalled (adversarial review finding: a push is TWO sequential HTTP exchanges — the first exchange finishing must not permanently poison the verdict for a SECOND exchange that stalls earlier)', () => {
  const trace = [
    // First exchange: info/refs GET completes fully, including its response.
    '== Info: Connected to github.com (140.82.114.4) port 443',
    '=> Send header, 0000000203 bytes (0x000000cb)',
    '=> Send header: GET /octocat/Hello-World.git/info/refs?service=git-receive-pack HTTP/2',
    '== Info: Request completely sent off',
    '<= Recv header, 0000000013 bytes (0x0000000d)',
    '<= Recv header: HTTP/2 200',
    '== Info: Connection #0 to host github.com left intact',
    // Second exchange: the actual receive-pack POST starts a NEW request
    // (its own "=> Send header, N bytes" line) and then goes silent —
    // never even reaches "Request completely sent off".
    '== Info: Re-using existing connection with host github.com',
    '=> Send header, 0000000275 bytes (0x00000113)',
    '=> Send header: POST /octocat/Hello-World.git/git-receive-pack HTTP/2',
  ].join('\n');
  assert.equal(classifyStallPhase(trace), 'sending-request');
});

test('classifyStallPhase: a completed info/refs GET followed by a receive-pack POST that fully sends but never gets a response is request-sent-awaiting-response', () => {
  const trace = [
    '=> Send header, 0000000203 bytes (0x000000cb)',
    '=> Send header: GET /octocat/Hello-World.git/info/refs?service=git-receive-pack HTTP/2',
    '<= Recv header: HTTP/2 200',
    '== Info: Connection #0 to host github.com left intact',
    '=> Send header, 0000000275 bytes (0x00000113)',
    '=> Send header: POST /octocat/Hello-World.git/git-receive-pack HTTP/2',
    '== Info: upload completely sent off: 4200 bytes',
  ].join('\n');
  assert.equal(classifyStallPhase(trace), 'request-sent-awaiting-response');
});

test('redactCurlTrace strips Cookie and Proxy-Authorization header values', () => {
  const line = '=> Send header: Cookie: session=supersecret123\n=> Send header: Proxy-Authorization: Basic xyz789secret';
  const redacted = redactCurlTrace(line);
  assert.ok(!redacted.includes('supersecret123'));
  assert.ok(!redacted.includes('xyz789secret'));
});

test('redactCurlTrace strips query-string tokens', () => {
  const line = '== Info: [HTTP/2] [1] OPENED stream for https://github.com/repo.git?access_token=abcdef123456';
  const redacted = redactCurlTrace(line);
  assert.ok(!redacted.includes('abcdef123456'));
});

test('redactCurlTrace strips ALL-CAPS header names too (follow-up adversarial review: the first cut only matched Title-Case/lower-case)', () => {
  const line = '=> Send header: AUTHORIZATION: Bearer SECRETVALUE12345\n=> Send header: COOKIE: session=SECRETVALUE12345';
  const redacted = redactCurlTrace(line);
  assert.ok(!redacted.includes('SECRETVALUE12345'), `credential must not survive: ${redacted}`);
});

test('redactCurlTrace strips compound query-string param names (api_key, client_secret, oauth_token — follow-up adversarial review: the first cut only matched an exact "key"/"secret"/"token" immediately after ? or &)', () => {
  const line = 'url https://host/x?api_key=SECRETVALUE1&client_secret=SECRETVALUE2&oauth_token=SECRETVALUE3';
  const redacted = redactCurlTrace(line);
  assert.ok(!redacted.includes('SECRETVALUE1'), `api_key must be redacted: ${redacted}`);
  assert.ok(!redacted.includes('SECRETVALUE2'), `client_secret must be redacted: ${redacted}`);
  assert.ok(!redacted.includes('SECRETVALUE3'), `oauth_token must be redacted: ${redacted}`);
});
