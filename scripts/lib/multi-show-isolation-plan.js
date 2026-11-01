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
function verdictCitesOtherSection(reason, fullPost, ownSectionText, { requireQuoted = false } = {}) {
  // Automated verdicts only (content verifier, collector LLM); a human reason stands.
  // Cross-show URL collision: the same post URL sits under several shows.
  // BRO-6742: 'Retroactive LLM verify' is the same automated verifier run later (chess-2025
  // read the post's 'Initiative' section).
  if (!/^(CV-promoted|Collector LLM|Cross-show URL collision|Retroactive LLM verify)/.test(String(reason || ''))) return false;
  // requireQuoted (BRO-6742 second opinion): match only inside a quoted title
  // ('Initiative', "Giant"), so a reason that merely mentions a heading's word
  // in passing (cabaret-2024's West End verdict) never clears.
  const r = requireQuoted
    ? ` ${quotedTitles(reason).map(normSectionText).join(' | ')} `
    : ` ${normSectionText(reason)} `;
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

/** Quoted spans in a verdict reason: "X", 'X', “X”, ‘X’. */
function quotedTitles(reason) {
  const out = [];
  const re = /"([^"]{2,80})"|“([^”]{2,80})”|(?:^|[\s(])'([^']{2,80})'(?=[\s.,;:)]|$)|‘([^’]{2,80})’/g;
  let m;
  while ((m = re.exec(String(reason || '')))) out.push(m[1] || m[2] || m[3] || m[4]);
  return out;
}

/**
 * The verdict's reason text. BRO-6742: some writers kept it only in
 * incompleteDetail (data-off-broadway-2026, pen-pals: wrongProductionReason absent),
 * so the sweep could never see that it named another section's show.
 */
function verdictReason(data, flag) {
  return verdictReasonSource(data, flag).reason;
}

/** { reason, own }: own=false when the text came from the incompleteDetail fallback. */
function verdictReasonSource(data, flag) {
  const ownReason = data[`${flag}Reason`];
  if (ownReason) return { reason: ownReason, own: true };
  return { reason: data.incompleteDetail || '', own: false };
}

/**
 * Looser evidence (the incompleteDetail fallback, which can carry the other
 * flag's reason; the later 'Retroactive LLM verify' verdicts; any refetched
 * post) must quote the other section's title, not just mention its words.
 */
function citesOtherSection(data, flag, fullPost, ownSectionText, strict) {
  const { reason, own } = verdictReasonSource(data, flag);
  const requireQuoted = strict || !own || /^Retroactive LLM verify/.test(reason);
  return verdictCitesOtherSection(reason, fullPost, ownSectionText, { requireQuoted });
}

/**
 * Pure decision + mutation for one record. Returns null when nothing to do.
 * @returns {{ data: object, clearedFlags: string[], from: number, to: number } | { refused: true } | null}
 */
function planIsolation(data, showId, at, { strict = false } = {}) {
  if (!data || !data.fullText || !isMultiShowPostUrl(data.url)) return null;
  const iso = isolateMultiShowSectionForShowId(data.url, data.fullText, showId);
  if (iso.action === 'refuse') return { refused: true };
  if (iso.action === 'single-section') return planStaleWholePostRejection(data, at);
  if (iso.action !== 'isolated') return null;
  const out = { ...data };
  const from = data.fullText.length;
  out.fullText = iso.text;
  out.textWordCount = countWords(iso.text);
  out.isFullReview = iso.text.length > 1500;
  const clearedFlags = [];
  const why = `isolate-multi-show-sections ${at.slice(0, 10)}: verdict was made on the whole multi-show post; re-judge on this show's section`;
  if (out.wrongShow === true && citesOtherSection(out, 'wrongShow', data.fullText, iso.text, strict)) {
    out.wrongShow = false;
    out.wrongShowAutoCleared = why;
    out.wrongShowAutoClearedAt = at;
    clearedFlags.push('wrongShow');
  }
  if (out.wrongProduction === true && citesOtherSection(out, 'wrongProduction', data.fullText, iso.text, strict)) {
    out.wrongProduction = false;
    out.wrongProductionAutoCleared = why;
    out.wrongProductionAutoClearedAt = at;
    clearedFlags.push('wrongProduction');
  }
  if (clearedFlags.length && out.wrongShow !== true && out.wrongProduction !== true && out.incompleteReason === 'wrong_content') {
    // Same as rebuild's legacy wrongShow heal (BRO-6716): the wrong_content
    // reason described the cleared verdict. The *AutoCleared fields keep the trail.
    delete out.incompleteReason;
    delete out.incompleteDetail;
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

const WHOLE_POST_REASONING_RE = /multi[\s-]?show|round-?up|\b(?:two|three|four|five|several|multiple)\s+(?:different\s+|separate\s+)?(?:productions|shows|plays|reviews)\b/i;
const AUTOMATED_REJECTER_RE = /^(?:ensemble|collector|llm|cv|content-verif|auto)/i;

/**
 * BRO-6744: the stored text is already ONE show's section (isolated or split
 * earlier) but an automated rejection / roundup flag made BEFORE that cut still
 * stands, and its reasoning describes the whole multi-show post (jesa-off-
 * broadway-2026: "multi-show roundup covering three productions" rejected the
 * file for good). Clear it and rescore. Never touches a human verdict, a
 * rejection made after the cut, or one whose reasoning is not about a
 * multi-show post.
 * @returns {{ data: object, clearedFlags: string[], from: number, to: number } | null}
 */
function planStaleWholePostRejection(data, at) {
  const cutAt = Date.parse(data.multiShowSectionIsolatedAt || data.multiShowSplitProcessed || '');
  if (!cutAt) return null;
  const rejected = !!(data.rejectionReason || data.rejectedAt);
  if (!rejected) return null;
  if (data.humanReviewScore != null || data.manualContentTier || data.wrongShowManualClear || data.wrongShowOverride || data.humanReviewedWrongProduction === true) return null;
  const rejectedAt = Date.parse(data.rejectedAt || '');
  if (!AUTOMATED_REJECTER_RE.test(String(data.rejectedBy || ''))) return null;
  if (!rejectedAt || rejectedAt >= cutAt) return null;
  if (!WHOLE_POST_REASONING_RE.test(String(data.rejectionReasoning || ''))) return null;
  const out = { ...data };
  const clearedFlags = [];
  for (const k of ['rejectedAt', 'rejectedBy', 'rejectionReason', 'rejectionReasoning']) delete out[k];
  clearedFlags.push('rejection');
  out.wholePostVerdictClearedAt = at;
  markRescoreNeeded(out, 'multi-show post: verdict made on the whole post cleared; re-judge this show\'s section', at);
  const len = String(data.fullText).length;
  return { data: out, clearedFlags, from: len, to: len };
}

/**
 * BRO-6742: a file flagged wrongShow/wrongProduction by a verdict on the WHOLE
 * post whose stored text is now empty or already one section (so planIsolation
 * on the stored text finds nothing to do and the verdict never gets re-judged):
 * dry-run planIsolation against the freshly fetched post. Returns its plan only
 * when it clears a verdict that named another section's show; otherwise null
 * (the file is left exactly as it is).
 * @param {object} data stored record
 * @param {string} showId
 * @param {string} fetchedPost the post as the collector stores it before isolation
 * @param {string} at ISO time
 */
function planRefetchedIsolation(data, showId, fetchedPost, at) {
  if (!needsRefetch(data)) return null;
  const plan = planIsolation({ ...data, fullText: fetchedPost }, showId, at, { strict: true });
  if (!plan || plan.refused || plan.clearedFlags.length === 0) return null;
  plan.data.multiShowRefetchedAt = at;
  return plan;
}

/** Pure: is this a flagged multi-show file whose stored text cannot show the verdict was cross-section? */
function needsRefetch(data) {
  if (!data || !isMultiShowPostUrl(data.url)) return false;
  if (data.wrongShow !== true && data.wrongProduction !== true) return false;
  return findSectionHeadings(String(data.fullText || '')).length < 2;
}

module.exports = { planIsolation, planStaleWholePostRejection, verdictCitesOtherSection, verdictReason, quotedTitles, planRefetchedIsolation, needsRefetch };
