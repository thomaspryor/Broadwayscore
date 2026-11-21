#!/usr/bin/env node
/**
 * github-rest-write-probe — time ONE GitHub REST *write* against this repo
 * and print the result as a single JSON line. Diagnostic only: it never
 * throws, never exits non-zero, and never mutates a ref.
 *
 * WHY THIS EXISTS (BRO-2951)
 * =========================
 * push-via-git-api.sh's ref update currently exits through `git push`, and
 * in production every attempt burns the full 90s GIT_NET_TIMEOUT_SEC cap
 * (6/6 on run 34222531340) with ZERO lost ref races. Two hypotheses explain
 * that identically, and they demand OPPOSITE fixes:
 *
 *   H1  Ref-lock contention on refs/heads/main specifically. main takes
 *       841-1210 commits/day, so a contending push blocks on the
 *       server-side ref lock and returns nothing until it wins; our cap
 *       SIGTERMs it first, which is why the failure is always a timeout and
 *       never a rejection. => Fix: stop pushing to main over receive-pack;
 *       do the ref update over REST instead.
 *
 *   H2  Actor-level throttling of receive-pack traffic. push-via-git-api.sh
 *       itself hypothesizes this in its own header: "GitHub-side
 *       serialization/throttling of receive-pack traffic under sustained
 *       concurrent push volume FROM THE SAME ACTOR". => Fix: reduce the
 *       write volume (BRO-2983) or move the state off main entirely. A REST
 *       ref update would help here too, but a git-push-based workaround
 *       (e.g. pushing objects to a scratch ref first) would NOT — it is the
 *       same actor over the same receive-pack.
 *
 * The measurements taken while diagnosing this card ran from the OWNER's
 * machine under the OWNER's credentials, and showed a 128 KB payload
 * reaching a non-main ref in ~1.8s. That isolates the ref but NOT the
 * actor, so it cannot separate H1 from H2 — the failing pushes are
 * github-actions[bot]. This probe closes exactly that gap: it runs inside
 * the failing job, as the failing actor, in the same seconds as the
 * timeout, and asks the one question that discriminates:
 *
 *     Is a REST write from this actor, right now, fast?
 *
 *   fast REST write  -> the REST transport is NOT throttled for this actor,
 *                       so the cost is specific to the receive-pack ref
 *                       update (H1). A REST ref-update path fixes it.
 *   slow REST write  -> the throttle covers this actor's writes generally
 *                       (H2). A REST ref-update path would NOT fix it, and
 *                       the answer is BRO-2983 / moving off main.
 *
 * WHY A BLOB CREATE, AND NOT A REF READ OR A SCRATCH-REF PUSH
 * ==========================================================
 * - A GET is the wrong probe: reads and writes sit in different rate-limit
 *   classes, so a fast GET would prove nothing about PATCH /git/refs.
 *   POST /git/blobs is a content-mutating request, the SAME class as the
 *   ref update we are considering.
 * - A scratch-ref push is the wrong probe twice over: it goes over
 *   receive-pack (so under H2 it is throttled identically and tells us
 *   nothing), and it creates a server-side ref. Plan-review's pre-mortem
 *   built its primary failure scenario on exactly that: leaked
 *   refs/push-api-tmp/* accumulate, are advertised on every fetch, are
 *   copied into the GitLab mirrors and R2 cold backups, and pin objects
 *   against GC in an already 3.8 GB .git — and "best-effort cleanup" is
 *   skipped on every cancelled job, which this repo produces constantly.
 *   A blob create dodges all of it: an unreferenced blob is reachable from
 *   nothing, GitHub prunes it on its own schedule, and no ref ever exists.
 *
 * Usage:  node github-rest-write-probe.js <owner/repo>
 * Env:    GH_TOKEN or GITHUB_TOKEN (the caller resolves and passes this)
 * Output: exactly one JSON line on stdout. Always exit 0.
 */

'use strict';

const { fetchGitHubJSON } = require('./gh-api-client.js');
const { classifyRefUpdate } = require('./github-ref-update-classify.js');

/** Emit one JSON line and leave. Never throws. */
function emit(obj) {
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  } catch {
    /* a diagnostic that cannot print is still not worth failing a push over */
  }
}

async function main() {
  const repo = process.argv[2];
  // Accept only owner/repo — this value is interpolated into a URL path.
  if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    emit({ ok: false, skipped: true, reason: 'missing or malformed <owner/repo> argument' });
    return;
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    emit({ ok: false, skipped: true, reason: 'no GH_TOKEN/GITHUB_TOKEN in env' });
    return;
  }

  // Content is unique per run so the API cannot dedupe this to an existing
  // blob and hand back a cached-fast answer that misrepresents write cost.
  const content = `bro-2951 rest write probe ${new Date().toISOString()} ${process.pid} ${Math.random()}\n`;
  const url = `https://api.github.com/repos/${repo}/git/blobs`;

  const started = Date.now();
  try {
    const res = await fetchGitHubJSON(url, {
      method: 'POST',
      caller: 'github-rest-write-probe.js',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
      // Deliberately longer than gh-api-client's 15s default: the entire
      // point is to observe HOW slow a throttled write is. Capping at 15s
      // would censor the distribution we are trying to measure. Still far
      // below the 90s git cap, so the probe can never dominate an attempt.
      timeoutMs: 30000,
    });
    emit({
      ok: true,
      ms: Date.now() - started,
      status: 201,
      blobSha: res && res.sha ? res.sha : null,
      outcome: 'success',
    });
  } catch (err) {
    const ms = Date.now() - started;
    // Reuse the SAME classifier the real ref-update path will use, so the
    // probe's verdict and production's verdict can never disagree about
    // what a given status means.
    const { outcome, reason } = classifyRefUpdate({
      status: err && err.status,
      body: err && err.body,
      errorMessage: err && err.message,
      retryAfter: err && err.retryAfter,
    });
    emit({ ok: false, ms, status: (err && err.status) || null, outcome, reason });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    // Unreachable in principle; a diagnostic must still never fail a push.
    emit({ ok: false, skipped: true, reason: `probe crashed: ${err && err.message}` });
    process.exit(0);
  },
);
