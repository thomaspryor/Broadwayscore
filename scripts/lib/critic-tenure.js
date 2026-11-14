/**
 * Critic/outlet tenure check (BRO-5222 gap 4). Advisory.
 *
 * audit-critic-outlets.js already flags a critic at an outlet holding under
 * 10% of their reviews. That misses a row at the critic's REAL outlet in a
 * year they were not writing there (a Variety row for a critic who had moved
 * to the NYT ten years earlier), and a row at an outlet no verified text
 * supports. This builds, from verified rows only, each critic's first and
 * last year at each outlet and flags:
 *   outside_tenure   the pair has >= MIN_PAIR_VERIFIED verified rows, the row's
 *                    year is more than TENURE_SLACK_YEARS outside them, and
 *                    the critic has >= MIN_ELSEWHERE_VERIFIED verified rows at
 *                    one other outlet that year
 *   unsupported_pair the row has no verified text, the pair has no verified
 *                    row at all, and the critic has >= MIN_CRITIC_VERIFIED
 *                    verified rows elsewhere
 *   byline_contradicted the stored page credits another of the outlet's
 *                    critics and never names this one (bylineContradicted)
 * "Verified" = text a fetch stored and the content tier accepted, so a made-up
 * row cannot vouch for itself.
 */
'use strict';

const MIN_PAIR_VERIFIED = 3;
const MIN_CRITIC_VERIFIED = 5;
const TENURE_SLACK_YEARS = 1;
/** Verified rows at another outlet in the row's year needed to say the critic was elsewhere. */
const MIN_ELSEWHERE_VERIFIED = 3;
const UNNAMED_CRITIC = /^(unknown|staff|anonymous|n\/a|none)$/i;

/**
 * @param {object} data - review-text JSON
 * @returns {boolean}
 */
function isVerifiedRow(data) {
  if (!data || !data.url) return false;
  if (!['complete', 'truncated'].includes(data.contentTier)) return false;
  return typeof data.fullText === 'string' && data.fullText.length >= 1000;
}

/** Characters of stored text searched for a byline (USA Today puts it ~80 in). */
const BYLINE_HEAD_CHARS = 600;
/** Two to four capitalised words: a person, not "Unknown" or a lowercase handle. */
const PERSON_NAME = /^[A-Z][\p{L}'\u2019.-]+(?: [A-Z][\p{L}'\u2019.-]*){1,3}$/u;
/** Outlet names and labels the corpus stores as critic names ("New York", "Written By"). */
const NOT_A_PERSON = /\b(?:The|New|York|Time|Times|Out|Stage|Written|By|Daily|News|Magazine|Theatre|Theater|Review|Reviews|Staff|Editor|Post|Journal|Press|Mail|Globe|Online|Team|Admin|Desk)\b/;

/**
 * True when the stored page credits another critic and never names the row's
 * own: its head names a critic who also writes for this outlet, and the row's
 * surname appears nowhere in the text. Such a row cannot vouch for its own
 * byline (BRO-5232: three web-search usatoday--charles-isherwood rows carried
 * Patrick Ryan's reviews, stored text and all, and supported each other as
 * Isherwood's USA Today tenure).
 * @param {string} text - stored fullText
 * @param {string} criticName - the row's critic
 * @param {string[]} outletCritics - display names of the outlet's other critics
 * @returns {boolean}
 */
function bylineContradicted(text, criticName, outletCritics) {
  if (typeof text !== 'string' || !text) return false;
  const surname = String(criticName || '').split(/[,(]/)[0].trim().split(/\s+/).pop();
  if (!surname || surname.length < 3) return false;
  const noMarks = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const body = noMarks(text);
  const lower = body.toLowerCase();
  if (lower.includes(noMarks(surname).toLowerCase())) return false;
  const head = body.slice(0, BYLINE_HEAD_CHARS);
  const headLower = lower.slice(0, BYLINE_HEAD_CHARS);
  const own = noMarks(String(criticName).trim()).toLowerCase();
  return outletCritics.some(n => {
    if (!PERSON_NAME.test(String(n || '').trim()) || NOT_A_PERSON.test(String(n))) return false;
    const name = noMarks(String(n).trim()).toLowerCase();
    if (name === own) return false;
    for (let i = headLower.indexOf(name); i !== -1; i = headLower.indexOf(name, i + 1)) {
      if (isBylineAt(head, i, name.length)) return true;
    }
    return false;
  });
}

/**
 * The name at head[i, i+len) reads as a byline, not a mention ("as Frank Rich
 * wrote", "James Graham's play"): "By NAME" / "review by NAME", "NAME in the
 * West End" (Plays International), or the name run straight into the outlet
 * or a handle with no space ("Patrick RyanUSA TODAY", "Bill Canacci@...").
 */
function isBylineAt(head, i, len) {
  const before = head.slice(Math.max(0, i - 12), i);
  const after = head.slice(i + len, i + len + 30);
  if (/\bby:?\s*$/i.test(before)) return true;
  if (/^\s+in (?:the West End|(?:[A-Z][a-z]+ )?London)\b/.test(after)) return true;
  return /^(?:[A-Z]{2}|[A-Z][a-z]+[A-Z.]|@)/.test(after);
}

/**
 * Year the review ran: publishDate when it parses, else the production year
 * from the show id suffix.
 * @param {string} showId
 * @param {object} data
 * @returns {number|null}
 */
function reviewYear(showId, data) {
  // Any year written in the date, not only an ISO prefix: a third of stored
  // dates are prose ('March 3rd, 2016'), and falling back to the show id's
  // year put a 2016 cast-change review of chicago-1996 in 1996 (BRO-5261).
  // Read the digits, not a date parser: new Date('Act 1') is 2001.
  const m = String((data && data.publishDate) || '').match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/);
  if (m) return Number(m[1]);
  const s = String(showId || '').match(/-(\d{4})$/);
  return s ? Number(s[1]) : null;
}

/**
 * @param {Object<string, {displayName: string, reviews: Array<{showId: string, file: string, outlet: string, year: number|null, verified: boolean}>}>} critics
 * @param {{skipCritics?: string[]}} [opts]
 * @returns {Array<object>} flags
 */
function findTenureFlags(critics, opts = {}) {
  const skip = new Set(opts.skipCritics || []);
  const flags = [];
  for (const [criticSlug, c] of Object.entries(critics)) {
    if (skip.has(criticSlug) || UNNAMED_CRITIC.test(String(c.displayName || criticSlug).trim())) continue;
    // isNonReview rows (closing notices, listings, reviews that never ran,
    // BRO-5232) carry no review byline: neither flagged nor tenure evidence.
    const reviews = c.reviews.filter(r => !r.nonReview);
    // The stored page credits another of the outlet's critics (set by the scan).
    for (const r of reviews) {
      if (r.bylineContradicted) flags.push({ critic: c.displayName, criticSlug, outlet: r.outlet, showId: r.showId, file: r.file, year: r.year, kind: 'byline_contradicted' });
    }
    const verified = reviews.filter(r => r.verified && Number.isFinite(r.year));
    if (verified.length === 0) continue;
    const tenure = {};
    const yearCounts = {}; // outlet -> year -> verified rows
    for (const r of verified) {
      const t = tenure[r.outlet] || (tenure[r.outlet] = { first: r.year, last: r.year, count: 0 });
      t.first = Math.min(t.first, r.year);
      t.last = Math.max(t.last, r.year);
      t.count++;
      const yc = yearCounts[r.outlet] || (yearCounts[r.outlet] = {});
      yc[r.year] = (yc[r.year] || 0) + 1;
    }
    const elsewhereIn = (outlet, year) => Object.entries(yearCounts)
      .filter(([o, yc]) => o !== outlet && (yc[year] || 0) >= MIN_ELSEWHERE_VERIFIED)
      .map(([o, yc]) => `${o} (${yc[year]})`);
    for (const r of reviews) {
      if (r.bylineContradicted) continue;
      const t = tenure[r.outlet];
      const base = { critic: c.displayName, criticSlug, outlet: r.outlet, showId: r.showId, file: r.file, year: r.year };
      if (t && t.count >= MIN_PAIR_VERIFIED && Number.isFinite(r.year)
        && (r.year < t.first - TENURE_SLACK_YEARS || r.year > t.last + TENURE_SLACK_YEARS)) {
        const others = elsewhereIn(r.outlet, r.year);
        if (others.length > 0) {
          flags.push({ ...base, kind: 'outside_tenure', tenure: { first: t.first, last: t.last, count: t.count }, verifiedElsewhereThatYear: others });
        }
        continue;
      }
      if (!t && !r.verified && verified.length >= MIN_CRITIC_VERIFIED) {
        flags.push({ ...base, kind: 'unsupported_pair', verifiedOutlets: Object.fromEntries(Object.entries(tenure).map(([o, x]) => [o, `${x.first}-${x.last} (${x.count})`])) });
      }
    }
  }
  return flags.sort((a, b) => (a.criticSlug + a.showId).localeCompare(b.criticSlug + b.showId));
}

/**
 * Key for one flagged row: `<showId>/<file>#<kind>:<criticSlug>`. Kind and
 * critic are part of it so a reviewed entry stops matching once the row's
 * byline or flag kind changes.
 */
function tenureFlagKey(flag) {
  return `${flag.showId}/${flag.file}#${flag.kind}:${flag.criticSlug}`;
}

/**
 * Split flags against a reviewed-exceptions list (rows checked by hand and
 * found correct). An entry counts only with an http(s) evidence link; entries
 * that no longer match a flag are returned as stale so the list cannot rot.
 *
 * @param {Array} flags - findTenureFlags() output
 * @param {Array<{key: string, evidence: string}>} reviewed
 * @returns {{unresolved: Array, reviewed: Array, stale: Array, invalid: Array}}
 */
function applyReviewedTenureFlags(flags, reviewed = []) {
  const valid = new Map();
  const invalid = [];
  for (const e of reviewed) {
    if (e && typeof e.key === 'string' && /^https?:\/\//.test(String(e.evidence || ''))) valid.set(e.key, e);
    else invalid.push(e);
  }
  const unresolved = [];
  const matched = [];
  for (const f of flags) (valid.has(tenureFlagKey(f)) ? matched : unresolved).push(f);
  const flagKeys = new Set(flags.map(tenureFlagKey));
  const stale = [...valid.values()].filter(e => !flagKeys.has(e.key));
  return { unresolved, reviewed: matched, stale, invalid };
}

/**
 * One-line human description of a flag for audit output. Switches on every
 * kind findTenureFlags emits so a new kind cannot crash the reporter (the
 * daily corpus-drift run died on byline_contradicted, which carries no
 * verifiedOutlets: BRO-5789).
 */
function describeTenureFlag(f) {
  switch (f.kind) {
    case 'outside_tenure':
      return `${f.year} outside ${f.tenure.first}-${f.tenure.last} (${f.tenure.count} verified); verified at ${f.verifiedElsewhereThatYear.join(', ')} that year`;
    case 'unsupported_pair':
      return `no verified row at this outlet; verified at ${Object.keys(f.verifiedOutlets || {}).join(', ') || 'no outlet'}`;
    case 'byline_contradicted':
      return 'stored page credits another critic of this outlet';
    default:
      return `unrecognised flag kind ${f.kind}`;
  }
}

module.exports = { describeTenureFlag, bylineContradicted, tenureFlagKey, applyReviewedTenureFlags, isVerifiedRow, reviewYear, findTenureFlags, MIN_PAIR_VERIFIED, MIN_CRITIC_VERIFIED, TENURE_SLACK_YEARS, MIN_ELSEWHERE_VERIFIED };
