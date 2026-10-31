'use strict';
/**
 * One line of ingest-urls input: "URL [outletId] [ | Critic Name ]" (BRO-6518).
 *
 * The critic part lets a caller that already knows the byline (theatreinchicago.com
 * lists it beside every review link) pass it through, because some outlets' pages
 * carry only a site-wide author. The separator is whitespace-pipe-whitespace:
 * a bare "|" occurs inside real URLs (Variety's "...&cmpid=RSS|News|LatestNews").
 */
const CRITIC_SEP = /\s+\|\s+/;

function parseIngestLine(line) {
  // A trailing " |" with no name is dropped rather than read as an outlet id.
  const trimmed = String(line || '').trim().replace(/\s+\|$/, '');
  const sep = trimmed.search(CRITIC_SEP);
  const head = sep >= 0 ? trimmed.slice(0, sep) : trimmed;
  // Only the first separator splits; anything after a second one is not a name.
  const critic = sep >= 0 ? trimmed.slice(sep).replace(CRITIC_SEP, '').split(CRITIC_SEP)[0].trim() : '';
  const parts = head.split(/\s+/);
  return { url: parts[0], outletOverride: parts[1] || null, listedCritic: critic || null };
}

function formatIngestLine({ url, outlet = null, critic = null }) {
  let line = outlet ? `${url} ${outlet}` : url;
  const name = critic ? String(critic).replace(/\s+\|\s+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (name) line += ` | ${name}`;
  return line;
}

module.exports = { parseIngestLine, formatIngestLine };
