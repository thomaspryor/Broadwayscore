// Unit tests for pushCookieSecretWithMeta() (task #897) — extracted from
// wsj-otp-login.js's pushCookiesToGitHubSecret() so #850/#876's OTP-login
// outlets inherit the #881 cookie-freshness fix instead of re-deriving the
// two-secret (cookies + _META) push pattern themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// execFileSync is destructured by otp-login-helpers.js at require time, so
// the child_process module object must be patched BEFORE the module is
// (re-)required — mirrors the stub pattern in owner-alert-router.test.mjs.
function loadHelpersWithFakeExecFileSync(execFileSyncImpl) {
  const modulePath = require.resolve('./otp-login-helpers.js');
  const childProcessPath = require.resolve('node:child_process');
  delete require.cache[modulePath];

  const calls = [];
  const realChildProcess = require(childProcessPath);
  const originalExecFileSync = realChildProcess.execFileSync;
  realChildProcess.execFileSync = (...args) => {
    calls.push(args);
    return execFileSyncImpl(...args);
  };

  const helpers = require(modulePath);

  return {
    pushCookieSecretWithMeta: helpers.pushCookieSecretWithMeta,
    calls,
    restore: () => {
      realChildProcess.execFileSync = originalExecFileSync;
      delete require.cache[modulePath];
    },
  };
}

test('pushCookieSecretWithMeta: both pushes succeed', () => {
  const { pushCookieSecretWithMeta, calls, restore } = loadHelpersWithFakeExecFileSync(() => '');
  try {
    const cookies = [{ name: 'a', value: '1' }];
    const meta = { extractedAt: '2026-08-02T00:00:00.000Z', extractedAtUnix: 1754092800 };
    const result = pushCookieSecretWithMeta('WSJ_COOKIES', cookies, meta, { repo: 'thomaspryor/Broadwayscore' });

    assert.deepEqual(result, { cookiesPushed: true, metaPushed: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'gh');
    assert.deepEqual(calls[0][1], ['secret', 'set', 'WSJ_COOKIES', '--repo', 'thomaspryor/Broadwayscore']);
    assert.equal(calls[0][2].input, Buffer.from(JSON.stringify(cookies)).toString('base64'));
    assert.equal(calls[1][0], 'gh');
    assert.deepEqual(calls[1][1], ['secret', 'set', 'WSJ_COOKIES_META', '--repo', 'thomaspryor/Broadwayscore']);
    assert.equal(calls[1][2].input, Buffer.from(JSON.stringify(meta)).toString('base64'));
  } finally {
    restore();
  }
});

test('pushCookieSecretWithMeta: cookies push fails is fatal — meta push never attempted', () => {
  const { pushCookieSecretWithMeta, calls, restore } = loadHelpersWithFakeExecFileSync(() => {
    throw new Error('gh: not authenticated');
  });
  try {
    const result = pushCookieSecretWithMeta('WSJ_COOKIES', [{ name: 'a', value: '1' }], { extractedAt: 'x' });

    assert.deepEqual(result, { cookiesPushed: false, metaPushed: false });
    assert.equal(calls.length, 1, 'meta push must not be attempted after a fatal cookies-push failure');
  } finally {
    restore();
  }
});

test('pushCookieSecretWithMeta: meta push fails after cookies succeed — non-fatal, cookies still landed', () => {
  let call = 0;
  const { pushCookieSecretWithMeta, calls, restore } = loadHelpersWithFakeExecFileSync(() => {
    call++;
    if (call === 2) throw new Error('gh: network error');
    return '';
  });
  try {
    const result = pushCookieSecretWithMeta('WSJ_COOKIES', [{ name: 'a', value: '1' }], { extractedAt: 'x' });

    assert.deepEqual(result, { cookiesPushed: true, metaPushed: false });
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test('pushCookieSecretWithMeta: no meta provided — only cookies secret is pushed', () => {
  const { pushCookieSecretWithMeta, calls, restore } = loadHelpersWithFakeExecFileSync(() => '');
  try {
    const result = pushCookieSecretWithMeta('NYT_COOKIES', [{ name: 'a', value: '1' }], null);

    assert.deepEqual(result, { cookiesPushed: true, metaPushed: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'gh');
    assert.equal(calls[0][1][2], 'NYT_COOKIES');
  } finally {
    restore();
  }
});

test('pushCookieSecretWithMeta: repo defaults to GITHUB_REPOSITORY env, then thomaspryor/Broadwayscore', () => {
  const { pushCookieSecretWithMeta, calls, restore } = loadHelpersWithFakeExecFileSync(() => '');
  const priorRepo = process.env.GITHUB_REPOSITORY;
  try {
    delete process.env.GITHUB_REPOSITORY;
    pushCookieSecretWithMeta('NEWYORKER_COOKIES', [], null);
    assert.deepEqual(calls[0][1], ['secret', 'set', 'NEWYORKER_COOKIES', '--repo', 'thomaspryor/Broadwayscore']);

    process.env.GITHUB_REPOSITORY = 'someorg/somerepo';
    pushCookieSecretWithMeta('NEWYORKER_COOKIES', [], null);
    assert.deepEqual(calls[1][1], ['secret', 'set', 'NEWYORKER_COOKIES', '--repo', 'someorg/somerepo']);
  } finally {
    if (priorRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = priorRepo;
    restore();
  }
});

test('pushCookieSecretWithMeta: shell metacharacters in envVarName/repo are passed as literal argv, not interpreted', () => {
  // Regression test for a ship-check finding (task #897): the original
  // extraction used execSync() with a template-literal shell command, which
  // was safe only because WSJ's caller hardcoded both values. Generalizing
  // envVarName/repo to future outlet-driven callers (#850/#876) turned that
  // into a real injection vector, so this now uses execFileSync() with an
  // argv array — a value like `$(rm -rf /)` must reach `gh` as one literal
  // argument, never get shell-expanded.
  const dangerous = '$(rm -rf /)_COOKIES';
  const { pushCookieSecretWithMeta, calls, restore } = loadHelpersWithFakeExecFileSync(() => '');
  try {
    pushCookieSecretWithMeta(dangerous, [], null, { repo: 'evil"; rm -rf /; echo "' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'gh');
    assert.deepEqual(calls[0][1], ['secret', 'set', dangerous, '--repo', 'evil"; rm -rf /; echo "']);
  } finally {
    restore();
  }
});
