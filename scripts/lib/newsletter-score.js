/**
 * The newsletter's score for one show, read from the show's slim
 * public/data/shows/<id>.json (`cs` = canonical compositeScore, `rc` = count).
 *
 * When the slim file exists but carries no `cs`, the site is withholding the
 * score (too few scoreable reviews, or the coverage floor holds it at TBD), so
 * the newsletter has no score either. It used to fall back to a raw mean of
 * reviews.json here, which printed a score the site does not show (The Dog
 * Show: Come. Sit. Stay., 79 in the 2026-10-19 draft while its page was TBD).
 * CLAUDE.md rule 3: never raw-mean.
 *
 * @param {object|null} slim  parsed slim show JSON, or null when the file is missing
 * @returns {{ avg: number, count: number, raw: number } | null | undefined}
 *   a score, null for "no score" (file present, cs withheld), or undefined
 *   when the file is missing (caller decides).
 */
function scoreFromSlimShow(slim) {
  if (slim == null) return undefined;
  if (typeof slim.cs === 'number' && typeof slim.rc === 'number') {
    return { avg: Math.round(slim.cs), count: slim.rc, raw: slim.cs };
  }
  return null;
}

module.exports = { scoreFromSlimShow };
