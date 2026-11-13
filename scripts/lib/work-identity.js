'use strict';
/**
 * Work identity (BRO-7429): are two productions with the same title the same WORK?
 *
 * getOtherProductions links productions by normalized title. A title is not a work:
 * Brecht's play "Galileo" (Trap Door, Chicago) is not the 2026 Broadway musical
 * "Galileo". Regional discovery records no creativeTeam, so nothing told them apart.
 *
 * Evidence, strongest first:
 *   1. An explicit link (transferOf, transferredTo) or `sameWorkAs: [ids]`
 *      (a reviewed statement that this row is the same work as those rows): same work.
 *   2. `workKey`: a kebab slug naming the work. When either show has one, the two
 *      are the same work only if both carry the same key. Set it on the shows that
 *      are NOT the title's default work (e.g. Brecht's Galileo: "galileo-brecht-play").
 *   3. Credited writers (book/music/lyrics/playwright/adaptor, accent-folded
 *      surnames). A shared surname is the same work. No shared surname AND one
 *      side is a musical/opera while the other is a play: different work.
 *      Disjoint writers within one type are NOT split on their own (credits are
 *      partial and adaptations re-credit: Rodgers vs Hammerstein, Dickens vs the
 *      adaptor), they are reported "unknown" for the audit to settle with a source.
 *   4. Nothing to compare: "unknown". Callers keep the link (type labels alone are
 *      unreliable: regional Annie, Godspell and Joseph are labelled "play").
 */

const WRITER_ROLE_RE = /^(book|books|music|lyrics?|lyricist|lyricists|composer|composers|playwright|playwrights|writer|writers|written|adapt|adaptation|adaptor|adapter|libretto|librettist|screenplay|story|created|conceived|translat|text|script|words)/i;
// "Music Direction", "Music Supervision", "Orchestrations" etc. are not authorship.
const NOT_WRITER_RE = /(direct|supervis|orchestrat|arrang|coordinat|staging|design|contract|associate|assistant|casting|producer|choreograph)/i;
const SUFFIX_RE = /^(jr|sr|ii|iii|iv|esq|phd)$/;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Surnames of everyone credited with writing the show, accent-folded. Empty set when none. */
function writerSurnames(show) {
  const out = new Set();
  for (const m of (show && show.creativeTeam) || []) {
    const role = String((m && m.role) || '').trim();
    if (!role || !WRITER_ROLE_RE.test(role)) continue;
    if (NOT_WRITER_RE.test(role) && !/^written/i.test(role)) continue;
    // "A, B and C" / "A & B": one entry may name several people. Template junk
    // ("{{plainlist | ...") is dropped rather than parsed.
    const raw = String((m && m.name) || '').replace(/\([^)]*\)/g, ' ');
    if (/[{}|]/.test(raw)) continue;
    for (const part of raw.split(/\s*(?:,|&|\band\b)\s*/i)) {
      const toks = fold(part).replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean).filter((t) => !SUFFIX_RE.test(t));
      if (toks.length) out.add(toks[toks.length - 1].replace(/^[-']+|[-']+$/g, ''));
    }
  }
  out.delete('');
  return out;
}

const MUSICALISH = new Set(['musical', 'opera']);
const PLAYISH = new Set(['play']);
function typeConflict(a, b) {
  const ta = a && a.type; const tb = b && b.type;
  return (MUSICALISH.has(ta) && PLAYISH.has(tb)) || (PLAYISH.has(ta) && MUSICALISH.has(tb));
}

function linked(a, b) {
  const declares = (x, y) => Array.isArray(x.sameWorkAs) && x.sameWorkAs.includes(y.id);
  return declares(a, b) || declares(b, a)
    || a.transferOf === b.id || b.transferOf === a.id || a.transferredTo === b.id || b.transferredTo === a.id;
}

/**
 * Verdict for two same-title productions.
 * @returns {{verdict: 'same'|'different'|'unknown', basis: string}}
 */
function workIdentity(a, b) {
  if (!a || !b || a.id === b.id) return { verdict: 'same', basis: 'identical' };
  if (linked(a, b)) return { verdict: 'same', basis: 'linked' };
  if (a.workKey || b.workKey) {
    return a.workKey === b.workKey
      ? { verdict: 'same', basis: 'workKey' }
      : { verdict: 'different', basis: 'workKey' };
  }
  const wa = writerSurnames(a); const wb = writerSurnames(b);
  if (wa.size && wb.size) {
    if ([...wa].some((x) => wb.has(x))) return { verdict: 'same', basis: 'shared-writer' };
    if (typeConflict(a, b)) return { verdict: 'different', basis: 'writers+type' };
    return { verdict: 'unknown', basis: 'disjoint-writers-same-type' };
  }
  return { verdict: 'unknown', basis: wa.size || wb.size ? 'one-side-no-writers' : 'no-writers' };
}

/** True when the two productions are known to be different works. */
function differentWorks(a, b) {
  return workIdentity(a, b).verdict === 'different';
}

function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[‘’′'']/g, "'").replace(/[^\w\s']/g, '').trim();
}

/**
 * A NEW show that cannot be told apart from an existing same-title work it
 * is likely not: it has no writers and no workKey, and a same-title sibling that
 * lists writers has the other musical/play type (the Galileo shape), or the sibling
 * is a different work by workKey. Used by add-show-action, discovery staging and
 * the validate-data advisory. Returns the sibling's id or null.
 */
function undistinguishableSibling(show, allShows) {
  if (!show || show.workKey || writerSurnames(show).size) return null;
  const key = normalizeTitle(show.title);
  for (const s of allShows || []) {
    if (!s || s.id === show.id || normalizeTitle(s.title) !== key) continue;
    if (linked(show, s)) continue;
    if (typeConflict(show, s) && writerSurnames(s).size) return s.id;
  }
  return null;
}

/**
 * Discovery-time resolver (BRO-7429): a page's own text (a venue blurb, a listing description) that names
 * a same-title sibling's writer is evidence the page is that sibling's work. Returns the sibling id or null.
 * It never concludes "different": a blurb that names nobody leaves the row unresolved for a person or agent
 * to read the writer off the page.
 */
function sameWorkFromText(text, show, allShows) {
  const hay = ' ' + fold(text).replace(/[^a-z\s'-]/g, ' ') + ' ';
  const key = normalizeTitle(show.title);
  for (const s of allShows || []) {
    if (!s || s.id === show.id || normalizeTitle(s.title) !== key || !typeConflict(show, s)) continue;
    for (const w of writerSurnames(s)) if (w.length > 3 && hay.includes(' ' + w + ' ')) return s.id;
  }
  return null;
}

module.exports = { sameWorkFromText, writerSurnames, workIdentity, differentWorks, undistinguishableSibling, normalizeTitle, typeConflict };
