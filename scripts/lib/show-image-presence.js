'use strict';

/**
 * Is a show's image reference backed by something that actually exists?
 *
 * Extracted from check-opening-night-readiness.js so the predicate can be
 * tested against the real function rather than a copy (CLAUDE.md rule 15).
 *
 * The history matters, because both directions have shipped as bugs:
 *
 *  - The ORIGINAL check hardcoded a `.webp` extension, so a show with a real
 *    poster.jpg + thumbnail.jpg on disk reported "Missing: hero, poster,
 *    thumbnail". A false WARN.
 *  - The FIX for that checked only whether `show.images.<key>` was truthy,
 *    which turned it into a false ALL-CLEAR: high-society-west-end-2026 points
 *    images.hero at hero.webp, only poster.jpg and thumbnail.jpg are on disk,
 *    and the readiness check printed "✅ Show images". Corpus-wide there were
 *    334 images.* refs pointing at files absent from public/.
 *
 * On an opening-night gate the false all-clear is the worse direction, so the
 * predicate is: the field must be SET, and either be a remote URL or resolve
 * to a file that exists under public/.
 *
 * Remote URLs are trusted on the field alone. A readiness check must not fire
 * a network request per image.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * @param {unknown} ref  a show.images.* value, e.g. "/images/shows/x/hero.webp"
 * @param {{repoRoot?: string, existsSync?: (p: string) => boolean}} [opts]
 *        injectable for tests; production callers pass nothing
 * @returns {boolean}
 */
function imagePresent(ref, opts = {}) {
  if (!ref || typeof ref !== 'string') return false;
  if (/^https?:\/\//i.test(ref)) return true;
  const root = opts.repoRoot || REPO_ROOT;
  const exists = opts.existsSync || fs.existsSync;
  return exists(path.join(root, 'public', ref.replace(/^\//, '')));
}

module.exports = { imagePresent, REPO_ROOT };
