'use strict';
// scripts/lib/mac-applied-heartbeat.js — tell the cloud which origin/main sha
// the Mac checkout last applied (BRO-5085; BRO-4638 step 4).
//
// com.broadwayscore.checkout-sync fast-forwards ~/Broadwayscore every 30 min,
// but when it wedges (an untracked file at a path origin adds blocks ff-only,
// scripts/lib/sync-audit-decision.js) only the Mac's own morning digest knew.
// Cloud sessions could not tell. After each successful sync this posts a
// commit status on the applied origin/main sha (not HEAD, which can be a
// local-only ledger commit):
//   context     mac/checkout-sync-applied
//   state       success
//   description applied <ISO timestamp>
// Readable from the cloud with the GitHub commit-status API, needs no land and
// triggers no workflow. Read it as two rules:
//   stuck: origin/main's head is over ~1h old and has no such status while an
//          older commit does (sync can't apply new commits);
//   dead:  the newest such status is over ~7h old (REPOST_MS + one tick), even
//          on a quiet day with no new commits.
// Retirements done by the reconciler post their own context,
// mac/launchd-retire (failure = a partial retirement to fix by hand).
//
// Posted only when the applied sha changed or the last post is older than
// REPOST_MS, so a quiet day costs a handful of API calls, not 48.

const STATUS_CONTEXT = 'mac/checkout-sync-applied';
const REPOST_MS = 6 * 3600e3;
// The "dead" rule above: REPOST_MS plus one 30-min sync tick and slack for a slow tick.
const DEAD_AFTER_MS = REPOST_MS + 3600e3;
const HISTORY_PAGES = 12; // x100 commits; ~70 commits/h on main covers ~17h, past DEAD_AFTER_MS

function shouldPost({ sha, last, now = new Date() }) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return false;
  if (!last || last.sha !== sha) return true;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || now.getTime() - at >= REPOST_MS;
}

function statusArgs({ repo, sha, now = new Date() }) {
  return [
    'api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', 'state=success',
    '-f', `context=${STATUS_CONTEXT}`,
    '-f', `description=applied ${now.toISOString()}`,
  ];
}

// Reader side (BRO-6230). The morning-digest pager (check-morning-digest-sent.yml) learns the Mac
// is dead because the digest did not arrive; once the digest sends from GitHub Actions it arrives
// either way, so the pager reads this heartbeat instead. A missing heartbeat means "no successful
// checkout-sync": the Mac is off or logged out, or its sync is wedged. The message says both.
//
// newestMs: newest heartbeat time (null if none in the commits walked); oldestWalkedMs: commit
// time of the oldest commit walked, which says whether "none found" covers the dead window.
// Never 'dead' on a failed or too-short read: 'unknown', so the caller goes red instead of paging.
function decideMacAlive({ newestMs, oldestWalkedMs, readError, now = new Date() }) {
  if (readError) return { state: 'unknown', ageH: null, reason: `heartbeat read failed: ${readError}` };
  const limitH = DEAD_AFTER_MS / 3600e3;
  if (Number.isFinite(newestMs)) {
    const ageMs = now.getTime() - newestMs;
    const ageH = Math.round((ageMs / 3600e3) * 10) / 10;
    return ageMs > DEAD_AFTER_MS
      ? { state: 'dead', ageH, reason: `the Mac last finished a checkout sync ${ageH}h ago (limit ${limitH}h)` }
      : { state: 'alive', ageH, reason: `the Mac finished a checkout sync ${ageH}h ago` };
  }
  if (Number.isFinite(oldestWalkedMs) && now.getTime() - oldestWalkedMs > DEAD_AFTER_MS) {
    return { state: 'dead', ageH: null, reason: `no Mac checkout sync in the last ${limitH}h of main` };
  }
  return { state: 'unknown', ageH: null, reason: 'main history read was too short to judge the heartbeat' };
}

const HISTORY_QUERY = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){ref(qualifiedName:"refs/heads/main"){target{... on Commit{history(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{committedDate status{context(name:"${STATUS_CONTEXT}"){state createdAt}}}}}}}}}`;

// graphql(query, variables) resolves the `data` object and rejects on any error.
// Walks main newest-first and stops at the first commit carrying a heartbeat
// (each one lands on the then-current head, so the first hit is the newest).
async function fetchHeartbeat({ graphql, repo, maxPages = HISTORY_PAGES }) {
  const [owner, name] = String(repo).split('/');
  let after = null;
  let oldestWalkedMs = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(HISTORY_QUERY, { owner, name, after });
    const history = data && data.repository && data.repository.ref && data.repository.ref.target && data.repository.ref.target.history;
    if (!history || !Array.isArray(history.nodes)) throw new Error('main history missing from the GraphQL response');
    for (const node of history.nodes) {
      const ctx = node && node.status && node.status.context;
      if (ctx && ctx.state === 'SUCCESS') {
        const at = Date.parse(ctx.createdAt);
        if (Number.isFinite(at)) return { newestMs: at, oldestWalkedMs };
      }
      const c = Date.parse(node && node.committedDate);
      if (Number.isFinite(c)) oldestWalkedMs = c;
    }
    if (!history.pageInfo || !history.pageInfo.hasNextPage) break;
    after = history.pageInfo.endCursor;
  }
  return { newestMs: null, oldestWalkedMs };
}

// The graphql() fetchHeartbeat wants, over GitHub's API with a token (GH_TOKEN / GITHUB_TOKEN).
function githubGraphql(token) {
  return async (query, variables) => {
    if (!token) throw new Error('GH_TOKEN not set');
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'broadwayscore-mac-heartbeat' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.errors) throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify((body && body.errors) || body).slice(0, 160)}`);
    return body.data;
  };
}

// One call for both readers: fetch, then decide. Never throws.
async function readMacAlive({ token, repo = 'thomaspryor/Broadwayscore', graphql = githubGraphql(token), now = new Date() } = {}) {
  try {
    return decideMacAlive({ ...(await fetchHeartbeat({ graphql, repo })), now });
  } catch (err) {
    return decideMacAlive({ readError: String(err.message).slice(0, 160), now });
  }
}

module.exports = { STATUS_CONTEXT, REPOST_MS, DEAD_AFTER_MS, shouldPost, statusArgs, decideMacAlive, fetchHeartbeat, githubGraphql, readMacAlive };
