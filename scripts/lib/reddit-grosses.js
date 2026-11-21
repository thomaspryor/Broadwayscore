'use strict';

/**
 * Shared predicate for identifying a Reddit post as a "Grosses Analysis" /
 * "Post-Mortem" weekly commercial-data post, regardless of author.
 *
 * Consolidated from 3 near-duplicate implementations (2026-07-19,
 * plan-review finding): scripts/scrape-boring-waltz-costs.js's
 * isRelevantPost(), and an inline `/grosses\s*analysis/i` regex in
 * scripts/update-commercial-data.js's fetchGrossesAnalysisPost(). Both
 * scripts now import from here instead of maintaining their own copy —
 * a 3rd/4th divergent copy is exactly what this consolidation avoids.
 */
function isRelevantPost(post) {
  const title = (post.title || '').toLowerCase();
  return title.includes('grosses') || title.includes('post-mortem') || title.includes('postmortem');
}

const SUFFIX_MULTIPLIER = { k: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, million: 1e6 };

/**
 * A dollar amount in u/Boring_Waltz_9545's notation: "650k", "1.1M",
 * "850,000", or a number plus a separate suffix ("1", "million").
 * @returns {number|null} whole dollars
 */
function parseDollarAmount(number, suffix) {
  if (!number) return null;
  const val = parseFloat(String(number).replace(/[,$\s]/g, ''));
  if (!Number.isFinite(val)) return null;
  const mult = suffix ? SUFFIX_MULTIPLIER[suffix.toLowerCase()] : 1;
  return mult ? Math.round(val * mult) : null;
}

// "Estimated Weekly Operating Cost: $850k/week", "$1 million/week", "$1.1M",
// "$650-$700k" (a range: the midpoint). The suffix may follow a space
// ("$1 million"), which an earlier version read as $1 (BRO-4666). Also
// "Operating Costs", "**...Cost:** $850k" and "Cost: ~$850k".
const SUFFIX = String.raw`(million|mil|thousand|m|k)?\b`;
const COST_RE = new RegExp(
  // At most a closing "**" after the colon, so a "***Show Running Cost***
  // *$400k gross*" heading is not read as a cost line.
  String.raw`(?:Estimated\s+)?(?:Weekly\s+)?(?:Operating|Running)\s+Costs?:?\*{0,2}\s*~?\s*\$\s*([\d.,]+)\s*` + SUFFIX +
    String.raw`(?:\s*[-–—]\s*~?\$?\s*([\d.,]+)\s*` + SUFFIX + ')?',
  'i'
);

/**
 * The low end of "$650-$700k" or "$950-$1.1M": its own suffix, else the high
 * end's when that keeps it below the high end ($650k), else thousands
 * ($950k); null when neither does.
 */
function rangeLow(lowNum, lowSuffix, high, highSuffix) {
  if (lowSuffix) return parseDollarAmount(lowNum, lowSuffix);
  for (const suffix of [highSuffix, 'k']) {
    const low = parseDollarAmount(lowNum, suffix);
    if (low && high && low <= high) return low;
  }
  return null;
}
// ***Show Name*** (optionally an emoji inside the asterisks).
const SHOW_RE = /\*{3}\s*[^\w\s]*\s*([^*]+?)\s*\*{3}/;
const LEADING_EMOJI_RE = /^[\u{1F300}-\u{1FEFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+\s*/u;
// "***Buena Vista Social Club-*** *$804k gross..." leaves a dash inside the bold.
const TRAILING_PUNCT_RE = /[\s\-–—:\\]+$/;

/**
 * Weekly operating cost estimates in a Grosses Analysis / Post-Mortem post,
 * in post order: one { showName, cost } per cost line, attributed to the
 * last ***Show Name*** heading above it.
 */
// The escaped-cost fix is opt-in for BRO-5028's shadow comparison until the
// commercial checker approves changing the live gap-fill.
function extractCostsFromPost(selftext, { unescapeCosts = false } = {}) {
  if (!selftext) return [];
  const results = [];
  let currentShowName = null;
  for (const line of selftext.split('\n')) {
    const showMatch = line.match(SHOW_RE);
    if (showMatch) {
      const name = showMatch[1].trim().replace(LEADING_EMOJI_RE, '').replace(TRAILING_PUNCT_RE, '').trim();
      if (name) currentShowName = name;
    }
    const m = (unescapeCosts ? line.replace(/\\~/g, '~') : line).match(COST_RE);
    if (!m || !currentShowName) continue;
    const [, lowNum, lowSuffix, highNum, highSuffix] = m;
    const high = highNum ? parseDollarAmount(highNum, highSuffix) : null;
    const low = high ? rangeLow(lowNum, lowSuffix, high, highSuffix) : parseDollarAmount(lowNum, lowSuffix);
    const cost = low && high ? Math.round((low + high) / 2) : (low || high);
    if (cost && cost > 0) results.push({ showName: currentShowName, cost });
  }
  return results;
}

// One dollar figure inside a profit value: "$100k", "($100k+)", "$(100k)",
// "$0", "\~$50k". Parentheses anywhere around it mean a loss; "+" means the
// bound is open (at least this much profit, or at least this much loss).
// The suffix and "+" may also sit outside the parentheses: "$(68)k", "($100k)+".
// Matched on text with escapes removed and whitespace collapsed, so every gap
// is at most one space: no run of optional whitespace to backtrack over.
const PROFIT_AMOUNT_RE = /(\()? ?~? ?\$? ?(\()? ?~? ?\$? ?([\d.,]*\d) ?(million|mil|m|k)?\b ?(\+)? ?(\))? ?(?:(million|mil|m|k)\b)? ?(\+)?/gi;
// Prose after the figures ("$100k+ this week, vs 2023") is cut at the first
// word that is not a unit or "to" ("$(100k) to $0").
const TRAILING_PROSE_RE = /\b(?!(?:million|mil|even|to)\b)[a-z]{2,}\b.*$/i;

/**
 * "Estimated Profit (Loss): $0k-$(100k)" as a range in whole dollars.
 * { low, high } with null for an open bound ("$100k+" is { low: 100000,
 * high: null }, "($100k+)" is { low: null, high: -100000 }); null for N/A
 * or an unreadable value. A bare low end takes the high end's suffix
 * ("$50-$100k" is 50k..100k) unless it is zero.
 */
function parseProfitRange(value) {
  if (!value || /^\W*n\/?a\b/i.test(value)) return null;
  if (/^\W*(?:break[-\s]*)?even\b/i.test(value)) return { low: 0, high: 0 };
  const figures = String(value).replace(/\\/g, '').replace(/\s+/g, ' ').replace(TRAILING_PROSE_RE, '');
  const amounts = [];
  for (const m of figures.matchAll(PROFIT_AMOUNT_RE)) {
    const [, open1, open2, num, suffix, plus, close, outerSuffix, outerPlus] = m;
    amounts.push({ num, suffix: suffix || outerSuffix, negative: !!(open1 || open2 || close), plus: !!(plus || outerPlus) });
    if (amounts.length === 2) break;
  }
  if (!amounts.length) return null;
  // A nonzero figure under $1k ("($300+)") is a missing suffix: unreadable.
  const toDollars = (a, fallbackSuffix) => {
    const zero = parseFloat(a.num.replace(/,/g, '')) === 0;
    const d = parseDollarAmount(a.num, a.suffix || (zero ? null : fallbackSuffix));
    if (d == null || (d !== 0 && Math.abs(d) < 1000)) return null;
    return a.negative ? -d : d;
  };
  if (amounts.length === 1) {
    const v = toDollars(amounts[0], null);
    if (v == null) return null;
    if (!amounts[0].plus) return { low: v, high: v };
    return v < 0 ? { low: null, high: v } : { low: v, high: null };
  }
  const second = toDollars(amounts[1], null);
  const first = toDollars(amounts[0], amounts[1].suffix);
  if (first == null || second == null) return null;
  const low = Math.min(first, second), high = Math.max(first, second);
  // "+" opens the range away from zero: "$0-$100k+" has no top, "$0-($100k+)" no bottom.
  const open = amounts.find((a) => a.plus);
  if (!open) return { low, high };
  return open.negative ? { low: null, high } : { low, high: null };
}

// "$884k" or "$*1.0 million" (an italic marker can sit after the "$").
// A figure labelled "gross" wins, "$" optional ("*1.0 million gross" is a
// typo seen in the wild); else the first dollar figure on the heading line.
const LABELLED_GROSS_RE = /\$?[\s*]*([\d.,]*\d)\s*(million|mil|m|k)\s*gross\b/i;
const DOLLAR_RE = /\$[\s*]*([\d.,]*\d)\s*(million|mil|m|k)?\b/i;
// "Gross Less-Fees: $778k", "Gross Less-Fees: 776k", "Gross Less-Fees- $1.050 million".
const LESS_FEES_RE = /Gross\s+Less[-\s]*Fees\s*[:\-–]?\**\s*\$?\s*([\d.,]*\d)\s*(million|mil|m|k)?\b/i;
// The weekly line only: a post-mortem's "Total Estimated Profit (Loss)" and a
// profit figure on a "Capitalization" line are run totals, and are skipped.
const PROFIT_LINE_RE = /(?<!Total\s{1,3})Estimated\s+Profit\s*\(Loss\)[:;]?\**[ \t]*([^;\n]*)/i;
const RUN_TOTAL_LINE_RE = /capitali[sz]ation/i;
const RECOUPED_RE = /percentage\s+recouped\**:?\**\s*~?\s*([\d.]+)\s*%(?:\s*[-–]\s*([\d.]+)\s*%)?/i;

/**
 * Per-show weekly figures from a Grosses Analysis post, in post order:
 * { showName, gross, grossLessFees, costLow, costHigh, profit, recoupedLow,
 * recoupedHigh, flags }. gross is the "gross"-labelled (else first) dollar
 * figure on the ***Show*** heading line; profit is parseProfitRange's output.
 * Missing fields are null. A show heading with none of the detail lines is
 * dropped.
 */
function extractWeeklyFinancialsFromPost(selftext, { includeCommercialFields = false } = {}) {
  if (!selftext) return [];
  const rows = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.grossLessFees || cur.profit || cur.costLow || cur.recoupedLow != null)) rows.push(cur);
  };
  for (const line of selftext.split('\n')) {
    const showMatch = line.match(SHOW_RE);
    if (showMatch) {
      const name = showMatch[1].trim().replace(LEADING_EMOJI_RE, '').replace(TRAILING_PUNCT_RE, '').trim();
      if (name) {
        flush();
        const after = line.slice(showMatch.index + showMatch[0].length);
        const g = after.match(LABELLED_GROSS_RE) || after.match(DOLLAR_RE);
        cur = {
          showName: name, gross: g ? parseDollarAmount(g[1], g[2]) : null, grossLessFees: null,
          costLow: null, costHigh: null, profit: null, profitText: null, recoupedLow: null, recoupedHigh: null,
        };
        if (includeCommercialFields) {
          const capacity = after.match(/([\d.]+)%\s*capacity/i);
          const atp = after.match(/\$([\d.,]+)\s*atp/i);
          cur.capacity = capacity ? Number(capacity[1]) : null;
          cur.atp = atp ? Number(atp[1].replace(/,/g, '')) : null;
          cur.commentary = '';
        }
      }
    }
    if (!cur) continue;
    // First match wins for every field: later lines in a block are commentary
    // or a post-mortem's run totals.
    const lf = cur.grossLessFees == null && line.match(LESS_FEES_RE);
    if (lf) cur.grossLessFees = parseDollarAmount(lf[1], lf[2]);
    // Reddit escapes "~" as "\~" ("\~$750k"). The live cost-only caller
    // retains its old behavior until BRO-5028's checker signoff.
    const c = cur.costLow == null && line.replace(/\\~/g, '~').match(COST_RE);
    if (c) {
      const [, lowNum, lowSuffix, highNum, highSuffix] = c;
      const high = highNum ? parseDollarAmount(highNum, highSuffix) : null;
      const low = high ? rangeLow(lowNum, lowSuffix, high, highSuffix) : parseDollarAmount(lowNum, lowSuffix);
      cur.costLow = low || high;
      cur.costHigh = high || low;
    }
    const p = !cur.profitSeen && !RUN_TOTAL_LINE_RE.test(line) && line.match(PROFIT_LINE_RE);
    if (p) { cur.profitText = p[1].trim(); cur.profit = parseProfitRange(p[1]); cur.profitSeen = true; }
    const r = cur.recoupedLow == null && line.match(RECOUPED_RE);
    if (r) {
      cur.recoupedLow = parseFloat(r[1]);
      cur.recoupedHigh = r[2] ? parseFloat(r[2]) : parseFloat(r[1]);
    }
    if (includeCommercialFields && !showMatch && !lf && !c && !p && !r && line.trim()) {
      cur.commentary = [cur.commentary, line.trim()].filter(Boolean).join(' ');
    }
  }
  flush();
  // Plausibility flags; filtering is the consumer's call. Less-fees should be
  // 50-100% of gross (5% slack over: the heading gross is rounded); a figure
  // outside that is a typo or a line copied forward from an earlier week.
  // A profit above gross minus cost cannot be a week's operating profit.
  for (const row of rows) {
    delete row.profitSeen;
    row.flags = [];
    if (row.gross && row.grossLessFees && (row.grossLessFees > 1.05 * row.gross || row.grossLessFees < 0.5 * row.gross)) row.flags.push('lessFeesImplausible');
    if (row.gross && row.costLow && row.profit && row.profit.low != null && row.profit.low > row.gross - row.costLow) row.flags.push('profitAboveGrossLessCost');
  }
  return rows;
}

module.exports = { isRelevantPost, parseDollarAmount, extractCostsFromPost, parseProfitRange, extractWeeklyFinancialsFromPost };
