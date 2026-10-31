/**
 * Which lottery-rush.json date says the feed is current (BRO-901 / BRO-5261).
 *
 * `lastUpdated` only moves when a policy changed, so a healthy feed with
 * nothing new looks stale by it, and the data-stale banner would warn shoppers
 * for no reason. scrape-lottery-rush.js now stamps `lastCheckedAt` on every run
 * where all sources answered (scripts/lib/lottery-rush-check.js), changes or
 * not. Prefer it; fall back to `lastUpdated` for files written before it existed.
 *
 * Kept free of data imports so tests and client code can use it directly.
 */
export function ticketPolicyCheckedAt(file: { lastCheckedAt?: string | null; lastUpdated?: string | null }): string {
  return file.lastCheckedAt || file.lastUpdated || '';
}
