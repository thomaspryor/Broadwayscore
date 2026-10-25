/**
 * push-via-git-api-rest — GitHub REST Git Data API primitives for
 * push-via-git-api.sh's opt-in REST ref-update path (BRO-2233/BRO-2951
 * Phase 2). Sibling to gh-api-client.js / github-ref-update-classify.js /
 * github-rest-write-probe.js — NOT modeled on push-via-git-api-merge.js
 * (a zero-HTTP merge CLI; the first plan-review round flagged citing it as
 * the wrong precedent for an HTTP+auth+retry-classification module).
 *
 * WHY THIS EXISTS: push-via-git-api.sh's ref update goes through
 * `git push` over receive-pack, which times out at a 90s cap on every
 * attempt under this repo's main-branch contention (confirmed live,
 * data-health-check.yml run 34690587066) — while a diagnostic
 * POST /git/blobs from the SAME actor in the SAME job completes in
 * ~400ms (github-rest-write-probe.js). This module builds the SAME commit
 * push-via-git-api.sh's git-plumbing path builds, but lands it via
 * REST calls (blob -> tree -> commit -> ref PATCH) instead of a git-push
 * transport, so the compare-and-swap ref update never touches
 * receive-pack.
 *
 * DESIGN CONSTRAINTS FROM PLAN-REVIEW (both rounds — do not regress these):
 *   - Every exported function takes an injectable `fetchImpl` (defaults to
 *     gh-api-client's fetchGitHubJSON) so tests import these functions
 *     directly and mock at the HTTP boundary, in-process — no subprocess,
 *     no fake HTTP server, matching how github-ref-update-classify.test.mjs
 *     already tests a pure function.
 *   - `attemptRestPush` performs ONE full ref-update attempt (tree create
 *     -> commit create -> ref PATCH) and returns exactly ONE classified
 *     outcome (success/race/throttled/timeout/fatal, via the EXISTING
 *     github-ref-update-classify.js). It NEVER sleeps or retries
 *     internally — push-via-git-api.sh's bash loop is the sole retry/
 *     backoff authority, mapping this one outcome onto its existing
 *     FAIL_TIMEOUT/FAIL_RACE/FAIL_OTHER counters exactly as it does today
 *     for a `git push` stderr-grep classification.
 *   - `createBlob` is separate and reusable for BOTH the one-time
 *     pre-loop upload of non-merge-path blobs (content is invocation-
 *     invariant — see push-via-git-api.sh's own CHANGED_STATUS comment)
 *     and the per-attempt upload of apiFallbackMerge-path blobs (content
 *     legitimately differs per attempt, merged against the current tip
 *     each time).
 *   - A ref-update success is verified by checking the PATCH response's
 *     `object.sha` matches the commit we asked for — an ambiguous "no
 *     error, but nothing confirms it landed" response is NOT success
 *     (user-impact review, round 2: an unverified success here would let
 *     the daily health-check report "healthy" while main didn't actually
 *     advance — worse than today's honest crash).
 */

'use strict';

const { fetchGitHubJSON } = require('./gh-api-client.js');
const { classifyRefUpdate } = require('./github-ref-update-classify.js');

const GITHUB_API = 'https://api.github.com';

/** Git tree entry mode -> type. 160000 (gitlink/submodule) is rejected —
 * this script has no way to "create" a submodule reference via the blob
 * path, and this repo has zero submodules today (an assertion, not a
 * silent mishandling). */
const MODE_TYPE = {
  '100644': 'blob',
  '100755': 'blob',
  '120000': 'blob',
  '040000': 'tree',
};

/**
 * Classify a thrown fetchGitHubJSON error (or a plain Error) the same way
 * push-via-git-api.sh's git-push path classifies a rejected/timed-out
 * push — via the shared classifier, so both transports report through one
 * taxonomy.
 */
function classifyThrown(err) {
  return classifyRefUpdate({
    status: err && err.status,
    body: err && err.body,
    errorMessage: err && err.message,
    retryAfter: err && err.retryAfter,
  });
}

/**
 * Create one blob via the REST Git Data API. Returns the blob sha (should
 * match git's own content-addressed sha for the same bytes — GitHub hashes
 * blobs identically to git).
 *
 * @param {object} opts
 * @param {string} opts.repoSlug - "owner/repo"
 * @param {string} opts.content - base64-encoded content
 * @param {string} [opts.token]
 * @param {function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: true, sha: string}|{ok: false, outcome: string, reason: string}>}
 */
async function createBlob({ repoSlug, content, token, fetchImpl = fetchGitHubJSON, timeoutMs = 20000 }) {
  try {
    const res = await fetchImpl(`${GITHUB_API}/repos/${repoSlug}/git/blobs`, {
      method: 'POST',
      token,
      caller: 'push-via-git-api-rest.js',
      body: JSON.stringify({ content, encoding: 'base64' }),
      timeoutMs,
    });
    if (!res || typeof res.sha !== 'string' || !res.sha) {
      return { ok: false, outcome: 'fatal', reason: 'blob create returned no sha (malformed 2xx response)' };
    }
    return { ok: true, sha: res.sha };
  } catch (err) {
    const { outcome, reason } = classifyThrown(err);
    return { ok: false, outcome, reason: `blob create failed: ${reason}` };
  }
}

/**
 * Build a REST tree entry for one changed path. `mode` comes straight
 * from the caller's local `git ls-tree` read (matches today's
 * git-plumbing path — modes are never re-derived or guessed here).
 * A delete is represented by omitting `sha` (GitHub removes the path from
 * the resulting tree when `sha` is absent for an existing base_tree entry).
 *
 * @param {object} entry
 * @param {string} entry.path
 * @param {string} [entry.mode] - required for add/modify, omitted for delete
 * @param {string} [entry.sha] - blob sha; omitted (or null) means delete
 * @returns {{ok: true, entry: object}|{ok: false, outcome: string, reason: string}}
 */
function buildTreeEntry({ path, mode, sha }) {
  if (sha === undefined || sha === null) {
    return { ok: true, entry: { path, mode: mode || '100644', type: 'blob', sha: null } };
  }
  if (mode === '160000') {
    return {
      ok: false,
      outcome: 'fatal',
      reason: `path '${path}' is a gitlink (submodule, mode 160000) — the REST push path has no way to create a submodule reference and this repo is expected to have none; refusing rather than silently mishandling it`,
    };
  }
  const type = MODE_TYPE[mode] || 'blob';
  return { ok: true, entry: { path, mode: mode || '100644', type, sha } };
}

/**
 * Perform ONE full REST ref-update attempt: create tree (base_tree +
 * partial entries — GitHub merges only the touched paths onto the
 * existing tree, no need to re-upload unchanged blobs), create commit,
 * PATCH the ref with force:false (the compare-and-swap: rejected with 422
 * if the branch moved since baseTreeSha/parentSha were read).
 *
 * NEVER sleeps or retries — returns one classified outcome. The caller
 * (push-via-git-api.sh's bash loop) owns all retry/backoff decisions,
 * exactly as it already does for a rejected/timed-out `git push`.
 *
 * @param {object} opts
 * @param {string} opts.repoSlug - "owner/repo"
 * @param {string} opts.branch
 * @param {string} opts.parentSha - current tip commit sha (re-resolve fresh every attempt)
 * @param {string} opts.baseTreeSha - current tip's tree sha (re-resolve fresh every attempt)
 * @param {Array<{path:string, mode?:string, sha?:string|null}>} opts.entries
 * @param {string} opts.message
 * @param {string} [opts.expectedTreeSha] - the tree sha push-via-git-api.sh
 *   already built LOCALLY (free — pure git plumbing, no network) from the
 *   exact same entries overlaid onto the exact same base. If GitHub's
 *   REST-created tree sha disagrees, that is a live, per-push assertion
 *   that GitHub's base_tree+partial-entries merge produced a
 *   byte-different result than git's own read-tree+write-tree for
 *   equivalent input — an assumption both plan-review rounds flagged as
 *   asserted-but-never-verified. Checked EVERY call when provided, not
 *   just in a one-off test, so a violation fails loudly in production
 *   instead of silently trusting object-hash parity. Omit only when the
 *   caller has no independent local tree to compare against.
 * @param {string} [opts.token]
 * @param {function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{outcome:'success', sha:string}|{outcome:'race'|'throttled'|'timeout'|'fatal', reason:string, retryAfter?:string|number}>}
 */
async function attemptRestPush({
  repoSlug,
  branch,
  parentSha,
  baseTreeSha,
  entries,
  message,
  expectedTreeSha,
  token,
  fetchImpl = fetchGitHubJSON,
  timeoutMs = 20000,
}) {
  const treeEntries = [];
  for (const raw of entries) {
    const built = buildTreeEntry(raw);
    if (!built.ok) return { outcome: built.outcome, reason: built.reason };
    treeEntries.push(built.entry);
  }

  let treeSha;
  try {
    const treeRes = await fetchImpl(`${GITHUB_API}/repos/${repoSlug}/git/trees`, {
      method: 'POST',
      token,
      caller: 'push-via-git-api-rest.js',
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      timeoutMs,
    });
    if (!treeRes || typeof treeRes.sha !== 'string' || !treeRes.sha) {
      return { outcome: 'fatal', reason: 'tree create returned no sha (malformed 2xx response)' };
    }
    treeSha = treeRes.sha;
  } catch (err) {
    const { outcome, reason } = classifyThrown(err);
    return { outcome, reason: `tree create failed: ${reason}` };
  }

  if (expectedTreeSha && treeSha !== expectedTreeSha) {
    // ship-check finding: the original form of this check exempted
    // treeSha === baseTreeSha from the mismatch guard unconditionally — but
    // if the CALLER's own locally-built expectedTreeSha says content DID
    // change (expectedTreeSha !== baseTreeSha) while GitHub's REST tree
    // create came back UNCHANGED (treeSha === baseTreeSha), that is not a
    // legitimate no-op, it is GitHub silently failing to apply our entries
    // (or a client-side entries-construction bug) — reporting it as
    // "already applied" success would silently drop the intended change.
    // Only a treeSha that agrees with what WE expected is trustworthy;
    // "matches baseTreeSha" is no longer treated as an automatic pass.
    return {
      outcome: 'fatal',
      reason: `GitHub's REST tree create returned ${treeSha}, which disagrees with our locally-built tree (${expectedTreeSha}) — refusing to commit on top of an unverified tree rather than trusting object-hash parity blindly`,
    };
  }

  // Our overlay applied to the current tip yields the SAME tree — either a
  // prior ambiguous attempt already landed this content, a sibling writer
  // pushed byte-identical content, or our diff only deletes paths already
  // absent from the tip. Mirrors push-via-git-api.sh's own no-op-commit
  // short-circuit (git-plumbing path, comparing NEW_TREE to
  // CURRENT_TIP_TREE) — state the observed fact, don't infer which case it
  // was. The caller already checks this locally BEFORE calling here for
  // the common (non-throttled) case; this catches it even when the local
  // check couldn't run yet (fresh module, first attempt). Only reachable
  // now when expectedTreeSha is absent OR itself equals baseTreeSha — the
  // guard above already rejected any case where our own expectation
  // disagreed with an unchanged remote tree.
  if (treeSha === baseTreeSha) {
    return { outcome: 'success', sha: parentSha, alreadyApplied: true };
  }

  let commitSha;
  try {
    const commitRes = await fetchImpl(`${GITHUB_API}/repos/${repoSlug}/git/commits`, {
      method: 'POST',
      token,
      caller: 'push-via-git-api-rest.js',
      body: JSON.stringify({ tree: treeSha, parents: [parentSha], message }),
      timeoutMs,
    });
    if (!commitRes || typeof commitRes.sha !== 'string' || !commitRes.sha) {
      return { outcome: 'fatal', reason: 'commit create returned no sha (malformed 2xx response)' };
    }
    commitSha = commitRes.sha;
  } catch (err) {
    const { outcome, reason } = classifyThrown(err);
    return { outcome, reason: `commit create failed: ${reason}` };
  }

  try {
    const refRes = await fetchImpl(
      `${GITHUB_API}/repos/${repoSlug}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'PATCH',
        token,
        caller: 'push-via-git-api-rest.js',
        body: JSON.stringify({ sha: commitSha, force: false }),
        timeoutMs,
      },
    );
    // Verify the ref actually points at OUR commit now — a response with
    // no usable object.sha, or one that disagrees with what we asked for,
    // is not proof the ref moved. Treat it as fatal rather than silently
    // reporting success for an update we never confirmed landed (the
    // "worse than an honest crash" risk the user-impact review flagged).
    if (!refRes || !refRes.object || refRes.object.sha !== commitSha) {
      return {
        outcome: 'fatal',
        reason: `ref update response did not confirm landing (expected object.sha=${commitSha}, got ${refRes && refRes.object && refRes.object.sha})`,
      };
    }
    return { outcome: 'success', sha: commitSha };
  } catch (err) {
    const { outcome, reason, retryAfter } = classifyThrown(err);
    return { outcome, reason: `ref update failed: ${reason}`, retryAfter };
  }
}

module.exports = { createBlob, buildTreeEntry, attemptRestPush };

/**
 * Thin CLI wrapper — all real logic lives in the exported functions above,
 * which is what tests import directly (no subprocess, no fake HTTP
 * server needed for the primary test tier). This wrapper exists only so
 * push-via-git-api.sh (bash) can invoke the logic as a subprocess.
 *
 * Request/response cross the process boundary as JSON files, not argv —
 * argv has a size ceiling this repo's tree-entry lists (hundreds of paths
 * on a heavy diff) can exceed, and per the file's own credential-safety
 * rule the token must NEVER appear in argv (visible in `ps`) or a log
 * line. The token is read from GH_TOKEN/GITHUB_TOKEN env only, matching
 * how gh-api-client.js already resolves it and how push-via-git-api.sh's
 * existing _rest_write_probe call already passes it (`GH_TOKEN="$token"
 * node ...`), never as a CLI argument.
 *
 * Usage:
 *   node push-via-git-api-rest.js create-blob <content-file-base64> <repo-slug>
 *   node push-via-git-api-rest.js attempt-push <request.json>
 * Prints exactly one JSON line to stdout. Always exits 0 — the caller
 * (bash) reads the JSON body to decide outcome, matching this repo's
 * "a diagnostic/wrapper must never crash the caller with its own
 * exception" convention (see github-rest-write-probe.js).
 */
if (require.main === module) {
  const fs = require('fs');
  (async () => {
    const [, , mode, ...rest] = process.argv;
    try {
      if (mode === 'create-blob') {
        const [contentFile, repoSlug] = rest;
        const content = fs.readFileSync(contentFile, 'utf8');
        const result = await createBlob({ repoSlug, content });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      if (mode === 'attempt-push') {
        const [requestFile] = rest;
        const req = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        const result = await attemptRestPush(req);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify({ outcome: 'fatal', reason: `unknown mode '${mode}' — expected create-blob or attempt-push` })}\n`);
    } catch (err) {
      // A crash in the wrapper itself must still report SOMETHING parseable
      // rather than leaving bash to interpret a stack trace as JSON.
      process.stdout.write(`${JSON.stringify({ outcome: 'fatal', reason: `CLI wrapper crashed: ${err && err.message}` })}\n`);
    }
  })();
}
