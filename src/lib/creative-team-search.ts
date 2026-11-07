/**
 * Text the market-page Fuse index searches for creative names. Live shows arrive
 * slim (`creativeTeamNames`); archive entries still carry the full `creativeTeam`
 * array, so closed shows fall back to it (BRO-5991).
 */
export function creativeTeamSearchText(obj: unknown): string {
  const show = obj as { creativeTeamNames?: string; creativeTeam?: { name?: string }[] };
  if (show.creativeTeamNames) return show.creativeTeamNames;
  return (show.creativeTeam ?? []).map(m => m.name).filter(Boolean).join(', ');
}
