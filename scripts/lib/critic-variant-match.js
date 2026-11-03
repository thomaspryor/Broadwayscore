'use strict';

/**
 * critic-variant-match.js — decides whether two critic pages are the same
 * person under two bylines (BRO-6928).
 *
 * WHY: a critic page is keyed by the byline's slug, so every spelling variant
 * mints its own page. The weekly detector (detect-critic-typos.js) only
 * auto-merged pairs at Levenshtein distance 1 that share an outlet, and only
 * logged the rest. It therefore never caught:
 *   - transposed letters (andrjez/andrzej, jospeh/joseph): Levenshtein 2
 *   - nickname or short forms (chris/christopher, dave/david)
 *   - extra leading words ("erickson elisabeth vincentelli")
 *   - a one-off typo at an outlet the critic does not usually write for
 *     (jess green at Musical Theatre Review)
 * Critics pages are the most visible place this shows, and the owner is
 * emailing the 50 busiest critics.
 *
 * classifyVariantPair() returns one of:
 *   'merge'    same person with high confidence: safe to alias automatically
 *   'review'   looks like a variant but the evidence is thin: a human decides
 *   'distinct' different people (or no variant relation)
 *
 * A pair is a MERGE only when the NAMES agree AND there is evidence they are
 * one person: a shared outlet, or the smaller page is a straggler (a few
 * reviews against a page ten times its size). Two real people with similar
 * names (Stu/Scott Brown, Marina/Mark Kennedy) fail both tests.
 *
 * Pure, so the test require()s the real function (CLAUDE.md section 15).
 */

const { foldDiacritics } = require('./url-slug');

/** First-name short forms. Each row is a set of interchangeable first names. */
const NICKNAME_GROUPS = [
  ['chris', 'christopher'],
  ['dave', 'david'],
  ['steve', 'steven', 'stephen'],
  ['matt', 'matthew'],
  ['sam', 'samuel'],
  ['mike', 'michael'],
  ['tim', 'timothy'],
  ['joe', 'joseph'],
  ['jim', 'james'],
  ['bob', 'robert'],
  ['bill', 'william'],
  ['tom', 'thomas'],
  ['dan', 'daniel'],
  ['ben', 'benjamin'],
  ['nick', 'nicholas'],
  ['andy', 'andrew'],
  ['tony', 'anthony'],
  ['ed', 'edward'],
  ['ken', 'kenneth'],
  ['liz', 'elizabeth'],
  ['kate', 'katherine', 'kathryn'],
  ['jen', 'jennifer'],
  ['greg', 'gregory'],
  ['pete', 'peter'],
  ['rick', 'richard'],
  ['jess', 'jesse'],
];

const NICKNAME_INDEX = new Map();
NICKNAME_GROUPS.forEach((group, i) => group.forEach(n => {
  if (!NICKNAME_INDEX.has(n)) NICKNAME_INDEX.set(n, new Set());
  NICKNAME_INDEX.get(n).add(i);
}));

const JOINT_WORDS = new Set(['and', 'with', 'photo', 'named']);

function foldTokens(name) {
  return foldDiacritics(String(name || ''))
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[-\s]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Damerau-Levenshtein (adjacent transposition counts as one edit). */
function damerau(a, b) {
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

/** One token is a typo of the other: 1 edit for 5+ letters, 2 edits for 7+ (andrjez/andrzej). */
function closeToken(x, y) {
  const n = Math.min(x.length, y.length);
  const d = damerau(x, y);
  // 2 edits only for same-length tokens (transposition/substitution), so suffix
  // pairs like Richards/Richardson and Roberts/Robertson stay different.
  return (n >= 5 && d <= 1) || (n >= 7 && d <= 2 && x.length === y.length);
}

function sameNickname(x, y) {
  if (x === y) return true;
  const gx = NICKNAME_INDEX.get(x), gy = NICKNAME_INDEX.get(y);
  if (!gx || !gy) return false;
  for (const g of gx) if (gy.has(g)) return true;
  return false;
}

/**
 * How do two folded names relate? Returns the name-variant kind, or null.
 *   'typo'      one name is the other with a typo (1 edit, transposition = 1)
 *   'nickname'  same last name, first names are short/long forms of each other
 *   'extra'     one name is the other with extra leading or trailing words
 */
function nameRelation(tokA, tokB) {
  if (tokA.length === 0 || tokB.length === 0) return null;
  const a = tokA.join(' '), b = tokB.join(' ');
  if (a === b) return null;

  // Extra words: "erickson elisabeth vincentelli" contains "elisabeth vincentelli".
  const shorter = tokA.length <= tokB.length ? tokA : tokB;
  const longer = tokA.length <= tokB.length ? tokB : tokA;
  if (shorter.length >= 2 && longer.length > shorter.length) {
    const sj = shorter.join(' '), lj = longer.join(' ');
    if (lj.endsWith(' ' + sj) || lj.startsWith(sj + ' ')) return 'extra';
  }

  if (tokA.length !== tokB.length) return null;

  // A differing single-letter token is a middle initial (Breanne J / Breanne L): two people.
  for (let i = 0; i < tokA.length; i++) {
    if (tokA[i] !== tokB[i] && tokA[i].length === 1 && tokB[i].length === 1) return null;
  }

  // Whole-name typo: one edit overall, names long enough for an edit to mean it.
  if (Math.min(a.length, b.length) >= 8 && damerau(a, b) <= 1) return 'typo';

  // Per-token: every token typo-close or nickname-equal, at most one differing.
  if (tokA.length >= 2) {
    const lastA = tokA[tokA.length - 1], lastB = tokB[tokB.length - 1];
    const firstA = tokA[0], firstB = tokB[0];
    const midSame = tokA.slice(1, -1).join(' ') === tokB.slice(1, -1).join(' ');
    // "Breanne J Heldman" vs "Breanne L Heldman": different middle initials can be two people.
    if (lastA === lastB && midSame && sameNickname(firstA, firstB)) return 'nickname';
    if (firstA === firstB && midSame && closeToken(lastA, lastB)) return 'typo';
    if (lastA === lastB && midSame && closeToken(firstA, firstB)) return 'typo';
  }
  return null;
}

/**
 * @param {{name:string, count:number, outlets:Iterable<string>}} a
 * @param {{name:string, count:number, outlets:Iterable<string>}} b
 * @param {{distinct?: Set<string>}} [opts] distinct: "slugA|slugB" (sorted) pairs
 *   a human confirmed are different people; never flagged.
 * @returns {{verdict:'merge'|'review'|'distinct', relation:string|null, reason:string, canonical:'a'|'b'|null}}
 */
function classifyVariantPair(a, b, opts = {}) {
  const tokA = foldTokens(a.name), tokB = foldTokens(b.name);
  const slugKey = [tokA.join('-'), tokB.join('-')].sort().join('|');
  if (opts.distinct && opts.distinct.has(slugKey)) {
    return { verdict: 'distinct', relation: null, reason: 'confirmed different people', canonical: null };
  }
  const relation = nameRelation(tokA, tokB);
  if (!relation) return { verdict: 'distinct', relation: null, reason: 'names are not variants', canonical: null };

  const outletsA = new Set(a.outlets), outletsB = new Set(b.outlets);
  const shared = [...outletsA].filter(o => outletsB.has(o));
  const big = a.count >= b.count ? a : b, small = big === a ? b : a;
  const straggler = small.count <= 3 && small.count * 10 <= big.count;
  const canonical = big === a ? 'a' : 'b';

  // A joint byline ("A and B", "A with B") belongs to two critics, so no alias can
  // route it to one page. A human (or the byline splitter) resolves those.
  if (relation === 'extra' && [...tokA, ...tokB].some(t => JOINT_WORDS.has(t))) {
    return { verdict: 'review', relation, reason: 'joint or garbled byline, needs a human', canonical };
  }
  // 'extra' words are the weakest signal (two people can share a surname and a
  // given name inside a longer name), so they need the straggler test as well.
  if (relation === 'extra') {
    if (straggler) return { verdict: 'merge', relation, reason: `extra words on a ${small.count}-review page`, canonical };
    return { verdict: 'review', relation, reason: 'extra words, both pages sizeable', canonical };
  }
  if (shared.length > 0) return { verdict: 'merge', relation, reason: `${relation}, shared outlet ${shared[0]}`, canonical };
  // A name match with no shared outlet is not enough (Simon Thomson/Thompson, Jess/Jesse Green
  // were two people): a human decides.
  if (straggler) return { verdict: 'review', relation, reason: `${relation}, ${small.count}-review straggler but no shared outlet`, canonical };
  return { verdict: 'review', relation, reason: `${relation}, no shared outlet and both pages sizeable`, canonical };
}

module.exports = { classifyVariantPair, nameRelation, damerau, foldTokens, sameNickname, NICKNAME_GROUPS };
