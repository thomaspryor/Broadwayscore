'use strict';
// BRO-4665: the final answer text of an Anthropic Messages response.
//
// With a server tool such as the advisor (advisor_20260301) the response holds
// several blocks: a preamble ("I'll analyze each transcript..."), the tool call
// and its result, then the real answer. Reading only the first text block
// (`content.find(c => c.type === 'text')`) returns the preamble and the
// caller's JSON parse fails (weekly-video-reviews run 37267725282). Joining
// every block is wrong too: a draft written before the advisor call would be
// parsed instead of the revised answer. So: the text blocks after the last
// non-text block, joined. Without tool blocks that is simply all the text.

function finalResponseText(content) {
  if (!Array.isArray(content)) return '';
  let start = 0;
  content.forEach((c, i) => { if (c && c.type !== 'text') start = i + 1; });
  const texts = content.filter(c => c && c.type === 'text' && typeof c.text === 'string');
  const tail = content.slice(start).filter(c => texts.includes(c)).map(c => c.text).join('\n');
  // Nothing after the last tool block (answer came first, or a truncated
  // turn): the last text block is the best remaining candidate.
  return tail || (texts.length ? texts[texts.length - 1].text : '');
}

// One-line shape summary for parse-failure errors: stop_reason + block types.
function describeResponse(data) {
  const types = Array.isArray(data && data.content) ? data.content.map(c => c && c.type).join(',') : 'none';
  return `stop_reason=${(data && data.stop_reason) || 'unknown'} blocks=[${types}]`;
}

module.exports = { finalResponseText, describeResponse };
