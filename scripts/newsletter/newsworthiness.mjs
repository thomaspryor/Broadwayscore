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
export const WEIGHTS = {
  BW_OPENING_BASE: 70,
  BW_OPENING_GOLD_BUMP: 15,           // critical-gold debut is huge
  OB_OPENING_BASE: 50,
  OB_OPENING_GOLD_BUMP: 15,
  RECOUPMENT_BASE: 78,                // recouping is the rarest + most newsworthy biz signal
  RECOUPMENT_FAST_BUMP: 7,            // <12 weeks-to-recoup
  CLOSING_THIS_WEEK_BASE: 65,
  CLOSING_LONG_RUN_BUMP: 8,           // closing show that ran 200+ perfs
  ANNOUNCED_CLOSING_BASE: 60,
  BIGGEST_MOVER_BASE: 55,
  BIGGEST_MOVER_LARGE_BUMP: 15,       // ≥10pt swing
  TONY_PREDICTION_BASE: 50,           // only really matters in last 3 weeks before ceremony
  TONY_CEREMONY_NEAR_BUMP: 20,        // when ceremony is <14 days away
  BUZZ_NEW_NUM_ONE: 55,               // dethrones prior #1
  BUZZ_HOLD_NUM_ONE: 30,              // still #1, not "news" per se
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

// Each candidate is `{ kind, weight, headline, show, slug }`. `headline` is the
// short imperative phrase that goes into the subject line and lede.
export function scoreCandidates(input) {
  const out = [];

  // 1. Broadway openings (with critic score known)
  for (const s of (input.bwOpenings || [])) {
    const score = input.aggregateScore ? input.aggregateScore(s.id)?.avg : null;
    const goldBump = isGoldTier(score, s.category) ? WEIGHTS.BW_OPENING_GOLD_BUMP : 0;
    out.push({
      kind: 'bw-opening',
      weight: WEIGHTS.BW_OPENING_BASE + goldBump,
      headline: `${s.title} opens on Broadway`,
      show: s,
      slug: s.slug,
    });
  }

  // 2. Off-Broadway openings
  for (const s of (input.obOpenings || [])) {
    const score = input.aggregateScore ? input.aggregateScore(s.id)?.avg : null;
    const goldBump = isGoldTier(score, s.category) ? WEIGHTS.OB_OPENING_GOLD_BUMP : 0;
    out.push({
      kind: 'ob-opening',
      weight: WEIGHTS.OB_OPENING_BASE + goldBump,
      headline: `${s.title} opens off-Broadway`,
      show: s,
      slug: s.slug,
    });
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

  // 6. Biggest movers (only the top one is interesting per week)
  if (input.topMover) {
    const m = input.topMover;
    const delta = Math.abs(Math.round(m.after - m.before));
    const largeBump = delta >= 10 ? WEIGHTS.BIGGEST_MOVER_LARGE_BUMP : 0;
    const dir = m.delta > 0 ? 'rises' : 'drops';
    out.push({
      kind: 'mover',
      weight: WEIGHTS.BIGGEST_MOVER_BASE + largeBump,
      headline: `${m.show.title} ${dir} ${delta} pts`,
      show: m.show,
      slug: m.show.slug,
    });
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
  const prefix = opts.prefix || 'Scorecard Weekly: ';
  if (!candidates.length) return `${prefix}this week in NYC theatre.`;
  const unique = dedupeByKind(candidates);
  const items = unique.slice(0, 4).map(c => c.headline);
  let parts = items.slice();
  let tail = parts.length >= 3 ? ', and more.' : '.';
  let subject = prefix + parts.join(', ') + tail;
  while (subject.length > 130 && parts.length > 1) {
    parts.pop();
    tail = parts.length >= 3 ? ', and more.' : '.';
    subject = prefix + parts.join(', ') + tail;
  }
  return subject;
}

// Editorial lede — 2-3 sentence narrative from the top candidates.
// Stronger than the subject because it can use full prose. Deduped by kind so
// we don't get three "X recoups" sentences in a row.
export function buildLedeFromCandidates(candidates) {
  if (!candidates.length) return null;
  const unique = dedupeByKind(candidates).slice(0, 3);
  return unique.map(headlineToSentence).join(' ');
}

function headlineToSentence(c) {
  // Capitalize the first character and add a period if missing.
  const h = c.headline.charAt(0).toUpperCase() + c.headline.slice(1);
  return h.endsWith('.') ? h : h + '.';
}
