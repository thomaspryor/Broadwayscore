// Array-of-posts merge for data/social-post-history.json.
//
// Why this exists:
//   social-post.yml uses a PER-RUN concurrency group (`social-post-${{ github.run_id }}`),
//   not a static one — update-show-status.yml dispatches it once per newly-opened
//   show in a tight loop, and a static group risks GitHub's 1-pending-queue limit
//   silently cancelling a queued dispatch (see update-mezzanine.yml's "Cats
//   2026-04-07 poller postmortem" comment). A per-run group means concurrent runs
//   for different shows are expected and normal, so the underlying push race on
//   this file needs a real merge, not serialization — same reasoning as
//   diary-shows.json (merge-diary-shows.js). Without this, push-with-retry.sh's
//   generic "accept remote" fallback would silently drop one run's new post
//   entry, defeating the duplicate-post check in generate-social-post.js
//   (wasPostedRecently reads this history) on the next run. Card 3a5637c5-416f-812a.
//
// Used by:
//   - scripts/lib/merge-commercial-conflict.js (push-with-retry.sh conflict path)
//   - tests/unit/merge-social-post-history.test.mjs
//
// Merge rules:
//   * shape: { _meta: { description, lastUpdated }, posts: [ { date, type, showId,
//     tweetId, tweetUrl, text }, ... ] }
//   * Natural key: tweetId, falling back to `${date}|${type}|${showId}` when
//     tweetId is absent (defensive — generate-social-post.js only appends on a
//     successful, non-dry-run post, which normally has a tweetId).
//   * Union of keys is kept: entries present on only one side survive.
//   * On key collision: keep OURS (matches the "-X ours" rebase strategy already
//     applied upstream). Entries are only ever appended, never mutated in place,
//     so a shared key is the same post recorded by both sides — no data to lose.
//   * Order: ours first (original order preserved), then remote-only entries
//     appended in remote order — deterministic, minimal diff.
//   * _meta.lastUpdated: the newer of the two ISO timestamps.

function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.tweetId) return `tw:${entry.tweetId}`;
  if (entry.date || entry.type || entry.showId) {
    return `fallback:${entry.date}|${entry.type}|${entry.showId}`;
  }
  return null;
}

function newerIso(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

function mergeSocialPostHistory(ours, remote) {
  ours = ours && typeof ours === 'object' ? ours : { posts: [] };
  remote = remote && typeof remote === 'object' ? remote : { posts: [] };
  const oursPosts = Array.isArray(ours.posts) ? ours.posts : [];
  const remotePosts = Array.isArray(remote.posts) ? remote.posts : [];

  const oursKeys = new Set();
  for (const e of oursPosts) {
    const k = keyOf(e);
    if (k) oursKeys.add(k);
  }

  const mergedPosts = [...oursPosts];
  let added = 0;
  let kept = 0;
  for (const e of remotePosts) {
    const k = keyOf(e);
    if (k && oursKeys.has(k)) {
      kept++;
      continue;
    }
    mergedPosts.push(e);
    if (k) oursKeys.add(k);
    added++;
  }

  const merged = { ...ours, posts: mergedPosts };
  merged._meta = { ...(ours._meta || {}), ...(remote._meta || {}) };
  const lu = newerIso(ours._meta && ours._meta.lastUpdated, remote._meta && remote._meta.lastUpdated);
  if (lu) merged._meta.lastUpdated = lu;

  return {
    merged,
    stats: { added, kept, totalPosts: mergedPosts.length },
  };
}

module.exports = { mergeSocialPostHistory, keyOf };
