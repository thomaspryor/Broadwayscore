'use strict';

// Promise.race timeout wrapper that always clears its own timer (BRO-2427).
// A bare `new Promise((_, rej) => setTimeout(rej, ms))` inside Promise.race
// keeps the event loop alive for the FULL timeout even after the work wins,
// which shows up as multi-second hangs on fast calls and late process exit.
//
// Bounds how long the caller WAITS; it does not cancel the underlying work.
//   withTimeout(promise, ms, { label, message })      rejects on timeout
//   withTimeout(promise, ms, { resolveWith: value })  resolves to value on timeout
// Accepts a promise or a function returning one.
async function withTimeout(work, ms, opts = {}) {
  const { label = 'operation', message, resolveWith } = opts;
  // ms of 0 / undefined means no timeout configured (collect-review-texts relies on it).
  // Other invalid values (NaN, negative, Infinity) are a caller bug: fail loudly.
  if (ms === 0 || ms === undefined || ms === null) return typeof work === 'function' ? work() : work;
  if (!Number.isFinite(ms) || ms < 0) throw new TypeError(`withTimeout: invalid ms ${ms}`);
  const hasFallback = Object.prototype.hasOwnProperty.call(opts, 'resolveWith');
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (hasFallback) resolve(resolveWith);
      else reject(new Error(message || `${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    const p = typeof work === 'function' ? Promise.resolve().then(work) : work;
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withTimeout };
