/**
 * Wikipedia Markup Utilities
 *
 * Reusable functions for cleaning Wikipedia wikitext markup.
 * Used by enrich-wikipedia-synopsis.js and clean-synopsis-markup.js.
 */

/**
 * Strip Wikipedia markup from text, returning clean plaintext.
 * Handles: HTML comments, refs, templates (nested), wikilinks, bold/italic,
 * section headers, HTML entities, list items, stray pipes/brackets.
 *
 * @param {string} text - Raw or partially-cleaned wikitext
 * @returns {string} Clean plaintext
 */
function stripWikiMarkup(text) {
  let cleaned = text
    .replace(/<!--.*?-->/gs, '')                           // HTML comments
    .replace(/<ref[^>]*>.*?<\/ref>/gis, '')                // <ref>...</ref>
    .replace(/<ref[^>]*\/>/gi, '')                         // <ref />
    .replace(/<\/?(?:br|small|nowiki|sup|sub|blockquote)[^>]*>/gi, ' ') // HTML tags
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '') // File/Image/Category links
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')       // [[link|text]] → text
    .replace(/'{2,3}/g, '')                                // Bold/italic markup
    .replace(/={2,5}\s*[^=\n]+\s*={2,5}/g, ' ')           // === Section Headers ===
    .replace(/&nbsp;/g, ' ')                               // HTML entities
    .replace(/\n\*/g, ' ');                                // List items → spaces

  // Iteratively strip templates (handles nesting like {{convert|{{x}}|km}})
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/\{\{[^{}]*\}\}/g, '');
  } while (cleaned !== prev);

  // Clean up orphaned brackets and pipes (from partially-stripped markup)
  cleaned = cleaned
    .replace(/\[\[/g, '')                                  // Orphaned [[
    .replace(/\]\]/g, '')                                  // Orphaned ]]
    .replace(/\|/g, ' ')                                   // Stray pipes
    .replace(/\n+/g, ' ')                                  // Newlines → spaces
    .replace(/\s+/g, ' ')                                  // Collapse whitespace
    .trim();

  return cleaned;
}

/**
 * Check if text still contains raw Wikipedia markup.
 * Use after stripWikiMarkup() as a safety check.
 *
 * @param {string} text
 * @returns {boolean} True if markup remnants detected
 */
function hasWikiMarkup(text) {
  return /[={]{2}|\[\[|\]\]|\{\{/.test(text);
}

module.exports = {
  stripWikiMarkup,
  hasWikiMarkup,
};
