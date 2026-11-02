// Week voice — the Broadway edition's subject line and lede when the week's
// story is its New York openings (BRO-3921). Owner-approved voice, 2026-10-04:
//
//   "Schmigadoon! and 5 other shows open on Broadway this week"
//   "A packed week on Broadway, with six openings. Schmigadoon! opens to
//    strong reviews, tied at 79 with Joe Turner's Come and Gone and The
//    Balusters. Beaches lands at 44."
//
//   "Paranormal Activity opens on Broadway in a quiet week"
//   "A slow week in New York, with just two openings. Paranormal Activity
//    opens on Broadway to strong reviews (78). Off Broadway, The Real Ivanov
//    lands at 53."
//
// The lead show is the one with the most reviews, then the higher score (the
// caller passes each market's list already in that order — see
// scripts/lib/opening-story-order.js). Copy that leads with the most-reviewed
// show must never claim it has the strongest reviews, so a weak lead says so
// and the better-reviewed openings are named as "the ones to see".
//
// Titles go out as plain text: generate.mjs's italicizeLede() italicizes
// canonical titles in the visible lede, and the inbox preheader must stay
// tag-free.
//
// Pure: no I/O, no globals. generate.mjs decides when to use it.
import { createRequire } from 'node:module';
import { reviewVerdictTier, VERDICT_VARIANTS, trimToWordBoundary } from './newsworthiness.mjs';
const { showHasFestivalVenue } = createRequire(import.meta.url)('../lib/review-guards.js');

const SUBJECT_MAX = 80;
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n) => WORDS[n] || String(n);

function joinWithAnd(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const MARKETS = {
  broadway: { on: 'on Broadway', the: 'on Broadway', name: 'Broadway', category: 'broadway' },
  'off-broadway': { on: 'off-Broadway', the: 'Off Broadway', name: 'Off Broadway', category: 'off-broadway' },
};
const SITP = 'at Free Shakespeare in the Park';
// The Delacorte is Free Shakespeare in the Park, not an off-Broadway house —
// the same editorial rule as newsworthiness.mjs's OB-opening headline.
const isSitp = (show, m) => m.category === 'off-broadway' && showHasFestivalVenue(show);
const whereOf = (show, m) => (isSitp(show, m) ? SITP : m.on);

// Rounded canonical critic score, the number the site shows.
const scoreOf = (o) => {
  const v = o.agg?.raw ?? o.agg?.avg;
  return typeof v === 'number' ? Math.round(v) : null;
};

/**
 * @param {{ bw: Array<{show, agg, isReopening?}>, ob: Array<{show, agg, isReopening?}>,
 *           counts?: { bw?: number, ob?: number } }} input
 *   bw/ob hold the week's scored openings in lead order (most reviews, then
 *   score): only shows that opened THIS week and that the email renders.
 *   counts are the calendar's opening counts for the week (including shows
 *   too thinly reviewed to name), so "two openings" or "and 5 other shows"
 *   stay true when the email names fewer.
 *   announcedIds: show ids that already got their own opening-night
 *   broadcast. When every Broadway opening is in it, Off Broadway leads the
 *   subject and lede: subscribers already had the Broadway news the morning
 *   after it opened, so leading with it again reads as a duplicate (owner,
 *   2026-11-02).
 *   notableIds: Off-Broadway openings worth naming on recognition alone
 *   (a revival of a title that has played Broadway, e.g. In the Heights at
 *   City Center). See obHighlights().
 * @returns {null | { subject, sentences: string[], showRefs: Array<{id,slug,title}>, lead }}
 *   null when there is no New York opening to lead with.
 */
export function composeWeekVoice({ bw = [], ob = [], counts = {}, announcedIds = new Set(), notableIds = new Set() } = {}) {
  const bwScored = bw.filter(o => scoreOf(o) != null);
  const obScored = ob.filter(o => scoreOf(o) != null);
  if (!bwScored.length && !obScored.length) return null;
  const bwN = Math.max(counts.bw || 0, bwScored.length);
  const obN = Math.max(counts.ob || 0, obScored.length);
  const total = bwN + obN;
  const bwAnnounced = bwScored.length > 0 && bwScored.every(o => announcedIds.has(o.show.id));
  if (bwAnnounced && obScored.length) {
    return composeAnnouncedBroadwayWeek({ bwScored, obScored, bwN, obN, notableIds });
  }
  // Broadway leads Off Broadway whenever it has an opening, same as the
  // newsworthiness weights.
  const [leadKey, list, other, otherKey, n, otherN] = bwScored.length
    ? ['broadway', bwScored, obScored, 'off-broadway', bwN, obN]
    : ['off-broadway', obScored, bwScored, 'broadway', obN, bwN];
  const M = MARKETS[leadKey];
  const OM = MARKETS[otherKey];
  const lead = list[0];
  const L = lead.show.title;
  const S = scoreOf(lead);
  const verb = lead.isReopening ? 'reopens' : 'opens';
  const leadWhere = whereOf(lead.show, M);

  // ── Subject ──────────────────────────────────────────────────────────────
  const subjectOptions = [];
  const topScorer = [...list].sort((x, y) => scoreOf(y) - scoreOf(x))[0];
  if (n >= 5 && list.length < n) {
    // A packed week where some openings have no Critic Score yet: lead with how
    // many got reviewed and who scored highest (owner's wording, 2026-10-18).
    const T = topScorer.show.title;
    subjectOptions.push(`${list.length} ${M.on === 'on Broadway' ? 'Broadway' : 'off-Broadway'} shows get reviews this week, with ${T} scoring the highest with critics`);
    subjectOptions.push(`${list.length} ${M.on === 'on Broadway' ? 'Broadway' : 'off-Broadway'} shows get reviews, ${T} scores highest with critics`);
  }
  if (n >= 2) {
    subjectOptions.push(`${L} and ${n - 1} other show${n - 1 === 1 ? '' : 's'} open ${M.on} this week`);
  } else if (total <= 2) {
    subjectOptions.push(`${L} ${verb} ${leadWhere} in a quiet week`);
  } else {
    subjectOptions.push(`${L} ${verb} ${leadWhere}, plus ${word(otherN)} ${OM.on} opening${otherN === 1 ? '' : 's'}`);
  }
  subjectOptions.push(`${L} ${verb} ${leadWhere} this week`);
  const subject = subjectOptions.find(s => s.length <= SUBJECT_MAX) || trimToWordBoundary(subjectOptions[subjectOptions.length - 1], SUBJECT_MAX);

  // ── Lede ─────────────────────────────────────────────────────────────────
  const named = new Set([lead.show.id]);
  const sentences = [];
  if (total === 1) sentences.push('A slow week in New York, with just one opening.');
  else if (total === 2) sentences.push('A slow week in New York, with just two openings.');
  else if (n >= 5) {
    // The count is the calendar's; openings without enough reviews for a Critic
    // Score get no card, so say how many did and who scored highest (owner's own
    // Resend wording, 2026-10-18).
    const reviewed = list.length;
    const top = [...list].sort((x, y) => scoreOf(y) - scoreOf(x))[0];
    const tail = reviewed < n
      ? ` ${reviewed} got enough reviews for a Critic Score, and ${top.show.title} scored the highest with a ${scoreOf(top)}.`
      : '';
    sentences.push(`A packed week ${M.the}, with ${word(n)} openings.${tail}`);
  }
  else if (total >= 5) sentences.push(`A busy week in New York, with ${word(total)} openings.`);
  else if (!otherN) sentences.push(`A steady week for ${M.name}.`);
  else sentences.push(`A steady week in New York, with ${word(total)} openings.`);

  // Name the market when the opener spoke of New York as a whole; always
  // name Shakespeare in the Park (the market name would be wrong for it).
  const nyWide = n < 5 && (total <= 2 || otherN > 0);
  const loc = (nyWide || isSitp(lead.show, M)) ? ` ${leadWhere}` : '';
  const verdict = VERDICT_VARIANTS[reviewVerdictTier(S, M.category)][0];
  const others = list.slice(1);
  if (others.length && S < 65) {
    // Never "draws the most reviews": review count is only the lead sort key,
    // not news (owner, 2026-10-18).
    const grade = `${S < 55 ? 'weak' : 'middling'} ${S}`;
    sentences.push(`${L} ${verb}${loc} to a ${grade}.`);
    const toSee = others.filter(o => scoreOf(o) >= 75).sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 2);
    if (toSee.length) {
      toSee.forEach(o => named.add(o.show.id));
      const names = joinWithAnd(toSee.map(o => `${o.show.title} (${scoreOf(o)})`));
      sentences.push(`${names} ${toSee.length === 1 ? 'is the one' : 'are the ones'} to see.`);
    }
  } else {
    const ties = others.filter(o => scoreOf(o) === S);
    if (ties.length) {
      ties.forEach(o => named.add(o.show.id));
      sentences.push(`${L} ${verb}${loc} to ${verdict}, tied at ${S} with ${joinWithAnd(ties.map(o => o.show.title))}.`);
    } else {
      sentences.push(`${L} ${verb}${loc} to ${verdict} (${S}).`);
    }
    const best = others.filter(o => !named.has(o.show.id) && scoreOf(o) >= 75 && scoreOf(o) > S)
      .sort((a, b) => scoreOf(b) - scoreOf(a))[0];
    if (best) {
      named.add(best.show.id);
      sentences.push(`The best reviews went to ${best.show.title} (${scoreOf(best)}).`);
    }
  }
  // A busy week's clear miss is news too ("Beaches lands at 44").
  if (list.length >= 3) {
    const low = others.filter(o => !named.has(o.show.id) && scoreOf(o) < 55)
      .sort((a, b) => scoreOf(a) - scoreOf(b))[0];
    if (low) {
      named.add(low.show.id);
      sentences.push(`${low.show.title} lands at ${scoreOf(low)}.`);
    }
  }
  // The other market, one sentence, led by its most-reviewed show.
  if (other.length) {
    const o = other[0];
    const os = scoreOf(o);
    named.add(o.show.id);
    const oVerb = o.isReopening ? 'reopens' : 'opens';
    const phrase = os < 65 ? `lands at ${os}` : `${oVerb} to ${VERDICT_VARIANTS[reviewVerdictTier(os, OM.category)][0]} (${os})`;
    const place = isSitp(o.show, OM) ? 'At Free Shakespeare in the Park' : OM.the.charAt(0).toUpperCase() + OM.the.slice(1);
    if (otherN > 1 && otherKey === 'off-broadway') {
      const hl = obHighlights(other, notableIds);
      hl.ids.forEach(id => named.add(id));
      sentences.push(`Off Broadway, ${word(otherN)} shows opened. ${hl.text}`);
    } else {
      sentences.push(otherN > 1
        ? `${OM.the.charAt(0).toUpperCase() + OM.the.slice(1)}, ${word(otherN)} shows opened, led by ${o.show.title} (${os}).`
        : `${place}, ${o.show.title} ${phrase}.`);
    }
  }

  const all = [...bwScored, ...obScored];
  const showRefs = [...named].map(id => all.find(o => o.show.id === id).show)
    .map(s => ({ id: s.id, slug: s.slug, title: s.title }));
  return { subject, sentences: sentences.slice(0, 5), showRefs, lead: lead.show };
}

// Minimum reviews before a show can be called the week's best-reviewed: a
// 3-review 84 is not "the strongest reviews" next to an 8-review 81 (owner's
// Oct 26 picks: I Became We over Hospital Hour).
export const BEST_REVIEWED_MIN_REVIEWS = 5;

const countOf = (o) => (typeof o.agg?.count === 'number' ? o.agg.count : 0);

/**
 * Up to three Off-Broadway highlights, in this order (owner, 2026-11-02):
 *   1. the most-reviewed opening (list[0]: callers pass lead order),
 *   2. the best-reviewed opening with BEST_REVIEWED_MIN_REVIEWS+ reviews,
 *      when it scores 75+,
 *   3. a notable revival (notableIds), named on recognition.
 * Never says "most reviews" (owner, 2026-10-18: review count is the sort key,
 * not news). Returns { text, ids }.
 */
export function obHighlights(list, notableIds = new Set()) {
  const scored = list.filter(o => scoreOf(o) != null);
  if (!scored.length) return { text: '', ids: [] };
  const M = MARKETS['off-broadway'];
  const first = scored[0];
  const ids = [first.show.id];
  const fs = scoreOf(first);
  const parts = [fs < 65
    ? `${first.show.title} lands at ${fs}`
    : `${first.show.title} opens to ${VERDICT_VARIANTS[reviewVerdictTier(fs, M.category)][0]} (${fs})`];
  const best = scored
    .filter(o => !ids.includes(o.show.id) && countOf(o) >= BEST_REVIEWED_MIN_REVIEWS && scoreOf(o) >= 75)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || countOf(b) - countOf(a))[0];
  if (best) {
    ids.push(best.show.id);
    parts.push(`${best.show.title} earned the strongest reviews (${scoreOf(best)})`);
  }
  const notable = scored.find(o => !ids.includes(o.show.id) && notableIds.has(o.show.id));
  if (notable) {
    ids.push(notable.show.id);
    parts.push(`the ${notable.show.title} revival scored ${scoreOf(notable)}`);
  }
  const text = parts.length === 1
    ? `${parts[0]}.`
    : `${parts[0]}. ${capitalize(joinWithAnd(parts.slice(1)))}.`;
  return { text, ids };
}

const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Off Broadway leads; the already-announced Broadway opening(s) close the lede.
function composeAnnouncedBroadwayWeek({ bwScored, obScored, bwN, obN, notableIds }) {
  const bwTitles = bwScored.map(o => o.show.title);
  const bwPart = bwScored.length <= 2 ? joinWithAnd(bwTitles) : `${word(bwScored.length)} Broadway shows`;
  const subjectOptions = [
    `${obN} off-Broadway shows + ${bwPart} opened this week`,
    `${obN} off-Broadway shows + ${bwScored.length} on Broadway opened this week`,
  ];
  if (obN === 1) subjectOptions.unshift(`${obScored[0].show.title} + ${bwPart} opened this week`);
  const subject = subjectOptions.find(x => x.length <= SUBJECT_MAX) || trimToWordBoundary(subjectOptions[subjectOptions.length - 1], SUBJECT_MAX);

  const sentences = [];
  sentences.push(obN >= 5
    ? `A busy week Off Broadway, with ${word(obN)} openings.`
    : obN === 1 ? 'One new show Off Broadway this week.' : `A steady week Off Broadway, with ${word(obN)} openings.`);
  const hl = obHighlights(obScored, notableIds);
  sentences.push(hl.text);
  const bwSentence = bwScored.length === 1
    ? (() => {
      const o = bwScored[0]; const sc = scoreOf(o);
      const v = o.isReopening ? 'reopened' : 'opened';
      return `On Broadway, ${o.show.title} ${v} to ${VERDICT_VARIANTS[reviewVerdictTier(sc, 'broadway')][0]} (${sc}).`;
    })()
    : `On Broadway, ${joinWithAnd(bwScored.map(o => `${o.show.title} (${scoreOf(o)})`))} opened.`;
  sentences.push(bwSentence);

  const named = new Set([...hl.ids, ...bwScored.map(o => o.show.id)]);
  const all = [...bwScored, ...obScored];
  const showRefs = [...named].map(id => all.find(o => o.show.id === id).show)
    .map(x => ({ id: x.id, slug: x.slug, title: x.title }));
  return { subject, sentences: sentences.filter(Boolean).slice(0, 5), showRefs, lead: obScored[0].show };
}
