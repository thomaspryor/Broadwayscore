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
// Unicode-aware (accented names like Nilgün) and tolerant of lowercase
// particles (van/der/de/von/le/al) inside a name.
const PI_NAME_TOKEN = "[\\p{L}'’.-]+";
const PI_BYLINE_RE = new RegExp(
  "(\\p{Lu}" +
    PI_NAME_TOKEN +
    "(?:\\s+(?:van|von|der|de|le|al|el|da|di)\\s+" + PI_NAME_TOKEN + "|\\s+\\p{Lu}" + PI_NAME_TOKEN + "){1,3})" +
    "\\s+(?:in|on)\\s+(?:" +
    PI_LOCATION +
    ")",
  "u"
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
  // Unknown critic: return the full capture unaltered (it may contain leading
  // junk like "19 Views ..."). Consumers only auto-apply known:true names, so
  // this is a report-for-manual-verify path — don't guess-trim, it mangles
  // particle names ("Jan van der Berg" → "der Berg").
  return { name: captured, known: false };
}

// TheaterScene.net prints the real byline as "Posted on October 15, 2026 by Samuel L. Leiter in Musicals".
// Its page chrome / listing metadata credits the editor (Victor Gluck) on pages other critics wrote, so a
// scraped or aggregator-supplied name is wrong whenever this line names someone else (Midnight 2026,
// BRO-5499). A name printed on this line is the critic.
const TS_POSTED_BY_RE = /Posted on [A-Z][a-z]+ \d{1,2}, \d{4} by (\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}?)\s+in\s/u;
function extractTheaterSceneByline(text) {
  if (!text) return null;
  const m = TS_POSTED_BY_RE.exec(String(text).slice(0, 1500).replace(/\s+/g, " "));
  return m ? { name: m[1].trim(), known: true } : null;
}

const { extractBodyByline } = require("./byline-normalization");

const BYLINE_EXTRACTORS = {
  "plays-international": extractPlaysInternationalByline,
  "theater-scene": extractTheaterSceneByline,
};

/**
 * Outlets whose printed byline line is authoritative over a scraped / aggregator-supplied name, so a
 * different stored name is replaced rather than only filled when missing.
 */
const PRINTED_BYLINE_OVERRIDES = new Set(["theater-scene"]);

/** The critic the article itself prints, for outlets in PRINTED_BYLINE_OVERRIDES; else null. */
function printedBylineOverride(outletId, text, url) {
  if (!PRINTED_BYLINE_OVERRIDES.has(outletId)) return null;
  const hit = BYLINE_EXTRACTORS[outletId](text);
  if (!hit || !hit.known) return null;
  // "Posted by" can name whoever uploaded the post (5 of 129 TheaterScene pages disagree with the
  // critic slug in their own url). Replace a stored name only when the url's critic slug agrees.
  const slug = hit.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug && String(url || "").toLowerCase().includes("/" + slug) ? hit.name : null;
}

/**
 * @param {string} outletId canonical outlet id
 * @param {string} text review fullText
 * @param {{showTitle?: string}} [opts]
 * @returns {{name: string, known: boolean} | null}
 */
function extractBylineFromText(outletId, text, opts = {}) {
  const extractor = BYLINE_EXTRACTORS[outletId];
  const hit = extractor ? extractor(text) : null;
  if (hit) return hit;
  // BRO-3919: any outlet — a reviewer credit as the text's final line
  // ("Review: Emma Foxhall Photos Helen Murray", "Reviewer: Vera Liber").
  // The extractor is strict (end-anchored, person-shaped, not the show
  // title), so a hit is safe to apply where the stored byline is missing.
  const tail = extractBodyByline(text, { showTitle: opts.showTitle });
  return tail ? { name: tail, known: true } : null;
}

/**
 * True when the rebuild's seen dedup keys ("<outlet>|<critic>") already hold a
 * named critic at `outletKey` other than `criticKey`. The rebuild then keeps an
 * Unknown file Unknown, so it still collapses into that critic instead of
 * scoring as a second review at the outlet (BRO-3919 ship-check).
 * @param {Iterable<string>} seenKeys
 * @param {string} outletKey
 * @param {string} criticKey
 */
function otherNamedCriticAtOutlet(seenKeys, outletKey, criticKey) {
  for (const k of seenKeys) {
    const [o, c] = k.split("|");
    if (o === outletKey && c !== criticKey && !/^(unknown|unnamed)$/.test(c)) return true;
  }
  return false;
}

module.exports = {
  otherNamedCriticAtOutlet,
  extractBylineFromText,
  printedBylineOverride,
  extractTheaterSceneByline,
  extractPlaysInternationalByline,
  PI_KNOWN_CRITICS,
};
