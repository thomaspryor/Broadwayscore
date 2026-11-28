'use strict';

// BRO-6773: the first monthly sync hit 429 after its contact reads. Share pacing
// across every page, add and unsubscribe in this sequential sync. Retry only
// explicit rate-limit rejections, never a write with an uncertain outcome.
function createAudienceRequest({
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  let nextRequestAt = 0;
  return async function audienceRequest(attempt) {
    for (let i = 0; i < 3; i++) {
      const wait = nextRequestAt - now();
      if (wait > 0) await sleep(wait);
      let response;
      try {
        response = await attempt();
      } finally {
        nextRequestAt = now() + 600;
      }
      if (response.status !== 429) return response;
      // Resend's Retry-After is in seconds. Missing/invalid values back off.
      const seconds = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * (2 ** i);
      // Stop the sync on a long-lived limit instead of retrying other contacts early.
      if (delay > 30000) {
        await response.body?.cancel();
        throw new Error('Resend Retry-After exceeds the 30-second retry budget');
      }
      nextRequestAt = Math.max(nextRequestAt, now() + delay);
      if (i === 2) return response;
      await response.body?.cancel();
    }
  };
}

module.exports = { createAudienceRequest };
