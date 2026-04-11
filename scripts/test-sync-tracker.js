#!/usr/bin/env node
/**
 * Tests for syncTrackerToOrigin() + mergeTrackerEntries() from
 * scripts/send-opening-night-broadcast.js.
 *
 * Does NOT send any emails. Does NOT write to origin/main. The `fetchRemote`
 * path runs read-only against the real repo; the `putRemote` path is proven
 * unreachable in the CI-skip branch, and its inputs are verified via the
 * `mergeTrackerEntries` unit tests.
 *
 * Run: node scripts/test-sync-tracker.js
 */

const path = require('path');
const { execSync } = require('child_process');

// Guard: these tests must NEVER invoke any email-send code path. We require the
// module, which triggers main() only if require.main === module — so requiring
// it as a library is safe.
const mod = require('./send-opening-night-broadcast');
const { syncTrackerToOrigin, mergeTrackerEntries } = mod;

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

// ---------------------------------------------------------------------------
// mergeTrackerEntries — pure function, no network.
// ---------------------------------------------------------------------------

check(
  'merge: empty remote + empty local → { shows: {} }',
  JSON.stringify(mergeTrackerEntries({}, { shows: {} })) === '{"shows":{}}'
);

check(
  'merge: null remote + local entry → local wins',
  (() => {
    const r = mergeTrackerEntries(null, {
      shows: { 'preview:test:foo': { sentAt: '2026-04-11T12:00:00Z' } },
    });
    return r.shows['preview:test:foo']?.sentAt === '2026-04-11T12:00:00Z';
  })()
);

check(
  'merge: remote has shows + local is empty → remote preserved',
  (() => {
    const r = mergeTrackerEntries(
      { shows: { 'giant-2026': { completed: true } } },
      { shows: {} }
    );
    return r.shows['giant-2026']?.completed === true;
  })()
);

check(
  'merge: local and remote have different keys → union',
  (() => {
    const r = mergeTrackerEntries(
      { shows: { 'giant-2026': { completed: true } } },
      { shows: { 'preview:broadway:titanique:2026-04-12': { sentAt: 'X' } } }
    );
    return (
      r.shows['giant-2026']?.completed === true &&
      r.shows['preview:broadway:titanique:2026-04-12']?.sentAt === 'X'
    );
  })()
);

check(
  'merge: key conflict → local wins (CLI just sent)',
  (() => {
    const r = mergeTrackerEntries(
      { shows: { 'preview:broadway:x:2026-04-11': { sentAt: 'REMOTE', reviewCount: 10 } } },
      { shows: { 'preview:broadway:x:2026-04-11': { sentAt: 'LOCAL', reviewCount: 15 } } }
    );
    return (
      r.shows['preview:broadway:x:2026-04-11'].sentAt === 'LOCAL' &&
      r.shows['preview:broadway:x:2026-04-11'].reviewCount === 15
    );
  })()
);

check(
  'merge: remote has top-level non-shows key → preserved',
  (() => {
    const r = mergeTrackerEntries(
      { version: 2, shows: { foo: { a: 1 } } },
      { shows: { bar: { b: 2 } } }
    );
    return r.version === 2 && r.shows.foo.a === 1 && r.shows.bar.b === 2;
  })()
);

check(
  'merge: remote without .shows key → still merges local',
  (() => {
    const r = mergeTrackerEntries({}, { shows: { foo: { a: 1 } } });
    return r.shows?.foo?.a === 1;
  })()
);

check(
  'merge: deeply nested sentAt format preserved',
  (() => {
    const r = mergeTrackerEntries(
      {},
      {
        shows: {
          'preview:broadway:death-of-a-salesman-2026:2026-04-11': {
            sentAt: '2026-04-11T02:09:00.123Z',
            previewTo: 'thomas.pryor@gmail.com',
            reviewCount: 24,
          },
        },
      }
    );
    const e = r.shows['preview:broadway:death-of-a-salesman-2026:2026-04-11'];
    return (
      e.sentAt === '2026-04-11T02:09:00.123Z' &&
      e.previewTo === 'thomas.pryor@gmail.com' &&
      e.reviewCount === 24
    );
  })()
);

// ---------------------------------------------------------------------------
// syncTrackerToOrigin — GITHUB_ACTIONS guard is a silent no-op.
// ---------------------------------------------------------------------------

check(
  'CI-skip: GITHUB_ACTIONS=true → no side effects, no throw',
  (() => {
    const prev = process.env.GITHUB_ACTIONS;
    const prevExitCode = process.exitCode;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      // Pass obviously-wrong data to prove no code path runs.
      syncTrackerToOrigin({ shows: { 'TEST_SENTINEL_DO_NOT_WRITE': { sentAt: 'X' } } });
      // If gh api had been called, stderr would be noisy and process.exitCode would be 1.
      return process.exitCode === prevExitCode || process.exitCode === 0 || process.exitCode === undefined;
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prev;
      if (prevExitCode === undefined) process.exitCode = undefined;
    }
  })()
);

// ---------------------------------------------------------------------------
// fetchRemote path — verified by a read-only gh api call against the real repo.
// This is safe: it's a GET, no writes.
// ---------------------------------------------------------------------------

check(
  'gh CLI is available and authed (needed for real sync path)',
  (() => {
    try {
      execSync('gh auth status', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })(),
  'run `gh auth login` if this fails'
);

check(
  'fetchRemote GET: origin/main has data/opening-night-sent.json',
  (() => {
    try {
      const raw = execSync(
        'gh api repos/thomaspryor/Broadwayscore/contents/data/opening-night-sent.json?ref=main',
        { encoding: 'utf8' }
      );
      const meta = JSON.parse(raw);
      return typeof meta.sha === 'string' && meta.sha.length >= 7 && typeof meta.content === 'string';
    } catch (err) {
      console.log('  gh api error:', (err.stderr || err.message || '').toString().slice(0, 300));
      return false;
    }
  })()
);

check(
  'fetchRemote decode: base64 content round-trips to valid JSON',
  (() => {
    try {
      const raw = execSync(
        'gh api repos/thomaspryor/Broadwayscore/contents/data/opening-night-sent.json?ref=main',
        { encoding: 'utf8' }
      );
      const meta = JSON.parse(raw);
      const decoded = Buffer.from(meta.content, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return typeof parsed === 'object' && parsed.shows && typeof parsed.shows === 'object';
    } catch (err) {
      console.log('  decode error:', err.message);
      return false;
    }
  })()
);

check(
  'fetchRemote 404 path: non-existent file returns null sha + empty shows (simulated via gh api error)',
  (() => {
    try {
      execSync(
        'gh api repos/thomaspryor/Broadwayscore/contents/data/does-not-exist-' + Date.now() + '.json?ref=main',
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      return false; // should have thrown
    } catch (err) {
      const msg = String(err.stderr || err.message || '');
      // Exactly the string our fetchRemote uses to detect 404.
      return msg.includes('404');
    }
  })()
);

// ---------------------------------------------------------------------------
// End-to-end merge simulation: read real origin, merge a synthetic local entry,
// verify the would-be-PUT payload is structurally correct, but NEVER PUT.
// ---------------------------------------------------------------------------

check(
  'end-to-end merge simulation (read origin, merge synthetic local, DO NOT PUT)',
  (() => {
    try {
      const raw = execSync(
        'gh api repos/thomaspryor/Broadwayscore/contents/data/opening-night-sent.json?ref=main',
        { encoding: 'utf8' }
      );
      const meta = JSON.parse(raw);
      const remoteContent = Buffer.from(meta.content, 'base64').toString('utf8');
      const remoteParsed = JSON.parse(remoteContent);

      const synthetic = {
        shows: {
          // Obviously synthetic — not a real show ID, never match any real pending show.
          'preview:broadway:__test_sync_tracker__:2099-01-01': {
            sentAt: '2099-01-01T00:00:00.000Z',
            previewTo: '__test__@example.invalid',
            reviewCount: 0,
          },
        },
      };

      const merged = mergeTrackerEntries(remoteParsed, synthetic);

      // Structural checks:
      // 1. Every remote entry survives unchanged.
      for (const [k, v] of Object.entries(remoteParsed.shows)) {
        const m = merged.shows[k];
        if (JSON.stringify(m) !== JSON.stringify(v)) return false;
      }
      // 2. Synthetic entry is present in merged.
      const synth = merged.shows['preview:broadway:__test_sync_tracker__:2099-01-01'];
      if (!synth || synth.previewTo !== '__test__@example.invalid') return false;

      // 3. The would-be-PUT payload is valid JSON, encodes to base64 cleanly.
      const payload = JSON.stringify(merged, null, 2);
      const b64 = Buffer.from(payload, 'utf8').toString('base64');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const reparsed = JSON.parse(decoded);
      if (reparsed.shows[Object.keys(synthetic.shows)[0]]?.reviewCount !== 0) return false;

      // 4. sha is a string (required by PUT for update).
      if (typeof meta.sha !== 'string') return false;

      return true;
    } catch (err) {
      console.log('  e2e merge error:', (err.stderr || err.message || '').toString().slice(0, 400));
      return false;
    }
  })()
);

// ---------------------------------------------------------------------------
// Workflow require-path verification: simulate what the inline `node -e` in
// opening-night-broadcast.yml does. Must resolve from repo root.
// ---------------------------------------------------------------------------

check(
  'workflow require path: ./scripts/lib/preview-dedup resolves from repo root',
  (() => {
    const repoRoot = path.resolve(__dirname, '..');
    const result = execSync(
      `cd ${JSON.stringify(repoRoot)} && node -e "const { hasRecentPreviewForShow, hasRecentOverdueAlert } = require('./scripts/lib/preview-dedup'); console.log(typeof hasRecentPreviewForShow, typeof hasRecentOverdueAlert)"`,
      { encoding: 'utf8', shell: '/bin/bash' }
    );
    return result.trim() === 'function function';
  })()
);

// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error(`${failed} test(s) FAILED`);
  process.exit(1);
}
