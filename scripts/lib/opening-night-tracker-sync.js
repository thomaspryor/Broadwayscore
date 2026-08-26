#!/usr/bin/env node
/**
 * opening-night-tracker-sync.js
 *
 * Shared sync helper for data/opening-night-sent.json. Extracted from
 * send-opening-night-broadcast.js (task #1853, follow-up to BRO-60) so every
 * script that writes local corrections to the tracker — not just the
 * broadcast sender — can push them to origin/main instead of leaving them
 * invisible to CI until the next scheduled commit.
 *
 * As of task #1759, opening-night-sent.json is untracked+ignored in the
 * PUBLIC repo (like every other CORE_FILES entry) — the private data repo
 * (synced via checkout-core-data/push-core-data) is the only place a
 * `gh api contents` read/write can reach it. Files sit at that repo's ROOT
 * (checkout-core-data does `cp -f /tmp/core-data-checkout/*.json data/`), so
 * no 'data/' prefix here.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { recordRecencyMs } = require('./tracker-record-recency');

const SYNC_REPO = 'thomaspryor/broadway-scorecard-data';
const SYNC_REMOTE_PATH = 'opening-night-sent.json';

/**
 * Pure merge helper — exposed for unit tests. Remote entries are preserved;
 * on a key conflict, local wins by default (the caller just wrote it from a
 * fresh observation) UNLESS remote's recorded content is strictly newer per
 * recordRecencyMs (task #1914) — the case where a different writer already
 * pushed a newer state for this key (e.g. this caller observed 'queued'
 * before a concurrent send flipped it to 'sent' and landed first).
 */
function mergeTrackerEntries(remoteParsed, localParsed) {
  const remoteShows = (remoteParsed && remoteParsed.shows) || {};
  const localShows = (localParsed && localParsed.shows) || {};
  const merged = { ...(remoteParsed || {}) };
  merged.shows = { ...remoteShows };
  for (const [k, v] of Object.entries(localShows)) {
    const remoteRec = remoteShows[k];
    if (remoteRec && recordRecencyMs(remoteRec) > recordRecencyMs(v)) {
      continue; // remote already has a newer observation for this key — keep it.
    }
    merged.shows[k] = v;
  }
  return merged;
}

/**
 * Push opening-night-sent.json to the private data repo's main branch (SYNC_REPO)
 * via the GitHub Contents API.
 *
 * Why: when a script is invoked from a local shell (manual CLI preview, or a
 * manual `--show=X` reconcile correction), it writes the tracker to disk but
 * a running-in-CI workflow reads the private repo (via checkout-core-data).
 * Without a sync step, the workflow can't see the local write and can
 * double-send or re-requeue on its next run. This is what caused the
 * 2026-04-11 duplicate-preview incident (CLI sent at 02:09 UTC but never
 * committed; workflow fired at 12:21 UTC reading stale state).
 *
 * Strategy: fetch the current file from origin/main, parse it, merge in our in-memory
 * entries (caller's write wins on conflict unless remote is recency-newer — see
 * mergeTrackerEntries), PUT back with the fetched sha. If the sha is stale due to
 * concurrent write, retry once with a fresh fetch.
 *
 * Skipped when:
 *   - Running in GitHub Actions (the workflow commits separately).
 *   - opts.dryRun is true (never write to origin).
 *   - `gh` CLI is missing or the user isn't authenticated (logged loudly).
 *
 * Sets process.exitCode = 1 on failure after one retry, so the caller's process
 * exits non-zero and the user knows dedup is at risk.
 */
function syncTrackerToOrigin(localData, opts = {}) {
  const { dryRun = false } = opts;
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Workflow's dedicated commit step handles this path.
    return;
  }
  if (dryRun) return;

  // Check gh is available and authed.
  try {
    execSync('gh auth status', { stdio: 'ignore' });
  } catch {
    console.error('\nWARNING: `gh` CLI missing or not authenticated — cannot sync opening-night-sent.json to origin.');
    console.error('         The next workflow run will not see this local write. Run `gh auth login`, then manually');
    console.error('         push data/opening-night-sent.json to main, or live with a possible duplicate.');
    process.exitCode = 1;
    return;
  }

  const REPO = SYNC_REPO;
  const REMOTE_PATH = SYNC_REMOTE_PATH;
  const BRANCH = 'main';

  const fetchRemote = () => {
    // gh api errors (incl. 404) throw; treat 404 as "file doesn't exist yet".
    try {
      const raw = execSync(
        `gh api repos/${REPO}/contents/${REMOTE_PATH}?ref=${BRANCH}`,
        { encoding: 'utf8' }
      );
      const meta = JSON.parse(raw);
      const content = Buffer.from(meta.content, 'base64').toString('utf8');
      let parsed = {};
      try { parsed = JSON.parse(content); } catch { parsed = {}; }
      return { sha: meta.sha, parsed };
    } catch (err) {
      if (String(err.stderr || err.message || '').includes('404')) {
        return { sha: null, parsed: { shows: {} } };
      }
      throw err;
    }
  };

  const putRemote = (sha, parsed) => {
    const content = Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8').toString('base64');
    const payload = {
      message: 'data: Sync opening-night-sent tracking from CLI',
      content,
      branch: BRANCH,
    };
    if (sha) payload.sha = sha;
    // Write payload via stdin so the filename doesn't leak into shell expansion.
    const tmpPath = path.join(require('os').tmpdir(), `ons-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    try {
      execSync(
        `gh api --method PUT repos/${REPO}/contents/${REMOTE_PATH} --input ${JSON.stringify(tmpPath)}`,
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  };

  const attempt = () => {
    const remote = fetchRemote();
    const merged = mergeTrackerEntries(remote.parsed, localData);
    putRemote(remote.sha, merged);
  };

  try {
    attempt();
    console.log(`  Synced opening-night-sent.json to origin/${BRANCH} via gh api`);
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    // Retry once on sha conflict (409/422) — remote may have changed between fetch and PUT.
    if (msg.includes('409') || msg.includes('422') || msg.includes('sha')) {
      console.error(`  Sync retry after remote conflict: ${msg.trim().slice(0, 200)}`);
      try {
        attempt();
        console.log(`  Synced opening-night-sent.json to origin/${BRANCH} (after retry)`);
        return;
      } catch (err2) {
        console.error(`\nWARNING: Sync retry failed: ${(err2.stderr || err2.message || '').toString().trim().slice(0, 300)}`);
      }
    } else {
      console.error(`\nWARNING: Failed to sync opening-night-sent.json to origin: ${msg.trim().slice(0, 300)}`);
    }
    console.error('         The next workflow run may not see this local write and could duplicate the send.');
    process.exitCode = 1;
  }
}

module.exports = { syncTrackerToOrigin, mergeTrackerEntries, SYNC_REPO, SYNC_REMOTE_PATH };
