/**
 * "Who's behind it" sentences for a show's About paragraph (BRO-7426).
 *
 * The owner asked for an About paragraph like TodayTix's. What makes theirs
 * useful is the facts (who stars, who wrote it, who directs), not the sales
 * copy, and we hold those facts ourselves. Everything here is built from our
 * own creative team and cast data, so nothing is copied from a ticket seller.
 *
 * Stars are named only when the data is clear: Playbill billing order
 * (castBilling) or a single opening cast member playing the title role. A
 * guessed "star" from an alphabetical cast list would be wrong (BRO-6746).
 */

export interface CreditMember { name?: string | null; role?: string | null; flags?: string[] | null }

interface CreditsInput {
  title: string;
  type?: string | null;
  creativeTeam?: CreditMember[] | null;
  openingCast?: CreditMember[] | null;
  castBilling?: string[] | null;
  /** Name a title-role star from the opening cast. Only true before opening or in the first year: Hamilton's 2015 cast is not today's. */
  openingCastIsCurrent?: boolean;
}

// Writing credits as parts, so one writer of book, music and lyrics reads
// "Book, music and lyrics by Lin-Manuel Miranda" instead of three sentences.
const PARTS = ['written', 'book', 'music', 'lyrics', 'adapted'] as const;
type Part = typeof PARTS[number];
function writerParts(role: string): Part[] {
  const r = role.toLowerCase().trim();
  if (/^(play|playwright|written by|writer)$/.test(r)) return ['written'];
  if (/^adaptation$/.test(r)) return ['adapted'];
  const bits = r.replace(/^original\s+/, '').split(/\s*(?:&|and|,)\s*/).filter(Boolean);
  if (!bits.length || !bits.every(b => b === 'book' || b === 'music' || b === 'lyrics')) return [];
  return bits as Part[];
}
const PART_LABEL: Record<Part, string> = { written: 'written', book: 'book', music: 'music', lyrics: 'lyrics', adapted: 'adapted' };
const DIRECTOR = /^director(\s*(&|and)\s*choreographer)?$/i;

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const clean = (n: string | null | undefined) => String(n ?? '').replace(/\s+/g, ' ').trim();
// A name with markup left in it ("{{plainlist | ...") is broken data; leave it out.
const usable = (n: string) => n.length > 1 && !/[{}[\]|<>]/.test(n);
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function namesFor(team: CreditMember[], test: (role: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of team) {
    const name = clean(m.name);
    if (usable(name) && test(clean(m.role)) && !out.includes(name)) out.push(name);
  }
  return out;
}

const TITLE_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'on', 'in', 'to', 'at', 'broadway', 'musical', 'play', 'show', 'new', 'my']);

/** One opening cast member whose role carries every word of a short title ("Galileo" -> "Galileo Galilei"). */
export function titleRoleStar(title: string, cast: CreditMember[]): string | null {
  const words = fold(title).split(/[^a-z]+/).filter(w => w.length > 2 && !TITLE_STOP.has(w));
  if (words.length === 0 || words.length > 2) return null;
  const names = new Set<string>();
  for (const m of cast) {
    if ((m.flags ?? []).length) continue; // alternates, standbys, understudies
    const roleWords = fold(clean(m.role)).split(/[^a-z]+/);
    if (words.every(w => roleWords.includes(w)) && usable(clean(m.name))) names.add(clean(m.name));
  }
  return names.size === 1 ? [...names][0] : null;
}

export function getCreditSentences(input: CreditsInput): string[] {
  const team = input.creativeTeam ?? [];
  const out: string[] = [];

  const billed = (input.castBilling ?? []).map(clean).filter(usable).slice(0, 2);
  const stars = billed.length ? billed : [input.openingCastIsCurrent ? titleRoleStar(input.title, input.openingCast ?? []) : null].filter((n): n is string => !!n);
  if (stars.length) out.push(`Starring ${joinNames(stars)}.`);

  // name -> parts, in team order; then group names that share the same parts.
  const byName = new Map<string, Set<Part>>();
  for (const m of team) {
    const name = clean(m.name); const parts = writerParts(clean(m.role));
    if (!usable(name) || !parts.length) continue;
    const set = byName.get(name) ?? new Set<Part>(); parts.forEach(x => set.add(x)); byName.set(name, set);
  }
  const groups = new Map<string, string[]>();
  for (const [name, set] of byName) {
    const key = PARTS.filter(x => set.has(x)).join('+');
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const rank = (key: string) => PARTS.indexOf(key.split('+')[0] as Part);
  for (const key of [...groups.keys()].sort((x, y) => rank(x) - rank(y))) {
    const parts = key.split('+').map(x => PART_LABEL[x as Part]);
    const label = parts[0] === 'written' ? 'Written' : parts[0] === 'adapted' ? 'Adapted' : joinNames(parts);
    out.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} by ${joinNames(groups.get(key)!)}.`);
  }

  const directors = namesFor(team, r => DIRECTOR.test(r));
  if (directors.length) out.push(`Directed by ${joinNames(directors)}.`);
  return out;
}
