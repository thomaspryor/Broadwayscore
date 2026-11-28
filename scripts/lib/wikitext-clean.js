'use strict';
/**
 * Turn a Wikipedia infobox field value into plain comma-separated names.
 * Used by scripts/enrich-wikipedia-creative.js.
 *
 * BRO-7426: Galileo's "music" field was
 *   {{plainlist |\n* Zoe Sarnak\n* Michael Weiner\n}}
 * The old open-template strip only matched "{{plainlist|" with no space, and
 * list bullets became plain spaces, so the site showed one creative named
 * "{{plainlist | Zoe Sarnak Michael Weiner". List bullets and template pipes
 * are now separators, and any template opener with spaces is stripped.
 */
function cleanWikitext(text) {
  return String(text || '')
    .replace(/<!--.*?-->/gs, '')
    .replace(/<ref[^>]*>.*?<\/ref>/gis, '')       // Remove full ref tags
    .replace(/<ref[^>]*\/>/gi, '')                  // Remove self-closing ref tags
    .replace(/<\/?(?:br|small|nowiki)[^>]*>/gi, ', ') // br → separator
    .replace(/\{\{\s*(?:hidden|collapse|based on|Infobox|Cite)[^}]*\}\}/gis, '')
    .replace(/\{\{\s*efn\s*\|[^}]*\}\}/gi, '')      // Remove efn (footnote) templates
    .replace(/\{\{\s*(?:unbulleted list|ubl|plainlist|flatlist|hlist)\s*\|?/gi, '') // Strip list template open
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2') // [[link|text]] → text
    .replace(/\{\{\s*sortname\s*\|([^|{}]*)\|([^|{}]*)(\|[^{}]*)?\}\}/gi, '$1 $2') // {{sortname|First|Last}} → one name
    .replace(/\{\{\s*lang\s*\|[^|{}]*\|([^|{}]*)(\|[^{}]*)?\}\}/gi, '$1')            // {{lang|fr|Name}} → Name
    .replace(/\{\{\s*(?:nowrap|nobr|small|big|nobold|noitalic)\s*\|([^{}]*)\}\}/gi, '$1') // formatting wrappers → content
    .replace(/\{\{[^{}]*\}\}/g, '')                // any other closed template ({{citation needed|...}}) is not a name: drop it
    .replace(/'{2,3}/g, '')
    .replace(/(^|\n)\s*\*+\s*/g, ', ')              // "* item" list bullets → separator
    .replace(/\*/g, ' ')
    .replace(/\}\}/g, '')
    .replace(/\s*\|\s*/g, ', ')                     // leftover template pipes ({{ubl|A|B}}) → separator
    .replace(/\s*,(\s*,)+/g, ',')                   // Collapse multiple commas
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, '');               // Trim leading/trailing commas
}

/** True when a stored name still carries wiki markup (validate-data guard). */
function hasWikiMarkup(name) {
  return /\{\{|\}\}|\[\[|\]\]|<ref|'''/.test(String(name || ''));
}

module.exports = { cleanWikitext, hasWikiMarkup };
