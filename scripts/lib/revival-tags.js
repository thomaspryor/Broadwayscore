/**
 * Keep a show's `tags` in step with its `isRevival` flag.
 *
 * The site treats a show as a revival when EITHER `isRevival` is true OR
 * `tags` contains 'revival' (src/lib/engine.ts, browse/guide pages). So a
 * writer that sets `isRevival` without touching `tags` has no effect when it
 * clears the flag: Degenerates 2026 (a world premiere) kept its "revival"
 * label after an approved fix set isRevival=false (BRO-4436).
 *
 * Setting the flag also drops a stale 'new' tag (Galileo 2026-08-14 shipped
 * with tags ["new","revival"]). Clearing it only removes 'revival': 'new'
 * means "low-confidence, verify by hand" (discover-new-shows.js), so it is
 * never added here (same as the Paddington fix; validate-data.js flags the
 * mismatch as "Remove the tag").
 *
 * Mutates and returns `show`. Only `show.tags` changes.
 */
function syncRevivalTags(show) {
  if (!show || typeof show.isRevival !== 'boolean') return show;
  const tags = Array.isArray(show.tags) ? show.tags : [];
  if (show.isRevival) {
    show.tags = tags.filter(t => t !== 'new');
    if (!show.tags.includes('revival')) show.tags.push('revival');
  } else {
    show.tags = tags.filter(t => t !== 'revival');
  }
  return show;
}

module.exports = { syncRevivalTags };
