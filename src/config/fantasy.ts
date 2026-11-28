/**
 * Broadway Fantasy League — Configuration & Types
 *
 * Season constants and point tables live in ./fantasy-season.json so the
 * site, the API routes and the weekly scripts (generate-fantasy-config.js,
 * compute-fantasy-scores.js) all read ONE file. The 2025-26 trial kept two
 * hand-copied sets of constants and they drifted (the draft deadline in
 * fantasy.ts said Dec 31 while the generator said Feb 7).
 */

// Import canonical tier labels from scoring.ts — never hardcode these
import { getCriticLabel } from './scoring';
import seasonConfig from './fantasy-season.json';

// Re-export so consumers can use it
export { getCriticLabel };

// ===========================================
// SEASON CONFIG
// ===========================================

export const FANTASY_SEASON: string = seasonConfig.season;
export const FANTASY_TONY_CEREMONY_YEAR: number = seasonConfig.tonyCeremonyYear;
export const FANTASY_TONY_WINDOW = seasonConfig.tonyWindow as { label: string; start: string; end: string };
export const FANTASY_BUDGET: number = seasonConfig.budget;
/** Maximum roster size. Fewer picks are allowed (the budget is the real constraint). */
export const FANTASY_TEAM_SIZE: number = seasonConfig.teamSize;
export const DRAFT_OPENS: string = seasonConfig.draftOpens;
export const DRAFT_DEADLINE: string = seasonConfig.draftDeadline;
export const SCORING_START: string = seasonConfig.scoringStart;
/**
 * Entries drafted on or before this date (New York time) score box office
 * from SCORING_START. Later entries score box office from the week they
 * draft. See scoringFromDate().
 */
export const EARLY_BIRD_CUTOFF: string = seasonConfig.earlyBirdCutoff;
export const SCORING_END: string = seasonConfig.scoringEnd; // Tony Awards night (provisional until announced)
export const PRIZE_DESCRIPTION: string = seasonConfig.prize;
/** Short prize amount for badges (homepage promo pill); absent means no cash prize. */
export const PRIZE_VALUE: string | undefined = (seasonConfig as { prizeValue?: string }).prizeValue;

// ===========================================
// SCORING POINT MAPPINGS
// ===========================================

/**
 * CriticScore tier → fantasy points. Labels must match getCriticLabel() output.
 *
 * Calibrated so CriticScore is ~15-18% of a strong show's total points.
 * A "Critical Gold" show earns 30 pts (vs 180 possible from awards).
 */
export const CRITIC_SCORE_POINTS: Record<string, number> = seasonConfig.scoring.criticScore;

/**
 * AudienceGrade → fantasy points. Grades must match getAudienceGrade() output.
 *
 * Calibrated so AudienceGrade is ~10-12% of a strong show's total.
 */
export const AUDIENCE_GRADE_POINTS: Record<string, number> = seasonConfig.scoring.audienceGrade;

/**
 * Box office: points per $100K weekly gross.
 *
 * At 0.30, a strong musical ($1M/week over 20 weeks) earns ~60 pts.
 * This makes box office ~25% of a Best Musical winner's total.
 */
export const BOX_OFFICE_POINTS_PER_100K: number = seasonConfig.scoring.boxOffice.pointsPer100K;

/**
 * Awards point values — Tonys + pre-Tony ceremonies.
 *
 * Multiple ceremonies create scoring events across 6 weeks (mid-May to mid-June),
 * not just one Tony night. Awards still ~45-50% of a strong show's total.
 *
 * Tony Awards (June): biggest single event — wins weigh 4x a nom;
 *   Best Musical/Play 1.5x a regular win
 * Drama League (mid-May): noms + wins
 * Outer Critics Circle (late May): noms + wins, covers BW + OB
 * Drama Desk (late May/early June): noms + wins, covers BW + OB
 * NY Drama Critics' Circle (early May): wins only (best play, best musical)
 * Lucille Lortel Awards (early May): noms + wins, OB only
 * Obies are not scored: their season runs Sept-Aug and the ceremony follows
 * the next February, so this season's shows win them after scoring ends.
 */
export const AWARDS_POINTS = seasonConfig.scoring.awards;

/** Award ceremonies that score, counted from the scoring keys (tonyNom, tonyWin, tonyBestMusical → tony),
 *  so page copy can't drift from the rules (the FAQ said "seven" after Obie was dropped, BRO-5667). */
export const AWARD_CEREMONY_COUNT = new Set(
  Object.keys(AWARDS_POINTS).map(k => k.replace(/(Nom|Win|Award|BestMusical|BestPlay)$/, '')),
).size;

// ===========================================
// TIEBREAKERS
// ===========================================

export const TIEBREAKER_QUESTIONS = [
  { id: 'tony-noms-most', question: 'How many nominations will the most-nominated show receive?', type: 'number' as const },
  { id: 'best-musical-winner', question: 'Which show will win Best Musical?', type: 'show-best-musical' as const },
  { id: 'total-tony-noms', question: 'How many total Tony nominations will there be?', type: 'number' as const },
];

// ===========================================
// ELIGIBILITY MARKERS
// ===========================================

/** Shown on draft form next to show name */
export const ELIGIBILITY_MARKERS = {
  criticScoreLocked: '★',   // CriticScore already public (opened before you drafted)
  offBroadway: '†',          // Off-Broadway (no box office, no Tonys)
};

// ===========================================
// TYPES
// ===========================================

export interface FantasyShowEligibility {
  /** False when the show opened before DRAFT_OPENS: its score was public before anyone could draft. */
  criticScore: boolean;
  audienceGrade: boolean;
  boxOffice: boolean;
  tonys: boolean;
}

export interface FantasyShow {
  price: number;
  eligible: FantasyShowEligibility;
  title: string;
  type: 'musical' | 'play' | 'special';
  category: 'broadway' | 'off-broadway';
  status: string;
  openingDate: string | null;
  closingDate?: string | null;
  isRevival?: boolean;
  /** Current CriticScore if available (for draft research) */
  criticScore?: number | null;
  /** Current AudienceGrade if available (for draft research) */
  audienceGrade?: string | null;
  /**
   * New York date the weekly generator first saw an audience grade for this
   * show (append-only). Audience reviews start in previews, so a grade can be
   * public before opening night; entries drafted on or after this date earn
   * no audience points for the show.
   */
  audienceGradeSince?: string | null;
  slug: string;
  /** Thumbnail image path */
  image?: string | null;
}

export interface FantasyLeagueConfig {
  _meta: {
    season: string;
    draftDeadline: string;
    scoringStart: string;
    scoringEnd: string;
    earlyBirdCutoff?: string;
    budget: number;
    teamSize: number;
    generatedAt: string;
    pricing?: {
      source?: 'frozen' | 'heuristic';
      method?: 'ev' | 'heuristic' | 'preseason-ev';
      k?: number | null;
      frozenAt?: string | null;
      targetTopPrice?: number;
      evSource?: string | null;
      evLastUpdated?: string | null;
      repricedAt?: string;
    };
  };
  shows: Record<string, FantasyShow>;
  scoring: {
    criticScore: Record<string, number>;
    audienceGrade: Record<string, number>;
    boxOffice: { pointsPer100K: number };
    awards: Record<string, number>;
  };
}

export interface FantasyShowScore {
  criticScorePoints: number;
  audienceGradePoints: number;
  boxOfficePoints: number;
  awardsPoints: number;
  totalPoints: number;
  /** Week-ending date → box office points for that week (season window only). */
  weeklyBoxOffice?: Record<string, number>;
  /** ISO opening date, used for the per-entry CriticScore lock. */
  openingDate?: string | null;
  /** First date an audience grade was public (see FantasyShow.audienceGradeSince). */
  audienceGradeSince?: string | null;
  breakdown: {
    criticTier: string | null;
    audienceGrade: string | null;
    boxOfficeWeeks: number;
    boxOfficeTotal: string;
    awards: string[];
  };
}

export interface FantasyScoresData {
  _meta: {
    lastUpdated: string;
    weekEnding: string;
    season: string;
  };
  showScores: Record<string, FantasyShowScore>;
}

export interface FantasyEntry {
  id: string;
  email: string;
  team_name: string | null;
  league_name: string | null;
  picks: string[]; // show IDs
  total_cost: number;
  season: string;
  created_at: string;
}

export interface LeaderboardEntry {
  id: string;
  rank: number;
  displayName: string; // team_name or masked email
  totalPoints: number;
  /** ISO date the entry's box office scoring starts (see scoringFromDate) */
  scoringFrom: string;
  picks: Array<{
    showId: string;
    showTitle: string;
    price: number;
    points: number;
    /** True when the show had already opened when this entry drafted it (no critic/audience points). */
    scoreLocked: boolean;
  }>;
  pointBreakdown: {
    criticScore: number;
    audienceGrade: number;
    boxOffice: number;
    awards: number;
  };
}

// ===========================================
// HELPERS
// ===========================================

/** Mask email for public display: tom@gmail.com → t***@gmail.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}***@${domain}`;
}

/**
 * The address one person's entry is keyed by. Providers that ignore a +tag
 * (and Gmail, which also ignores dots) deliver every variant to one inbox, so
 * those variants must collide on the (email, season) unique key or one person
 * can enter many times for the prize. Other domains are only lower-cased: a
 * '+' there may be a real part of the mailbox name.
 */
const PLUS_TAG_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'fastmail.com', 'proton.me', 'protonmail.com', 'pm.me',
]);
export function canonicalFantasyEmail(email: string): string {
  const lower = email.toLowerCase().trim();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (!PLUS_TAG_DOMAINS.has(domain)) return lower;
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  // "...@gmail.com" or "+x@outlook.com" would canonicalize to "@domain",
  // which the database rejects (a 500): keep such an address as typed.
  if (!local) return lower;
  return `${local}@${domain}`;
}

/** Check if draft deadline has passed */
export function isDraftClosed(now: Date = new Date()): boolean {
  return now > new Date(DRAFT_DEADLINE);
}

/**
 * Practice drafts for testers (BRO-5487): /fantasy/draft?practice=1 until the
 * real draft opens. Saved under their own season, which nothing that reads the
 * real season selects (leaderboard, leagues, ownership, weekly email, admin),
 * so practice teams never count. Must stay within the insert policy's 4 to 20
 * characters (20261016_fantasy_entries_insert_hardening.sql).
 */
export const PRACTICE_SEASON = `${FANTASY_SEASON}-practice`;

/** Practice drafts take entries until the real draft opens (New York date). */
export function isPracticeOpen(now: Date = new Date()): boolean {
  return nyDate(now.toISOString()) < DRAFT_OPENS;
}

export type DraftMode = 'practice' | 'practice-over' | 'not-open' | 'open' | 'closed';

/**
 * Which draft a page or request is in. `practiceRequested` is the link's
 * intent (?practice=1), never inferred from the clock: a practice form left
 * open past midnight on draft day must not turn into a real, final entry. The
 * draft page and /api/fantasy/draft both decide with this (BRO-5487).
 */
export function draftMode(practiceRequested: boolean, now: Date = new Date()): DraftMode {
  if (isDraftClosed(now)) return 'closed';
  if (practiceRequested) return isPracticeOpen(now) ? 'practice' : 'practice-over';
  return isDraftOpen(now) ? 'open' : 'not-open';
}

/** Check if the draft is open: on or after DRAFT_OPENS (a New York calendar date) and before the deadline */
export function isDraftOpen(now: Date = new Date()): boolean {
  // The exact complement of the practice window, so the two never overlap.
  return !isPracticeOpen(now) && !isDraftClosed(now);
}

/**
 * New York calendar date (YYYY-MM-DD) for an ISO timestamp. Fantasy rules are
 * stated in New York time: a show "opened" on its opening date, grosses weeks
 * end on Sundays, and an entry drafted at 11pm ET on opening night has seen
 * the reviews.
 */
const NY_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

export function nyDate(iso: string): string {
  return NY_DAY.format(new Date(iso));
}

/** The draft deadline as a New York calendar date (the deadline is 11:59pm ET). */
export function draftDeadlineDate(): string {
  return DEADLINE_DAY;
}
const DEADLINE_DAY = nyDate(DRAFT_DEADLINE);

/**
 * The NY day an entry counts as drafted on: its stamp, clamped to the deadline
 * day. An entry the route accepted at 11:59:59pm that the database stamps a
 * moment past midnight (DEADLINE_GRACE_MS lets it count at all) keeps the
 * deadline day for every rule: box office week and critic/audience locks.
 */
function draftedDay(createdAtIso: string): string {
  const stamped = nyDate(createdAtIso);
  return stamped > DEADLINE_DAY ? DEADLINE_DAY : stamped;
}

/**
 * True when drafting stays open after the early-bird cutoff (late entries
 * score box office from the day they draft). False for a single draft window:
 * every entry is an early bird and box office starts at SCORING_START for all.
 */
export function hasLateEntry(): boolean {
  return EARLY_BIRD_CUTOFF < draftDeadlineDate();
}

/**
 * The date an entry starts earning box office points. Early-bird entries
 * (drafted on or before EARLY_BIRD_CUTOFF) score from SCORING_START so the
 * launch cohort competes on equal footing; later entries score from the day
 * they draft. Same rule as BroadwayWorld's Producer Fantasy Game grace window.
 */
export function scoringFromDate(createdAtIso: string): string {
  const drafted = draftedDay(createdAtIso);
  if (drafted <= EARLY_BIRD_CUTOFF) return SCORING_START;
  // The Monday of the draft week: grosses weeks run Monday to Sunday and are
  // keyed by their Sunday, so this scores exactly the same weeks as the draft
  // day itself, and "box office counts from the week of Mon Nov 9" reads
  // right for a Sunday drafter too. Never before SCORING_START.
  const monday = mondayOf(drafted);
  return monday < SCORING_START ? SCORING_START : monday;
}

/** Monday (YYYY-MM-DD) of the Monday-to-Sunday week containing a calendar date. */
export function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Whether an entry can earn CriticScore / AudienceGrade points for a show.
 * Locked when the show had opened on or before the day the entry was drafted:
 * reviews drop on opening night, so anyone drafting from that day on already
 * knows the score. Shows with no opening date (TBA) are never locked.
 */
export function isScoreLockedForEntry(openingDate: string | null | undefined, createdAtIso: string): boolean {
  if (!openingDate) return false;
  return openingDate <= draftedDay(createdAtIso);
}

/**
 * Whether drafting this show now earns no critic/audience points: it opened
 * before the draft opened (locked for everyone) or has opened since (locked
 * for anyone drafting from opening night on). Drives every "Already open"
 * label so players see the lock BEFORE they submit, not on the confirmation
 * screen after picks are final.
 */
export function isShowOpenForDrafter(
  show: Pick<FantasyShow, 'eligible' | 'openingDate'>,
  now: Date = new Date(),
): boolean {
  if (!show.eligible.criticScore) return true;
  return isScoreLockedForEntry(show.openingDate, now.toISOString());
}

/**
 * Audience points are locked for an entry when the show's audience grade was
 * already public on the New York day the entry was drafted. Grades can appear
 * during previews, before the opening-night critic lock applies.
 */
export function isAudienceLockedForEntry(audienceGradeSince: string | null | undefined, createdAtIso: string): boolean {
  if (!audienceGradeSince) return false;
  return audienceGradeSince <= draftedDay(createdAtIso);
}

/**
 * Whether a show can still earn box office points for a team whose box office
 * starts on `fromDate` (scoringFromDate of its draft time; SCORING_START for
 * the earliest teams): Broadway only, and still running on or after that
 * week's Monday. A show that closes earlier earns that team awards points only.
 */
export function earnsBoxOffice(
  show: Pick<FantasyShow, 'eligible' | 'closingDate'>,
  fromDate: string = SCORING_START,
): boolean {
  if (!show.eligible.boxOffice) return false;
  return !show.closingDate || show.closingDate >= fromDate;
}

/**
 * Plain-English note for a pick whose points are limited for this entry
 * (null when it can earn on every pillar). Shown on the confirmation screen
 * and in the confirmation email, so it must match computeLeaderboard.
 */
export function pickLimitNote(
  show: Pick<FantasyShow, 'eligible' | 'openingDate' | 'closingDate' | 'audienceGradeSince'>,
  createdAtIso: string,
): string | null {
  const criticLocked = !show.eligible.criticScore || isScoreLockedForEntry(show.openingDate, createdAtIso);
  const boxOffice = earnsBoxOffice(show, scoringFromDate(createdAtIso));
  if (criticLocked) return boxOffice ? 'already open: box office and awards only' : 'already open: awards only';
  if (isAudienceLockedForEntry(show.audienceGradeSince, createdAtIso)) return 'audience grade already public: no audience points';
  return null;
}

/**
 * An entry saved this long after the deadline still counts. The route refuses
 * submissions once the deadline passes, but the database stamps created_at
 * itself, a few milliseconds after the route's check; without this grace a
 * player who submitted at 11:59:59pm would get a confirmation and then vanish
 * from the standings.
 */
export const DEADLINE_GRACE_MS = 5 * 60 * 1000;

/** Validate a set of picks against the config */
export function validatePicks(
  pickIds: string[],
  shows: Record<string, FantasyShow>,
): { valid: boolean; error?: string } {
  if (pickIds.length < 1) {
    return { valid: false, error: 'Must pick at least 1 show' };
  }

  if (pickIds.length > FANTASY_TEAM_SIZE) {
    return { valid: false, error: `Too many picks: ${pickIds.length} > ${FANTASY_TEAM_SIZE}` };
  }

  // Strings only, own keys only: [["x"],["x"]] passes a Set duplicate check
  // and shows[["x"]] resolves to show x, and 'constructor' is a key of every
  // object. Either let one show be drafted eight times.
  for (const id of pickIds) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(shows, id)) {
      return { valid: false, error: `Invalid show: ${String(id).slice(0, 60)}` };
    }
  }

  const uniqueIds = new Set(pickIds);
  if (uniqueIds.size !== pickIds.length) {
    return { valid: false, error: 'Duplicate picks not allowed' };
  }

  const totalCost = pickIds.reduce((sum, id) => sum + shows[id].price, 0);
  if (totalCost > FANTASY_BUDGET) {
    return { valid: false, error: `Over budget: $${totalCost} > $${FANTASY_BUDGET}` };
  }

  return { valid: true };
}
