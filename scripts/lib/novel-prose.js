/**
 * novel-prose.js: the novel-prose measure (BRO-7171 Stage 4), pure and
 * dependency-light so extraction code (collect-review-texts.js chooseOutletOrGeneric)
 * can use it without pulling gap-acceptance.js and its LLM/browser secret reads
 * into every workflow step that runs the collector. gap-acceptance re-exports it.
 */
'use strict';

// Novel-prose gain (BRO-7171 Stage 4). The raw-length bar let a same-url
// refetch "recover" a review by gaining page chrome: of the first 97 accepted
// recoveries 71 stayed truncated, and diffing each against its pre-recovery
// text showed most gains were share buttons ("Get link Facebook X"), listing
// blocks (dates, tube station, map), ticket calendars, newsletter footers or a
// related-article teaser (Guardian Ceilidh +22 chars = a Trump headline).
// Words of the candidate count as novel when no 6-word shingle containing
// them occurs in the prior text (both tokenized by review-text-identity's
// identityTokens, which also drops boilerplate lines). A novel run counts as
// prose only with >= 12 words, under a quarter of them chrome words or bare
// numbers, cut at a "related articles"-style marker.
const NOVEL_SHINGLE = 6;
const NOVEL_MIN_RUN_WORDS = 12;
const NOVEL_MAX_CHROME_FRAC = 0.25;
const MIN_NOVEL_PROSE_CHARS = 300;
const MIN_NOVEL_PROSE_FRAC = 0.15;
const CHROME_WORDS = new Set((
  'share shares facebook twitter x pinterest email whatsapp linkedin reddit tumblr bluesky threads link copied get other apps '
  + 'subscribe subscribed subscribing newsletter newsletters sign signup login log comments comment post posted tags tagged '
  + 'categories category related articles article read more views view tickets ticket book booking buy box office '
  + 'map location nearest tube station photo photos photography credit image images advertisement skip opens new window tab '
  + 'follow followers people previous next mon tue wed thu fri sat sun am pm until runs price prices details info information '
  + 'visit website rating reviewer reviewed author min listen audio loading home menu search privacy cookie cookies policy '
  + 'rights reserved copyright click here unsubscribe footer jan feb mar apr jun jul aug sep sept oct nov dec january february '
  + 'march april june july august september october november december'
).split(/\s+/));
const RELATED_MARKER_RE = /\b(?:related (?:articles|posts|stories|content|reading)|more (?:news|stories|from|things to do)|you (?:may|might) also like|popular posts|latest news|recommended for you|read next|trending now)\b/;

/**
 * Characters of genuinely new prose the candidate adds over the prior text.
 * Pure. @returns {number}
 */
function novelProseChars(priorText, candidateText, { minRunWords = NOVEL_MIN_RUN_WORDS } = {}) {
  const { identityTokens } = require('./review-text-identity');
  const words = (t) => identityTokens(String(t || '')).map((x) => x.w);
  const pw = words(priorText);
  const seen = new Set();
  for (let i = 0; i + NOVEL_SHINGLE <= pw.length; i++) seen.add(pw.slice(i, i + NOVEL_SHINGLE).join(' '));
  const cw = words(candidateText);
  const covered = new Array(cw.length).fill(false);
  for (let i = 0; i + NOVEL_SHINGLE <= cw.length; i++) {
    if (seen.has(cw.slice(i, i + NOVEL_SHINGLE).join(' '))) for (let j = i; j < i + NOVEL_SHINGLE; j++) covered[j] = true;
  }
  const runs = [];
  let run = [];
  for (let i = 0; i < cw.length; i++) {
    if (!covered[i]) run.push(cw[i]);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  let chars = 0;
  for (const r0 of runs) {
    let r = r0;
    const joined = r.join(' ');
    const m = RELATED_MARKER_RE.exec(joined);
    if (m) r = joined.slice(0, m.index).trim().split(' ').filter(Boolean);
    if (r.length < minRunWords) continue;
    const chrome = r.filter((w) => CHROME_WORDS.has(w) || /^\d+$/.test(w)).length;
    if (chrome / r.length > NOVEL_MAX_CHROME_FRAC) continue;
    chars += r.join(' ').length;
  }
  return chars;
}

/**
 * The one novel-prose bar, shared by the acceptance gate (gate 9) and the
 * chrome rollback (gap-rollback.js) so the two can never disagree. Pure.
 * @returns {{ok: boolean, novel: number, need: number}}
 */
function novelProseVerdict(priorText, candidateText) {
  const prior = String(priorText || '');
  const novel = novelProseChars(prior, candidateText);
  const need = Math.max(MIN_NOVEL_PROSE_CHARS, Math.ceil(prior.length * MIN_NOVEL_PROSE_FRAC));
  return { ok: novel >= need, novel, need };
}

module.exports = { novelProseChars, novelProseVerdict, MIN_NOVEL_PROSE_CHARS, MIN_NOVEL_PROSE_FRAC };
