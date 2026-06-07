/**
 * Dump current-season Tony Predictions snapshot as JSON to stdout.
 * Mirrors src/app/tony-awards/predictions/[season]/page.tsx — same softmax(T=7).
 * Run (cwd must be main repo so JSON imports resolve to real data files):
 *   node_modules/.bin/tsx scripts/newsletter/dump-tony-predictions.ts
 *
 * Imports go through the main repo's src/lib (NOT relative to this file) so
 * the same script works when invoked from a git worktree where data/ files
 * aren't checked in — see memory/feedback_worktree_code_changes.md.
 */
import { getBroadwayShows } from '../../src/lib/data-core';
import {
  getTonySeasonWindow,
  getEligibleShows,
  groupIntoCategories,
  resolveRecipeTier,
} from '../../src/lib/data-tony-predictions';
import { hasNominationsBeenAnnounced } from '../../src/lib/tony-cutoffs';

const season = getTonySeasonWindow();
const allShows = getBroadwayShows();
const eligible = getEligibleShows(allShows, season);
const tier = resolveRecipeTier(season);
// hasNominationsBeenAnnounced takes a TonySeasonRecord; pass season-like object
const nominationsAnnounced = (() => {
  try { return hasNominationsBeenAnnounced(season as never); } catch { return true; }
})();
const useNomineesOnly = nominationsAnnounced;
const cats = groupIntoCategories(
  eligible,
  useNomineesOnly ? { nomineesOnly: true, season, tier } : { tier },
);

const T = 7;
const out: Record<string, Array<{ slug: string; title: string; blendedScore: number | null; prob: number }>> = {};
for (const cat of cats) {
  const scored = cat.shows.filter(s => s.blendedScore != null);
  if (scored.length === 0) { out[cat.key] = []; continue; }
  const exps = scored.map(s => Math.exp((s.blendedScore as number) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  out[cat.key] = scored.map((s, i) => ({
    slug: s.slug,
    title: s.title,
    blendedScore: s.blendedScore,
    prob: exps[i] / sum,
  })).sort((a, b) => b.prob - a.prob);
}
process.stdout.write(JSON.stringify({ season: season.label, tier, categories: out }, null, 2));
