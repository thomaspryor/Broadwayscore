// Unit tests for push-via-git-api-rest.js (BRO-2233/BRO-2951 Phase 2).
//
// Per CLAUDE.md §15 these require() the REAL functions — no logic copied
// into this file. Every test injects a fake `fetchImpl` so nothing here
// touches the network; the module's own design (both plan-review rounds)
// requires exactly this in-process mockability instead of a subprocess or
// fake HTTP server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBlob, buildTreeEntry, attemptRestPush } = require('./push-via-git-api-rest.js');

const REPO = 'thomaspryor/broadway-scorecard-data';

function fakeFetch(responses) {
  let call = 0;
  return async (url, opts) => {
    const r = responses[call];
    call += 1;
    if (!r) throw new Error(`fakeFetch called more times than expected (call ${call})`);
    if (r.throw) {
      const err = new Error(r.throw.message || 'fake error');
      if (r.throw.status !== undefined) err.status = r.throw.status;
      if (r.throw.body !== undefined) err.body = r.throw.body;
      if (r.throw.retryAfter !== undefined) err.retryAfter = r.throw.retryAfter;
      throw err;
    }
    return r.resolve;
  };
}

// --- buildTreeEntry --------------------------------------------------------

test('buildTreeEntry: add/modify preserves mode and maps to blob', () => {
  assert.deepEqual(buildTreeEntry({ path: 'a.json', mode: '100644', sha: 'abc' }), {
    ok: true,
    entry: { path: 'a.json', mode: '100644', type: 'blob', sha: 'abc' },
  });
  assert.deepEqual(buildTreeEntry({ path: 'run.sh', mode: '100755', sha: 'def' }), {
    ok: true,
    entry: { path: 'run.sh', mode: '100755', type: 'blob', sha: 'def' },
  });
});

test('buildTreeEntry: delete omits sha and is represented as sha:null', () => {
  const r = buildTreeEntry({ path: 'gone.json', mode: '100644' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.sha, null);
});

test('buildTreeEntry: gitlink (160000) is rejected, not silently mishandled', () => {
  const r = buildTreeEntry({ path: 'vendor/sub', mode: '160000', sha: 'zzz' });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fatal');
  assert.match(r.reason, /gitlink/i);
});

// --- createBlob -------------------------------------------------------------

test('createBlob: success returns the sha', async () => {
  const fetchImpl = fakeFetch([{ resolve: { sha: 'blobsha123' } }]);
  const r = await createBlob({ repoSlug: REPO, content: 'aGVsbG8=', fetchImpl });
  assert.deepEqual(r, { ok: true, sha: 'blobsha123' });
});

test('createBlob: malformed 2xx (no sha) is fatal, not a silent undefined', async () => {
  const fetchImpl = fakeFetch([{ resolve: {} }]);
  const r = await createBlob({ repoSlug: REPO, content: 'aGVsbG8=', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fatal');
});

test('createBlob: a thrown 403 secondary-limit error classifies as throttled', async () => {
  const fetchImpl = fakeFetch([
    { throw: { status: 403, body: 'secondary rate limit exceeded' } },
  ]);
  const r = await createBlob({ repoSlug: REPO, content: 'aGVsbG8=', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'throttled');
});

// --- attemptRestPush ---------------------------------------------------------

const BASE_ARGS = {
  repoSlug: REPO,
  branch: 'main',
  parentSha: 'parent111',
  baseTreeSha: 'basetree111',
  entries: [{ path: 'data/audit/health-digest-snapshot.json', mode: '100644', sha: 'newblobsha' }],
  message: 'data: Update digest snapshot [skip ci]',
};

test('attemptRestPush: full success path verifies the landed ref sha', async () => {
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'newtree111' } }, // tree create
    { resolve: { sha: 'newcommit111' } }, // commit create
    { resolve: { object: { sha: 'newcommit111' } } }, // ref patch
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, expectedTreeSha: 'newtree111', fetchImpl });
  assert.deepEqual(r, { outcome: 'success', sha: 'newcommit111' });
});

test('attemptRestPush: tree sha disagreeing with the locally-built tree is fatal, not trusted blindly', async () => {
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'SURPRISE_DIFFERENT_TREE' } }, // tree create disagrees with expectedTreeSha
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, expectedTreeSha: 'newtree111', fetchImpl });
  assert.equal(r.outcome, 'fatal');
  assert.match(r.reason, /unverified tree/i);
});

test('attemptRestPush: GitHub returning an UNCHANGED tree when we expected a real change is fatal, not a silent no-op (ship-check finding)', async () => {
  // We locally computed a DIFFERENT tree (expectedTreeSha) than baseTreeSha,
  // meaning our diff genuinely changes something — but GitHub's REST tree
  // create came back identical to baseTreeSha. That is GitHub silently
  // failing to apply our entries (or a client-side bug), NOT a legitimate
  // "already applied" no-op. Must never be reported as success.
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'basetree111' } }, // == baseTreeSha, but we expected 'newtree111'
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, expectedTreeSha: 'newtree111', fetchImpl });
  assert.equal(r.outcome, 'fatal');
  assert.match(r.reason, /disagrees with our locally-built tree/i);
});

test('attemptRestPush: tree matching baseTreeSha short-circuits as already-applied (no-op)', async () => {
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'basetree111' } }, // tree create — identical to base, i.e. our overlay changed nothing
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, fetchImpl });
  assert.equal(r.outcome, 'success');
  assert.equal(r.alreadyApplied, true);
});

test('attemptRestPush: 422 non-fast-forward on the ref PATCH is a race, not fatal', async () => {
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'newtree111' } },
    { resolve: { sha: 'newcommit111' } },
    { throw: { status: 422, body: JSON.stringify({ message: 'Update is not a fast forward' }) } },
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, expectedTreeSha: 'newtree111', fetchImpl });
  assert.equal(r.outcome, 'race');
});

test('attemptRestPush: 429 on the ref PATCH is throttled, distinct from a timeout', async () => {
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'newtree111' } },
    { resolve: { sha: 'newcommit111' } },
    { throw: { status: 429 } },
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, expectedTreeSha: 'newtree111', fetchImpl });
  assert.equal(r.outcome, 'throttled');
});

test('attemptRestPush: a transport timeout on any leg classifies as timeout', async () => {
  const fetchImpl = fakeFetch([
    { throw: { message: 'GitHub API POST https://api.github.com/... -> timed out after 20000ms' } },
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, fetchImpl });
  assert.equal(r.outcome, 'timeout');
});

test('attemptRestPush: ref PATCH response that does not confirm the landed sha is fatal, never a silent success', async () => {
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'newtree111' } },
    { resolve: { sha: 'newcommit111' } },
    { resolve: { object: { sha: 'SOME_OTHER_SHA' } } }, // ambiguous/wrong — must not be trusted as success
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, expectedTreeSha: 'newtree111', fetchImpl });
  assert.equal(r.outcome, 'fatal');
  assert.match(r.reason, /did not confirm landing/i);
});

test('attemptRestPush: malformed commit-create response (no sha) is fatal', async () => {
  const fetchImpl = fakeFetch([
    { resolve: { sha: 'newtree111' } },
    { resolve: {} },
  ]);
  const r = await attemptRestPush({ ...BASE_ARGS, expectedTreeSha: 'newtree111', fetchImpl });
  assert.equal(r.outcome, 'fatal');
});

test('attemptRestPush: a gitlink entry aborts before any network call', async () => {
  const fetchImpl = fakeFetch([]); // must never be called
  const r = await attemptRestPush({
    ...BASE_ARGS,
    entries: [{ path: 'vendor/sub', mode: '160000', sha: 'zzz' }],
    fetchImpl,
  });
  assert.equal(r.outcome, 'fatal');
  assert.match(r.reason, /gitlink/i);
});
