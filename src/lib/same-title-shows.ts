/**
 * Ids of shows whose title also belongs to another show in the same list
 * (e.g. two concurrent London "Cinderella" productions). List cards use this to
 * add a venue line to just those rows, so identical-looking rows can be told
 * apart without changing the default card (BRO-4309).
 */
export function sameTitleShowIds(shows: ReadonlyArray<{ id: string; title: string }>): Set<string> {
  const norm = (t: string) => t.toLowerCase().replace(/[‘’'`]/g, '').replace(/\s+/g, ' ').trim();
  const byTitle = new Map<string, string[]>();
  for (const s of shows) {
    const key = norm(s.title);
    const ids = byTitle.get(key);
    if (ids) ids.push(s.id); else byTitle.set(key, [s.id]);
  }
  const out = new Set<string>();
  for (const ids of byTitle.values()) if (ids.length > 1) ids.forEach((id) => out.add(id));
  return out;
}
