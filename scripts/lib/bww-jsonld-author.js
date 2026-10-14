/**
 * BWW JSON-LD posting -> {outletRaw, criticName}.
 *
 * Single source of truth for the author/headline decision, shared by
 * gather-reviews.js (extractBWWRoundupReviews Method 1), backfill-bww-thumbs.js
 * and re-extract-aggregator-reviews.js. These three used to carry hand-copies;
 * only gather-reviews.js received the comma/colon/bare-name fixes (BRO-3247),
 * so the other two minted phantom outlets from bare critic names (BRO-3345).
 *
 * Pure: takes a BlogPosting object and an isRegisteredOutlet predicate.
 * Returns { outletRaw: string|null, criticName: string|null }; a null
 * outletRaw means the posting carries no usable outlet (caller skips it).
 */

const { isRegisteredOutlet: defaultIsRegisteredOutlet } = require('./review-normalization');

function parseBwwPostingAuthor(posting, isRegisteredOutlet = defaultIsRegisteredOutlet) {
  // Two formats:
  // 1. Standalone BlogPosting: author.name = "Outlet - Critic"
  // 2. LiveBlogPosting entries: headline = "Outlet - Review Title"
  let outletRaw = null;
  let criticName = null;

  if (posting.author) {
    const authorName = Array.isArray(posting.author) ? posting.author[0]?.name : posting.author?.name;
    if (authorName && authorName.includes(' - ')) {
      const parts = authorName.split(' - ');
      outletRaw = parts[0].trim();
      criticName = parts[1]?.trim() || null;
    } else if (authorName && authorName.includes(', ')) {
      // BWW comma format: "Critic, Outlet" (e.g., "Mandell, New York Theater")
      const commaIdx = authorName.indexOf(', ');
      const part0 = authorName.substring(0, commaIdx).trim();
      const part1 = authorName.substring(commaIdx + 2).trim();
      // Check which part is a known outlet
      if (isRegisteredOutlet(part1)) {
        outletRaw = part1;
        criticName = part0;
      } else if (isRegisteredOutlet(part0)) {
        outletRaw = part0;
        criticName = part1;
      } else {
        // Neither is a known outlet — treat whole string as outlet (existing behavior)
        outletRaw = authorName;
      }
    } else if (authorName && authorName.includes(': ')) {
      // BWW colon format: "Outlet: Critic" (e.g., "NY Post: Johnny Oleksinski")
      // Use lastIndexOf to handle multiple colons (e.g., "Re: Review: NY Post")
      const colonIdx = authorName.lastIndexOf(': ');
      const part0 = authorName.substring(0, colonIdx).trim();
      const part1 = authorName.substring(colonIdx + 2).trim();
      if (isRegisteredOutlet(part0)) {
        outletRaw = part0;
        criticName = part1;
      } else if (isRegisteredOutlet(part1)) {
        outletRaw = part1;
        criticName = part0;
      } else {
        outletRaw = authorName;
      }
    } else if (authorName) {
      outletRaw = authorName;
    }
  } else if (posting.headline && posting.headline.includes(' - ')) {
    // LiveBlogPosting entries: "Outlet - Review Title"
    outletRaw = posting.headline.split(' - ')[0].trim();
    // Validate: real outlet names are 1-5 words. 6+ words = headline fragment, not outlet
    if (outletRaw.split(/\s+/).length > 5) {
      outletRaw = null;
    }
  }

  // posting.author sometimes carries just the critic's bare name with no
  // "Outlet - Critic"/"Critic, Outlet"/"Outlet: Critic" delimiter (e.g.
  // author.name = "Jon Sobel"). Every branch above falls through to
  // `outletRaw = authorName` in that case, minting a phantom outlet from
  // the critic's own name ("jon-sobel") while criticName stays null —
  // creating a permanent duplicate alongside the real outlet-attributed
  // record a later run (or Method 2/3 below) writes for the same critic
  // (Safe House / BRO-3247, 2026-09-14: 4 shows-up-twice pairs, e.g.
  // outletId="jon-sobel" criticName=null next to outletId="blogcritics"
  // criticName="Jon Sobel" — same review, double-counted in the score).
  // Prefer the headline's "Outlet - Title" outlet when outletRaw isn't a
  // registered outlet, and demote the bare author name to criticName.
  //
  // The demotion is shape-gated (/second-opinion, same day): `!criticName
  // && !isRegisteredOutlet(outletRaw)` is also true for the comma and
  // colon branches above when NEITHER side is a registered outlet — they
  // fall through to `outletRaw = authorName` with the delimiter intact.
  // Demoting those wholesale wrote junk critic names
  // ("Mandell, Some Unregistered Blog") that dedup against nothing,
  // recreating the very duplicate-pair shape this block exists to kill.
  // Only a person-name-shaped string becomes a criticName; anything else
  // still takes the headline outlet but stays criticName=null, which
  // routes it into the per-outlet unknown-slot path Method 2 upgrades
  // from articleBody.
  if (outletRaw && !criticName && !isRegisteredOutlet(outletRaw) &&
      posting.headline && posting.headline.includes(' - ')) {
    const headlineOutlet = posting.headline.split(' - ')[0].trim();
    if (headlineOutlet.split(/\s+/).length <= 5 && isRegisteredOutlet(headlineOutlet)) {
      const looksLikePersonName = !/[,:;|/]/.test(outletRaw) &&
        outletRaw.split(/\s+/).length <= 4;
      criticName = looksLikePersonName ? outletRaw : null;
      outletRaw = headlineOutlet;
    }
  }

  return { outletRaw, criticName };
}

module.exports = { parseBwwPostingAuthor };
