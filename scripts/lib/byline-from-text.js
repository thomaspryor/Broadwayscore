/**
 * Per-outlet byline extraction from review fullText.
 *
 * Some outlets never expose the critic in scrapable metadata (WP author is
 * "ri-admin" etc.) but print the byline as the first line of the article body.
 * When gather leaves criticName Unknown, these extractors recover the real
 * critic from the text we already store — the alternative (defaultCritic fill)
 * misattributed 30/31 Plays International reviews to Maryam Philpott
 * (Louise Penn report, 2026-08-03).
 *
 * Pure functions. No I/O.
 */

// Plays International house style: article body opens with
//   "<Critic Name> in the West End ★★★★☆ 22 July 2026 <review...>"
//   "<Critic Name> on the South Bank ..." / "in North London" / "in north London"
// Occasionally preceded by junk ("19 Views", or the article title).
const PI_LOCATION =
  "(?:the\\s+)?(?:[Nn]orth|[Ss]outh|[Ee]ast|[Ww]est)\\s+London|the\\s+West\\s+End|the\\s+South\\s+Bank";
const PI_BYLINE_RE = new RegExp(
  "([A-Z][\\w'’.-]*(?:\\s+[A-Z][\\w'’.-]*){1,2})\\s+(?:in|on)\\s+(?:" + PI_LOCATION + ")"
);

// Critics observed writing for Plays International — used to trim leading junk
// the name capture may have swallowed ("19 Views Mark Shenton" → "Mark Shenton").
const PI_KNOWN_CRITICS = [
  "Jeremy Malies",
  "David Wootton",
  "Maryam Philpott",
  "Franco Milazzo",
  "Neil Dowden",
  "Jane Edwardes",
  "Louise Penn",
  "Tom Bolton",
  "Mark Shenton",
];

/**
 * @param {string} text review fullText (or og:description)
 * @returns {{name: string, known: boolean} | null} extracted critic, with
 *   known=false when the name is not in PI_KNOWN_CRITICS (verify manually).
 */
function extractPlaysInternationalByline(text) {
  if (!text) return null;
  const head = String(text).slice(0, 300).replace(/\s+/g, " ");
  const m = PI_BYLINE_RE.exec(head);
  if (!m) return null;
  const captured = m[1].trim();
  for (const critic of PI_KNOWN_CRITICS) {
    if (captured === critic || captured.endsWith(" " + critic)) {
      return { name: critic, known: true };
    }
  }
  // Unknown critic: keep the trailing two tokens (leading tokens are more
  // likely junk than a rarely-used middle name).
  const tokens = captured.split(" ");
  const name = tokens.slice(-2).join(" ");
  return { name, known: false };
}

const BYLINE_EXTRACTORS = {
  "plays-international": extractPlaysInternationalByline,
};

/**
 * @param {string} outletId canonical outlet id
 * @param {string} text review fullText
 * @returns {{name: string, known: boolean} | null}
 */
function extractBylineFromText(outletId, text) {
  const extractor = BYLINE_EXTRACTORS[outletId];
  return extractor ? extractor(text) : null;
}

module.exports = {
  extractBylineFromText,
  extractPlaysInternationalByline,
  PI_KNOWN_CRITICS,
};
