'use strict';
/**
 * theartsdesk.com page chrome that older captures stored inside fullText (BRO-7061):
 * the "Help keep arts journalism alive" support banner at the start and a trailing
 * "Image" label left by a figure. Pure, no I/O. Used by scripts/strip-artsdesk-banner.js.
 * The live extractor (article-extractor.js extractArtsDeskBody) never emits either.
 */

// Banner heading, the "We're rebuilding..." paragraph and the SUBSCRIBE TODAY button text.
const BANNER_RE = /^\s*help keep arts journalism alive\.?[\s\S]{0,600}?subscribe today\W*(?:and be part of this movement\W*)?(?:subscribe today\W*)?/i;
const TRAILING_IMAGE_RE = /(?:\s|^)Image\s*$/;

/** The text without the banner and trailing Image label; unchanged text comes back as is. */
function stripArtsDeskChrome(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  const m = out.match(BANNER_RE);
  if (m && m[0].length < out.length * 0.5) out = out.slice(m[0].length);
  out = out.replace(TRAILING_IMAGE_RE, '');
  out = out.trim();
  return out === text.trim() ? text : out;
}

module.exports = { stripArtsDeskChrome, BANNER_RE, TRAILING_IMAGE_RE };
