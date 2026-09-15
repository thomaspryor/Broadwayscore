// BRO-2839 — break a hard-killed push's CONNECT phase into named sub-phases
// and identify the one that consumes the timeout.
//
// WHY THIS FILE EXISTS
// Every affected CI push runs to the GIT_NET_TIMEOUT_SEC wall and is killed
// (rc=124). BRO-3213 added GIT_TRACE_CURL capture plus classifyStallPhase(),
// which reports how far the LAST HTTP exchange got. Since 2026-09-13 that has
// answered "response-received-then-stalled" on 100% of ledger rows — and it
// structurally cannot answer anything else for this failure, because:
//
//   On CI run 34852355418 (Process Feedback Submissions, 2026-09-14,
//   GIT_NET_TIMEOUT_SEC=30) the trace's LAST line is stamped 13:58:34.383856,
//   ~1.7s into an attempt killed at 13:59:02.69. The other ~28s produced NO
//   trace output at all. The time is not spent INSIDE a logged phase; it is
//   the silence AFTER the last logged line. A furthest-marker-reached
//   classifier has no vocabulary for that.
//
// So the sub-phase breakdown has to treat "last trace line -> kill" as a
// first-class interval, which is what extractPhaseTimeline() adds and what
// these tests pin down.
//
// TEST STRATEGY (and its honest limits)
//  - PRIMARY assertions run against a REAL redacted CI trace captured from the
//    failing run above (tests/fixtures/). That is the actual artifact.
//  - The live end-to-end case below runs a REAL `git push` against a local
//    server that stalls, proving the capture->parse->identify chain works on a
//    genuinely killed push. It is HTTP/1.1 on loopback, whereas GitHub is
//    HTTP/2, so it validates the chain, NOT the CI wire shape. The fixture is
//    what speaks to the CI shape. Neither is claimed to reproduce the CI ROOT
//    CAUSE, which remains unidentified.
//
// Every function under test is require()d from the real module (CLAUDE.md
// rule 15) — no logic is reimplemented here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const require = createRequire(import.meta.url);
const {
  extractPhaseTimeline,
  classifyStallService,
  censusTrace,
  formatTimeline,
  parseTrace2Records,
  summarizeTrace2Children,
  extractTrace2Timeline,
  formatTrace2Timeline,
} = require('./lib/push-diagnostics.js');

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(
  REPO_ROOT,
  'tests/fixtures/push-stall-trace-ci-34852355418.txt'
);
// BRO-3358: real GIT_TRACE2_PERF captures (not synthetic lines) — see that
// module's header for why GIT_TRACE_CURL/GIT_TRACE_PERFORMANCE cannot answer
// what these do. Both were captured by this session with `GIT_TRACE2_PERF=1
// git ls-remote https://x-access-token:FAKETOKEN...@github.com/...` and
// redacted via push-diagnostics-cli.js redact-tail before being committed —
// FIXTURE2_KILLED is FIXTURE2_CLEAN truncated right after the credential-
// helper's child_start line, i.e. before its child_exit, which is exactly
// the shape a real git_push_traced() capture has when the process is
// SIGKILLed while that child is still running.
const FIXTURE2_CLEAN = join(
  REPO_ROOT,
  'tests/fixtures/push-stall-trace2-local-ls-remote.txt'
);
const FIXTURE2_KILLED = join(
  REPO_ROOT,
  'tests/fixtures/push-stall-trace2-killed-mid-credential-helper.txt'
);

// ---------------------------------------------------------------------------
// PRIMARY: the real CI artifact.
// ---------------------------------------------------------------------------

test('real CI trace: the timeout is spent in the SILENCE after the last trace line, not inside any HTTP phase', () => {
  const traceText = fs.readFileSync(FIXTURE, 'utf8');
  // Attempt 1 of run 34852355418 was killed at 13:59:02.69 (from the CI log's
  // own "Pre-resolution push (attempt 1) FAILED in 30s" line).
  const timeline = extractPhaseTimeline({
    traceText,
    killedAt: '13:59:02.690000',
  });

  assert.ok(timeline.dominantGap, 'a dominant gap must be identified');
  assert.equal(
    timeline.dominantGap.terminal,
    true,
    'the sub-phase consuming the timeout must be the terminal silence, not an inter-record gap'
  );

  // The whole point: the terminal gap must dominate by a wide margin. If an
  // inter-record gap ever won here, the identification would be wrong.
  const interRecord = timeline.gaps.filter((g) => !g.terminal);
  const largestInterRecord = interRecord.reduce((m, g) => Math.max(m, g.ms), 0);
  assert.ok(
    timeline.dominantGap.ms > largestInterRecord * 100,
    `terminal silence (${timeline.dominantGap.ms}ms) must dwarf the largest inter-record gap ` +
      `(${largestInterRecord}ms) — otherwise "where the time went" is not answered`
  );

  // ~28.3s of a 30s attempt. Asserted as a range so a re-capture of the same
  // fixture with slightly different rounding does not redden main.
  assert.ok(
    timeline.dominantGap.ms > 25000 && timeline.dominantGap.ms < 30000,
    `expected ~28s of silence, got ${timeline.dominantGap.ms}ms`
  );
});

test('real CI trace: an exchange that is not receive-pack is never attributed to the push', () => {
  const traceText = fs.readFileSync(FIXTURE, 'utf8');
  const timeline = extractPhaseTimeline({
    traceText,
    killedAt: '13:59:02.690000',
  });

  // INVARIANT, not a hardcoded expectation of the current artifact. A `git
  // push` speaks receive-pack and nothing else — verified locally against this
  // repo's origin from both a full clone and a depth-1 shallow clone: every
  // push trace contained receive-pack exchanges and ZERO upload-pack lines.
  // So whatever service the trace turns out to describe, the rule is the same:
  // only receive-pack may be reported as the push's own stall. This keeps
  // passing if the census later explains the upload-pack traffic away.
  const service = classifyStallService(traceText);
  assert.equal(
    timeline.attributedToPush,
    service === 'receive-pack',
    'attribution must follow the service, never be assumed'
  );

  if (service !== 'receive-pack') {
    assert.equal(
      timeline.attributedToPush,
      false,
      'a non-receive-pack exchange must NOT be reported as the push stall'
    );
    assert.match(
      formatTimeline(timeline),
      /NOT receive-pack/,
      'the human-readable summary must say so out loud, so a reader cannot mistake it for the push'
    );
  }
});

test('real CI trace: census exposes that the logged tail is a truncated keyhole', () => {
  const traceText = fs.readFileSync(FIXTURE, 'utf8');
  const c = censusTrace(traceText);
  // The captured artifact is exactly the old 2000-byte redact-tail cap, and it
  // does not contain a single request line — which is precisely why the CI
  // logs could not answer "which exchange stalled". This is the evidence that
  // motivated raising the cap and adding the census.
  assert.equal(c.bytes, 2000, 'fixture is the old 2000-byte tail cap verbatim');
  assert.equal(
    c.requests.length,
    0,
    'the 2000-byte tail contained NO request line — the keyhole this card had to work through'
  );
  assert.ok(c.records > 0, 'but it does contain timestamped records');
});

// ---------------------------------------------------------------------------
// BRO-3358: real GIT_TRACE2_PERF captures.
// ---------------------------------------------------------------------------

test('real trace2 capture: a clean run pairs every child_start with a child_exit — nothing in-flight', () => {
  const traceText = fs.readFileSync(FIXTURE2_CLEAN, 'utf8');
  const records = parseTrace2Records(traceText);
  assert.ok(records.length > 10, 'a real capture parses into more than a couple records');
  const children = summarizeTrace2Children(traceText);
  assert.ok(children.length >= 3, 'a real ls-remote spawns multiple nested children (remote-https, dashed, credential helper)');
  assert.ok(
    children.every((c) => c.inFlightAtEnd === false),
    'a run that completed normally must have an exit for every child it started'
  );
  const helper = children.find((c) => /git-credential store/.test(c.argv));
  assert.ok(helper, 'the credential-helper child must be present in a real capture');
  assert.ok(helper.durationMs > 0 && helper.durationMs < 5000, `credential-helper duration should be a small positive number, got ${helper.durationMs}ms`);
});

test('real trace2 capture, KILLED mid-credential-helper: the in-flight child is identified — the exact signal this card exists to produce', () => {
  // This fixture is FIXTURE2_CLEAN truncated right after the credential
  // helper's child_start line — i.e. it has no child_exit for that child,
  // the same shape a real git_push_traced() capture has when SIGKILL lands
  // while that child is still running.
  const traceText = fs.readFileSync(FIXTURE2_KILLED, 'utf8');
  const children = summarizeTrace2Children(traceText);
  // The truncation point sits inside a 3-deep nested chain (git ->
  // remote-https -> git-remote-https -> credential helper) BEFORE any of
  // their child_exit lines — so all 3 ancestors read as still in-flight too,
  // which is correct: they genuinely are still running (waiting on their own
  // child) at the moment this capture stops. The credential-helper child
  // specifically being among them, at the DEEPEST nesting level, is the
  // signal this test exists to pin down.
  const inFlight = children.filter((c) => c.inFlightAtEnd);
  assert.equal(inFlight.length, 3, 'every still-running ancestor in the nested chain must be flagged in-flight');
  const helper = inFlight.find((c) => /git-credential store/.test(c.argv));
  assert.ok(helper, 'the credential-helper child must be among the in-flight children');
  assert.equal(helper.depth, Math.max(...inFlight.map((c) => c.depth)), 'the credential helper is the DEEPEST in-flight child — the one actually holding up the process');

  const records = parseTrace2Records(traceText);
  assert.equal(records[records.length - 1].event, 'child_start', 'the fixture must end ON the credential-helper child_start, with nothing logged after it');
  // 30s after the last logged line — a real GIT_NET_TIMEOUT_SEC-class kill,
  // not an instant one, so the terminal silence clearly dominates every real
  // inter-record gap in this fixture (the largest of which is the ~111ms
  // credential-helper spawn latency itself, already present in the capture).
  const timeline = extractTrace2Timeline({ traceText, killedAt: '17:14:09.014142' });
  assert.equal(timeline.dominantGap.terminal, true, 'the terminal silence (kill - last line) must dominate every real inter-record gap');
  assert.ok(timeline.dominantGap.ms > 29000 && timeline.dominantGap.ms < 31000, `expected ~30s, got ${timeline.dominantGap.ms}ms`);

  const out = formatTrace2Timeline(timeline, children);
  assert.match(out, /NO child_exit OBSERVED FOR/);
  assert.match(out, /git-credential store/);
  assert.ok(!out.includes('FAKETOKEN'), 'no unredacted credential text may reach the formatted summary');
});

test('real trace2 capture: git already redacts URL userinfo natively — no raw credential survives even before redactTrace2 runs', () => {
  const clean = fs.readFileSync(FIXTURE2_CLEAN, 'utf8');
  const killed = fs.readFileSync(FIXTURE2_KILLED, 'utf8');
  for (const text of [clean, killed]) {
    assert.doesNotMatch(text, /x-access-token:[^*][^@]*@/, 'a raw (non-***) userinfo token must never appear in a committed fixture');
  }
});

// ---------------------------------------------------------------------------
// SECONDARY: live end-to-end — a REAL push, really killed, really parsed.
// ---------------------------------------------------------------------------

// 5s, not 3: the request handler does a blocking ref-advertisement spawn,
// which is tight on a 2-core runner — too short a stall risks killing the push
// before the response headers land, flaking the phase assertion (ship-check
// finding). Still trivial against test.yml's 15-minute unit-tests budget.
const STALL_SEC = 5;

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('live: a real push killed mid-stall produces a trace whose terminal gap is identified', {
  skip: !gitAvailable() && 'git not available',
  // Explicit ceiling so a wedged child can never hold the whole CI job.
  timeout: 60000,
}, async (t) => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'bro2839-'));
  const bare = join(tmp, 'remote.git');
  const work = join(tmp, 'work');
  const trace = join(tmp, 'push.trace');
  // BRO-3358: a second, independent capture in the SAME live-killed run —
  // mirrors git_push_traced() setting both GIT_TRACE_CURL and GIT_TRACE2_PERF
  // on one `git push` invocation, on its own temp file.
  const trace2 = join(tmp, 'push.trace2');

  // Setup runs under its own try: the temp dir already exists by this point,
  // and any git failure here (a restrictive core.hooksPath, a missing identity
  // fallback) would otherwise throw past the main try/finally below and leak
  // the directory (post-ship-check review finding).
  try {
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', work]);
    const G = (...a) =>
      execFileSync('git', ['-C', work, ...a], { stdio: 'pipe' });
    fs.writeFileSync(join(work, 'a.txt'), 'hello\n');
    G('add', 'a.txt');
    G('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed');
    execFileSync('git', ['-C', work, 'push', '-q', bare, 'HEAD:refs/heads/main']);
    fs.writeFileSync(join(work, 'b.txt'), 'world\n');
    G('add', 'b.txt');
    G('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'second');
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // Skipping is right on a developer machine with an unusual git config, but
    // WRONG in CI: there, a fixture that suddenly cannot be built is a real
    // breakage, and silently skipping would hide it behind a green run
    // (adversarial review finding). CI fails hard.
    if (process.env.CI) throw err;
    return t.skip(`git could not build the fixture repo here: ${err.message}`);
  }

  const pkt = (line) =>
    Buffer.from((line.length + 4).toString(16).padStart(4, '0') + line);

  let advertisementFailed = false;

  // Minimal git smart-HTTP: answer the ref advertisement for real (delegated
  // to git itself, so the pkt-line format is never hand-rolled), then accept
  // the receive-pack POST, send response headers, and STALL forever.
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('service=git-receive-pack')) {
      const adv = spawnSync(
        'git',
        ['receive-pack', '--stateless-rpc', '--advertise-refs', bare],
        { maxBuffer: 1 << 24 }
      ).stdout;
      if (!adv || adv.length === 0) {
        // No advertisement means this environment's git cannot serve
        // receive-pack. Answering 500 makes the client fail FAST and loudly
        // rather than letting the test sit until its own kill timer, which
        // would look like the stall under test and assert against garbage.
        advertisementFailed = true;
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'cache-control': 'no-cache',
      });
      res.write(pkt('# service=git-receive-pack\n'));
      res.write(Buffer.from('0000'));
      res.write(adv);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/git-receive-pack')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'cache-control': 'no-cache',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        // Deliberately never res.end() — this is the stall under test.
      });
      return;
    }
    res.writeHead(404).end();
  });

  const listening = await new Promise((resolve) => {
    server.on('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => resolve(true));
  });
  if (!listening) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return t.skip('cannot listen on loopback in this environment');
  }

  try {
    const url = `http://127.0.0.1:${server.address().port}/remote.git`;
    // detached: own process group. SIGTERM to the `git push` parent alone
    // leaves `git-remote-http` alive holding the stdio pipes, so 'close' never
    // fires and the test hangs — found the hard way while prototyping this.
    // Killing the GROUP and waiting on 'exit' (not 'close') is what works.
    const child = spawn(
      'git',
      ['-C', work, 'push', '--progress', url, 'HEAD:refs/heads/main'],
      {
        env: {
          ...process.env,
          GIT_TRACE_CURL: trace,
          GIT_TRACE_CURL_NO_DATA: '1',
          GIT_TRACE2_PERF: trace2,
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }
    );
    child.stdout.resume();
    child.stderr.resume();

    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }, STALL_SEC * 1000);
    // Wall clock at the kill, on the SAME clock GIT_TRACE_CURL stamps its
    // lines with — mirroring what push-with-retry.sh's git_push_traced()
    // captures right after the timeout wrapper returns.
    await new Promise((resolve) => child.on('exit', () => resolve()));
    clearTimeout(killer);
    const d = new Date();
    const killedAt =
      `${String(d.getHours()).padStart(2, '0')}:` +
      `${String(d.getMinutes()).padStart(2, '0')}:` +
      `${String(d.getSeconds()).padStart(2, '0')}.` +
      `${String(d.getMilliseconds()).padStart(3, '0')}000`;

    if (advertisementFailed) {
      return t.skip('this environment\'s git cannot serve receive-pack');
    }

    const traceText = fs.readFileSync(trace, 'utf8');

    // The capture itself must be real: a genuine receive-pack conversation.
    const census = censusTrace(traceText);
    assert.ok(
      census.requests.length >= 1,
      'the live trace must contain at least one request line'
    );
    assert.equal(
      classifyStallService(traceText),
      'receive-pack',
      'a real push speaks receive-pack — if this ever fails, the premise behind the attribution rule is wrong'
    );

    const timeline = extractPhaseTimeline({ traceText, killedAt });
    assert.ok(timeline.dominantGap, 'a dominant gap must be identified');
    assert.equal(
      timeline.attributedToPush,
      true,
      'a real receive-pack push IS attributable to the push'
    );
    assert.equal(
      timeline.dominantGap.terminal,
      true,
      'the stall was the silence after the last trace line, so that gap must win'
    );
    // The server answered headers then went silent, so the last logged phase
    // is the response-received one — the same terminal marker CI reports.
    assert.equal(
      timeline.dominantGap.phase,
      'response-received-then-stalled',
      'the live stall lands in the same phase CI reports, which is exactly why the phase label alone is not enough to locate the time'
    );

    // BRO-3358: the trace2 capture, from the SAME killed process, on the
    // SAME clock. GIT_TRACE2_PERF has no HTTP-phase vocabulary (that's what
    // the curl trace above is for) — what it answers here is "did this
    // capture work end-to-end against a REAL killed push", not phase
    // identification, which the curl-trace assertions above already cover.
    if (fs.existsSync(trace2)) {
      const trace2Text = fs.readFileSync(trace2, 'utf8');
      const records = parseTrace2Records(trace2Text);
      assert.ok(records.length > 0, 'a real killed push must produce SOME trace2 records');
      const trace2Timeline = extractTrace2Timeline({ traceText: trace2Text, killedAt });
      assert.ok(trace2Timeline.dominantGap, 'a dominant gap must be identified in the trace2 capture too');
      assert.equal(
        trace2Timeline.dominantGap.terminal,
        true,
        'the trace2 capture must also identify the terminal silence as dominant, independently of the curl trace'
      );
    }
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
