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
// Pure: no I/O, no globals. generate.mjs decides when to use it.
import { reviewVerdictTier, VERDICT_VARIANTS, trimToWordBoundary } from './newsworthiness.mjs';

const SUBJECT_MAX = 80;
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n) => WORDS[n] || String(n);
const em = (t) => `<em>${t}</em>`;

function joinWithAnd(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const MARKETS = {
  broadway: { on: 'on Broadway', name: 'Broadway', the: 'on Broadway', category: 'broadway' },
  'off-broadway': { on: 'off-Broadway', name: 'Off Broadway', the: 'Off Broadway', category: 'off-broadway' },
};

// Rounded canonical critic score, the number the site shows.
const scoreOf = (o) => {
  const v = o.agg?.raw ?? o.agg?.avg;
  return typeof v === 'number' ? Math.round(v) : null;
};

/**
 * @param {{ bw: Array<{show, agg, isReopening?}>, ob: Array<{show, agg, isReopening?}> }} input
 *   Each list holds the week's scored openings in lead order (most reviews,
 *   then score). Only shows the email renders should be passed.
 * @returns {null | { subject, sentences: string[], showRefs: Array<{id,slug,title}>, lead }}
 *   null when there is no New York opening to lead with.
 */
export function composeWeekVoice({ bw = [], ob = [] } = {}) {
  const bwScored = bw.filter(o => scoreOf(o) != null);
  const obScored = ob.filter(o => scoreOf(o) != null);
  const total = bwScored.length + obScored.length;
  if (!total) return null;
  // Broadway leads Off Broadway whenever it has an opening, same as the
  // newsworthiness weights.
  const [leadKey, list, other, otherKey] = bwScored.length
    ? ['broadway', bwScored, obScored, 'off-broadway']
    : ['off-broadway', obScored, bwScored, 'broadway'];
  const M = MARKETS[leadKey];
  const OM = MARKETS[otherKey];
  const n = list.length;
  const lead = list[0];
  const L = lead.show.title;
  const S = scoreOf(lead);
  const verb = lead.isReopening ? 'reopens' : 'opens';

  // ── Subject ──────────────────────────────────────────────────────────────
  const subjectOptions = [];
  if (n >= 2) {
    subjectOptions.push(`${L} and ${n - 1} other show${n - 1 === 1 ? '' : 's'} open ${M.on} this week`);
  } else if (total <= 2) {
    subjectOptions.push(`${L} ${verb} ${M.on} in a quiet week`);
  } else {
    subjectOptions.push(`${L} ${verb} ${M.on}, plus ${word(other.length)} ${OM.on} opening${other.length === 1 ? '' : 's'}`);
  }
  subjectOptions.push(`${L} ${verb} ${M.on} this week`);
  const subject = subjectOptions.find(s => s.length <= SUBJECT_MAX) || trimToWordBoundary(subjectOptions[subjectOptions.length - 1], SUBJECT_MAX);

  // ── Lede ─────────────────────────────────────────────────────────────────
  const named = new Set([lead.show.id]);
  const sentences = [];
  const nyWide = n < 5 && (total <= 2 || other.length > 0);
  if (total === 1) sentences.push('A slow week in New York, with just one opening.');
  else if (total === 2) sentences.push('A slow week in New York, with just two openings.');
  else if (n >= 5) sentences.push(`A packed week ${M.the}, with ${word(n)} openings.`);
  else if (total >= 5) sentences.push(`A busy week in New York, with ${word(total)} openings.`);
  else if (!other.length) sentences.push(`A steady week for ${M.name}.`);
  else sentences.push(`A steady week in New York, with ${word(total)} openings.`);

  const loc = nyWide ? ` ${M.on}` : '';
  const tier = reviewVerdictTier(S, M.category);
  const verdict = VERDICT_VARIANTS[tier][0];
  const others = list.slice(1);
  if (n >= 2 && S < 65) {
    sentences.push(`${em(L)} draws the most reviews and a ${S < 55 ? 'weak' : 'middling'} ${S}.`);
    const toSee = others.filter(o => scoreOf(o) >= 75).sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 2);
    if (toSee.length) {
      toSee.forEach(o => named.add(o.show.id));
      const names = joinWithAnd(toSee.map(o => `${em(o.show.title)} (${scoreOf(o)})`));
      sentences.push(`${names} ${toSee.length === 1 ? 'is the one' : 'are the ones'} to see.`);
    }
  } else {
    const ties = others.filter(o => scoreOf(o) === S);
    if (ties.length) {
      ties.forEach(o => named.add(o.show.id));
      sentences.push(`${em(L)} ${verb}${loc} to ${verdict}, tied at ${S} with ${joinWithAnd(ties.map(o => em(o.show.title)))}.`);
    } else {
      sentences.push(`${em(L)} ${verb}${loc} to ${verdict} (${S}).`);
    }
    const best = others.filter(o => !named.has(o.show.id) && scoreOf(o) >= 75 && scoreOf(o) > S)
      .sort((a, b) => scoreOf(b) - scoreOf(a))[0];
    if (best) {
      named.add(best.show.id);
      sentences.push(`The best reviews went to ${em(best.show.title)} (${scoreOf(best)}).`);
    }
  }
  // A busy week's clear miss is news too ("Beaches lands at 44").
  if (n >= 3) {
    const low = others.filter(o => !named.has(o.show.id) && scoreOf(o) < 55)
      .sort((a, b) => scoreOf(a) - scoreOf(b))[0];
    if (low) {
      named.add(low.show.id);
      sentences.push(`${em(low.show.title)} lands at ${scoreOf(low)}.`);
    }
  }
  // The other market, one sentence, led by its most-reviewed show.
  if (other.length) {
    const o = other[0];
    const os = scoreOf(o);
    named.add(o.show.id);
    const oVerb = o.isReopening ? 'reopens' : 'opens';
    const phrase = os < 65 ? `lands at ${os}` : `${oVerb} to ${VERDICT_VARIANTS[reviewVerdictTier(os, OM.category)][0]} (${os})`;
    const where = OM.the.charAt(0).toUpperCase() + OM.the.slice(1);
    sentences.push(other.length === 1
      ? `${where}, ${em(o.show.title)} ${phrase}.`
      : `${where}, ${word(other.length)} shows opened, led by ${em(o.show.title)} (${os}).`);
  }

  const all = [...bwScored, ...obScored];
  const showRefs = [...named].map(id => all.find(o => o.show.id === id).show)
    .map(s => ({ id: s.id, slug: s.slug, title: s.title }));
  return { subject, sentences: sentences.slice(0, 5), showRefs, lead: lead.show };
}
