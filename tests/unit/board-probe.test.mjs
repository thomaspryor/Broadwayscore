// tests/unit/board-probe.test.mjs — S1-T2 of the Notion→Linear cutover.
//
// Sprint 4 rewrites five gate hooks to branch on this verdict, and the whole
// point of the rewrite is that "the board answered badly" must stop being
// treated the same as "the board is fine". So the thing worth testing is not
// that a probe runs — it is that the two failure worlds never collapse into
// each other, and that the exit codes stay distinct enough for a bash hook
// holding only `$?` to tell them apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const probe = require(path.join(REPO, 'scripts/lib/board-probe.js'));

const { VERDICTS, EXIT_CODES, classifyProbeError, formatProbeLine } = probe;

test('an HTTP response — however bad — is erroring, never unreachable', () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const err = Object.assign(new Error(`Linear API HTTP ${status}`), { status });
    const got = classifyProbeError(err);
    assert.equal(got.verdict, VERDICTS.ERRORING, `HTTP ${status} must be erroring`);
    assert.equal(got.reason, `http-${status}`);
  }
});

test('a GraphQL error body is erroring and carries its code', () => {
  const err = Object.assign(new Error('Linear GraphQL error: Authentication required'), {
    linearErrors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }],
  });
  const got = classifyProbeError(err);
  assert.equal(got.verdict, VERDICTS.ERRORING);
  assert.equal(got.reason, 'graphql-AUTHENTICATION_ERROR');
});

test('a missing API key is erroring, not unreachable', () => {
  // Calling this "unreachable" would point whoever reads the digest at
  // Linear's status page instead of at .env.
  const got = classifyProbeError(new Error('LINEAR_API_KEY not set in .env or environment'));
  assert.equal(got.verdict, VERDICTS.ERRORING);
  assert.equal(got.reason, 'no-api-key');
});

test('only a genuine transport failure is unreachable', () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
    code: 23, // undici's numeric DOMException code — must not leak into the reason
  });
  const t = classifyProbeError(timeout);
  assert.equal(t.verdict, VERDICTS.UNREACHABLE);
  assert.equal(t.reason, 'TimeoutError');

  const dns = Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
  assert.equal(classifyProbeError(dns).verdict, VERDICTS.UNREACHABLE);
});

test('an unrecognised error is erroring, not unreachable', () => {
  // A health check must not claim the network is down on the strength of an
  // exception it does not understand.
  const got = classifyProbeError(new TypeError('x.y is not a function'));
  assert.equal(got.verdict, VERDICTS.ERRORING);
  assert.equal(got.reason, 'unclassified');
});

test('no error is healthy', () => {
  assert.equal(classifyProbeError(null).verdict, VERDICTS.HEALTHY);
});

test('the three exit codes are distinct, and only healthy is zero', () => {
  const codes = Object.values(EXIT_CODES);
  assert.equal(new Set(codes).size, 3, 'a bash hook holding only $? must be able to tell them apart');
  assert.equal(EXIT_CODES[VERDICTS.HEALTHY], 0);
  assert.ok(EXIT_CODES[VERDICTS.ERRORING] > 0);
  assert.ok(EXIT_CODES[VERDICTS.UNREACHABLE] > 0);
  assert.notEqual(EXIT_CODES[VERDICTS.ERRORING], EXIT_CODES[VERDICTS.UNREACHABLE]);
});

test('the probe line survives the grep the gate hooks will run on it', () => {
  // `grep -o 'BOARD_PROBE: [a-z]*'` is the contract. Renaming a verdict word
  // or moving it off the front of the line breaks Sprint 4's hooks silently.
  for (const verdict of Object.values(VERDICTS)) {
    const line = formatProbeLine('linear', verdict, 'some-reason', 'detail with — punctuation');
    const m = line.match(/BOARD_PROBE: ([a-z]+)/);
    assert.ok(m, `no BOARD_PROBE token in: ${line}`);
    assert.equal(m[1], verdict);
    assert.ok(!line.includes('\n'), 'must stay one line — hooks read it with grep, not a parser');
  }
});

test('linear-brain.js --probe prints one verdict line and exits with its code', () => {
  // End-to-end through the real CLI. Deliberately assertion-tolerant about
  // WHICH verdict comes back — a machine with no LINEAR_API_KEY (CI) gets
  // `erroring`, a machine with one gets `healthy` — because the invariant
  // being protected is that the printed verdict and the exit code always
  // agree. That is what a hook relies on.
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [path.join(REPO, 'scripts/linear-brain.js'), '--probe', '--timeout-ms', '8000'], {
      encoding: 'utf8',
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    stdout = String(err.stdout || '');
    code = err.status;
  }
  const m = stdout.match(/BOARD_PROBE: ([a-z]+)/);
  assert.ok(m, `expected a BOARD_PROBE line, got: ${JSON.stringify(stdout)}`);
  assert.ok(Object.values(VERDICTS).includes(m[1]), `unknown verdict ${m[1]}`);
  assert.equal(code, EXIT_CODES[m[1]], `exit code ${code} contradicts the printed verdict "${m[1]}"`);
  assert.equal(stdout.trim().split('\n').length, 1, 'exactly one line on stdout');
});
