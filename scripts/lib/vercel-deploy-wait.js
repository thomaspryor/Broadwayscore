/**
 * Pure decision + polling logic for waiting on a Vercel deployment (BRO-2067).
 *
 * Under a burst of pushes Vercel's "latest wins" dedup CANCELS our deployment
 * server-side while `vercel deploy` keeps waiting on it (hangs until the step
 * timeout). The workflow now deploys with --no-wait and polls the deployment
 * state itself via scripts/vercel-wait-deployment.js, so a CANCELED/ERROR state
 * is seen within one poll interval instead of at the timeout.
 */

// CANCELED_SUPERSEDED: canceled AND Vercel has a newer non-canceled production deployment.
const EXIT = { READY: 0, ERROR: 1, CANCELED: 3, TIMEOUT: 4, CANCELED_SUPERSEDED: 5 };

function classifyState(readyState) {
  switch (String(readyState || '').toUpperCase()) {
    case 'READY': return 'ready';
    case 'CANCELED': return 'canceled';
    case 'ERROR': return 'error';
    default: return 'pending'; // QUEUED, INITIALIZING, BUILDING, unknown
  }
}

/**
 * Poll until the deployment reaches a terminal state or the deadline passes.
 * fetchState() -> readyState string (may throw on transient API errors; a
 * throw counts as pending so one blip doesn't kill the wait; an error with
 * `fatal: true` ends the wait as 'error').
 */
async function waitForDeployment({ fetchState, sleep, now = Date.now, timeoutMs, intervalMs = 10000 }) {
  const deadline = now() + timeoutMs;
  let polls = 0;
  let state = 'UNKNOWN';
  while (true) {
    polls++;
    try {
      state = await fetchState();
    } catch (e) {
      // 4xx other than 404 (grace: just created) / 429 is a bad token or URL: retrying won't help.
      if (e && e.fatal) return { outcome: 'error', state: 'API_' + e.status, polls };
      state = 'UNKNOWN';
    }
    const cls = classifyState(state);
    if (cls !== 'pending') return { outcome: cls, state, polls };
    if (now() + intervalMs >= deadline) return { outcome: 'timeout', state, polls };
    await sleep(intervalMs);
  }
}

/**
 * A CANCELED deployment is benign only when Vercel is already building/serving
 * a NEWER production deployment (not merely "main moved": CI bookkeeping commits
 * move main every few minutes). `list` = Vercel deployments, any order.
 */
function hasNewerLiveDeployment(ourCreatedAt, list) {
  return (list || []).some(d => d && d.createdAt > ourCreatedAt && classifyState(d.readyState || d.state) !== 'canceled' && classifyState(d.readyState || d.state) !== 'error');
}

function exitCodeFor(outcome) {
  return outcome === 'ready' ? EXIT.READY
    : outcome === 'canceled' ? EXIT.CANCELED
    : outcome === 'timeout' ? EXIT.TIMEOUT
    : EXIT.ERROR;
}

module.exports = { EXIT, classifyState, waitForDeployment, hasNewerLiveDeployment, exitCodeFor };
