'use strict';
// BRO-4665: join every text block of an Anthropic Messages response.
//
// With a server tool such as the advisor (advisor_20260301) the response holds
// several text blocks: a preamble ("I'll analyze each transcript..."), the
// tool call and its result, then the real answer. Reading only the first text
// block (`content.find(c => c.type === 'text')`) returns the preamble and the
// caller's JSON parse fails. Seen in weekly-video-reviews run 37267725282.

function responseText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');
}

module.exports = { responseText };
