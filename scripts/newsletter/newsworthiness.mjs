// Newsworthiness scorer — ranks every potential story in the week so the
// subject line + editorial lede surface the BIGGEST actual development, not
// just the first item available in each feed (which was the prior failure
// mode flagged in the Codex review).
//
// Inputs: outputs from each newsletter section (`bwO`, `obO`, `tony` snapshot,
// `audienceBuzz`, `commercialFresh`, shows list, etc.). Each candidate carries
// a `weight` and a sentence template; we sort by weight and return the top N.

// Weights live at the top so tuning the policy doesn't require reading a
// function body — same pattern as src/lib/scoring.ts / src/lib/data-tony-predictions.ts.
// All weights are absolute (0–100). Add tier bumps inside each scorer.
//
// Tuning principle (2026-05-24): subscribers come for REVIEW news — what
// opened, what's critically rising/falling, what the Tony race looks like.
// Biz signals (recoupment, box office) are interesting context but must NOT
// lead the subject line. The first pass had RECOUPMENT_BASE=78 and a $5.6M
// Giant recoupment was burying the actual opening news; weights below
// re-anchor on the review-driven content the audience actually subscribes for.
import { createRequire } from 'node:module';
const { pluralize } = createRequire(import.meta.url)('../lib/pluralize.js');
// Canonical Delacorte/Free-Shakespeare-in-the-Park venue check — do not
// reinvent this as a local regex. review-guards.js already carries the
// scoped-to-outdoor-festival-stage definition (ship-check P0, 2026-06-16);
// duplicating it here as `/delacorte/i` would silently mislabel a future show
// venue'd as "Shakespeare in the Park" without the word "Delacorte" (second-
// opinion review, 2026-08-16).
const { showHasFestivalVenue } = createRequire(import.meta.url)('../lib/review-guards.js');

export const WEIGHTS = {
  BW_OPENING_BASE: 85,                // openings ARE the news — what subscribers wait for
  BW_OPENING_GOLD_BUMP: 15,           // critical-gold debut is the biggest event of the week
  OB_OPENING_BASE: 70,                // smaller market but still review news
  OB_OPENING_GOLD_BUMP: 15,
  // WE edition: West End (full-scale venue) is PRIMARY news, Off West End
  // (smaller venue) is SECONDARY — mirrors BW_OPENING_BASE/OB_OPENING_BASE
  // exactly (same base gap, same gold bump) so the subject/lede always leads
  // with a West End opening over an Off West End one, the way the US edition
  // always leads with Broadway over Off-Broadway (user, 2026-08-23: Jeeves
  // Takes Charge [Off West End] led the subject over Abigail's Party [West
  // End] purely because it had one more review — both were scored identically
  // regardless of venue tier before this fix).
  WE_OPENING_BASE: 85,
  WE_OPENING_GOLD_BUMP: 15,
  OFF_WE_OPENING_BASE: 70,
  OFF_WE_OPENING_GOLD_BUMP: 15,
  // US edition: a London opening of either tier is SECONDARY news — rank it
  // below every NY opening (OB_OPENING_BASE 70) so the editorial leads with
  // NY shows when they exist (user 2026-07-12). West End still outranks Off
  // West End within that secondary slot for the same reason as above.
  WE_OPENING_SECONDARY_BASE: 66,
  OFF_WE_OPENING_SECONDARY_BASE: 60,
  OUTLIER_BASE: 70,                   // a critic out of step IS review news
  OUTLIER_LARGE_BUMP: 10,             // ≥20pt delta from consensus
  BIGGEST_MOVER_BASE: 72,             // score moves are the most direct review signal
  BIGGEST_MOVER_LARGE_BUMP: 13,       // ≥10pt swing
  TONY_PREDICTION_BASE: 55,           // matters more as ceremony nears
  TONY_CEREMONY_NEAR_BUMP: 25,        // <14 days away — Tony week IS the news
  CLOSING_THIS_WEEK_BASE: 65,         // closing news is genuine fan-news
  CLOSING_LONG_RUN_BUMP: 8,
  ANNOUNCED_CLOSING_BASE: 58,
  RECOUPMENT_BASE: 50,                // biz news — interesting but secondary to reviews
  RECOUPMENT_FAST_BUMP: 6,            // <12 weeks-to-recoup is genuinely notable
  BUZZ_NEW_NUM_ONE: 48,               // social rotates fast; less stable signal
  BUZZ_HOLD_NUM_ONE: 25,
};

const SCORE_GOLD_MIN_NYC = 83;
const SCORE_GOLD_MIN_WE = 85;

function isGoldTier(score, category) {
  if (score == null) return false;
  const min = (category === 'west-end' || category === 'off-west-end')
    ? SCORE_GOLD_MIN_WE
    : SCORE_GOLD_MIN_NYC;
  return score >= min;
}

// Translate a composite critic score into the kind of phrase a human editor
// would write. "Rises 12 pts" is data-speak; "opens to decent reviews" reads
// like a newsletter. Returns the tier key (not the phrase) so callers can
// pick a variant for repetition-avoidance — see VERDICT_VARIANTS.
function reviewVerdictTier(score, category) {
  if (score == null) return null;
  const goldMin = (category === 'west-end' || category === 'off-west-end') ? SCORE_GOLD_MIN_WE : SCORE_GOLD_MIN_NYC;
  if (score >= goldMin) return 'rave';
  if (score >= 75)      return 'strong';
  if (score >= 65)      return 'decent';
  if (score >= 55)      return 'mixed';
  return 'rough';
}

// Synonym pool per tier. First entry is the "default" phrasing; later entries
// are swaps to use when the same tier shows up twice in one lede so we don't
// say "opens to decent reviews. … opens to decent reviews." First sentence
// always uses the default; subsequent same-tier sentences cycle through
// variants. Subject line always uses the default (it's only one shot).
const VERDICT_VARIANTS = {
  rave:   ['rave reviews', 'near-universal praise', 'glowing notices'],
  strong: ['strong reviews', 'enthusiastic notices', 'warm critical reception'],
  decent: ['decent reviews', 'a mostly-positive reception', 'broadly favorable notices'],
  mixed:  ['mixed reviews', 'a divided reception', 'split notices'],
  rough:  ['rough reviews', 'mostly-pans', 'a chilly reception'],
};

function reviewVerdict(score, category, variantIndex = 0) {
  const tier = reviewVerdictTier(score, category);
  if (!tier) return null;
  const pool = VERDICT_VARIANTS[tier];
  return pool[Math.min(variantIndex, pool.length - 1)];
}

// "Sun Aug 16" — same shape generate.mjs's `dayOf(d) + ' ' + fmt(d)` renders
// into the Closing this Week card and the `Last chance for …` context line, so
// the lede and the body agree on the wording as well as the date. Noon-anchored
// in America/New_York for the same reason those helpers are: a bare YYYY-MM-DD
// parses as UTC midnight and renders as the PREVIOUS day west of Greenwich.
// Returns '' for a missing/unparseable date so the caller degrades to an
// undated sentence instead of emitting "undefined" to subscribers.
export function formatClosingDay(closingDate) {
  if (typeof closingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(closingDate)) return '';
  const d = new Date(closingDate.slice(0, 10) + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' })
    + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

// Each candidate is `{ kind, weight, headline, show, slug }`. `headline` is the
// short imperative phrase that goes into the subject line and lede.
export function scoreCandidates(input) {
  const out = [];

  // 1. Broadway openings (or reopenings). Input items are `{show, isReopening}`
  // — the same flag the section uses, so headline verbiage matches the card.
  for (const item of (input.bwOpenings || [])) {
    const s = item.show || item; // backward compat if a bare show is passed
    const isReopen = !!item.isReopening;
    const score = input.aggregateScore ? input.aggregateScore(s.id)?.avg : null;
    const tier = reviewVerdictTier(score, s.category);
    const verdict = tier ? VERDICT_VARIANTS[tier][0] : null;
    const goldBump = isGoldTier(score, s.category) ? WEIGHTS.BW_OPENING_GOLD_BUMP : 0;
    const verb = isReopen ? 'reopens' : 'opens';
    const headline = verdict
      ? `${s.title} ${verb} to ${verdict}`
      : `${s.title} ${verb} on Broadway`;
    out.push({ kind: isReopen ? 'bw-reopening' : 'bw-opening', weight: WEIGHTS.BW_OPENING_BASE + goldBump, headline, show: s, slug: s.slug,
      verdictTier: tier, verdictPrefix: `${s.title} ${verb} to `, openingVenue: 'Broadway' });
  }

  // 1b. West End Gold openings — only Critical Gold WE shows enter the scorer.
  // Non-gold WE shows stay in London Openings but never lead the subject line.
  for (const item of (input.weGoldOpenings || [])) {
    const s = item.show || item;
    const score = input.aggregateScore ? input.aggregateScore(s.id)?.avg : null;
    const tier = reviewVerdictTier(score, s.category);
    const verdict = tier ? VERDICT_VARIANTS[tier][0] : null;
    // Edition-aware weight: PRIMARY in the West End edition (leads like a
    // Broadway opening); SECONDARY in the US edition (below NY openings so the
    // editorial leads with NY shows when they exist — user 2026-07-12). Within
    // either tier, West End (full-scale venue) always outweighs Off West End
    // (smaller venue) — mirrors Broadway always outweighing Off-Broadway.
    const isWeEdition = (input.edition || 'broadway') === 'west-end';
    const isWestEndVenue = s.category === 'west-end';
    const gold = isGoldTier(score, s.category);
    const weWeight = isWeEdition
      ? (isWestEndVenue ? WEIGHTS.WE_OPENING_BASE : WEIGHTS.OFF_WE_OPENING_BASE) + (gold ? (isWestEndVenue ? WEIGHTS.WE_OPENING_GOLD_BUMP : WEIGHTS.OFF_WE_OPENING_GOLD_BUMP) : 0)
      : (isWestEndVenue ? WEIGHTS.WE_OPENING_SECONDARY_BASE : WEIGHTS.OFF_WE_OPENING_SECONDARY_BASE);
    // "in London" is useful context in the US edition, but redundant in the
    // West End edition (the whole email IS the West End) — drop it there so it
    // reads "opens to strong reviews", not "opens in London..." (user 2026-07-12).
    const loc = isWeEdition ? '' : ' in London';
    const headline = verdict
      ? `${s.title} opens${loc} to ${verdict}`
      : `${s.title} opens${loc}`;
    out.push({ kind: 'we-gold-opening', weight: weWeight, headline, show: s, slug: s.slug,
      verdictTier: tier, verdictPrefix: `${s.title} opens${loc} to `,
      openingVenue: isWeEdition ? (isWestEndVenue ? 'the West End' : 'Off West End') : 'London' });
  }

  // 2. Off-Broadway openings (or reopenings).
  for (const item of (input.obOpenings || [])) {
    const s = item.show || item;
    const isReopen = !!item.isReopening;
    const score = input.aggregateScore ? input.aggregateScore(s.id)?.avg : null;
    const tier = reviewVerdictTier(score, s.category);
    const verdict = tier ? VERDICT_VARIANTS[tier][0] : null;
    const goldBump = isGoldTier(score, s.category) ? WEIGHTS.OB_OPENING_GOLD_BUMP : 0;
    const verb = isReopen ? 'reopens' : 'opens';
    // The Delacorte is Free Shakespeare in the Park — an outdoor, seasonal
    // Public Theater production, not a commercial off-Broadway house. "Opens
    // off-Broadway" reads as a category error to anyone who knows the venue
    // (user, 2026-08-16). shows.json still carries category:'off-broadway'
    // for market-routing/scoring purposes (out of scope here) — this only
    // changes the newsletter's editorial phrasing, shared by both editions.
    const isShakespeareInThePark = showHasFestivalVenue(s);
    const loc = isShakespeareInThePark ? 'at Free Shakespeare in the Park' : 'off-Broadway';
    const headline = verdict
      ? `${s.title} ${verb} ${loc} to ${verdict}`
      : `${s.title} ${verb} ${loc}`;
    out.push({ kind: isReopen ? 'ob-reopening' : 'ob-opening', weight: WEIGHTS.OB_OPENING_BASE + goldBump, headline, show: s, slug: s.slug,
      verdictTier: tier, verdictPrefix: `${s.title} ${verb} ${loc} to `, openingVenue: isShakespeareInThePark ? 'Free Shakespeare in the Park' : 'off-Broadway' });
  }

  // 3. Recoupment announcements (rarest biz news — high weight)
  for (const r of (input.recoupments || [])) {
    const weeks = r.weeksToRecoup;
    const fastBump = (weeks && weeks > 0 && weeks < 12) ? WEIGHTS.RECOUPMENT_FAST_BUMP : 0;
    const tail = (weeks && weeks > 0) ? ` recoups in ${pluralize(weeks, 'week')}` : ' recoups';
    out.push({
      kind: 'recoupment',
      weight: WEIGHTS.RECOUPMENT_BASE + fastBump,
      headline: `${r.show.title}${tail}`,
      show: r.show,
      slug: r.show.slug,
    });
  }

  // 4. Closings this week (final performances inside the week window)
  //
  // The date is NOT optional garnish. Until 2026-07-12 `closingsThisWeek` was
  // the week that just ENDED, so a bare "X plays final performance" was a
  // report on something that had already happened and read fine. That fix
  // (see generate.mjs `closingsThisWeek`) repointed the window at the NEXT 7
  // days to match the body's "Closing this Week" card — but left this string
  // alone, so the lede started announcing a future event in the present tense.
  // On 2026-08-09 the Broadway lede read "Ragtime plays final performance"
  // when Ragtime's last show was Aug 16, a week out. Always name the day.
  for (const c of (input.closingsThisWeek || [])) {
    out.push({
      kind: 'closing-final',
      weight: WEIGHTS.CLOSING_THIS_WEEK_BASE,
      headline: `${c.title} plays its final performance ${formatClosingDay(c.closingDate)}`.trimEnd(),
      show: c,
      slug: c.slug,
    });
  }

  // 5. Announced future closings
  for (const a of (input.announcedClosings || [])) {
    out.push({
      kind: 'closing-announced',
      weight: WEIGHTS.ANNOUNCED_CLOSING_BASE,
      headline: `${a.show.title} sets closing date`,
      show: a.show,
      slug: a.show.slug,
    });
  }

  // 5b. Outlier — INTENTIONALLY excluded from the subject-line / lede scorer
  // (2026-05-24): "one critic dissents on X" reads as if everyone else loved
  // X and one dissented; mostly-mixed shows like The Emporium misrepresent
  // as a result. The Outlier section still renders as a body card where the
  // single-critic context is clear; it just doesn't lead the subject anymore.

  // 6. Biggest mover — qualitative phrasing instead of "rises N pts".
  // The reader doesn't care about the integer; they care about the direction
  // and magnitude in plain language.
  if (input.topMover) {
    const m = input.topMover;
    const delta = Math.abs(Math.round(m.after - m.before));
    const largeBump = delta >= 10 ? WEIGHTS.BIGGEST_MOVER_LARGE_BUMP : 0;
    const headline = m.delta > 0
      ? `${m.show.title} ${delta >= 8 ? 'surges with new reviews' : 'climbs with new reviews'}`
      : `${m.show.title} ${delta >= 8 ? 'falls as reviews come in' : 'slips as reviews come in'}`;
    out.push({ kind: 'mover', weight: WEIGHTS.BIGGEST_MOVER_BASE + largeBump, headline, show: m.show, slug: m.show.slug });
  }

  // 7. Tony predictions — only newsworthy when ceremony is close
  if (input.tonyDaysOut != null && input.topTonyPick) {
    const nearBump = input.tonyDaysOut <= 14 ? WEIGHTS.TONY_CEREMONY_NEAR_BUMP : 0;
    out.push({
      kind: 'tony',
      weight: WEIGHTS.TONY_PREDICTION_BASE + nearBump,
      headline: `${input.topTonyPick.title} leads Tony predictions`,
      show: input.topTonyPick,
      slug: input.topTonyPick.slug,
    });
  }

  // 8. Social Buzz #1 — only newsworthy when it CHANGED
  if (input.buzziest && input.buzziest.changed) {
    out.push({
      kind: 'buzz',
      weight: WEIGHTS.BUZZ_NEW_NUM_ONE,
      headline: `${input.buzziest.show.title} tops social buzz`,
      show: input.buzziest.show,
      slug: input.buzziest.show.slug,
    });
  }

  // Sort by weight DESC
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

// Opening kinds name a SPECIFIC show — two different shows opening the same
// week are two different pieces of news, not a repeated one. Deduping these
// by bare `kind` silently dropped the second WE (or BW/OB) opening whenever
// two shows opened together, so the lede paired the surviving opening with an
// unrelated closing instead — even when the dropped show reviewed BETTER
// (user, 2026-08-16: How the Other Half Loves at 79 got dropped in favor of
// Death Note at 74, purely on review-count tiebreak, and the lede's second
// sentence went to an unrelated closing). Non-opening kinds (recoupment,
// closing, mover, tony, buzz) are still one-example-per-kind — those really
// do read repetitive/low-value as multiple near-identical sentences.
const PER_SHOW_KINDS = new Set(['bw-opening', 'bw-reopening', 'ob-opening', 'ob-reopening', 'we-gold-opening']);

// Dedupe by `kind` so the subject doesn't read "Show A recoups, Show B recoups, …"
// — except opening kinds, which dedupe per show (see PER_SHOW_KINDS above) so
// multiple distinct openings in the same week can all surface. Keeps the
// highest-weighted candidate per key (input is already sorted desc).
function dedupeByKind(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = PER_SHOW_KINDS.has(c.kind) ? `${c.kind}:${c.show?.id ?? c.headline}` : c.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Build a subject line from the top candidates. Hard-capped at 80 chars (the
// same limit pre-send-check enforces); appends
// ", and more." when ≥3 items survive. Returns { subject, showRefs } — the
// subject slices up to 4 unique-by-kind candidates (the lede takes only 3),
// so a subject-only 4th item exists that the lede's showRefs never covers;
// callers must fold `showRefs` into the same lede-⊆-body check (card #482)
// or an inbox subject line could still name a show absent from the body.
export function buildSubjectFromCandidates(candidates) {
  if (!candidates.length) return { subject: 'This week in NYC theatre.', showRefs: [] };
  const unique = dedupeByKind(candidates);
  let parts = unique.slice(0, 4);
  let tail = parts.length >= 3 ? ', and more.' : '.';
  let subject = parts.map(c => c.headline).join(', ') + tail;
  while (subject.length > 80 && parts.length > 1) {
    parts.pop();
    tail = parts.length >= 3 ? ', and more.' : '.';
    subject = parts.map(c => c.headline).join(', ') + tail;
  }
  // The loop above stops at parts.length === 1, so a SINGLE headline longer
  // than the cap escapes it entirely and the 80-char limit fails open. Long
  // show titles do this on their own: "Les Misérables: The Arena Concert
  // Spectacular opens off-Broadway to strong reviews." is 83, and it shipped
  // into the 2026-07-27 Broadway draft. The cost isn't the subject — it's that
  // pre-send-check treats over-length as a soft issue and injects its red
  // "PRE-SEND ISSUES" banner into the draft BODY, which every subscriber sees
  // if the owner hits Send without spotting it (caught in the Sunday review
  // pass, 2026-08-02). Trim at a word boundary so the cap always holds.
  if (subject.length > 80) subject = trimToWordBoundary(subject, 80);
  // showRefs is derived from `parts` (pre-truncation), so after a trim the
  // subject may no longer NAME a show that showRefs still lists. That is safe
  // and deliberate: generate.mjs folds these into meta.ledeShows
  // (generate.mjs:2574) and pre-send-check tests them against the BODY, never
  // against the subject text. An extra ref can therefore only make the
  // lede-⊆-body gate stricter, never weaker — and every ref comes from the
  // same newsworthy-candidate pool the body sections render from. Do not
  // "fix" this by filtering showRefs to what survived truncation: that would
  // weaken the gate, which is the opposite of what card #482 wanted.
  const showRefs = parts.map(c => c.show).filter(Boolean).map(s => ({ id: s.id, slug: s.slug, title: s.title }));
  return { subject, showRefs };
}

// Trim to at most `limit` chars, cutting at a word boundary and ending in a
// single ellipsis. Falls back to a hard cut when the string has no usable
// space (one very long unbroken token), so the return is always <= limit.
export function trimToWordBoundary(s, limit) {
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit - 1); // leave one char for the ellipsis
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[\s,.:;!?-]+$/, '') + '…';
}

// Editorial lede — 2-3 sentence narrative from the top candidates.
// Stronger than the subject because it can use full prose. Deduped by kind so
// we don't get three "X recoups" sentences in a row. Also rotates verdict
// phrasing — two openings in the same week with the same tier shouldn't both
// say "opens to decent reviews"; the second uses the next pool variant.
export function buildLedeFromCandidates(candidates, maxSentences = 3) {
  const r = buildLedeSentences(candidates, maxSentences);
  return r ? r.sentences.join(' ') : null;
}

// Sentence-level variant: returns { sentences, kinds, showRefs } so the
// expanded-lede composer in generate.mjs can add box-office / coming-up
// context without duplicating a kind that already made the cut. `showRefs`
// (one per surviving candidate, {id, slug, title}) lets the caller record
// exactly which shows the lede named — the mechanical input to the
// lede-⊆-body pre-send check (scripts/lib/lede-body-invariant.js).
export function buildLedeSentences(candidates, maxSentences = 3) {
  if (!candidates.length) return null;
  const unique = dedupeByKind(candidates).slice(0, maxSentences);
  // Per-tier counter so the Nth occurrence picks variantIndex N.
  const tierSeen = {};
  const sentences = unique.map((c) => {
    let headline = c.headline;
    if (c.verdictTier && c.verdictPrefix) {
      const i = (tierSeen[c.verdictTier] = (tierSeen[c.verdictTier] || 0) + 1) - 1;
      const pool = VERDICT_VARIANTS[c.verdictTier];
      if (pool && i > 0 && pool[i]) {
        headline = c.verdictPrefix + pool[i];
      }
    }
    return headlineToSentence({ ...c, headline });
  });
  const showRefs = unique
    .map(c => c.show)
    .filter(Boolean)
    .map(s => ({ id: s.id, slug: s.slug, title: s.title }));
  return { sentences, kinds: unique.map(c => c.kind), showRefs };
}

function headlineToSentence(c) {
  let h = c.headline.charAt(0).toUpperCase() + c.headline.slice(1);
  // Italicize the show title wherever it appears in the headline.
  const title = c.show?.title;
  if (title && h.includes(title)) {
    h = h.replace(title, `<em>${title}</em>`);
  }
  return h.endsWith('.') ? h : h + '.';
}
