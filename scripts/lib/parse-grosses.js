#!/usr/bin/env node

/**
 * Parse Reddit Grosses Analysis Posts
 *
 * Extracts structured financial data from u/Boring_Waltz_9545's weekly
 * grosses analysis posts on r/Broadway.
 *
 * Exported separately for unit testing.
 */

/**
 * Parse a dollar amount string into a number.
 *
 * Examples:
 *   "$1.3M"     -> 1300000
 *   "$1.300M"   -> 1300000
 *   "$600k"     -> 600000
 *   "$248"      -> 248
 *   "($150k)"   -> -150000
 *   "-$150k"    -> -150000
 *   "$0"        -> 0
 *   "N/A"       -> null
 *   null         -> null
 */
function parseDollarAmount(str) {
  if (!str || str.trim() === '' || /^n\/?a$/i.test(str.trim())) {
    return null;
  }

  const cleaned = str.trim();

  // Detect negative: ($XXX) or -$XXX
  const isNegative = /^\(.*\)$/.test(cleaned) || /^-/.test(cleaned);

  // Strip parentheses, minus, dollar sign, commas
  let numeric = cleaned.replace(/[()$,\-]/g, '').trim();

  // Handle M/m suffix (millions)
  if (/m$/i.test(numeric)) {
    const val = parseFloat(numeric.replace(/m$/i, ''));
    if (isNaN(val)) return null;
    return Math.round((isNegative ? -val : val) * 1000000);
  }

  // Handle K/k suffix (thousands)
  if (/k$/i.test(numeric)) {
    const val = parseFloat(numeric.replace(/k$/i, ''));
    if (isNaN(val)) return null;
    return Math.round((isNegative ? -val : val) * 1000);
  }

  // Plain number
  const val = parseFloat(numeric);
  if (isNaN(val)) return null;
  return Math.round(isNegative ? -val : val);
}

/**
 * Parse a percentage string into a number.
 *
 * Examples:
 *   "102%"  -> 102
 *   "81.5%" -> 81.5
 *   "N/A"   -> null
 */
function parsePercentage(str) {
  if (!str || str.trim() === '' || /^n\/?a$/i.test(str.trim())) {
    return null;
  }
  const val = parseFloat(str.replace(/%/g, '').trim());
  return isNaN(val) ? null : val;
}

/**
 * Parse a recoupment percentage range.
 *
 * Examples:
 *   "80%-100%" -> [80, 100]
 *   "80-100%"  -> [80, 100]
 *   "50%"      -> [50, 50]
 *   "N/A"      -> null
 */
function parseRecoupmentRange(str) {
  if (!str || str.trim() === '' || /^n\/?a$/i.test(str.trim())) {
    return null;
  }

  const cleaned = str.replace(/%/g, '').trim();

  // Range: "80-100" or "80 - 100"
  const rangeMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    return [parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2])];
  }

  // Single value: "50"
  const val = parseFloat(cleaned);
  if (!isNaN(val)) {
    return [val, val];
  }

  return null;
}

/**
 * Parse a single show block from the grosses analysis post.
 *
 * Expected format (Reddit markdown):
 *   **Show Name** - $X.XM gross, XX% capacity, $XXX atp
 *   Gross Less-Fees: $X.XXXM; Estimated Weekly Operating Cost: $XXXk/week
 *   Estimated Profit (Loss): $XXXk+ or ($XXXk)
 *   Estimated percentage recouped: XX%-XX%
 *
 * Lines may also include additional commentary text.
 */
function parseShowBlock(block) {
  const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length === 0) return null;

  // First line: **Show Name** - $X.XM gross, XX% capacity, $XXX atp
  const headerMatch = lines[0].match(/\*\*(.+?)\*\*\s*[-–—]\s*(.*)/);
  if (!headerMatch) return null;

  const showName = headerMatch[1].trim();
  const headerStats = headerMatch[2];

  // Extract gross, capacity, atp from header
  const grossMatch = headerStats.match(/(\$[\d.,]+[MmKk]?)\s*(?:gross|mil)/i) ||
                     headerStats.match(/(\$[\d.,]+[MmKk]?)\s*(?:gross)?/i);
  const capacityMatch = headerStats.match(/([\d.]+)%\s*capacity/i);
  const atpMatch = headerStats.match(/\$([\d.,]+)\s*atp/i);

  let weeklyGross = null;
  let capacity = null;
  let atp = null;

  if (grossMatch) {
    weeklyGross = parseDollarAmount(grossMatch[1] || grossMatch[0]);
  }
  if (capacityMatch) {
    capacity = parsePercentage(capacityMatch[1] + '%');
  }
  if (atpMatch) {
    atp = parseFloat(atpMatch[1].replace(/,/g, ''));
    if (isNaN(atp)) atp = null;
  }

  // Parse remaining lines
  let grossLessFees = null;
  let estimatedWeeklyCost = null;
  let estimatedProfitLoss = null;
  let estimatedRecoupmentPct = null;
  const commentaryLines = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Gross Less-Fees
    const glfMatch = line.match(/Gross\s*Less[\s-]*Fees:?\s*(\$[\d.,]+[MmKk]?)/i);
    if (glfMatch) {
      grossLessFees = parseDollarAmount(glfMatch[1]);
    }

    // Estimated Weekly Operating Cost
    const costMatch = line.match(/(?:Estimated\s*)?Weekly\s*Operating\s*Cost:?\s*(\$[\d.,]+[MmKk]?)/i) ||
                      line.match(/(?:Estimated\s*)?(?:Weekly\s*)?(?:Running|Operating)\s*Cost:?\s*(\$[\d.,]+[MmKk]?)/i);
    if (costMatch) {
      estimatedWeeklyCost = parseDollarAmount(costMatch[1]);
    }

    // Estimated Profit (Loss)
    const profitMatch = line.match(/(?:Estimated\s*)?Profit\s*\(?Loss\)?:?\s*(\(?[\$\d.,]+[MmKk]?\+?\)?)/i) ||
                        line.match(/(?:Estimated\s*)?Profit\s*\(?Loss\)?:?\s*(-?\$[\d.,]+[MmKk]?\+?)/i);
    if (profitMatch) {
      let profitStr = profitMatch[1].replace(/\+$/, ''); // Strip trailing +
      estimatedProfitLoss = parseDollarAmount(profitStr);
    }

    // Estimated percentage recouped
    const recoupMatch = line.match(/(?:Estimated\s*)?(?:percentage\s*)?recouped:?\s*([\d.]+%?\s*[-–—]\s*[\d.]+%?|[\d.]+%?|N\/A)/i);
    if (recoupMatch) {
      estimatedRecoupmentPct = parseRecoupmentRange(recoupMatch[1]);
    }

    // Lines that don't match known patterns are commentary
    if (!glfMatch && !costMatch && !profitMatch && !recoupMatch && i > 0) {
      // Skip lines that are mostly just the same data re-stated
      if (!line.match(/^(Gross Less|Estimated|Weekly Operating)/i)) {
        commentaryLines.push(line);
      }
    }
  }

  return {
    showName,
    weeklyGross,
    capacity,
    atp,
    grossLessFees,
    estimatedWeeklyCost,
    estimatedProfitLoss,
    estimatedRecoupmentPct,
    commentary: commentaryLines.join(' ').trim()
  };
}

/**
 * Parse the full grosses analysis post text into structured data.
 *
 * @param {string} selftext - The Reddit post body (markdown)
 * @returns {Object[]} Array of parsed show data
 */
function parseGrossesAnalysisPost(selftext) {
  if (!selftext || typeof selftext !== 'string') {
    return [];
  }

  // Split by show blocks. Each block starts with **ShowName**
  // Use a regex to find all show headers
  const blocks = [];
  const blockPattern = /\*\*[^*]+\*\*\s*[-–—]/g;
  let match;
  const positions = [];

  while ((match = blockPattern.exec(selftext)) !== null) {
    positions.push(match.index);
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : selftext.length;
    const blockText = selftext.slice(start, end).trim();
    blocks.push(blockText);
  }

  const results = [];
  for (const block of blocks) {
    const parsed = parseShowBlock(block);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

// Backward-compatible aliases for unit tests
const parseMoneyAmount = parseDollarAmount;
const parsePercentageRange = parseRecoupmentRange;

module.exports = {
  parseDollarAmount,
  parsePercentage,
  parseRecoupmentRange,
  parseShowBlock,
  parseGrossesAnalysisPost,
  // Aliases
  parseMoneyAmount,
  parsePercentageRange
};
