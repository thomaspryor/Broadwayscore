'use strict';

/**
 * ny-tax-credit.js — the NY City Musical and Theatrical Production Tax Credit
 * each recoupment model counts (BRO-5517). recoupment-model.js (weekly and
 * lifetime) and investor-return-model.js all call nyTaxCredit(), so the three
 * no longer keep their own copy of the formula.
 *
 * The program pays 25% of qualified costs, up to $3M per Broadway production,
 * for runs overlapping Aug 2021 - 2027 (deadline extensions in Sep and Nov
 * 2025, then the FY2027 top-up from Dec 1 2025, left no gap in eligibility).
 * The old formula, 25% of the cap plus up to a year of running costs, put 79
 * of 87 modelled shows at the $3M maximum. Of the 107 productions paid
 * through May 2025 only 45 got it: salaries count only to $200K, marketing at
 * half, royalties and legal not at all. Appropriate got $1,720,089 against a
 * modelled $3M, 80% of its $3.75M capitalization.
 *
 * So a published award wins. RECEIVED is what Empire State Development paid
 * (its payout list, amounts as paid); ALLOCATED is what ESD had set aside
 * from a production's application estimate as of Aug 18 2025, not yet paid
 * then. Both are keyed by show slug (tests/unit/ny-tax-credit.test.mjs checks
 * every key names a real show). A show on neither list keeps the formula,
 * refitted to the published awards: 13% of the cap plus up to 39 weeks of
 * running costs. Over the 90 modelled shows with an award the old formula
 * was off by $303K on average, nearly all of it too high; the refit is off
 * by $173K.
 */

const SOURCES = {
  received: 'https://www.investmentbroadway.com/post/so-who-received-the-new-york-city-musical-and-theatrical-production-tax-credit',
  allocated: 'https://www.broadwayworld.com/article/Exclusive-Inside-the-Numbers-Who-Benefited-and-Why-Broadway-Still-Needs-a-Tax-Credit-20250904',
  paid2026: 'https://news.bloombergtax.com/daily-tax-report/broadway-shows-backed-by-disney-billionaires-nab-ny-tax-credits',
  nysFocus2026: 'https://nysfocus.com/2026/03/19/new-york-broadway-tax-credit-flops',
};
const LISTS_AS_OF = '2025-08-18';

const TAX_CREDIT_MAX = 3000000;
const TAX_CREDIT_RATE = 0.25; // statutory rate, on qualified costs only
// Fit to the published awards (BRO-5517): the share of the cap plus running
// costs that the 25% lands on, and how many weeks of running costs it covers.
const FORMULA_RATE = 0.13;
const QUALIFYING_WEEKS = 39;
const TAX_CREDIT_PROGRAM_START = new Date('2021-08-01');
const TAX_CREDIT_PROGRAM_END = new Date('2027-12-31');

/**
 * Paid by ESD: [amount, date paid], through its May 22 2025 payout list plus
 * the 2026 payments Bloomberg Tax reported (below). A date
 * comes from the payout list: an amount paid once dates itself, a $3M award
 * is dated by the entity it went to ("Kiss The Cod Broadway LP" is Come From
 * Away). The two Disney awards (Buena Vista Theatrical Group, Mar 27 and Jun
 * 30 2023) take the later date, and the six $3M awards whose entity names no
 * show (DEH, Mrs. Doubtfire, Funny Girl, Harmony, The Notebook, Tommy) take the
 * latest unassigned $3M payout, Mar 10 2025: paid on or before that day.
 *
 * An optional third element is what ESD had allocated before it paid
 * ([amount, date paid, allocated]): a run replayed before the payment counts
 * that allocation, not the later payout (BRO-6218). Without it the payout
 * stands in for the allocation.
 */
const RECEIVED = {
  'the-phantom-of-the-opera-1988': [3000000, '2024-02-02'],
  'chicago': [3000000, '2024-06-10'],
  'the-lion-king': [3000000, '2023-06-30'],
  'wicked': [3000000, '2023-11-13'],
  'book-of-mormon': [3000000, '2023-09-05'],
  'aladdin': [3000000, '2023-06-30'],
  'dear-evan-hansen-2016': [3000000, '2025-03-10'],
  'come-from-away-2017': [3000000, '2023-09-05'],
  'harry-potter': [3000000, '2023-06-30'],
  'aint-too-proud-2019': [2556695, '2022-08-04'],
  'hadestown': [3000000, '2023-06-30'],
  'moulin-rouge': [3000000, '2022-08-04'],
  'tina-2019': [3000000, '2023-03-27'],
  'jagged-little-pill-2019': [2161741, '2022-08-04'],
  'six': [3000000, '2024-02-02'],
  'the-minutes-2022': [1892161, '2023-09-05'],
  'company-2021': [3000000, '2024-02-02'],
  'the-lehman-trilogy-2021': [2091142, '2023-12-07'],
  'dana-h-2021': [1095570, '2023-09-05'],
  'thoughts-of-a-colored-man-2021': [1389604, '2022-12-16'],
  'mrs-doubtfire-2021': [3000000, '2025-03-10'],
  'the-music-man-2022': [3000000, '2023-09-05'],
  'plaza-suite-2022': [2000887, '2024-04-24'],
  'paradise-square-2022': [2409003, '2024-09-20'],
  'american-buffalo-2022': [1856405, '2023-09-05'],
  'take-me-out-2022': [1871543, '2023-11-13'],
  'funny-girl-2022': [3000000, '2025-03-10'],
  'macbeth-2022': [2468842, '2024-04-24'],
  'mr-saturday-night-2022': [3000000, '2024-06-10'],
  'beetlejuice-2022': [3000000, '2023-09-05'],
  'hangmen-2022': [1425055, '2023-09-05'],
  'a-strange-loop-2022': [3000000, '2023-12-07'],
  'potus-or-behind-every-great-dumbass-are-seven-women-trying-to-keep-him-alive-2022': [2410358, '2024-02-02'],
  'into-the-woods-2022': [3000000, '2024-09-20'],
  'the-kite-runner-2022': [1807992, '2023-12-07'],
  'leopoldstadt-2022': [3000000, '2024-09-20'],
  'death-of-a-salesman-2022': [2264686, '2024-04-24'],
  'the-piano-lesson-2022': [2824745, '2024-02-02'],
  'topdog-underdog-2022': [1500376, '2024-02-02'],
  'almost-famous-2022': [2864752, '2024-02-02'],
  'kimberly-akimbo-2022': [3000000, '2024-04-24'],
  'kpop-2022': [1870970, '2023-11-13'],
  'and-juliet': [3000000, '2024-02-02'],
  'mike-birbiglia-the-old-man-and-the-pool-2022': [1113518, '2024-04-24'],
  'some-like-it-hot-2022': [3000000, '2024-02-02'],
  'pictures-from-home-2023': [2054513, '2024-04-24'],
  'a-dolls-house-2023': [2199479, '2024-07-16'],
  'bad-cinderella-2023': [3000000, '2024-11-25'],
  'parade-2023': [3000000, '2024-11-25'],
  'sweeney-todd-2023': [3000000, '2024-09-20'],
  'shucked-2023': [3000000, '2024-06-10'],
  'life-of-pi-2023': [2335366, '2024-07-16'],
  'peter-pan-goes-wrong-2023': [2090546, '2024-09-20'],
  'fat-ham-2023': [1766958, '2024-07-16'],
  'new-york-new-york-2023': [3000000, '2024-09-20'],
  'good-night-oscar-2023': [2666334, '2024-06-10'],
  'prima-facie-2023': [1610194, '2024-07-16'],
  'the-sign-in-sidney-brusteins-window-2023': [1356623, '2024-07-16'],
  'grey-house': [2157302, '2024-07-16'],
  'once-upon-a-one-more-time': [3000000, '2024-06-10'],
  'here-lies-love': [3000000, '2024-09-20'],
  'just-for-us': [706459, '2024-11-25'],
  'back-to-the-future': [3000000, '2024-11-25'],
  'the-cottage': [2035549, '2024-11-25'],
  'the-shark-is-broken': [1596131, '2024-11-25'],
  'purlie-victorious': [2699224, '2024-11-25'],
  'gutenberg': [2677016, '2024-11-25'],
  'merrily-we-roll-along': [3000000, '2025-03-10'],
  'harmony': [3000000, '2025-03-10'],
  'spamalot': [3000000, '2024-09-20'],
  'appropriate': [1720089, '2025-01-29'],
  'days-of-wine-and-roses': [2248387, '2024-11-25'],
  'the-notebook': [3000000, '2025-03-10'],
  'water-for-elephants': [3000000, '2025-01-29'],
  'the-whos-tommy': [3000000, '2025-03-10'],
  'the-outsiders': [3000000, '2025-05-22'],
  'hells-kitchen': [3000000, '2025-01-29'],
  'the-great-gatsby': [3000000, '2025-01-29'],
  'the-wiz': [3000000, '2025-03-10'],
  'mother-play': [1151854, '2025-05-22'],
  // Paid in 2026 on or before Jun 2 (Bloomberg Tax, from ESD records: 19 shows,
  // $33.5M this year). Glengarry "$2.7 million" and Enemy "roughly $2.3
  // million" are rounded as reported; All In keeps its allocated $1,474,276
  // ("about $1.5 million").
  'buena-vista-social-club': [3000000, '2026-06-02'],
  'maybe-happy-ending': [3000000, '2026-06-02'],
  'gypsy-2024': [3000000, '2026-06-02'],
  'glengarry-glen-ross-2025': [2700000, '2026-06-02'],
  'an-enemy-of-the-people': [2300000, '2026-06-02'],
  'all-in-comedy-about-love-2024': [1474276, '2026-06-02'],
  // New York Focus (Mar 19 2026), from ESD's payout list through Feb 2026:
  // Tammy Faye "received $2.5 million from the state earlier this year" and
  // Lempicka "got $2.6 million", both rounded as reported. Dated by the
  // report, so paid on or before that day; both had $3M allocated on Aug 18
  // 2025 (BRO-6218).
  'tammy-faye-2024': [2500000, '2026-03-19', 3000000],
  'lempicka': [2600000, '2026-03-19', 3000000],
};

/** Allocated by ESD from the application estimate, not yet paid on Aug 18 2025
 * (nor reported paid since). */
const ALLOCATED = {
  'suffs': 3000000,
  'heart-of-rock-and-roll': 3000000,
  'how-to-dance-in-ohio': 3000000,
  'cabaret-2024': 3000000,
  'patriots': 2121102,
  'stereophonic': 1772703,
  'mary-jane': 1185897,
  'illinoise': 2040628,
  'prayer-for-the-french-republic': 1161229,
  'oh-mary': 1664721,
  'job-2024': 1211350,
  'once-upon-a-mattress-2024': 2391962,
  'the-roommate': 2048115,
  'the-hills-of-california-2024': 2166232,
  'yellow-face-2024': 1145907,
  'our-town': 3000000,
  'romeo-juliet-2024': 3000000,
  'left-on-tenth-2024': 2238013,
  'sunset-boulevard-2024': 3000000,
  'a-wonderful-world-the-louis-armstrong-musical-2024': 3000000,
  // Dead Outlaw was paid "more than $2 million" by Jun 2 2026 (Bloomberg
  // Tax); the amount is not published, so its allocation stands.
  'death-becomes-her': 3000000,
  'swept-away-2024': 3000000,
  'elf-2024': 1930752,
  'cult-of-love-2024': 1254711,
  'eureka-day-2024': 1197869,
  'english-2025': 1029877,
  'redwood': 3000000,
  'operation-mincemeat': 3000000,
  'othello-2025': 3000000,
  'purpose-2025': 2306986,
  'the-picture-of-dorian-gray-2025': 2411390,
  'boop': 3000000,
  'smash-2025': 3000000,
  'good-night-and-good-luck-2025': 2568158,
  'the-last-five-years-2025': 2032330,
  'john-proctor-is-the-villain-2025': 2015243,
  'stephen-sondheims-old-friends-2025': 1483806,
  'stranger-things': 3000000,
  'just-in-time': 3000000,
  'real-women-have-curves': 3000000,
  'pirates-the-penzance-musical-2025': 2166348,
  'dead-outlaw-2025': 3000000,
  'call-me-izzy': 1636220,
  'mamma-mia': 3000000,
};

/** The refitted formula for a show with no published award. */
function formulaCredit(capitalization, qualifyingRunningCosts) {
  return Math.min(FORMULA_RATE * ((capitalization || 0) + Math.max(qualifyingRunningCosts || 0, 0)), TAX_CREDIT_MAX);
}

/**
 * The credit a model counts for one show.
 *
 * Order: nothing when the run does not overlap the program (checked first, so
 * a backtest replayed before 2021 never counts a later award); an ESD payment
 * made by `now`; the record's notes (an explicit "not received" is 0,
 * BRO-4623, or a stated amount); an ESD allocation, or a payment not yet made
 * at `now`; the formula.
 *
 * @param {object} p
 * @param {string} p.slug - show.slug || show.id
 * @param {number|null} p.notesCredit - parseTaxCreditFromNotes(commercial.notes)
 * @param {boolean} p.eligible - the run overlaps the program window (each model dates its own run)
 * @param {number} p.capitalization
 * @param {number} p.qualifyingRunningCosts - running costs of the first QUALIFYING_WEEKS played weeks
 * @param {Date|number} [p.now] - the run's "today" (a backtest's asOf); defaults to now
 * @returns {{ amount: number, basis: 'received'|'notes'|'allocated'|'formula'|'ineligible', received: boolean }}
 *   received: ESD had paid it by `now`, which counts as cited for the "% returned so far" run.
 */
function nyTaxCredit({ slug, notesCredit, eligible, capitalization, qualifyingRunningCosts, now = Date.now() }) {
  if (!eligible) return { amount: 0, basis: 'ineligible', received: false };
  const paid = RECEIVED[slug];
  if (paid && Date.parse(paid[1]) <= +now) return { amount: paid[0], basis: 'received', received: true };
  if (notesCredit != null) return { amount: notesCredit, basis: 'notes', received: false };
  const allocated = paid ? (paid[2] ?? paid[0]) : ALLOCATED[slug];
  if (allocated != null) return { amount: allocated, basis: 'allocated', received: false };
  return { amount: formulaCredit(capitalization, qualifyingRunningCosts), basis: 'formula', received: false };
}

// A dollar amount right next to "tax credit" in a record's notes: "Expected
// ~$1.9M NY state tax credit", "a tax credit of $2.7 million", "$1,892,161 in
// NYC tax credit". An amount further away is about something else ("its
// $5.25M capitalization ... helped by the revived tax credit"). "More than"
// and "up to" make the amount a bound, not a figure.
const NOTE_BOUND = String.raw`(?:(more than|over|at least|upwards of|up to|as much as)\s+)?`;
const NOTE_AMOUNT = String.raw`~?\$\s?(\d[\d,]*(?:\.\d+)?)\s*(million|mil|mm|m|k)?\b`;
const NOTE_CREDIT_RES = [
  new RegExp(NOTE_BOUND + NOTE_AMOUNT + String.raw`\s+(?:(?:in|ny|nyc|new|york|state|city|theatrical|theater|theatre|production|broadway)\s+){0,4}tax[\s-]*credit`, 'gi'),
  new RegExp(String.raw`tax[\s-]*credit\s*(?:of|worth|totaling|totalling|was|is|:)?\s*(?:about|roughly|approximately)?\s*` + NOTE_BOUND + NOTE_AMOUNT, 'gi'),
];
const LOWER_BOUND_RE = /^(?:more than|over|at least|upwards of)$/;

/**
 * Tax credit amounts a record's notes give that disagree with the award this
 * module counts for the show: more than 10% off, or a bound the award breaks
 * ("up to $1.75M" beside a $3M allocation). Notes print on the show card, so a
 * guess written before the award ("Expected ~$1.9M" for Glengarry, paid $2.7M)
 * must not outlive it (BRO-5517). A show with no award listed has nothing to
 * compare with. Callers warn; none refuses a write, because a new award would
 * otherwise block every write to an older record.
 * @returns {{ noted: number, counted: number, bound: string, message: string }[]}
 */
function taxCreditNoteConflicts(slug, notes) {
  const counted = RECEIVED[slug] ? RECEIVED[slug][0] : ALLOCATED[slug];
  if (counted == null || typeof notes !== 'string') return [];
  const found = new Map();
  for (const re of NOTE_CREDIT_RES) {
    for (const m of notes.matchAll(re)) {
      const bound = (m[1] || '').toLowerCase();
      const unit = (m[3] || '').toLowerCase();
      const n = parseFloat(m[2].replace(/,/g, ''));
      const noted = unit === 'k' ? n * 1e3 : (unit || n < 1000) ? n * 1e6 : n;
      const off = !bound ? Math.abs(noted - counted) > 0.1 * counted
        : LOWER_BOUND_RE.test(bound) ? counted < 0.9 * noted
        : counted > 1.1 * noted;
      if (!off) continue;
      const millions = (v) => `$${(v / 1e6).toFixed(2)}M`;
      found.set(`${bound}|${noted}`, {
        noted, counted, bound,
        message: `notes give a tax credit of ${bound ? bound + ' ' : ''}${millions(noted)}, but the award counted is ${millions(counted)} (scripts/lib/ny-tax-credit.js); update the note`,
      });
    }
  }
  return [...found.values()];
}

module.exports = {
  nyTaxCredit, formulaCredit, taxCreditNoteConflicts,
  RECEIVED, ALLOCATED, SOURCES, LISTS_AS_OF,
  TAX_CREDIT_MAX, TAX_CREDIT_RATE, FORMULA_RATE, QUALIFYING_WEEKS,
  TAX_CREDIT_PROGRAM_START, TAX_CREDIT_PROGRAM_END,
};
