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
  // Protocol-relative and data: URIs are remote-ish, not paths under public/.
  // Joining them would probe a nonsense local path and report a false WARN.
  if (ref.startsWith('//') || /^data:/i.test(ref)) return true;

  const root = opts.repoRoot || REPO_ROOT;
  const exists = opts.existsSync || fs.existsSync;
  const statFile = opts.statSync || fs.statSync;

  // Strip a ?query / #fragment before touching the filesystem — a real ref can
  // carry a cache-buster (Playbill's ?mtime=) and the file on disk does not.
  let rel = ref.replace(/[?#].*$/, '');
  try { rel = decodeURIComponent(rel); } catch { /* leave as-is if not valid encoding */ }
  rel = rel.replace(/^\/+/, '');
  // Refs are site paths, so a leading 'public/' is the caller repeating the
  // root; joining it verbatim would probe public/public/... and false-WARN.
  rel = rel.replace(/^public\//, '');

  const publicDir = path.join(root, 'public');
  const full = path.resolve(publicDir, rel);
  // Containment: '..' in a ref must never let this answer "present" about a
  // file outside public/.
  if (full !== publicDir && !full.startsWith(publicDir + path.sep)) return false;

  if (!exists(full)) return false;
  // existsSync alone accepts a DIRECTORY, which is the same false-all-clear
  // class this predicate exists to prevent: images.hero pointing at a folder
  // would have read as present.
  try { return statFile(full).isFile(); } catch { return false; }
}

module.exports = { imagePresent, REPO_ROOT };
