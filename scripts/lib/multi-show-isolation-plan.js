'use strict';

/**
 * Decision logic for scripts/isolate-multi-show-sections.js (corpus sweep of
 * multi-show blog posts stored whole). Kept in scripts/lib so tests require()
 * the real function (CLAUDE.md section 15).
 */

const {
  isMultiShowPostUrl, isolateMultiShowSectionForShowId, findSectionHeadings, headingShowName, normSectionText,
} = require('./multi-show-section-extract');
const { markRescoreNeeded } = require('./rescore-flagging');

function countWords(t) { return (t.match(/\S+/g) || []).length; }


/**
 * Did the verdict come from reading ANOTHER show's section? True only when the
 * reason names another section's show (first two words of its heading), e.g.
 * sunset-boulevard-2024: 'CV-promoted: The scraped content reviews "DRAG: The
 * Musical"'. A reason about venue/production (two-strangers regional page vs
 * the Broadway Lyceum review) names no other section and is left standing.
 */
function verdictCitesOtherSection(reason, fullPost, ownSectionText) {
  // Automated verdicts only (content verifier, collector LLM); a human reason stands.
  // Cross-show URL collision: the same post URL sits under several shows.
  if (!/^(CV-promoted|Collector LLM|Cross-show URL collision)/.test(String(reason || ''))) return false;
  const r = ` ${normSectionText(reason)} `;
  return findSectionHeadings(fullPost)
    .filter((h) => !ownSectionText.startsWith(fullPost.slice(h.start, h.start + 40)))
    .some((h) => {
      const name = headingShowName(h.title); // "bug", "chinese republicans"
      // Headings can run on ("eureka day presented by manhattan theatre club")
      // while the reason says just "Eureka Day": also accept its first two words.
      const two = name.split(' ').slice(0, 2).join(' ');
      return (name.length >= 3 && r.includes(` ${name} `)) || (two.length >= 6 && two !== name && r.includes(` ${two} `));
    });
}

/**
 * Pure decision + mutation for one record. Returns null when nothing to do.
 * @returns {{ data: object, clearedFlags: string[], from: number, to: number } | { refused: true } | null}
 */
function planIsolation(data, showId, at) {
  if (!data || !data.fullText || !isMultiShowPostUrl(data.url)) return null;
  const iso = isolateMultiShowSectionForShowId(data.url, data.fullText, showId);
  if (iso.action === 'refuse') return { refused: true };
  if (iso.action !== 'isolated') return null;
  const out = { ...data };
  const from = data.fullText.length;
  out.fullText = iso.text;
  out.textWordCount = countWords(iso.text);
  out.isFullReview = iso.text.length > 1500;
  const clearedFlags = [];
  const why = `isolate-multi-show-sections ${at.slice(0, 10)}: verdict was made on the whole multi-show post; re-judge on this show's section`;
  if (out.wrongShow === true && verdictCitesOtherSection(out.wrongShowReason, data.fullText, iso.text)) {
    out.wrongShow = false;
    out.wrongShowAutoCleared = why;
    out.wrongShowAutoClearedAt = at;
    clearedFlags.push('wrongShow');
  }
  if (out.wrongProduction === true && verdictCitesOtherSection(out.wrongProductionReason, data.fullText, iso.text)) {
    out.wrongProduction = false;
    out.wrongProductionAutoCleared = why;
    out.wrongProductionAutoClearedAt = at;
    clearedFlags.push('wrongProduction');
  }
  if (clearedFlags.length && out.contentVerification) {
    // The CV verdict object describes the whole post. Keep it (never delete
    // contentVerification) but neutralise its negative verdicts and mark it
    // stale so the next verification pass judges the section.
    out.contentVerification = {
      ...out.contentVerification,
      wrongArticle: false,
      wrongProduction: false,
      staleWholePostVerdict: true,
      staleWholePostVerdictAt: at,
    };
  }
  out.multiShowSectionIsolatedAt = at;
  out.multiShowFullPostLength = from;
  markRescoreNeeded(out, 'multi-show post: fullText reduced to this show\'s section', at);
  return { data: out, clearedFlags, from, to: iso.text.length };
}

module.exports = { planIsolation, verdictCitesOtherSection };
