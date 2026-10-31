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

module.exports = { wakeBoardWorker, FIRE_URL_RE };
