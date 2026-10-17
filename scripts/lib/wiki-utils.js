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
  let cleaned = stripFileLinks(stripDefinitionListMarkup(text))
    .replace(/<!--.*?-->/gs, '')                           // HTML comments
    .replace(/<ref[^>]*>.*?<\/ref>/gis, '')                // <ref>...</ref>
    .replace(/<ref[^>]*\/>/gi, '')                         // <ref />
    .replace(/<\/?(?:br|small|nowiki|sup|sub|blockquote)[^>]*>/gi, ' ') // HTML tags
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
    .replace(/\{\{/g, '')                                  // Orphaned {{
    .replace(/\}\}/g, '')                                  // Orphaned }}
    .replace(/\|/g, ' ')                                   // Stray pipes
    .replace(/\n+/g, ' ')                                  // Newlines → spaces
    .replace(/\s+/g, ' ')                                  // Collapse whitespace
    .trim();

  return cleaned;
}

/**
 * Remove [[File:...]] / [[Image:...]] / [[Category:...]] links, captions and
 * all. A caption holding its own links ("[[File:X.jpg|thumb|alt=...|[[Judith
 * Bliss]] strikes a pose, 1925]]") ends at the matching "]]", not the first
 * one; the old single regex stopped early and left "thumb alt=middle aged
 * white woman ... strikes a pose" in Hay Fever's synopsis (BRO-5063).
 */
function stripFileLinks(text) {
  const open = /\[\[(?:File|Image|Category):/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = open.exec(text)) !== null) {
    out += text.slice(pos, m.index);
    let depth = 1;
    let i = m.index + 2;
    while (i < text.length && depth > 0) {
      if (text.startsWith('[[', i)) { depth++; i += 2; } else if (text.startsWith(']]', i)) { depth--; i += 2; } else i++;
    }
    // Never closed (malformed, or a section cut inside the caption): drop
    // the caption to the end of its line instead of swallowing the plot after.
    if (depth > 0) {
      const eol = text.indexOf('\n', m.index);
      i = eol === -1 ? text.length : eol;
    }
    pos = i;
    open.lastIndex = i;
  }
  return out + text.slice(pos);
}

/**
 * Definition-list markup used for act and scene headings: ";'''Act I'''" and
 * ";'''1977'''" term lines are headings, "*Scene One: Pub." lines are scene
 * labels, ":Time: The first century" is a setting label, and ":" opens an
 * indented paragraph. Once newlines collapse, the headings read as ";Act I
 * Belle Poitrine ..." mid-synopsis (Little Me, Lestat, Betrayal, Amahl;
 * BRO-5063). A heading line that also carries a sentence after its label
 * (";Act I: Belle Poitrine writes her autobiography with Patrick Dennis.")
 * keeps the sentence; a bare heading is dropped.
 */
const HEADING_LINE_RE = /^(?:;+|\*+(?=\s*(?:'{2,3})?\s*(?:Act|Scene)\b)|:+(?=\s*(?:'{2,3})?\s*(?:Time|Place|Setting)(?:'{2,3})?\s*:))([^\n]*)$/gim;
const MIN_SENTENCE_WORDS = 6;

function headingLineContent(body, singleLine) {
  const plain = body.replace(/'{2,3}/g, '').trim();
  // Label ends at the first ": " so a time in it ("Act I, 10:30 p.m.: The bar") is not the cut.
  const colon = plain.indexOf(': ');
  const rest = colon === -1 ? '' : plain.slice(colon + 2).trim();
  if (rest.split(/\s+/).length >= MIN_SENTENCE_WORDS && /[.!?]["')]?$/.test(rest)) return rest;
  // A one-line stored synopsis that opens with ";" (clean-synopsis-markup.js
  // input) keeps its text minus the marker; in multi-line wikitext a long
  // line is still a heading ("Act One — The Ballroom of the Grand Hotel").
  if (singleLine && colon === -1 && plain.split(/\s+/).length > MIN_SENTENCE_WORDS) return plain;
  return '';
}

function stripDefinitionListMarkup(text) {
  const singleLine = !String(text).includes('\n');
  return text
    .replace(HEADING_LINE_RE, (_, body) => headingLineContent(body, singleLine))
    .replace(/^:+\s*/gm, '');
}

/**
 * Check if text still contains raw Wikipedia markup.
 * Use after stripWikiMarkup() as a safety check.
 *
 * @param {string} text
 * @returns {boolean} True if markup remnants detected
 */
function hasWikiMarkup(text) {
  return /[={]{2}|\[\[|\]\]|\{\{|\}\}|\|\s*\w+\s*=/.test(text);
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
  stripFileLinks,
  stripDefinitionListMarkup,
  hasWikiMarkup,
  stripLeadingJunk,
};
