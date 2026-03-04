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

/**
 * Strip leading junk from a synopsis that leaked through wikitext extraction.
 * Handles: image captions, scene/act markers, meta-notes, dimension strings.
 * Should be called AFTER stripWikiMarkup() on already-cleaned text.
 *
 * @param {string} text - Cleaned plaintext synopsis
 * @returns {string} Synopsis with leading junk removed
 */
function stripLeadingJunk(text) {
  let cleaned = text;

  // Remove image dimension strings anywhere (e.g., "298x298px")
  cleaned = cleaned.replace(/\d+x\d+px\s*/g, '');

  // Remove &nbsp; entities
  cleaned = cleaned.replace(/&nbsp;/g, ' ');

  // Remove leading image captions — everything up to where actual plot starts.
  // These are alt-text from Wikipedia images that leaked into the extraction.
  cleaned = cleaned
    // "as Name in [the original] [Broadway] production of Title (year) ..."
    .replace(/^as\s+[A-Z][\s\S]{0,300}?(?:original\s+(?:Broadway\s+)?)?(?:production|cast)\s+of\s+[^)]*?\(\d{4}\)\s*/i, '')
    // "as Name in Title (year) ," — shorter caption without "production of"
    .replace(/^as\s+[A-Z][a-z]+\s+(?:in\s+)?[^(]{0,100}?\(\d{4}\)\s*,?\s*/i, '')
    // "as Name in "Song Title"" (e.g., 'as Ariel in "Part of Your World"')
    .replace(/^as\s+[A-Z][a-z]+\s+in\s+[""][^""]+[""]\s*/i, '')
    // "by Artist Name, year" (painting credits)
    .replace(/^by\s+[A-Z][a-z]+\s+[A-Z][a-z]+,?\s*\d{0,4}\s*/, '')
    // Leading comma fragments: ", in 2010) ...", ", Name and Name as...", ", 1818 ..."
    .replace(/^,\s*[^.!?]{0,200}?\)\s*/, '')
    .replace(/^,\s*\d{4}\s*/, '')
    .replace(/^,\s*(?:from |in )[^.!?]{0,100}?\s+(?=[A-Z])/, '')
    // ", Name Name and Name Name as ..." (comma-prefixed actor caption)
    .replace(/^,\s*(?=[A-Z][a-z]+\s+[A-Z])/, '')
    // Comma-separated actor list: "Name and Name as Role ... in the original ... production"
    .replace(/^[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:and|,)\s+[\s\S]{0,200}?(?:original\s+)?(?:Broadway\s+)?production[\s\S]{0,100}?(?=[A-Z][a-z]+\s+(?:is|are|was|were|has|had|the|a|in|on|after|during|it|this|that|one|two|set)\b)/i, '')
    // "and Name Name as/in ... production..."
    .replace(/^and\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:as|in)\s+[\s\S]{0,200}?(?:production|cast)[\s\S]{0,50}?\s*/i, '')
    // Residual "of Title (year)" after partial caption strip
    .replace(/^of\s+[A-Z][\s\S]{0,100}?\(\d{4}\)\s*/, '');

  // Multi-actor caption strip: "Name Name and Name Name as Role ... original ... production of Title"
  // MUST contain "as" (the hallmark of image captions describing actors in roles)
  // followed by "original [Broadway] production" somewhere in the first 300 chars
  cleaned = cleaned
    .replace(/^(?:[A-Z][a-z]+\s+){1,4}(?:(?:and|,)\s+(?:[A-Z][a-z]+\s+){1,4})*as\s+[\s\S]{0,300}?(?:original\s+)?(?:Broadway\s+)?production\s+(?:of\s+)?[\s\S]{0,150}?\s+(?=[A-Z][a-z]+\s+(?:is|are|was|were|has|had|the|a|in|on|after|during|it|set)\b)/i, '');

  // Remove "production." prefix (from stripped infobox templates)
  cleaned = cleaned.replace(/^production\.\s*/, '');

  // Remove leading scene/act markers (semicolons from wikitext definition lists)
  cleaned = cleaned.replace(/^;\s*/g, '');
  // Remove leading colon markers (":Place: ...")
  cleaned = cleaned.replace(/^:\s*/g, '');

  // Remove "Setting: ..." prefix (keep subsequent content)
  cleaned = cleaned.replace(/^Setting:\s*[^.!?]+?\.\s*(?=[A-Z])/, '');
  // "Settings: Act I - Place; Act II - Place ..." (stage direction lists)
  cleaned = cleaned.replace(/^Settings?:\s*Act\s+[\s\S]{0,200}?\.\s*/i, '');

  // Remove "Sources: ..." lines (bibliographic, not plot)
  cleaned = cleaned.replace(/^Sources?:[\s\S]{0,200}?\.\s*/i, '');

  // Remove "Note: ..." or "Note that ..." meta prefixes
  cleaned = cleaned.replace(/^Note(?:\s+that)?:\s*/i, '');
  cleaned = cleaned.replace(/^Note that there are [^.]+?\.\s*/i, '');
  cleaned = cleaned.replace(/^Synopsis follows [^.]+?\.\s*/i, '');
  cleaned = cleaned.replace(/^This (?:summary|synopsis) is based on [^.]+?\.\s*/i, '');

  // "Graphic Gallery of Shakespeare's Heroines" — leftover image source
  cleaned = cleaned.replace(/^(?:from\s+)?(?:The\s+)?Graphic Gallery[^.]*?Heroines\s*/i, '');
  // Residual "of Shakespeare's Heroines" after partial strip
  cleaned = cleaned.replace(/^of\s+Shakespeare's\s+Heroines\s*/i, '');

  // Clean up any resulting leading whitespace/punctuation
  cleaned = cleaned.replace(/^[,;:\s]+/, '').trim();

  return cleaned;
}

module.exports = {
  stripWikiMarkup,
  hasWikiMarkup,
  stripLeadingJunk,
};
