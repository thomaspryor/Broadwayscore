/**
 * Cross-outlet duplicate pair policy (BRO-6759).
 *
 * detect-cross-outlet-duplicates.js used to flag the lower-tier file of ANY two
 * different-outlet files whose text matched (trigram >= 40, or 500-char
 * fingerprint). With two DIFFERENT critics that hides a real review whenever
 * the other file holds the wrong text: appropriate-2023 deadline--greg-evans
 * (Deadline rave, 92) was hidden because guardian--adrian-horton held Deadline's
 * words, so the Guardian row was scored on Deadline's text as well.
 *
 * Rule: two files by different named critics are only auto-flagged when the
 * relationship is VERIFIED:
 *   - same person under two spellings (alias),
 *   - outlets in a verified wire/ownership family (reprint of the same article),
 *   - the copy's own text says it is the other outlet's article (provenance);
 *     then the DECLARING file is the copy, whatever the outlet tier.
 * Anything else is a wrong-text candidate: reported, never hidden.
 *
 * Pure functions so tests require() the real rule (CLAUDE.md section 15).
 */
const { PUBLISHING_GROUPS } = require('./syndication-pairs');

const UNKNOWN_RE = /^(unknown|staff|n\/a|none|anonymous|contributing writer|ap drama writer|associated press|daily news|new york daily news|huff wires|westendwilma)?$/;

function compact(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
}

/** True for a blank / placeholder byline (no real person named). */
function isPlaceholderCritic(name) {
  return UNKNOWN_RE.test(String(name || '').toLowerCase().trim());
}

/**
 * Same person? Handles blank bylines, spelling variants (Alex/Aleks Sierz),
 * middle initials and slug-style names ("Rachelrweinberg" vs "Rachel Weinberg").
 */
function sameCritic(nameA, nameB) {
  if (isPlaceholderCritic(nameA) || isPlaceholderCritic(nameB)) return false;
  const a = compact(nameA);
  const b = compact(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  const tok = (n) => String(n).toLowerCase().normalize('NFKD').replace(/[^a-z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  const ta = tok(nameA);
  const tb = tok(nameB);
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  // Slug-style single token containing the other name's last name + first initial.
  if (ta.length === 1 && tb.length > 1 && a.startsWith(tb[0]) && a.includes(lastB)) return true;
  if (tb.length === 1 && ta.length > 1 && b.startsWith(ta[0]) && b.includes(lastA)) return true;
  // Same last name, first names within one edit (Alex / Aleks).
  if (lastA === lastB && ta.length > 1 && tb.length > 1) {
    const fa = ta[0];
    const fb = tb[0];
    const shortF = fa.length <= fb.length ? fa : fb;
    const longF = fa.length <= fb.length ? fb : fa;
    // Nickname / spelling variants: Doug~Douglas, Alex~Aleks.
    if (fa === fb || (shortF.length >= 3 && longF.startsWith(shortF)) || (shortF.length >= 4 && longF.length - shortF.length === 1 && fa.slice(0, 3) === fb.slice(0, 3) && editDistance(fa, fb) <= 2)) return true;
  }
  return false;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * Outlets that publish the SAME article under another byline by arrangement.
 * Each group was checked against pairs in review-texts (BRO-6759): the files
 * hold one article with different outlet chrome.
 *   - Tribune Content Agency: Tribune/Daily News run Chris Jones, and Variety
 *     reviews carry "Distributed by Tribune Content Agency".
 *   - Newsday Media Group: amNY reruns Newsday reviews.
 *   - AP wire: AP copy is carried under the subscriber's outlet id.
 *   - Penske (Variety/THR/Deadline) reprint sister-brand and wire copy;
 *     Reuters ran Hollywood Reporter reviews.
 *   - theartsdesk / Sierz, Rachel Weinberg / BroadwayWorld and other same-person
 *     blogs are handled by sameCritic(), not listed here.
 */
const VERIFIED_OUTLET_FAMILIES = [
  ['chicagotribune', 'nydailynews', 'variety', 'boston-herald', 'baltimoresun', 'hartford-courant', 'orlando-sentinel', 'south-florida-sun-sentinel'],
  ['newsday', 'amny'],
  ['ap', 'abc-news', 'huffpost', 'huffington-post', 'washpost', 'yahoo', 'bloomberg', 'newsday', 'minneapolis-star-tribune',
    'seattle-post-intelligencer', 'sfgate', 'npr', 'boston-com', 'collider', 'news-tribune', 'washington-times', 'headtopics'],
  ['hollywood-reporter', 'reuters'],
  ['theatermania', 'whatsonstage'],
  ['times-uk', 'sunday-times', 'thetimes'],
  ['timeout', 'timeout-london'],
  ['nytg', 'front-row-center'],
  ['san-francisco-chronicle', 'sfgate'],
  ['san-diego-union-tribune', 'headtopics'],
];

// Wire groups are hub-and-spoke: two subscribers (washpost, bloomberg) are not
// related to each other, only through the wire itself.
const HUB_GROUPS = new Map([['ap', 'ap']]);

function related(oa, ob) {
  if (!oa || !ob || oa === ob) return false;
  for (const g of [...VERIFIED_OUTLET_FAMILIES, ...PUBLISHING_GROUPS]) {
    if (g.includes('ap') && g.includes(oa) && g.includes(ob)) { if (oa === 'ap' || ob === 'ap') return true; continue; }
    if (g.includes(oa) && g.includes(ob)) return true;
  }
  return false;
}

function outletVariants(rec) {
  // Capitalized forms only: "the stage" / "a wide variety" in prose are not outlet names.
  const names = new Set();
  const title = (t) => t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const id = String(rec.outletId || '').trim();
  if (id) names.add(title(id.replace(/-/g, ' ')));
  const o = String(rec.outlet || '').trim();
  if (o) { names.add(o); names.add(title(o)); }
  return [...names].filter((n) => n.length >= 4);
}

/** Trigram similarity at which a bylineless file is the same article as a named one. */
const NEAR_IDENTICAL = 80;

const PROVENANCE_VERBS = '(?:was posted|posted on|first (?:appeared|ran|published) (?:on|in|at)|originally (?:appeared|published|posted|ran) (?:on|in|at)|reprinted|republished|courtesy of|distributed by|syndicated (?:from|by|with)|via|see (?:the )?original)';

/**
 * Does `copy`'s own text say it is `other`'s article? True when a provenance
 * phrase names the other outlet ("The following review was posted on
 * Deadline", "Distributed by Tribune Content Agency", "(Hollywood Reporter)").
 */
function declaresProvenance(copy, other) {
  const text = String(copy.text || '').slice(0, 4000) + ' ' + String(copy.text || '').slice(-1500);
  for (const n of outletVariants(other)) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Verb phrase is case-insensitive, the outlet name is not.
    const verb = new RegExp(`${PROVENANCE_VERBS}([^.\\n]{0,60})`, 'gi');
    const name = new RegExp(`\\b${esc}\\b`);
    let m;
    while ((m = verb.exec(text))) if (name.test(m[1])) return true;
    if (new RegExp(`\\(${esc}\\)`, 'i').test(text)) return true;
  }
  if (/^(ap|associated-press)$/.test(String(other.outletId || '')) && /\(AP\)|Associated Press/.test(text)) return true;
  return false;
}

/**
 * @param {{outletId:string,outlet?:string,criticName?:string,text:string}} a
 * @param {{outletId:string,outlet?:string,criticName?:string,text:string}} b
 * @returns {{action:'flag'|'review', reason:string, copy?:'a'|'b'}}
 *   flag: hiding one file is safe; `copy` names the file to hide when the
 *   evidence decides it (provenance), else the caller's tier rule picks.
 *   review: different critics, no verified link: wrong-text candidate, hide nothing.
 */
function classifyCrossOutletPair(a, b, { similarity = 0 } = {}) {
  if (sameCritic(a.criticName, b.criticName)) return { action: 'flag', reason: 'same-critic' };
  // A blank byline names nobody, so it cannot be a "different critic"; it still
  // needs a near-identical text to be hidden.
  if ((isPlaceholderCritic(a.criticName) || isPlaceholderCritic(b.criticName)) && similarity >= NEAR_IDENTICAL) {
    return { action: 'flag', reason: 'bylineless-near-identical' };
  }
  const aDeclares = declaresProvenance(a, b);
  const bDeclares = declaresProvenance(b, a);
  if (aDeclares !== bDeclares) return { action: 'flag', reason: 'provenance', copy: aDeclares ? 'a' : 'b' };
  if (related(String(a.outletId || '').toLowerCase(), String(b.outletId || '').toLowerCase())) {
    return { action: 'flag', reason: 'verified-family' };
  }
  return { action: 'review', reason: 'different-critics-unverified' };
}

module.exports = { NEAR_IDENTICAL, sameCritic, isPlaceholderCritic, declaresProvenance, classifyCrossOutletPair, VERIFIED_OUTLET_FAMILIES };
