'use strict';
/**
 * Self-reference detection for commercial research answers (BRO-4990).
 *
 * broadwayscorecard.com (and its llms.txt) republishes commercial.json, so an
 * answer built on it is circular: in a blind accuracy test it scores the
 * dataset against itself, and in real research it launders our own guess into
 * "evidence". The Responses API web search tool cannot block a domain, so the
 * prompt forbids it and this check catches what slips through.
 */

const SELF_HOST_RE = /(^|\.)broadwayscorecard\.com$/i;

function isSelfUrl(url) {
  try {
    return SELF_HOST_RE.test(new URL(String(url)).hostname);
  } catch {
    return /broadwayscorecard\.com/i.test(String(url || ''));
  }
}

/**
 * URLs the model opened or cited that point at our own site.
 * Looks at web_search_call actions (open_page url, search result sources)
 * and url_citation annotations on the answer text.
 * @param {object[]} output - Responses API `output` array
 * @returns {string[]} unique self URLs
 */
function findSelfReferences(output) {
  const urls = [];
  for (const item of output || []) {
    if (!item) continue;
    if (item.type === 'web_search_call' && item.action) {
      if (item.action.url) urls.push(item.action.url);
      for (const s of item.action.sources || []) if (s && s.url) urls.push(s.url);
    }
    if (item.type === 'message') {
      for (const c of item.content || []) {
        for (const a of (c && c.annotations) || []) if (a && a.url) urls.push(a.url);
      }
    }
  }
  return [...new Set(urls.filter(isSelfUrl))];
}

module.exports = { isSelfUrl, findSelfReferences };
