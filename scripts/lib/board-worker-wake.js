'use strict';
/**
 * board-worker-wake.js (BRO-6715): start the board worker routine now instead of at its next
 * 2-hourly firing, so an answered card is picked up within a minute or two. Uses the routine's
 * API trigger (POST /v1/claude_code/routines/<trig_...>/fire with the per-routine bearer token the
 * claude.ai routine page shows once). Fail-soft by design: with no URL or token configured, or on
 * any error, it reports why and the normal schedule still takes the card. Each fire starts a new
 * session (no idempotency key), so callers fire at most once per answer.
 */

const FIRE_URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;

async function wakeBoardWorker({ env = process.env, fetchImpl = globalThis.fetch, reason = '' } = {}) {
  const url = String(env.BOARD_WORKER_FIRE_URL || '').trim();
  const token = String(env.BOARD_WORKER_FIRE_TOKEN || '').trim();
  if (!url || !token) return { fired: false, why: 'not-configured' };
  if (!FIRE_URL_RE.test(url)) return { fired: false, why: 'bad-url' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      // No text: the saved routine prompt runs as usual and the picker puts the answered card first.
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { fired: false, why: `http-${res.status}`, reason };
    const json = await res.json().catch(() => ({}));
    return { fired: true, session: json.claude_code_session_url || null, reason };
  } catch (e) {
    return { fired: false, why: `error: ${String(e && e.message).slice(0, 80)}`, reason };
  }
}

/**
 * Debounce: every fire starts a full new routine session and the API has no idempotency key, so
 * five answers in a row must not start five sessions. One worker that starts after the first answer
 * picks every answered card (answers go first in the picker). Skip when another run of this workflow
 * finished successfully in the last `windowMin` minutes (4: a worker picks its cards in its first minutes, and 4 keeps fires under the routine 30-per-hour cap). Fail-open: if GitHub cannot be asked, fire.
 */
async function recentWakeRun({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), windowMin = 4 } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  try {
    const since = new Date(now - windowMin * 60000).toISOString();
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/board-worker-wake.yml/runs?status=success&per_page=10&created=%3E%3D${encodeURIComponent(since)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const other = (json.workflow_runs || []).find((r) => String(r.id) !== String(env.GITHUB_RUN_ID || ''));
    return other ? { id: other.id, at: other.created_at } : null;
  } catch { return null; }
}

/**
 * Ask the wake workflow (the one place that holds the routine token and debounces) to run. Used by the
 * Linear reply drain so that every wake, from an email tap or a Linear reply, goes through the same
 * serialized, debounced path. Only inside GitHub Actions and only when the workflow opts in with
 * BOARD_WORKER_WAKE_ENABLED=true (so no test, in CI or locally, ever starts a real run); fail-soft.
 */
async function requestWake({ env = process.env, fetchImpl = globalThis.fetch, reason = '' } = {}) {
  if (env.BOARD_WORKER_WAKE_ENABLED !== 'true' || env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return { requested: false, why: 'not-in-actions' };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/board-worker-wake.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: env.GITHUB_REF_NAME || 'main', inputs: { reason: String(reason).slice(0, 60) } }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? { requested: true } : { requested: false, why: `http-${res.status}` };
  } catch (e) { return { requested: false, why: `error: ${String(e && e.message).slice(0, 60)}` }; }
}

module.exports = { wakeBoardWorker, recentWakeRun, requestWake, FIRE_URL_RE };
