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

// A printed person name: 2 to 4 capitalised words (accents, apostrophes, hyphens, initials allowed),
// matched case-sensitively so a lowercase sentence fragment ("writes about the") never qualifies.
const PRINTED_NAME = String.raw`\p{Lu}[\p{L}'’-]*\.?(?:\s+\p{Lu}[\p{L}'’-]*\.?){1,3}`;
const PRINTED_NAME_NOT_PERSON_RE = /\b(?:theatre|theater|review|reviews|reviewer|photo|photos|photography|picture|pictures|credit|more|updated|published|posted|rating|stars?|share|admin|staff|team|editor|news|magazine|london|the)\b/i;

function printedPerson(raw) {
  const name = String(raw || "").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  if (!name || PRINTED_NAME_NOT_PERSON_RE.test(name)) return null;
  return name;
}

// South London (southlondon.co.uk) publishes every review under one CMS account, "Michael Holland"
// (JSON-LD author, rel=author link, the registry's old defaultCritic), while the real critic is named
// in the standfirst: "The Old Vic never disappoints, writes Lizzie Paul." (14 of 14 scanned reviews
// disagreed with the CMS name, Martin Guerre 2026 among them.)
const SL_WRITES_RE = new RegExp(String.raw`(?:^|[.!?,]\s+)(?:[a-z][^.!?]{0,160}?,\s*)?writes\s+(${PRINTED_NAME})\s*[.!?]`, "u");
function extractSouthLondonByline(text) {
  if (!text) return null;
  const m = SL_WRITES_RE.exec(String(text).slice(0, 700).replace(/\s+/g, " "));
  const name = m && printedPerson(m[1]);
  return name ? { name, known: true } : null;
}

// All That Dazzles prints "Review by Daz Gale ⭐⭐⭐⭐⭐" under the headline; the page's own author is the
// shared site account ("Sam - Admin"), and scraped files were filed as "Unknown" or "All That Dazzles".
const ATD_REVIEW_BY_RE = new RegExp(String.raw`\bReview(?:ed)? by\s+(${PRINTED_NAME}?)\s*(?:⭐|🌟|★|\n|$)`, "u");
function extractAllThatDazzlesByline(text) {
  if (!text) return null;
  const m = ATD_REVIEW_BY_RE.exec(String(text).slice(0, 400));
  const name = m && printedPerson(m[1]);
  return name ? { name, known: true } : null;
}

// Talkin' Broadway: "Theatre Review by Matthew Murray \n - December 11, 2005".
const TB_REVIEW_BY_RE = new RegExp(String.raw`\bTheatre Review by[ \t]+(${PRINTED_NAME}?)[ \t]*\n`, "u");
function extractTalkinBroadwayByline(text) {
  if (!text) return null;
  const m = TB_REVIEW_BY_RE.exec(String(text).slice(0, 600));
  const name = m && printedPerson(m[1]);
  return name ? { name, known: true } : null;
}

// New York Theatre Guide: "Review by Kathleen Campion 7 June 2016 <review...>".
const NYTG_REVIEW_BY_RE = new RegExp(String.raw`^\s*Review by\s+(${PRINTED_NAME}?)\s+\d{1,2}\s+[A-Z][a-z]+\s+\d{4}\b`, "u");
function extractNewYorkTheatreGuideByline(text) {
  if (!text) return null;
  const m = NYTG_REVIEW_BY_RE.exec(String(text).slice(0, 200));
  const name = m && printedPerson(m[1]);
  return name ? { name, known: true } : null;
}

// Time Out (US and London): "...WhatsAppBuy ticketWritten by Adam FeldmanTheater and Dance Editor, Time Out USA".
// Only the role-qualified credit counts; a bare "Written by" in the body names a show's author.
const TO_WRITTEN_BY_RE = new RegExp(String.raw`Written by\s+(${PRINTED_NAME}?)(?=\s*(?:Theat(?:er|re)|Associate|Senior|Chief|Deputy|Features?|Head|Global|Arts|Film|Travel|Editor|Critic|Contributing|Staff|Writer|Reporter|Advertising))`, "u");
// The scraped text glues the role onto the name ("Andrzej LukowskiTheatre Editor"); cut it back off.
const TO_GLUED_ROLE_RE = /(?<=\p{Ll})(?:Theat(?:er|re)|Associate|Senior|Chief|Deputy|Features?|Head|Global|Arts|Film|Travel|Editor|Critic|Contributing|Staff|Writer|Reporter|Advertising)$/u;
function extractTimeOutByline(text) {
  if (!text) return null;
  const m = TO_WRITTEN_BY_RE.exec(String(text).slice(0, 1200));
  const name = m && printedPerson(m[1].replace(TO_GLUED_ROLE_RE, ""));
  return name ? { name, known: true } : null;
}

// Theatre and Tonic (Squarespace): the CMS author is the account holder ("Emmie Newitt" on ~50 reviews)
// while each review ends "Written by Annie for Theatre and Tonic, October 2026." The writer is credited
// by first name (sometimes first name and initial or a full name), so a single capitalised word counts.
const TT_WRITTEN_BY_RE = new RegExp(String.raw`Written by\s+(\p{Lu}[\p{L}'’-]*\.?(?:\s+\p{Lu}[\p{L}'’-]*\.?){0,2})\s+for Theatre (?:and|&) Tonic`, "gu");
function extractTheatreAndTonicByline(text) {
  if (!text) return null;
  let last = null;
  for (const m of String(text).replace(/\s+/g, " ").matchAll(TT_WRITTEN_BY_RE)) last = m;
  const name = last && printedPerson(last[1]);
  return name ? { name, known: true } : null;
}

const BYLINE_EXTRACTORS = {
  "plays-international": extractPlaysInternationalByline,
  "theater-scene": extractTheaterSceneByline,
  "south-london": extractSouthLondonByline,
  "theatreandtonic": extractTheatreAndTonicByline,
  "all-that-dazzles-uk": extractAllThatDazzlesByline,
  "talkinbroadway": extractTalkinBroadwayByline,
  "nytg": extractNewYorkTheatreGuideByline,
  "timeout": extractTimeOutByline,
  "timeout-london": extractTimeOutByline,
};

/**
 * Outlets whose printed byline line is authoritative over a scraped / aggregator-supplied name, so a
 * different stored name is replaced rather than only filled when missing. `requireUrlSlug` outlets
 * (TheaterScene's "Posted by" can name the uploader) only replace when the url's critic slug agrees;
 * the others print a per-article credit that is never the uploader.
 */
const PRINTED_BYLINE_OVERRIDES = new Map([
  ["theater-scene", { requireUrlSlug: true }],
  ["south-london", { requireUrlSlug: false }],
  ["theatreandtonic", { requireUrlSlug: false }],
  ["all-that-dazzles-uk", { requireUrlSlug: false }],
]);

const foldName = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * True when a stored critic name and a printed credit are the same person: equal names, or the credit
 * is a first/last name or initial-form of the stored full name ("Penny" for "Penny Walshe").
 */
function sameCriticName(stored, printed) {
  const a = foldName(stored), b = foldName(printed);
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split(" "), bt = b.split(" ");
  const shorter = at.length <= bt.length ? at : bt;
  const longer = at.length <= bt.length ? bt : at;
  if (shorter.length === 1) return longer[0] === shorter[0] || longer[longer.length - 1] === shorter[0];
  return shorter.every((t, i) => longer[i] !== undefined && (longer[i] === t || (t.length === 1 && longer[i][0] === t)));
}

/**
 * The critic the article itself prints, for outlets in PRINTED_BYLINE_OVERRIDES; else null.
 * `stored` (optional): the name already on the record; a credit that names the same person (a first
 * name for a stored full name) is not an override.
 */
function printedBylineOverride(outletId, text, url, stored) {
  const rule = PRINTED_BYLINE_OVERRIDES.get(outletId);
  if (!rule) return null;
  const hit = BYLINE_EXTRACTORS[outletId](text);
  if (!hit || !hit.known) return null;
  if (stored && sameCriticName(stored, hit.name)) return null;
  if (!rule.requireUrlSlug) return hit.name;
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
  sameCriticName,
  extractSouthLondonByline,
  extractTheatreAndTonicByline,
  extractAllThatDazzlesByline,
  extractTalkinBroadwayByline,
  extractNewYorkTheatreGuideByline,
  extractTimeOutByline,
  PI_KNOWN_CRITICS,
};
