/**
 * Synopsis fact checks that go beyond "is this text shaped like a synopsis".
 *
 * Why this exists (BRO-4853, 2026-10-07): the Other Desert Cities revival went
 * live saying the play "originally won the Tony Award for Best Play revival".
 * That sentence is Show Score's producer-written blurb, copied verbatim by
 * scrape-show-score-audience.js, and it is false: the 2011 production was a
 * new play, lost Best Play, and won one Tony (Featured Actress). The only gate
 * on that write path was "synopsis is empty", so nothing compared the claim to
 * our own awards data. A site-wide sweep the same day also found a Fela!
 * record holding the 1776 revival's text, a Great Society record holding the
 * Great Comet's Wikipedia lede, and five records holding a cookie banner.
 *
 * Two checks live here (pure functions, no I/O, per CLAUDE.md §15):
 *   1. checkAwardClaims: a "won Best X" / "Tony Award-winning Best X" claim
 *      must match a win in awards.json for the show or its lineage.
 *   2. findSharedSentences: one long sentence appearing on shows with
 *      unrelated titles means a synopsis landed on the wrong show.
 * Page-chrome text (cookie banners) is rejected in synopsis-validation.js.
 */

const { SCRAPED_PAGE_CHROME_RE } = require('./synopsis-validation');
const { foldDiacritics } = require('./title-match');

// Longest alternatives first so "Play Revival" is not read as plain "Play".
const CATEGORY_SRC =
  '(Revival of a (?:Play|Musical)|(?:Play|Musical) Revival|New Play|New Musical|Play|Musical)';

// "won the Tony Award for Best Play revival", "winner of ... Best Musical".
const WON_CLAIM_RE = new RegExp(
  '\\b(?:won|wins|winner of|awarded|win for)\\b([^.]{0,80}?)\\bBest ' + CATEGORY_SRC + '\\b',
  'ig'
);
// "This Tony Award-winning Best Musical ...".
const WINNING_CLAIM_RE = new RegExp(
  '\\bTony(?: Award)?[®™]?[\\s\\u2013-]+winning Best ' + CATEGORY_SRC + '\\b',
  'ig'
);

const BEST_CATEGORY_RE = new RegExp('\\bBest ' + CATEGORY_SRC + '\\b', 'ig');
const OTHER_BODY_OR_NOMINATION_RE =
  /nominat|\b(?:Olivier|Grammy|Drama Desk|Obie|Pulitzer|Lortel|Emmy|Oscar|Academy Award)/i;

/**
 * Sentence split that does not break on initials or common abbreviations
 * ("Jeffrey L. Page", "St. James Theatre", "Mr. Wilde").
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])(?<!\b[A-Z]\.)(?<!\b(?:St|Mr|Mrs|Ms|Dr|Jr|Sr|vs)\.)\s+/);
}

/**
 * Cut `text` to at most `max` characters at the last sentence end, so the
 * result still passes isValidSynopsis (a hard cut ends mid-word and is
 * rejected as truncated). Falls back to a word boundary plus an ellipsis.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncateAtSentence(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const window = t.slice(0, max);
  const ends = [...window.matchAll(/[.!?]["”')\]]?(?=\s|$)/g)].filter(
    (e) => !/\b(?:[A-Z]|St|Mr|Mrs|Ms|Dr|Jr|Sr)$/.test(window.slice(0, e.index))
  );
  const last = ends.length ? ends[ends.length - 1] : null;
  if (last && last.index + last[0].length >= max * 0.4) return window.slice(0, last.index + last[0].length);
  return window.replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '...';
}

function normalizeCategory(raw) {
  const c = String(raw || '')
    .toLowerCase()
    .replace(/^best\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (c === 'play revival') return 'revival of a play';
  if (c === 'musical revival') return 'revival of a musical';
  if (c === 'new play') return 'play';
  if (c === 'new musical') return 'musical';
  return c;
}

/**
 * Tony category-win claims made in a synopsis. Only sentences that mention
 * Tony are read, and "won ... nominated ... Best X" is skipped (a nomination
 * is not a win claim).
 * @param {string} text
 * @returns {{ category: string, sentence: string }[]}
 */
function extractTonyCategoryClaims(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const sentence of splitSentences(text)) {
    if (!/\bTony/i.test(sentence)) continue;
    let m;
    WON_CLAIM_RE.lastIndex = 0;
    while ((m = WON_CLAIM_RE.exec(sentence))) {
      // The win must be a Tony one: "won the Grammy for Best Musical Theater
      // Album ... 12 Tony nominations" has Tony in the sentence but not here.
      if (!/\bTony/i.test(m[1]) || /nominat/i.test(m[1])) continue;
      // Every "Best X" after the verb, until the sentence turns to nominations
      // or another award body ("won Tony Awards for Best Play and Best
      // Revival of a Musical" is two claims).
      const tail = sentence.slice(m.index).split(OTHER_BODY_OR_NOMINATION_RE)[0];
      const seen = new Set();
      let c;
      BEST_CATEGORY_RE.lastIndex = 0;
      while ((c = BEST_CATEGORY_RE.exec(tail))) {
        const category = normalizeCategory(c[1]);
        if (seen.has(category)) continue;
        seen.add(category);
        out.push({ category, sentence: sentence.trim() });
      }
    }
    WINNING_CLAIM_RE.lastIndex = 0;
    while ((m = WINNING_CLAIM_RE.exec(sentence))) {
      out.push({ category: normalizeCategory(m[1]), sentence: sentence.trim() });
    }
  }
  return out;
}

/**
 * The show plus everything whose awards it may legitimately cite: earlier
 * productions (originalProductionId chain) and a tour's Broadway parent.
 * @param {{ id: string, originalProductionId?: string, tourOf?: string }} show
 * @param {Record<string, any>} showsById
 * @returns {string[]}
 */
function lineageIds(show, showsById) {
  const ids = [];
  let cur = show;
  for (let i = 0; cur && i < 6; i++) {
    if (ids.includes(cur.id)) break;
    ids.push(cur.id);
    const next = cur.originalProductionId || cur.tourOf;
    cur = next ? showsById[next] : null;
    if (!cur && next && !ids.includes(next)) ids.push(next);
  }
  return ids;
}

/**
 * Compare a synopsis's Tony category-win claims to awards.json.
 *  - unsupported: some show in the lineage has Tony data and none of its wins
 *    match the claimed category. This is the Other Desert Cities shape.
 *  - unverifiable: no show in the lineage has Tony data, so we cannot judge.
 * @param {{ id: string, synopsis?: string }} show
 * @param {{ awardsByShow: Record<string, any>, showsById: Record<string, any> }} ctx
 * @returns {{ unsupported: object[], unverifiable: object[] }}
 */
function checkAwardClaims(show, ctx) {
  const result = { unsupported: [], unverifiable: [] };
  const claims = extractTonyCategoryClaims(show && show.synopsis);
  if (claims.length === 0) return result;
  const lineage = lineageIds(show, ctx.showsById || {});
  const tonyEntries = lineage
    .map((id) => ctx.awardsByShow && ctx.awardsByShow[id] && ctx.awardsByShow[id].tony)
    .filter(Boolean);
  const wins = new Set(tonyEntries.flatMap((t) => (t.wins || []).map(normalizeCategory)));
  // Pre-1994 the single "Best Revival" award covered plays and musicals.
  if (wins.has('revival')) {
    wins.add('revival of a play');
    wins.add('revival of a musical');
  }
  for (const claim of claims) {
    if (tonyEntries.length === 0) {
      result.unverifiable.push(claim);
    } else if (!wins.has(claim.category)) {
      result.unsupported.push({ ...claim, actualWins: [...wins] });
    }
  }
  return result;
}

// Fold accents BEFORE stripping non-alphanumerics ("Les Misérables" must not shred).
const titleKey = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]/g, '');

// Related productions legitimately share copy: reruns, tours, "Both Parts" vs
// "One Part". Related = linked by originalProductionId/tourOf, or one
// normalized title contains the other.
function related(a, b) {
  if (a.originalProductionId === b.id || b.originalProductionId === a.id) return true;
  if (a.tourOf === b.id || b.tourOf === a.id) return true;
  const ta = titleKey(a.title);
  const tb = titleKey(b.title);
  if (ta === tb) return true;
  // Containment ("Both Parts" vs the base title) only counts for titles long
  // enough that a short name like "Six" cannot swallow unrelated ones.
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.length >= 8 && long.includes(short);
}

/**
 * Sentences of at least `minLen` characters that appear in the synopses of two
 * or more shows that are not related. Page chrome is ignored (the validator
 * handles it). A hit means one of the shows carries another show's text.
 * @param {{ id: string, title: string, synopsis?: string }[]} shows
 * @param {{ minLen?: number }} [opts]
 * @returns {{ sentence: string, ids: string[] }[]}
 */
function findSharedSentences(shows, opts = {}) {
  const minLen = opts.minLen || 80;
  const bySentence = new Map();
  for (const s of shows) {
    if (!s.synopsis) continue;
    const seen = new Set();
    for (const raw of splitSentences(s.synopsis)) {
      const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
      if (key.length < minLen || seen.has(key) || SCRAPED_PAGE_CHROME_RE.test(key)) continue;
      seen.add(key);
      if (!bySentence.has(key)) bySentence.set(key, { sentence: raw.trim(), shows: [] });
      bySentence.get(key).shows.push(s);
    }
  }
  const out = [];
  for (const { sentence, shows: group } of bySentence.values()) {
    if (group.length < 2) continue;
    const unrelated = group.some((a, i) => group.slice(i + 1).some((b) => !related(a, b)));
    if (unrelated) out.push({ sentence, ids: group.map((g) => g.id) });
  }
  return out;
}

// Wikipedia ledes: "<Subject> is a 2023 stage musical ...", "<Subject> is a
// tragedy written by ...". Only a work-noun right after "is a/an/the" counts, so
// character openers ("Lydia Deetz is a ...") never match.
// People count too: "Richard Greenberg (1958-2025) was an American playwright"
// is a biography that landed in the synopsis field, not a synopsis.
const WIKI_LEDE_RE =
  /^\*?([^.!?]{2,90}?)\*?\s+(?:is|was)\s+(?:an?|the)\s+(?:[\w'’,-]+\s+){0,5}?(?:musical|play|stage play|tragedy|comedy|drama|film|novel|opera|operetta|ballet|revue|monologue|television|series|book|playwright|actor|actress|director|screenwriter|composer|lyricist|filmmaker|author|comedian|singer)\b/i;

// Lede subjects that name the right work under a different spelling.
const LEDE_MISMATCH_ALLOW = new Set([
  'king-richard-iii-1979', // "The Tragedy of Richard the Third": the right play, other spelling
  'long-days-journey-into-night-2016', // opens on stage directions, still the right play
]);

/**
 * A synopsis written as a Wikipedia lede about a DIFFERENT work than the show
 * ("Linda Vista" carrying Buena Vista Social Club's lede) is the wrong-article
 * signature of the legacy Wikipedia fetcher (BRO-4853). Returns the lede subject
 * when it shares no title with the show, else null.
 * @param {{ title?: string, synopsis?: string }} show
 * @returns {string | null}
 */
function ledeTitleMismatch(show) {
  if (show && LEDE_MISMATCH_ALLOW.has(show.id)) return null;
  const m = show && show.synopsis && show.synopsis.match(WIKI_LEDE_RE);
  if (!m) return null;
  const key = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/&/g, 'and').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]/g, '');
  const subject = key(m[1].replace(/\([^)]*\)/g, ''));
  const title = key(show.title);
  if (!subject || !title) return null;
  if (subject.includes(title) || title.includes(subject)) return null;
  if (subject.slice(0, 6) === title.slice(0, 6)) return null;
  return m[1].trim();
}

/**
 * awards.json `shows` map, or {} when the file is absent (a stub-data cloud
 * session). With no awards data every claim is "unverifiable" and passes.
 * @returns {Record<string, any>}
 */
let awardsCache = null;
function loadAwardsByShow() {
  // Memoised: the gate runs once per show and awards.json is ~1.4 MB.
  if (awardsCache) return awardsCache;
  try {
    const p = require('path').join(__dirname, '../../data/awards.json');
    awardsCache = JSON.parse(require('fs').readFileSync(p, 'utf8')).shows || {};
  } catch {
    return {};
  }
  return awardsCache;
}

/**
 * Gate for any script that copies third-party blurb text (Show Score,
 * TodayTix, discovery feeds) into shows.json. Producer copy is marketing, not
 * a source of record: it must pass the shared shape checks AND not contradict
 * our awards data. A rejected candidate is left unwritten so a validated
 * source (Wikipedia enrichment, a human) can fill the field instead.
 * @param {object} show - the shows.json record being enriched
 * @param {string} candidate - the scraped text
 * @param {{ awardsByShow?: Record<string, any>, showsById: Record<string, any> }} ctx
 * @returns {{ ok: boolean, reason: string | null }}
 */
function gateScrapedSynopsis(show, candidate, ctx) {
  const { classifyBadSynopsis } = require('./synopsis-validation');
  const shape = classifyBadSynopsis({ synopsis: candidate, status: show && show.status });
  if (shape.bad) return { ok: false, reason: shape.reason };
  const probe = { ...show, synopsis: candidate };
  const lede = ledeTitleMismatch(probe);
  if (lede) return { ok: false, reason: `text is about "${lede.slice(0, 50)}", not this show` };
  const awardsByShow = (ctx && ctx.awardsByShow) || loadAwardsByShow();
  const claims = checkAwardClaims(probe, { awardsByShow, showsById: (ctx && ctx.showsById) || {} });
  if (claims.unsupported.length > 0) {
    return { ok: false, reason: `unsupported award claim: ${claims.unsupported[0].sentence.slice(0, 80)}` };
  }
  return { ok: true, reason: null };
}

module.exports = {
  gateScrapedSynopsis,
  loadAwardsByShow,
  splitSentences,
  truncateAtSentence,
  ledeTitleMismatch,
  extractTonyCategoryClaims,
  lineageIds,
  checkAwardClaims,
  findSharedSentences,
  normalizeCategory,
};
