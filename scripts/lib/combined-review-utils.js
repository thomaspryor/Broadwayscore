/**
 * Helpers for the combined-review (joint review) detection pipeline.
 *
 * Used by `scripts/flag-combined-reviews.js` and tests. Per CLAUDE.md §15,
 * extracted to a lib module so unit tests can require() the real function
 * instead of duplicating logic.
 */

/**
 * Strip year suffix and market suffix from a show ID so revival/historical/
 * current variants of the SAME production collapse to one base slug.
 *
 * Examples:
 *   the-lost-boys           → the-lost-boys
 *   the-lost-boys-2026      → the-lost-boys
 *   stranger-things-the-first-shadow-west-end-2023 → stranger-things-the-first-shadow
 *   evita-off-broadway-2025 → evita
 *
 * Used by flag-combined-reviews.js to filter out cross-variant URL collisions
 * (same critic + same URL on `the-lost-boys` and `the-lost-boys-2026` is the
 * same show, NOT a joint review). Joint review = URL spans 2+ DIFFERENT base
 * shows.
 *
 * Order matters: strip year first (`-2026`), THEN market suffix
 * (`-west-end`), because some IDs have both (`...-west-end-2023`). The
 * `-west-end` strip would otherwise leave `-2023` orphaned.
 */
function baseSlug(showId) {
  return String(showId)
    .replace(/-\d{4}$/, '')
    .replace(/-(?:off-broadway|west-end|off-west-end|tour|first-national-tour)$/, '');
}

module.exports = { baseSlug };
