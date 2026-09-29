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
  formatTimeline,
  extractPhaseTimeline,
  parseTraceRecords,
  parseTraceClock,
  redactTrace2,
  parseTrace2Records,
  summarizeTrace2Children,
  extractTrace2Timeline,
  formatTrace2Timeline,
} = require('./push-diagnostics.js');

// A trace line as GIT_TRACE_CURL really writes it (verified against live
// captures): "HH:MM:SS.micros <file>:<line><padding><message>".
const line = (stamp, msg) => `${stamp} http.c:889              ${msg}\n`;

// A trace2 line as GIT_TRACE2_PERF really writes it (verified against a live
// local capture, BRO-3358: `GIT_TRACE2_PERF=1 git ls-remote https://...`):
// "HH:MM:SS.ffffff file:line | dN | thread | event | repo | t_abs | t_rel |
// category | data".
const t2 = (stamp, depth, event, data, { tAbs = '', tRel = '', category = '' } = {}) =>
  `${stamp} run-command.c:740            | d${depth} | main                     | ` +
  `${event}  |     |  ${tAbs} |  ${tRel} |  ${category} | ${data}\n`;

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

test('redactCurlTrace: strips CLI-flag-shaped credentials in child argv (BRO-3358)', () => {
  // Adversarial review (Codex, BRO-3358 ship-check) caught that the pre-3358
  // denylist covers URLs/headers/query-params but not a credential passed as
  // a bare argv to some OTHER child tool — the shape a trace2 child_start's
  // argv column can carry.
  // Real trace2 argv is one single space-separated string per child (verified
  // against a live capture: argv:['/opt/homebrew/bin/gh auth git-credential
  // store']), not a comma-separated array of quoted tokens.
  const out = redactCurlTrace("argv:['some-tool --password SECRET123']");
  assert.ok(!out.includes('SECRET123'));
  const outEq = redactCurlTrace("argv:['some-tool --api-token=SECRET456']");
  assert.ok(!outEq.includes('SECRET456'));
  // A bare short flag like -p is too ambiguous with non-credential options
  // (port, path, ...) to redact on sight — must survive untouched.
  const outShort = redactCurlTrace('some-tool -p 5432 --host db.internal');
  assert.ok(outShort.includes('-p 5432'), 'a bare short flag must not be treated as a credential marker');
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

test('parseTraceRecords: a trailing line cut BEFORE its timestamp completes yields no record', () => {
  // A trace killed mid-write ends without a newline. A fragment too short to
  // carry a full timestamp must not become a record with a half-written time.
  const complete = line('10:00:00.000000', '== Info: Connected to github.com');
  assert.equal(parseTraceRecords(complete + '10:00:01.1').length, 1);
  assert.equal(parseTraceRecords(complete).length, 1);
});

test('parseTraceRecords: a trailing line cut mid-MESSAGE keeps its (valid) timestamp', () => {
  // The timestamp is written at the start of the line, so a line truncated
  // partway through its message still carries a fully valid one — and in a
  // killed trace that is the single most useful record, being the last thing
  // git did before the silence. Discarding it would shift the terminal gap's
  // start point earlier and overstate the stall.
  const complete = line('10:00:00.000000', '== Info: Connected to github.com');
  const cutMidMessage = complete + '10:00:02.500000 http.c:889              <= Recv hea';
  const records = parseTraceRecords(cutMidMessage);
  assert.equal(records.length, 2);
  assert.equal(records[1].stamp, '10:00:02.500000');
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

test('extractPhaseTimeline: a few ms of BACKWARDS clock jitter is 0, not a fabricated 24 hours', () => {
  // Regression test for a real bug found in adversarial review: treating every
  // backwards step as a midnight wrap turned 5ms of clock jitter into a
  // confident "86400.0s of silence". A 24h answer from a 90s-bounded operation
  // is exactly the kind of confidently-wrong output this card exists to stop.
  const t =
    line('10:00:00.000000', '== Info:   Trying 1.2.3.4...') +
    line('10:00:01.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '10:00:00.995000' });
  assert.ok(
    timeline.dominantGap.ms < 60000,
    `backwards jitter must not wrap to a day, got ${timeline.dominantGap.ms}ms`
  );
});

test('extractPhaseTimeline: a kill time absurdly far AHEAD is clamped too, not reported', () => {
  // The mirror of the backwards-jitter case. A forward clock step or a corrupt
  // killedAt must not yield "7200.0s of silence" from a 90s-bounded operation;
  // the clamp is symmetric precisely so neither direction produces a confident
  // number a reader would act on.
  const t = line('10:00:00.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '12:00:00.000000' });
  assert.equal(timeline.dominantGap, null, 'an unmeasurable gap must not become the dominant one');
  assert.equal(timeline.reason, 'timestamps-implausible');
  assert.equal(timeline.gaps[0].implausible, true);
});

test('formatTimeline: an all-implausible trace says the time CANNOT be located, never "0.0s"', () => {
  // The failure this guards: collapsing an unmeasurable interval to 0 renders
  // as "0.0s ... SILENCE AFTER last trace line", which a reader takes as "the
  // push did not stall" — a confidently-wrong answer of the same family this
  // whole card exists to remove.
  const t = line('10:00:00.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '12:00:00.000000' });
  const out = formatTimeline(timeline);
  assert.match(out, /cannot locate the time/);
  assert.doesNotMatch(out, /0\.0s/);
  assert.doesNotMatch(out, /SILENCE AFTER/);
});

test('extractPhaseTimeline: one implausible gap does not suppress a measurable one', () => {
  // Mixed case: the terminal gap is fine, an inter-record gap is not. The
  // measurable gap must still win rather than the whole trace being discarded.
  const t =
    line('10:00:00.000000', '== Info:   Trying 1.2.3.4...') +
    line('05:00:00.000000', '== Info: Connected to github.com') +
    line('05:00:01.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '05:00:31.000000' });
  assert.equal(timeline.dominantGap.terminal, true);
  assert.equal(timeline.dominantGap.ms, 30000);
  assert.equal(timeline.dominantGap.implausible, false);
});

test('extractPhaseTimeline: an elapsedMs shorter than the trace span does not wrap either', () => {
  const t =
    line('10:00:00.000000', '== Info:   Trying 1.2.3.4...') +
    line('10:00:10.000000', '<= Recv header: HTTP/2 200');
  // elapsed (1s) is shorter than the trace's own 10s span — incoherent input.
  const timeline = extractPhaseTimeline({ traceText: t, elapsedMs: 1000 });
  const terminal = timeline.gaps.find((g) => g.terminal);
  assert.ok(terminal.ms < 60000, `expected a clamped value, got ${terminal.ms}ms`);
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

test('formatTimeline: an UNKNOWN service is not accused of being someone else\'s traffic', () => {
  // "unknown" means the service marker was absent from the captured range —
  // usually because the capture is a truncated tail — NOT that the exchange
  // belonged to something other than the push. Claiming the latter from the
  // former is the same unearned diagnosis classifyStallPhase avoids for
  // unrecognized-vs-pre-connect, and it is the COMMON case.
  const t = line('10:00:00.000000', '== Info:   Trying 1.2.3.4...');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '10:00:30.000000' });
  assert.equal(timeline.service, 'unknown');
  assert.doesNotMatch(formatTimeline(timeline), /NOT receive-pack/);
});

test('formatTimeline: a POSITIVELY identified non-push service still is flagged', () => {
  const t = line('10:00:00.000000', '=> Send header: GET /o/r.git/info/refs?service=git-upload-pack HTTP/2');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '10:00:30.000000' });
  assert.match(formatTimeline(timeline), /NOT receive-pack/);
});

test('extractPhaseTimeline: an empty trace reports no-trace rather than throwing', () => {
  const timeline = extractPhaseTimeline({ traceText: '' });
  assert.equal(timeline.reason, 'no-trace');
  assert.equal(timeline.dominantGap, null);
  assert.equal(timeline.records, 0);
});

test('formatTimeline: a measurable inter-record gap does not hide an UNMEASURABLE terminal one', () => {
  // The winning number here is real, but it is not the answer to "where did
  // the timeout go" — the interval that consumed it is the one that could not
  // be measured. Reporting "2.0s between trace lines" alone reads as "the push
  // barely paused" (adversarial review: the implausible-gap fix stopped one
  // step short of its own goal).
  const t =
    line('10:00:00.000000', '== Info:   Trying 1.2.3.4...') +
    line('10:00:02.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '13:00:00.000000' });
  assert.equal(timeline.dominantGap.terminal, false, 'the measurable inter-record gap wins');
  assert.equal(timeline.dominantGap.ms, 2000);
  const out = formatTimeline(timeline);
  assert.match(out, /terminal interval .* could not be measured/);
  assert.match(out, /NOT located by this number/);
});

test('formatTimeline: a fully measurable timeline carries NO such caveat', () => {
  const t =
    line('10:00:00.000000', '== Info:   Trying 1.2.3.4...') +
    line('10:00:02.000000', '<= Recv header: HTTP/2 200');
  const timeline = extractPhaseTimeline({ traceText: t, killedAt: '10:00:32.000000' });
  assert.equal(timeline.dominantGap.terminal, true);
  assert.doesNotMatch(formatTimeline(timeline), /could not be measured/);
});

// ---------------------------------------------------------------------------
// BRO-3358: GIT_TRACE2_PERF diagnostics
// ---------------------------------------------------------------------------

test('redactTrace2 is the same denylist as redactCurlTrace (defense-in-depth reuse, not a fork)', () => {
  const withSecret = 'argv:[git-remote-https https://x-access-token:SECRETVAL@github.com/o/r.git]';
  assert.equal(redactTrace2(withSecret), redactCurlTrace(withSecret));
  assert.ok(!redactTrace2(withSecret).includes('SECRETVAL'));
});

test('parseTrace2Records: parses depth, event, and data fields, trimmed', () => {
  const t = t2('17:02:06.395019', 1, 'child_start', "[ch0] class:dashed argv:['git-remote-https']");
  const records = parseTrace2Records(t);
  assert.equal(records.length, 1);
  assert.equal(records[0].depth, 1);
  assert.equal(records[0].event, 'child_start');
  assert.match(records[0].data, /^\[ch0\] class:dashed/);
  assert.equal(records[0].stamp, '17:02:06.395019');
});

test('parseTrace2Records: non-trace2 lines (no pipes, e.g. a headless truncated tail) are skipped', () => {
  const t = 'not a trace2 line\n' + t2('10:00:00.000000', 0, 'version', '2.50.1');
  assert.equal(parseTrace2Records(t).length, 1);
});

test('summarizeTrace2Children: a child_start with a matching child_exit is NOT flagged in-flight', () => {
  const t =
    t2('10:00:00.000000', 2, 'child_start', "[ch0] class:? argv:['gh auth git-credential store']") +
    t2('10:00:00.180000', 2, 'child_exit', '[ch0] pid:1234 code:0', { tRel: '0.180000' });
  const children = summarizeTrace2Children(t);
  assert.equal(children.length, 1);
  assert.equal(children[0].inFlightAtEnd, false);
  assert.equal(children[0].durationMs, 180);
  assert.match(children[0].argv, /gh auth git-credential store/);
});

test('summarizeTrace2Children: a child_start with NO matching child_exit IS flagged in-flight — the credential-helper-hypothesis signal', () => {
  // This is the whole point of the card: a child still running when the
  // trace2 capture stops (because the process was SIGKILLed) has no
  // child_exit line at all.
  const t = t2('10:00:00.000000', 2, 'child_start', "[ch0] class:? argv:['gh auth git-credential store']");
  const children = summarizeTrace2Children(t);
  assert.equal(children.length, 1);
  assert.equal(children[0].inFlightAtEnd, true);
  assert.equal(children[0].durationMs, null);
});

test('summarizeTrace2Children: [chN] ids are scoped by DEPTH — an unrelated child at another depth reusing ch0 is tracked separately', () => {
  const t =
    t2('10:00:00.000000', 1, 'child_start', '[ch0] class:dashed argv:[git-remote-https]') +
    t2('10:00:00.010000', 2, 'child_start', "[ch0] class:? argv:['gh auth git-credential store']") +
    t2('10:00:00.190000', 2, 'child_exit', '[ch0] pid:1234 code:0', { tRel: '0.180000' });
  const children = summarizeTrace2Children(t);
  assert.equal(children.length, 2);
  const d1 = children.find((c) => c.depth === 1);
  const d2 = children.find((c) => c.depth === 2);
  assert.equal(d1.inFlightAtEnd, true, 'the depth-1 child (no exit) is still in flight');
  assert.equal(d2.inFlightAtEnd, false, 'the depth-2 child (has an exit) is not');
});

test('extractTrace2Timeline: the terminal silence wins, same model as extractPhaseTimeline', () => {
  const t =
    t2('10:00:00.000000', 0, 'version', '2.50.1') +
    t2('10:00:00.010000', 2, 'child_start', "[ch0] argv:['gh auth git-credential store']");
  const timeline = extractTrace2Timeline({ traceText: t, killedAt: '10:01:00.010000' });
  assert.equal(timeline.dominantGap.terminal, true);
  assert.equal(timeline.dominantGap.ms, 60000);
  assert.equal(timeline.dominantGap.event, 'child_start');
});

test('extractTrace2Timeline: an empty trace reports no-trace rather than throwing', () => {
  const timeline = extractTrace2Timeline({ traceText: '' });
  assert.equal(timeline.reason, 'no-trace');
  assert.equal(timeline.dominantGap, null);
});

test('extractTrace2Timeline: a kill time across midnight is a forward wrap, never negative (shares forwardDelta with extractPhaseTimeline)', () => {
  const t = t2('23:59:59.000000', 0, 'version', '2.50.1');
  const timeline = extractTrace2Timeline({ traceText: t, killedAt: '00:00:29.000000' });
  assert.equal(timeline.dominantGap.ms, 30000);
});

test('formatTrace2Timeline: names the in-flight child in the CI-log line', () => {
  const t = t2('10:00:00.000000', 2, 'child_start', "[ch0] class:? argv:['gh auth git-credential store']");
  const timeline = extractTrace2Timeline({ traceText: t, killedAt: '10:00:28.000000' });
  const children = summarizeTrace2Children(t);
  const out = formatTrace2Timeline(timeline, children);
  assert.match(out, /NO child_exit OBSERVED FOR/);
  assert.match(out, /gh auth git-credential store/);
});

test('formatTrace2Timeline: a clean trace with no children carries no in-flight note', () => {
  const t =
    t2('10:00:00.000000', 0, 'version', '2.50.1') +
    t2('10:00:00.010000', 0, 'exit', 'code:0', { tRel: '0.010000' });
  const timeline = extractTrace2Timeline({ traceText: t, killedAt: '10:00:00.011000' });
  const out = formatTrace2Timeline(timeline, summarizeTrace2Children(t));
  assert.doesNotMatch(out, /IN-FLIGHT/);
});
