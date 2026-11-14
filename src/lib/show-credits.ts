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
// Role words as they appear in our data ("Composer" 29x, "Lyricist" 18x, "Book writer"
// 20x on current shows). A role is split into bits ("Book/Music/Lyrics", "Writer &
// Director"); one unknown bit drops the whole role, so a credit is never half-read.
type Bit = Part | 'director' | 'skip';
const BIT: Record<string, Bit | undefined> = {
  book: 'book', 'book writer': 'book', 'book writers': 'book', libretto: 'book', librettist: 'book',
  music: 'music', composer: 'music', composers: 'music',
  lyrics: 'lyrics', lyricist: 'lyrics', lyricists: 'lyrics',
  play: 'written', playwright: 'written', playwrights: 'written', writer: 'written', writers: 'written', written: 'written', author: 'written', 'co-author': 'written',
  adaptation: 'adapted', adapter: 'adapted', adaptor: 'adapted',
  director: 'director', 'co-director': 'director', directors: 'director',
  choreographer: 'skip', choreography: 'skip',
};
function roleBits(role: string): Bit[] {
  const bits = role.toLowerCase().trim().replace(/^original\s+/, '')
    .split(/\s*(?:&|\band\b|,|\/)\s*/).filter(Boolean)
    .map(b => BIT[b.replace(/\s+by$/, '')]);
  return bits.length && bits.every(Boolean) ? bits as Bit[] : [];
}
function writerParts(role: string, isPlay: boolean): Part[] {
  return roleBits(role).filter((b): b is Part => b !== 'director' && b !== 'skip')
    // A play's "Book" credit is its script: "Written by Agatha Christie", not "Book by".
    .map(b => (isPlay && b === 'book' ? 'written' : b));
}
const PART_LABEL: Record<Part, string> = { written: 'written', book: 'book', music: 'music', lyrics: 'lyrics', adapted: 'adapted' };

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

  // Stars only while the cast data describes the current company (pre-opening or
  // the first year). On a long-runner the Playbill list leads with whoever is
  // billed first this season, often not a star (Chicago, The Lion King).
  const billed = input.openingCastIsCurrent ? (input.castBilling ?? []).map(clean).filter(usable).slice(0, 2) : [];
  const stars = billed.length ? billed : [input.openingCastIsCurrent ? titleRoleStar(input.title, input.openingCast ?? []) : null].filter((n): n is string => !!n);
  if (stars.length) out.push(`Starring ${joinNames(stars)}.`);

  // part -> names in team order; parts with the same names merge, so one writer
  // of everything reads "Book, music and lyrics by Lin-Manuel Miranda" and
  // co-writers stay together ("Book by Fred Ebb and Bob Fosse").
  const byPart = new Map<Part, string[]>();
  for (const m of team) {
    const name = clean(m.name);
    if (!usable(name)) continue;
    for (const part of writerParts(clean(m.role), input.type === 'play')) {
      const names = byPart.get(part) ?? [];
      if (!names.includes(name)) byPart.set(part, [...names, name]);
    }
  }
  const groups = new Map<string, Part[]>(); // names key -> parts, in PARTS order
  for (const part of PARTS) {
    const names = byPart.get(part);
    if (!names) continue;
    const key = names.join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), part]);
  }
  for (const [key, parts] of groups) {
    const label = parts[0] === 'written' ? 'Written' : parts[0] === 'adapted' ? 'Adapted' : joinNames(parts.map(x => PART_LABEL[x]));
    out.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} by ${joinNames(key.split('\u0000'))}.`);
  }

  const directors = namesFor(team, r => roleBits(r).includes('director'));
  if (directors.length) out.push(`Directed by ${joinNames(directors)}.`);
  return out;
}
