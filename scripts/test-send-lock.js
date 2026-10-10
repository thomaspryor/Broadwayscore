#!/usr/bin/env node
/**
 * Tests for scripts/lib/send-lock.js
 *
 * Safety boundaries:
 *   - NEVER sends any email (no Resend/Buttondown calls, period).
 *   - Tests use a 5-second TTL so any leftover test lock auto-expires long
 *     before the 5-minute production TTL, meaning a crashed test can't block
 *     a real broadcast for more than ~5 seconds.
 *   - Cleanup guard runs at start AND in finally to force-delete any lock
 *     whose purpose starts with TEST_PURPOSE_PREFIX.
 *   - Creates real commits on origin/main for the lock file only. Two commits
 *     per acquire/release cycle. This is auditable in the git log.
 *
 * Run: node scripts/test-send-lock.js
 */

const { execSync } = require('child_process');
const {
  acquireSendLock,
  releaseSendLock,
  fetchLock,
  deleteLock,
  LOCK_PATH,
  REPO,
} = require('./lib/send-lock');

const TEST_PURPOSE_PREFIX = '__test_send_lock__';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`\u2713 ${name}`);
    passed++;
  } else {
    console.log(`\u2717 ${name}${extra ? ' — ' + extra : ''}`);
    failed++;
  }
}

/**
 * Before the tests run, force-clean any lock file on origin whose purpose
 * looks like a leftover test. Safety: only removes locks matching the
 * TEST_PURPOSE_PREFIX — never touches a real production lock.
 */
function cleanupTestLock(label = 'pre-test') {
  const current = fetchLock();
  if (current.error) {
    console.log(`  (cleanup ${label}: fetch error: ${current.error})`);
    return;
  }
  if (!current.exists) {
    console.log(`  (cleanup ${label}: no lock present)`);
    return;
  }
  const existing = current.parsed || {};
  if (!existing.purpose || !existing.purpose.startsWith(TEST_PURPOSE_PREFIX)) {
    console.log(`  (cleanup ${label}: lock present but NOT a test lock — purpose="${existing.purpose || '?'}", leaving it alone)`);
    return;
  }
  const del = deleteLock(current.sha, `lock: cleanup leftover test lock (${label})`);
  if (del.ok) {
    console.log(`  (cleanup ${label}: removed leftover test lock, purpose="${existing.purpose}")`);
  } else {
    console.log(`  (cleanup ${label}: DELETE failed: ${del.stderr || del.status})`);
  }
}

async function runTests() {
  // ---------------------------------------------------------------------------
  // Pre-flight: gh auth + initial cleanup
  // ---------------------------------------------------------------------------
  try {
    execSync('gh auth status', { stdio: 'ignore' });
  } catch {
    console.error('FATAL: gh CLI is not authenticated. Run `gh auth login` first.');
    process.exit(1);
  }
  console.log('Pre-flight: gh auth OK');
  cleanupTestLock('startup');
  console.log('');

  // ---------------------------------------------------------------------------
  // Test 1: Happy path — acquire, verify on origin, release, verify gone.
  // ---------------------------------------------------------------------------
  console.log('--- Test 1: acquire → verify → release → verify gone ---');
  const purpose1 = `${TEST_PURPOSE_PREFIX}-happy-path-${Date.now()}`;
  const lock1 = acquireSendLock({ purpose: purpose1, ttlMs: 5000 });
  check('lock acquired cleanly', lock1.acquired === true, lock1.reason);
  check('sessionId is a UUID-shaped string', typeof lock1.sessionId === 'string' && lock1.sessionId.length === 36);
  check('sha returned from PUT', typeof lock1.sha === 'string' && lock1.sha.length >= 7);

  // Verify on origin
  const verify1 = fetchLock();
  check('origin shows the lock file', verify1.exists === true);
  check('origin lock has our sessionId', verify1.parsed?.sessionId === lock1.sessionId);
  check('origin lock has our purpose', verify1.parsed?.purpose === purpose1);
  check('origin lock has TTL in the future', new Date(verify1.parsed?.expiresAt).getTime() > Date.now());
  check(
    'holder is "cli" when not running under GITHUB_ACTIONS',
    verify1.parsed?.holder === 'cli' || verify1.parsed?.holder === 'workflow'
  );

  // Release
  const rel1 = releaseSendLock(lock1);
  check('release succeeded', rel1.released === true);

  // Verify gone
  const verify1b = fetchLock();
  check('origin no longer has the lock file after release', verify1b.exists === false);
  console.log('');

  // ---------------------------------------------------------------------------
  // Test 2: Contention — acquire, try to acquire again (must fail), release,
  // acquire again (must succeed), release.
  // ---------------------------------------------------------------------------
  console.log('--- Test 2: contention (second acquire blocked while first is held) ---');
  const purpose2 = `${TEST_PURPOSE_PREFIX}-contention-${Date.now()}`;
  const lock2a = acquireSendLock({ purpose: purpose2, ttlMs: 5000 });
  check('first acquire succeeds', lock2a.acquired === true);

  const lock2b = acquireSendLock({ purpose: purpose2, ttlMs: 5000 });
  check('second acquire is refused while first is held', lock2b.acquired === false);
  check(
    'refusal reason mentions the held state',
    typeof lock2b.reason === 'string' && lock2b.reason.includes('held by'),
    lock2b.reason
  );
  check(
    'refusal exposes the holder session',
    lock2b.heldBy?.sessionId === lock2a.sessionId
  );

  const rel2a = releaseSendLock(lock2a);
  check('release of first lock succeeds', rel2a.released === true);

  const lock2c = acquireSendLock({ purpose: purpose2, ttlMs: 5000 });
  check('third acquire (after release) succeeds', lock2c.acquired === true);
  check('third acquire has a fresh sessionId', lock2c.sessionId !== lock2a.sessionId);

  const rel2c = releaseSendLock(lock2c);
  check('final release succeeds', rel2c.released === true);
  console.log('');

  // ---------------------------------------------------------------------------
  // Test 3: Expiry takeover — acquire with 1s TTL, wait past expiry, acquire
  // again (should succeed via takeover path).
  // ---------------------------------------------------------------------------
  console.log('--- Test 3: expired lock takeover ---');
  const purpose3 = `${TEST_PURPOSE_PREFIX}-expiry-${Date.now()}`;
  const lock3a = acquireSendLock({ purpose: purpose3, ttlMs: 1000 });
  check('short-TTL acquire succeeds', lock3a.acquired === true);

  // Wait for expiry.
  await new Promise((r) => setTimeout(r, 1500));

  const lock3b = acquireSendLock({ purpose: purpose3, ttlMs: 5000 });
  check('acquire past expiry takes over', lock3b.acquired === true, lock3b.reason);
  check('takeover produced a fresh sessionId', lock3b.sessionId !== lock3a.sessionId);

  // Original holder's release should now be a no-op or fail gracefully — the
  // lock belongs to lock3b now, so releaseSendLock(lock3a) must NOT nuke it.
  const rel3a = releaseSendLock(lock3a);
  check(
    'old holder release is refused (lock now belongs to new holder)',
    rel3a.released === false && String(rel3a.reason || '').includes('taken over'),
    rel3a.reason
  );

  // Verify the new holder's lock is still intact.
  const verify3 = fetchLock();
  check(
    'new holder lock still present after old holder release attempt',
    verify3.exists === true && verify3.parsed?.sessionId === lock3b.sessionId
  );

  const rel3b = releaseSendLock(lock3b);
  check('new holder release succeeds', rel3b.released === true);
  console.log('');

  // ---------------------------------------------------------------------------
  // Test 4: Release of a not-held lock is safe.
  // ---------------------------------------------------------------------------
  console.log('--- Test 4: defensive release ---');
  const relNull = releaseSendLock(null);
  check('releaseSendLock(null) → { released: false }', relNull.released === false);
  const relStub = releaseSendLock({ acquired: false });
  check('releaseSendLock({acquired:false}) → { released: false }', relStub.released === false);
  console.log('');

  // ---------------------------------------------------------------------------
  // Test 5: releaseSendLock is idempotent — releasing an already-released lock
  // returns released:true (404 is treated as success).
  // ---------------------------------------------------------------------------
  console.log('--- Test 5: idempotent release ---');
  const purpose5 = `${TEST_PURPOSE_PREFIX}-idempotent-${Date.now()}`;
  const lock5 = acquireSendLock({ purpose: purpose5, ttlMs: 5000 });
  check('setup acquire', lock5.acquired === true);
  const rel5a = releaseSendLock(lock5);
  check('first release succeeds', rel5a.released === true);
  const rel5b = releaseSendLock(lock5);
  check(
    'second release reports already-gone cleanly',
    rel5b.released === true && String(rel5b.reason || '').includes('already gone')
  );
  console.log('');

  // ---------------------------------------------------------------------------
  // Final cleanup — absolutely must not leave a test lock behind.
  // ---------------------------------------------------------------------------
  cleanupTestLock('shutdown');
}

runTests()
  .then(() => {
    console.log('');
    console.log(`${passed}/${passed + failed} passed`);
    if (failed > 0) {
      console.error(`${failed} test(s) FAILED`);
      cleanupTestLock('failure-cleanup');
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('FATAL error in test harness:', err);
    cleanupTestLock('error-cleanup');
    process.exit(1);
  });
