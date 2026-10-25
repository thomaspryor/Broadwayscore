'use strict';

/**
 * Summarize one fetchPage() result for a probe (BRO-4038).
 *
 * fetchPage resolves to { content, format, source }. Probes that read
 * r.html / r.body see undefined and report "0 links" on a page that is fine
 * (BRO-2763; BRO-4038's own VERIFY line did this for westendbestfriend.co.uk).
 * This reads `content` only, so a zero here means the page really lacks the
 * pattern.
 *
 * @param {{content?: string, format?: string, source?: string}} result
 * @param {RegExp|null} expect - pattern to count (global flag added if absent)
 * @returns {{source: string|null, format: string|null, length: number, matches: string[], ok: boolean}}
 */
function summarizeFetchResult(result, expect) {
  const content = (result && typeof result.content === 'string') ? result.content : '';
  let matches = [];
  if (expect) {
    const re = expect.global ? expect : new RegExp(expect.source, expect.flags + 'g');
    matches = [...new Set(content.match(re) || [])];
  }
  return {
    source: (result && result.source) || null,
    format: (result && result.format) || null,
    length: content.length,
    matches,
    ok: content.length > 0 && (!expect || matches.length > 0),
  };
}

module.exports = { summarizeFetchResult };
