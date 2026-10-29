/**
 * Ids of shows whose title also belongs to another show in the same list
 * (e.g. two concurrent London "Cinderella" productions). List cards use this to
 * add a venue line to just those rows, so identical-looking rows can be told
 * apart without changing the default card (BRO-4309). A group whose venues are
 * all the same (two "North American Tour" rows) is skipped: a venue line would
 * add clutter without telling them apart.
 */
export function sameTitleShowIds(shows: ReadonlyArray<{ id: string; title: string; venue?: string | null }>): Set<string> {
  const norm = (t: string) => t.toLowerCase().replace(/[‘’'`]/g, '').replace(/\s+/g, ' ').trim();
  const byTitle = new Map<string, typeof shows[number][]>();
  for (const s of shows) {
    const key = norm(s.title);
    const group = byTitle.get(key);
    if (group) group.push(s); else byTitle.set(key, [s]);
  }
  const out = new Set<string>();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const venues = new Set(group.map((s) => (s.venue ?? '').trim().toLowerCase()));
    if (venues.size > 1) group.forEach((s) => out.add(s.id));
  }
  return out;
}
