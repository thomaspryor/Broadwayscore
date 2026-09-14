// Unit coverage for scripts/lib/push-diagnostics.js.
//
// This module had ZERO test files before BRO-2839 (push-with-retry.stall-
// diagnostics.test.sh:47 refers to a push-diagnostics.test.mjs that did not
// exist), even though its output is what every push-failure ledger row since
// BRO-3213 has been recording. These tests pin both the pre-existing behavior
// (classifyStallPhase — deliberately UNCHANGED by BRO-2839, since its value
// space is asserted by the .sh test above and documented in push-ledger.js)
// and the BRO-2839 additions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  redactCurlTrace,
  classifyStallPhase,
  classifyStallService,
  censusTrace,
  extractPhaseTimeline,
  parseTraceRecords,
  parseTraceClock,
} = require('./push-diagnostics.js');

// A trace line as GIT_TRACE_CURL really writes it (verified against live
// captures): "HH:MM:SS.micros <file>:<line><padding><message>".
const line = (stamp, msg) => `${stamp} http.c:889              ${msg}\n`;

// ---------------------------------------------------------------------------
// classifyStallPhase — pre-existing behavior, must not drift.
// ---------------------------------------------------------------------------

test('classifyStallPhase: empty / non-string input is no-trace', () => {
  assert.equal(classifyStallPhase(''), 'no-trace');
  assert.equal(classifyStallPhase('   '), 'no-trace');
  assert.equal(classifyStallPhase(null), 'no-trace');
  assert.equal(classifyStallPhase(undefined), 'no-trace');
});

test('classifyStallPhase: a non-empty trace matching no known marker is unrecognized, NOT pre-connect', () => {
  // Conflating "I do not recognize this format" with "it stalled in the
  // earliest phase" would assert an unearned diagnosis.
  assert.equal(classifyStallPhase(line('10:00:00.000000', 'some future git wording')), 'unrecognized');
});

test('classifyStallPhase: reports the furthest marker reached', () => {
  const t =
    line('10:00:00.000000', '== Info:   Trying 140.82.113.4...') +
    line('10:00:00.100000', '== Info: Connected to github.com') +
    line('10:00:00.200000', '=> Send header: GET /x/info/refs?service=git-receive-pack HTTP/2');
  assert.equal(classifyStallPhase(t), 'sending-request');
});

test('classifyStallPhase: classifies the LAST request cycle, not the furthest ever reached', () => {
  // A completed first exchange must not permanently pin the verdict when a
  // SECOND exchange hung earlier (the BRO-3213 adversarial-review finding).
  const t =
    line('10:00:00.000000', '=> Send header, 0000000173 bytes (0x000000ad)') +
    line('10:00:00.010000', '=> Send header: GET /x/info/refs?service=git-receive-pack HTTP/2') +
    line('10:00:00.020000', '<= Recv header: HTTP/2 200') +
    line('10:00:01.000000', '=> Send header, 0000000210 bytes (0x000000d2)') +
    line('10:00:01.010000', '=> Send header: POST /x/git-receive-pack HTTP/2');
  assert.equal(classifyStallPhase(t), 'sending-request');
});

// ---------------------------------------------------------------------------
// redactCurlTrace
// ---------------------------------------------------------------------------

test('redactCurlTrace: strips URL-embedded credentials', () => {
  const out = redactCurlTrace('OPENED stream for https://x-access-token:ghp_SECRETVALUE@github.com/o/r.git');
  assert.ok(!out.includes('ghp_SECRETVALUE'), 'token must not survive redaction');
  assert.ok(out.includes('://***@'));
});

test('redactCurlTrace: strips credential headers case-insensitively, mid-line', () => {
  const t = line('10:00:00.000000', '=> Send header: AUTHORIZATION: Basic QUJDOmRlZmdoaWprbA==') +
            line('10:00:00.000001', '=> Send header: Cookie: session=abcdefghijkl');
  const out = redactCurlTrace(t);
  assert.ok(!out.includes('QUJDOmRlZmdoaWprbA=='));
  assert.ok(!out.includes('session=abcdefghijkl'));
});

test('redactCurlTrace: strips compound token query params', () => {
  const out = redactCurlTrace('GET /x?api_key=SECRET1&client_secret=SECRET2&ok=1');
  assert.ok(!out.includes('SECRET1'));
  assert.ok(!out.includes('SECRET2'));
  assert.ok(out.includes('ok=1'), 'non-credential params must survive');
});

// ---------------------------------------------------------------------------
// parseTraceClock / parseTraceRecords (BRO-2839)
// ---------------------------------------------------------------------------

test('parseTraceClock: parses micro- and nanosecond precision, rejects junk', () => {
  assert.equal(parseTraceClock('00:00:01.500000'), 1500);
  assert.equal(parseTraceClock('01:00:00.000000000'), 3600000);
  // BSD `date` has no %N; push-with-retry.sh falls back rather than emit this,
  // but the parser must refuse it either way instead of producing NaN.
  assert.equal(parseTraceClock('10:00:00.N'), null);
  assert.equal(parseTraceClock('garbage'), null);
  assert.equal(parseTraceClock(undefined), null);
});

test('parseTraceRecords: drops a trailing partial line from a SIGTERM-killed trace', () => {
  // A trace killed mid-write ends without a newline. Parsing that fragment
  // could yield a record with a half-written timestamp.
  const complete = line('10:00:00.000000', '== Info: Connected to github.com');
  const withPartial = complete + '10:00:01.1';
  assert.equal(parseTraceRecords(withPartial).length, 1);
  assert.equal(parseTraceRecords(complete).length, 1);
});

test('parseTraceRecords: skips headless lines from a mid-line-truncated tail', () => {
  // git_push_traced logs only the trace's last N bytes, so a real capture
  // routinely BEGINS mid-line. That fragment has no timestamp and must be
  // skipped, not guessed at.
  const t = '    <= Recv header: content-type: application/x-git-upload-pack-result\n' +
            line('10:00:00.000000', '<= Recv header: HTTP/2 200');
  const records = parseTraceRecords(t);
  assert.equal(records.length, 1);
  assert.equal(records[0].stamp, '10:00:00.000000');
});

// ---------------------------------------------------------------------------
// classifyStallService (BRO-2839)
// ---------------------------------------------------------------------------

test('classifyStallService: distinguishes push traffic from fetch traffic', () => {
  assert.equal(
    classifyStallService(line('10:00:00.000000', '=> Send header: POST /o/r.git/git-receive-pack HTTP/2')),
    'receive-pack'
  );
  assert.equal(
    classifyStallService(line('10:00:00.000000', '=> Send header: GET /o/r.git/info/refs?service=git-upload-pack HTTP/2')),
    'upload-pack'
  );
  assert.equal(classifyStallService(''), 'unknown');
  assert.equal(classifyStallService(line('10:00:00.000000', 'no service here')), 'unknown');
});

test('classifyStallService: recovers the service from a headless truncated tail', () => {
  // The real CI artifact's only service marker sits on the mid-line-truncated
  // FIRST line, which carries no timestamp and so becomes no record.
  const t = '    <= Recv header: content-type: application/x-git-upload-pack-result\n' +
            line('10:00:00.000000', '<= Recv header: date: Mon, 14 Sep 2026 13:58:33 GMT');
  assert.equal(classifyStallService(t), 'upload-pack');
});

test('classifyStallService: last exchange wins', () => {
  const t =
    line('10:00:00.000000', '=> Send header: GET /o/r.git/info/refs?service=git-upload-pack HTTP/2') +
    line('10:00:01.000000', '=> Send header: POST /o/r.git/git-receive-pack HTTP/2');
  assert.equal(classifyStallService(t), 'receive-pack');
});

// ---------------------------------------------------------------------------
// censusTrace (BRO-2839)
// ---------------------------------------------------------------------------

test('censusTrace: counts one entry per request line, not per service mention', () => {
  const t =
    line('10:00:00.000000', '=> Send header, 0000000173 bytes (0x000000ad)') +
    line('10:00:00.010000', '=> Send header: GET /o/r.git/info/refs?service=git-receive-pack HTTP/2') +
    line('10:00:00.020000', '<= Recv header: content-type: application/x-git-receive-pack-advertisement') +
    line('10:00:01.000000', '=> Send header: POST /o/r.git/git-receive-pack HTTP/2');
  const c = censusTrace(t);
  assert.equal(c.receivePack, 2);
  assert.equal(c.uploadPack, 0);
  assert.equal(c.requests.length, c.receivePack + c.uploadPack, 'counts must equal the request list length');
  assert.equal(c.firstStamp, '10:00:00.000000');
  assert.equal(c.lastStamp, '10:00:01.000000');
});

test('censusTrace: empty input is reported, not thrown', () => {
  const c = censusTrace('');
  assert.equal(c.bytes, 0);
  assert.equal(c.records, 0);
  assert.equal(c.firstStamp, null);
  assert.deepEqual(c.requests, []);
});

// ---------------------------------------------------------------------------
// extractPhaseTimeline (BRO-2839)
// ---------------------------------------------------------------------------

test('extractPhaseTimeline: the terminal silence wins over every inter-record gap', () => {
  // This is the whole point of the card. Without the kill timestamp the
  // largest measurable interval here is 1s, and the 60s that actually killed
  // the push is invisible.
  const t =
    line('10:00:00.000000', '== Info:   Trying 140.82.113.4...') +
    line('10:00:01.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '10:01:01.000000' });
  assert.equal(timeline.dominantGap.terminal, true);
  assert.equal(timeline.dominantGap.ms, 60000);
  assert.equal(timeline.dominantGap.phase, 'response-received-then-stalled');
});

test('extractPhaseTimeline: without a kill time, the terminal silence is simply not visible', () => {
  // Documents the failure mode the killedAt parameter exists to fix: this is
  // exactly what the classifier could see before BRO-2839.
  const t =
    line('10:00:00.000000', '== Info:   Trying 140.82.113.4...') +
    line('10:00:01.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t });
  assert.equal(timeline.dominantGap.terminal, false);
  assert.equal(timeline.dominantGap.ms, 1000);
});

test('extractPhaseTimeline: a kill time across midnight is a forward wrap, never negative', () => {
  const t = line('23:59:59.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '00:00:29.000000' });
  assert.equal(timeline.dominantGap.ms, 30000);
});

test('extractPhaseTimeline: elapsedMs is accepted as a fallback and flagged approximate', () => {
  const t =
    line('10:00:00.000000', '== Info:   Trying 140.82.113.4...') +
    line('10:00:01.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, elapsedMs: 90000 });
  assert.equal(timeline.dominantGap.terminal, true);
  assert.equal(timeline.dominantGap.approximate, true);
  assert.equal(timeline.dominantGap.ms, 89000, 'first-record + elapsed, minus the last record');
});

test('extractPhaseTimeline: attribution follows the service', () => {
  const push = line('10:00:00.000000', '=> Send header: POST /o/r.git/git-receive-pack HTTP/2');
  const fetch = line('10:00:00.000000', '=> Send header: GET /o/r.git/info/refs?service=git-upload-pack HTTP/2');
  assert.equal(extractPhaseTimeline({ traceText: push }).attributedToPush, true);
  assert.equal(extractPhaseTimeline({ traceText: fetch }).attributedToPush, false);
  assert.equal(extractPhaseTimeline({ traceText: 'nothing' }).attributedToPush, false);
});

test('extractPhaseTimeline: an empty trace reports no-trace rather than throwing', () => {
  const timeline = extractPhaseTimeline({ traceText: '' });
  assert.equal(timeline.reason, 'no-trace');
  assert.equal(timeline.dominantGap, null);
  assert.equal(timeline.records, 0);
});
