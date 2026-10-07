/**
 * Shared `--shows=a,b,c` / `--show=a` filter parser for scripts that scope a
 * run to specific show IDs.
 *
 * Why this exists (BRO-4595): update-critic-consensus.yml runs under
 * `concurrency: group: update-critic-consensus, cancel-in-progress: false`,
 * which keeps ONE running and ONE pending run; every further dispatch cancels
 * the previously pending one. opening-night-poller.yml dispatched that
 * workflow once per polled show (58 dispatches on 2026-10-04) and 56 of them
 * were silently cancelled. The fix is a single dispatch carrying the whole
 * list, which needs the generator to accept a list where it previously took
 * one ID (`showId !== showFilter`).
 *
 * Lives in scripts/lib rather than inside generate-critic-consensus.js because
 * that script is ESM, builds an Anthropic client at module top and calls
 * main() on import — nothing in it can be unit-tested without running a
 * generation (CLAUDE.md §15: tests require() the real function).
 *
 * Accepts both spellings so single-ID callers keep working unchanged:
 *   --shows=a,b,c   list form (matches sweep-we-aggregators.js, fetch-guardian's
 *                   `-f shows=` input)
 *   --show=a        one-ID alias (opening-night-remediation.js,
 *                   critics-take-present.check.js, the workflow's `show` input)
 * Both may be repeated or mixed; the result is the union. Entries are trimmed,
 * quotes stripped (the old parser did this for `--show="x"`), and empties
 * dropped, so a trailing comma or a double comma is harmless.
 *
 * @param {string[]} argv - argument list (without node/script)
 * @returns {Set<string>|null} the requested IDs, or null when no filter flag
 *   was supplied (callers treat null as "all shows"). A flag with no usable
 *   IDs (`--shows=` or `--shows=,`) returns an EMPTY Set, not null — an
 *   operator who passed a filter must not get a whole-scan by accident.
 */
function parseShowListArg(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const flags = list.filter((a) => a.startsWith('--shows=') || a.startsWith('--show='));
  if (!flags.length) return null;
  const ids = new Set();
  for (const flag of flags) {
    const value = flag.slice(flag.indexOf('=') + 1).replace(/['"]/g, '');
    for (const raw of value.split(',')) {
      const id = raw.trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * One-line mode description for the run log.
 * @param {Set<string>|null} filter - result of parseShowListArg
 * @returns {string|null} null when there is no filter
 */
function describeShowFilter(filter) {
  if (filter === null) return null;
  if (filter.size === 0) return 'Show filter supplied but empty: nothing to do';
  if (filter.size === 1) return `Single-show mode: ${[...filter][0]}`;
  return `Show-list mode (${filter.size} shows): ${[...filter].join(', ')}`;
}

module.exports = { parseShowListArg, describeShowFilter };
