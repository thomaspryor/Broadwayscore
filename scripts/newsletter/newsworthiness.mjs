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
export const WEIGHTS = {
  BW_OPENING_BASE: 85,                // openings ARE the news — what subscribers wait for
  BW_OPENING_GOLD_BUMP: 15,           // critical-gold debut is the biggest event of the week
  OB_OPENING_BASE: 70,                // smaller market but still review news
  OB_OPENING_GOLD_BUMP: 15,
  WE_GOLD_OPENING_BASE: 78,           // Critical Gold West End earns subject line (non-gold WE excluded)
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
    // Always Gold, so always use the top phrase
    const headline = verdict
      ? `${s.title} opens in London to ${verdict}`
      : `${s.title} opens in London`;
    out.push({ kind: 'we-gold-opening', weight: WEIGHTS.WE_GOLD_OPENING_BASE, headline, show: s, slug: s.slug,
      verdictTier: tier, verdictPrefix: `${s.title} opens in London to `, openingVenue: 'London' });
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
    const headline = verdict
      ? `${s.title} ${verb} off-Broadway to ${verdict}`
      : `${s.title} ${verb} off-Broadway`;
    out.push({ kind: isReopen ? 'ob-reopening' : 'ob-opening', weight: WEIGHTS.OB_OPENING_BASE + goldBump, headline, show: s, slug: s.slug,
      verdictTier: tier, verdictPrefix: `${s.title} ${verb} off-Broadway to `, openingVenue: 'off-Broadway' });
  }

  // 3. Recoupment announcements (rarest biz news — high weight)
  for (const r of (input.recoupments || [])) {
    const weeks = r.weeksToRecoup;
    const fastBump = (weeks && weeks > 0 && weeks < 12) ? WEIGHTS.RECOUPMENT_FAST_BUMP : 0;
    const tail = (weeks && weeks > 0) ? ` recoups in ${weeks} weeks` : ' recoups';
    out.push({
      kind: 'recoupment',
      weight: WEIGHTS.RECOUPMENT_BASE + fastBump,
      headline: `${r.show.title}${tail}`,
      show: r.show,
      slug: r.show.slug,
    });
  }

  // 4. Closings this week (final performances inside the week window)
  for (const c of (input.closingsThisWeek || [])) {
    out.push({
      kind: 'closing-final',
      weight: WEIGHTS.CLOSING_THIS_WEEK_BASE,
      headline: `${c.title} plays final performance`,
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

// Dedupe by `kind` so the subject doesn't read "Show A recoups, Show B recoups, …".
// Keeps the highest-weighted candidate per kind (input is already sorted desc).
function dedupeByKind(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (seen.has(c.kind)) continue;
    seen.add(c.kind);
    out.push(c);
  }
  return out;
}

// Build a subject line from the top candidates. Caps at 130 chars; appends
// ", and more." when ≥3 items survive.
export function buildSubjectFromCandidates(candidates, opts = {}) {
  if (!candidates.length) return 'This week in NYC theatre.';
  const unique = dedupeByKind(candidates);
  const items = unique.slice(0, 4).map(c => c.headline);
  let parts = items.slice();
  let tail = parts.length >= 3 ? ', and more.' : '.';
  let subject = parts.join(', ') + tail;
  while (subject.length > 80 && parts.length > 1) {
    parts.pop();
    tail = parts.length >= 3 ? ', and more.' : '.';
    subject = parts.join(', ') + tail;
  }
  return subject;
}

// Editorial lede — 2-3 sentence narrative from the top candidates.
// Stronger than the subject because it can use full prose. Deduped by kind so
// we don't get three "X recoups" sentences in a row. Also rotates verdict
// phrasing — two openings in the same week with the same tier shouldn't both
// say "opens to decent reviews"; the second uses the next pool variant.
export function buildLedeFromCandidates(candidates) {
  if (!candidates.length) return null;
  const unique = dedupeByKind(candidates).slice(0, 3);
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
  return sentences.join(' ');
}

function headlineToSentence(c) {
  // Capitalize the first character and add a period if missing.
  const h = c.headline.charAt(0).toUpperCase() + c.headline.slice(1);
  return h.endsWith('.') ? h : h + '.';
}
