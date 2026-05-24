/**
 * Site Award Score — a stable prestige-weighted score per show.
 *
 * Distinct from src/lib/data-tony-predictions.ts: that module uses *predictive*
 * weights tuned for forecasting a Tony winner. This module uses *prestige*
 * weights — what a theater fan thinks a show's award legacy is worth.
 * Both modules can read the same awards.json; only the weights differ.
 */

import awardsData from '../../data/awards.json';
import { tonyCeremonyIsFuture } from './tony-cutoffs';

export type CategoryTier = 'S' | 'A+' | 'A' | 'B' | 'C';

export type TierBadge =
  | 'eligible'
  | 'in-the-hunt'
  | 'nominated'
  | 'honored'
  | 'decorated'
  | 'sweeper';

export type Market = 'broadway' | 'west-end';

type CeremonyKey =
  | 'tony'
  | 'pulitzer'
  | 'olivier_bway'
  | 'olivier_we'
  | 'nydcc'
  | 'occ'
  | 'dramaLeague'
  | 'dramaDesk'
  | 'obie'
  | 'lortel'
  | 'oba'
  | 'criticsCircle'
  | 'eveningStandard'
  | 'whatsOnStage';

interface TierPoints { win: number; nom: number }

const POINTS: Record<CeremonyKey, Partial<Record<CategoryTier, TierPoints>>> = {
  // Tony S-tier raised so Best Musical/Play dominates over any craft-award combination.
  // Previously 150 — two A+ craft wins (Book + Score = 180) could outrank Best Musical.
  // Nom values ~50% of original — nominations signal industry recognition but a win is
  // worth ~8-10x a nomination. Previously ~4-5x, which let 5 noms + 0 wins score 51 [Honored].
  tony:         { S: { win: 200, nom: 20 }, A: { win: 75, nom: 9 }, B: { win: 35, nom: 5 }, C: { win: 25, nom: 3 } },
  pulitzer:     { S: { win: 110, nom: 18 } },
  olivier_bway: { S: { win: 50,  nom: 6 },  A: { win: 25, nom: 3 },  B: { win: 15, nom: 2 }, C: { win: 12, nom: 2 } },
  olivier_we:   { S: { win: 110, nom: 14 }, A: { win: 55, nom: 7 },  B: { win: 32, nom: 4 }, C: { win: 24, nom: 3 } },
  nydcc:        { S: { win: 45,  nom: 0 } },
  occ:          { S: { win: 30,  nom: 5 },  A: { win: 20, nom: 3 },  B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
  dramaLeague:  { S: { win: 35,  nom: 5 },  A: { win: 22, nom: 3 } },
  dramaDesk:    { S: { win: 28,  nom: 4 },  A: { win: 18, nom: 2 },  B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
  // Off-Broadway and UK critics' awards — lower weight than Broadway ceremony equivalents.
  // Obie: wins only (Wikipedia has no nominee lists), S-tier per category matching.
  // Lortel: full nom tracking, Off-Broadway prestige tier below OCC.
  // criticsCircle: UK Critics' Circle Theatre Awards; primarily West End-relevant.
  obie:         { S: { win: 18,  nom: 0 },  A: { win: 12, nom: 0 },  B: { win: 8,  nom: 0 }, C: { win: 5,  nom: 0 } },
  lortel:       { S: { win: 20,  nom: 3 },  A: { win: 12, nom: 2 },  B: { win: 8,  nom: 1 }, C: { win: 5,  nom: 1 } },
  // Off Broadway Alliance Awards (industry-voted alliance, 2011-present, annual).
  // Slotted BELOW Lortel — OBA is industry-voted, Lortel is critic-voted. Above
  // Obie in S because Obie is wins-only (no noms) and on hiatus since 2019.
  oba:          { S: { win: 12,  nom: 2 },  A: { win: 8,  nom: 1 },  B: { win: 5,  nom: 1 }, C: { win: 3,  nom: 0 } },
  criticsCircle:{ S: { win: 30,  nom: 0 },  A: { win: 18, nom: 0 },  B: { win: 10, nom: 0 }, C: { win: 6,  nom: 0 } },
  // Evening Standard Theatre Awards (UK, 1955–present). Second-most prestigious
  // WE award after Olivier. Lower weight than olivier_we — popular jury award
  // with full nominee lists (winners marked by <b> in Wikipedia tables).
  eveningStandard: { S: { win: 60, nom: 8 }, A: { win: 30, nom: 4 }, B: { win: 18, nom: 2 }, C: { win: 12, nom: 2 } },
  // WhatsOnStage Awards (UK, 2001–present). AUDIENCE-voted — weight slotted
  // between Drama League (NY audience-voted) and Critics' Circle (critic-voted).
  // Includes a dedicated Best Off-West End Production category, the only WOS
  // award OWE shows can win.
  whatsOnStage:    { S: { win: 35, nom: 5 }, A: { win: 22, nom: 3 }, B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
};

const A_PLUS_MULTIPLIER = 1.2;
const REVIVAL_DISCOUNT = 0.85;
const C_STACKING = [1.0, 0.7, 0.5, 0.4, 0.4, 0.4];

/**
 * Map a precursor category name (e.g. "Outstanding Director of a Musical") to
 * a tier (S/A+/A/B/C) and revival flag. Returns null for unrecognized
 * categories. Exported for reuse by Tony predictions (data-tony-predictions.ts)
 * which applies different WEIGHTS to the same classification.
 */
export function classifyCategory(category: string): { tier: CategoryTier; revival: boolean } | null {
  const c = category.toLowerCase();
  if (/revival of a musical|musical revival/.test(c)) return { tier: 'S', revival: true };
  if (/revival of a play|play revival/.test(c)) return { tier: 'S', revival: true };
  // Lortel "Outstanding Revival" — combined musical+play revival category (no type distinction)
  if (/^outstanding revival$/.test(c)) return { tier: 'S', revival: true };
  if (/best musical$|outstanding musical$|outstanding new (broadway|off-broadway) musical|outstanding production of a (broadway or off-broadway )?musical/.test(c)) return { tier: 'S', revival: false };
  if (/best play$|outstanding play$|outstanding new (broadway|off-broadway) play|outstanding production of a play/.test(c)) return { tier: 'S', revival: false };
  // Olivier "Best New Play" and "Best Revival"
  if (/best new play/.test(c)) return { tier: 'S', revival: false };
  if (/^best revival$/.test(c)) return { tier: 'S', revival: true };
  if (/^drama$/.test(c)) return { tier: 'S', revival: false };
  if (/best (original )?score|outstanding (new )?score|outstanding music\b|outstanding lyrics|outstanding music in a play/.test(c)) return { tier: 'A+', revival: false };
  if (/best book|outstanding book/.test(c)) return { tier: 'A+', revival: false };
  if (/direction|director/.test(c)) return { tier: 'A', revival: false };
  if (/choreograph/.test(c)) return { tier: 'A', revival: false };
  if (/distinguished performance/.test(c)) return { tier: 'A', revival: false };
  if (/best (actor|actress) in a (play|musical)|outstanding (actor|actress) in a (play|musical)/.test(c)) return { tier: 'A', revival: false };
  // Olivier "Best Actor" / "Best Actress" — Olivier play acting awards have no "in a play" qualifier
  if (/^best (actor|actress)$/.test(c)) return { tier: 'A', revival: false };
  // Lead Performance (DD 70th+) / Lead Performer (OCC) / Lead Actor|Actress (Lortel) in a [Broadway|Off-Broadway] [play|musical]
  if (/outstanding lead (performance|performer|actor|actress) in an? (broadway |off-broadway )?(play|musical)/.test(c)) return { tier: 'A', revival: false };
  // WhatsOnStage acting categories — "Performer" (modern, 2020+) and gender-neutral
  // "Performer in a Female/Male Identifying Role" variants. Lead vs supporting split.
  if (/best supporting performer in a/.test(c)) return { tier: 'B', revival: false };
  if (/best performer in a/.test(c)) return { tier: 'A', revival: false };
  // WhatsOnStage "Best Supporting Actor/Actress" (pre-2020 naming, before "Performer").
  if (/best supporting (actor|actress)/.test(c)) return { tier: 'B', revival: false };
  // WhatsOnStage "Best Off-West End Production" — only WOS award OWE shows can win.
  if (/best off.?west.?end production/.test(c)) return { tier: 'S', revival: false };
  if (/best original music\b/.test(c)) return { tier: 'A+', revival: false };
  if (/video design/.test(c)) return { tier: 'C', revival: false };
  if (/featured (actor|actress)/.test(c)) return { tier: 'B', revival: false };
  // Olivier supporting role categories (use "supporting role" instead of "featured")
  if (/best (actor|actress) in a supporting role/.test(c)) return { tier: 'B', revival: false };
  // Featured Performance (DD 70th+) / Featured Performer (OCC) / Featured Actor|Actress (Lortel) variants
  if (/outstanding featured (performance|performer|actor|actress) in an? (broadway |off-broadway )?(play|musical)/.test(c)) return { tier: 'B', revival: false };
  if (/orchestration/.test(c)) return { tier: 'B', revival: false };
  if (/ensemble/.test(c)) return { tier: 'B', revival: false };
  if (/scenic|set design/.test(c)) return { tier: 'C', revival: false };
  if (/costume/.test(c)) return { tier: 'C', revival: false };
  if (/lighting/.test(c)) return { tier: 'C', revival: false };
  if (/sound/.test(c)) return { tier: 'C', revival: false };
  if (/projection design/.test(c)) return { tier: 'C', revival: false };
  if (/solo performance|solo show/.test(c)) return { tier: 'B', revival: false };
  if (/john gassner award|most promising playwright/.test(c)) return { tier: 'C', revival: false };
  // NYDCC Best Foreign Play — S-tier like Best Play; foreign-authored Broadway productions
  if (/best foreign play/.test(c)) return { tier: 'S', revival: false };
  // Obie Award categories (Village Voice Off-Broadway, 1956–2019)
  if (/best new american play|outstanding new american play/.test(c)) return { tier: 'S', revival: false };
  if (/best new musical/.test(c)) return { tier: 'S', revival: false };
  if (/\bbest performance\b/.test(c)) return { tier: 'B', revival: false };
  // Off Broadway Alliance Awards categories (since 2011).
  // Family Show and Unique Theatrical Experience are niche categories — C tier.
  if (/best family show/.test(c)) return { tier: 'C', revival: false };
  if (/best unique theatrical experience/.test(c)) return { tier: 'C', revival: false };
  // Special/honorary career awards — recognized but intentionally worth 0 points; not a typo.
  if (/special achievement|body of work/.test(c)) return null;
  return null;
}

export interface ContributionItem {
  category: string;
  tier: CategoryTier;
  revival: boolean;
  result: 'win' | 'nom';
  points: number;
}

export interface CeremonyContribution {
  ceremony: string;
  items: ContributionItem[];
  subtotal: number;
}

export interface ScoreResult {
  rawPoints: number;
  displayScore: number;
  badge: TierBadge;
  inProgress: boolean;
  breakdown: CeremonyContribution[];
  tonyWins: number;
  tonyNoms: number;
  tonySeason?: string;
}

function applyMultipliers(points: number, tier: CategoryTier, isRevival: boolean): number {
  let p = points;
  if (tier === 'A+') p *= A_PLUS_MULTIPLIER;
  if (isRevival) p *= REVIVAL_DISCOUNT;
  return p;
}

function pointsForTier(table: Partial<Record<CategoryTier, TierPoints>>, tier: CategoryTier): TierPoints | null {
  if (tier === 'A+') return table.A ?? null;
  return table[tier] ?? null;
}

function scoreCeremony(
  display: string,
  key: CeremonyKey,
  wins: string[],
  noms: string[],
  unknownNomCount = 0,
): CeremonyContribution {
  const table = POINTS[key];
  const items: ContributionItem[] = [];
  const winCount: Record<string, number> = {};
  const nomCount: Record<string, number> = {};
  for (const w of wins) winCount[w] = (winCount[w] || 0) + 1;
  for (const n of noms) nomCount[n] = (nomCount[n] || 0) + 1;
  let cWinsSeen = 0;
  for (const [cat, count] of Object.entries(winCount)) {
    const cls = classifyCategory(cat);
    if (!cls) continue;
    const pts = pointsForTier(table, cls.tier);
    if (!pts) continue;
    for (let i = 0; i < count; i++) {
      let raw = pts.win;
      if (cls.tier === 'C') {
        raw *= C_STACKING[Math.min(cWinsSeen, C_STACKING.length - 1)];
        cWinsSeen++;
      }
      items.push({ category: cat, tier: cls.tier, revival: cls.revival, result: 'win', points: applyMultipliers(raw, cls.tier, cls.revival) });
    }
  }
  for (const [cat, count] of Object.entries(nomCount)) {
    const cls = classifyCategory(cat);
    if (!cls) continue;
    const pts = pointsForTier(table, cls.tier);
    if (!pts || pts.nom <= 0) continue;
    const losing = Math.max(0, count - (winCount[cat] || 0));
    for (let i = 0; i < losing; i++) {
      items.push({ category: cat, tier: cls.tier, revival: cls.revival, result: 'nom', points: applyMultipliers(pts.nom, cls.tier, cls.revival) });
    }
  }
  if (unknownNomCount > 0 && table.C && table.C.nom > 0) {
    for (let i = 0; i < unknownNomCount; i++) {
      items.push({ category: '(uncategorized)', tier: 'C', revival: false, result: 'nom', points: table.C.nom });
    }
  }
  const subtotal = items.reduce((s, x) => s + x.points, 0);
  return { ceremony: display, items, subtotal };
}

function unknownNoms(totalCount: number | undefined, enumeratedWins: string[], enumeratedNoms: string[]): number {
  if (!totalCount) return 0;
  const enumerated = new Set([...enumeratedWins, ...enumeratedNoms]).size;
  return Math.max(0, totalCount - enumerated);
}

export function computeSiteAwardScore(showId: string, market: Market = 'broadway'): ScoreResult {
  const shows = (awardsData as { shows: Record<string, AwardsShowEntry> }).shows;
  const entry = shows[showId];
  if (!entry) {
    return { rawPoints: 0, displayScore: 0, badge: 'eligible', inProgress: false, breakdown: [], tonyWins: 0, tonyNoms: 0, tonySeason: undefined };
  }
  const breakdown: CeremonyContribution[] = [];
  if (entry.tony) {
    const wins = entry.tony.wins ?? [];
    const noms = entry.tony.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Tony Awards', 'tony', wins, noms, unknownNoms(entry.tony.nominations, wins, noms)));
  }
  if (entry.pulitzer || entry.pulitzerFinalist) {
    const wins = entry.pulitzer?.wins ?? [];
    const finalists = entry.pulitzer?.finalist ? [...entry.pulitzer.finalist] : [];
    if (entry.pulitzerFinalist) finalists.push('Drama');
    breakdown.push(scoreCeremony('Pulitzer Prize', 'pulitzer', wins, finalists));
  }
  if (entry.olivier) {
    const key: CeremonyKey = market === 'broadway' ? 'olivier_bway' : 'olivier_we';
    const wins = entry.olivier.wins ?? [];
    const noms = entry.olivier.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Olivier Awards', key, wins, noms, unknownNoms(entry.olivier.nominations, wins, noms)));
  }
  if (entry.nyDramaCritics && !entry.nyDramaCritics.noAward) {
    breakdown.push(scoreCeremony("NY Drama Critics' Circle", 'nydcc', entry.nyDramaCritics.wins ?? [], []));
  }
  if (entry.outerCriticsCircle) {
    const wins = entry.outerCriticsCircle.wins ?? [];
    const noms = entry.outerCriticsCircle.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Outer Critics Circle', 'occ', wins, noms, unknownNoms(entry.outerCriticsCircle.nominations, wins, noms)));
  }
  if (entry.dramaLeague) {
    const wins = entry.dramaLeague.wins ?? [];
    const noms = entry.dramaLeague.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Drama League', 'dramaLeague', wins, noms));
  }
  if (entry.dramadesk) {
    const wins = entry.dramadesk.wins ?? [];
    const noms = entry.dramadesk.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Drama Desk', 'dramaDesk', wins, noms, unknownNoms(entry.dramadesk.nominations, wins, noms)));
  }
  if (entry.obie) {
    const wins = entry.obie.wins ?? [];
    breakdown.push(scoreCeremony('Obie Awards', 'obie', wins, []));
  }
  if (entry.lortel) {
    const wins = entry.lortel.wins ?? [];
    const noms = entry.lortel.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Lucille Lortel Awards', 'lortel', wins, noms, unknownNoms(entry.lortel.nominations, wins, noms)));
  }
  if (entry.oba) {
    const wins = entry.oba.wins ?? [];
    const noms = entry.oba.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Off Broadway Alliance Awards', 'oba', wins, noms));
  }
  if (entry.criticsCircle) {
    const wins = entry.criticsCircle.wins ?? [];
    const noms = entry.criticsCircle.nominatedFor ?? [];
    breakdown.push(scoreCeremony("Critics' Circle Theatre Awards", 'criticsCircle', wins, noms));
  }
  if (entry.eveningStandard) {
    const wins = entry.eveningStandard.wins ?? [];
    const noms = entry.eveningStandard.nominatedFor ?? [];
    breakdown.push(scoreCeremony('Evening Standard Theatre Awards', 'eveningStandard', wins, noms));
  }
  if (entry.whatsOnStage) {
    const wins = entry.whatsOnStage.wins ?? [];
    const noms = entry.whatsOnStage.nominatedFor ?? [];
    breakdown.push(scoreCeremony('WhatsOnStage Awards', 'whatsOnStage', wins, noms));
  }
  const rawPoints = breakdown.reduce((s, b) => s + b.subtotal, 0);
  // Hard-cap display at 100 — UX call: scores >100 read as bugs.
  const displayScore = Math.max(0, Math.min(100, Math.round(40 * Math.log10(1 + rawPoints / 4))));
  const totalWins = breakdown.reduce((s, b) => s + b.items.filter(i => i.result === 'win').length, 0);
  let badge: TierBadge;
  if (displayScore === 0) badge = 'eligible';
  // "Nominated" = recognized but 0 wins across all ceremonies. Any win earns at least Honored.
  else if (totalWins === 0) badge = 'nominated';
  else if (displayScore <= 69) badge = 'honored';
  else if (displayScore <= 89) badge = 'decorated';
  else badge = 'sweeper';
  // In-progress = the show's ceremony hasn't happened yet AND it has no wins.
  // Switched from "showSeason === currentSeason.label" (which dropped the flag
  // for shows in the April-cutoff-to-June-ceremony gap because currentSeason
  // had already advanced to the next eligibility window). 2026-05-16.
  const showSeason = entry.tony?.season;
  const tonyDone = (entry.tony?.wins?.length ?? 0) > 0;
  const inProgress = !!showSeason && !tonyDone && tonyCeremonyIsFuture(showSeason);
  const tonyWins = entry.tony?.wins?.length ?? 0;
  const tonyNoms = entry.tony?.nominatedFor?.length ?? 0;
  return { rawPoints, displayScore, badge, inProgress, breakdown, tonyWins, tonyNoms, tonySeason: showSeason };
}

interface PrecursorNode { wins?: string[]; nominatedFor?: string[]; nominations?: number }
interface AwardsShowEntry {
  tony?: PrecursorNode & { season?: string; ceremony?: string };
  dramadesk?: PrecursorNode & { season?: string };
  outerCriticsCircle?: PrecursorNode & { season?: string };
  dramaLeague?: PrecursorNode & { season?: string };
  nyDramaCritics?: PrecursorNode & { season?: string; noAward?: boolean };
  obie?: PrecursorNode & { season?: string };
  lortel?: PrecursorNode & { season?: string };
  oba?: PrecursorNode & { season?: string };
  criticsCircle?: PrecursorNode & { season?: string };
  eveningStandard?: PrecursorNode & { season?: string };
  whatsOnStage?: PrecursorNode & { season?: string };
  pulitzer?: { wins?: string[]; finalist?: string[]; year?: number };
  pulitzerFinalist?: { year?: number; note?: string };
  olivier?: PrecursorNode & { season?: string };
}
