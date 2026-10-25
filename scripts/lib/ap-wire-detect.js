'use strict';
/**
 * ap-wire-detect — is this review file really the Associated Press wire review?
 * Used by detect-syndicated-duplicates.js (every rebuild) to mark AP copy filed
 * under another outlet as a syndicated duplicate of AP's own file.
 */

// Many reviews quote AP excerpts in roundup pages — those are NOT syndication.
const AP_STRONG_SIGNALS = [
  // AP byline at start: "By Mark Kennedy, AP" or "By Mark Kennedy\nAP Drama Writer"
  { regex: /(?:^|\n)\s*(?:by\s+)?(?:Mark Kennedy|Jennifer Farrar|Michael Kuchwara|Jocelyn Noveck),?\s*(?:AP|Associated Press)/im, where: 'head' },
  // "AP Drama/Theater Writer" byline near start
  { regex: /(?:^|\n)\s*(?:by\s+)?\w+ \w+\s*\n\s*AP (?:Drama|Theater|Theatre|Entertainment) (?:Writer|Critic)/im, where: 'head' },
  // AP credit at end: "Mark Kennedy is at twitter.com/KennedyTwits"
  { regex: /Kennedy is at (?:http|twitter)/i, where: 'tail' },
  // AP copyright at end
  { regex: /(?:Copyright|©).*Associated Press/i, where: 'tail' },
];

// AP wire article id on a partner newspaper's site, e.g.
// online.wsj.com/article/AP216f8806ddad4b8b9837a6702e4...html (BRO-5243: five
// WSJ files held Mark Kennedy's AP review this way, four of them live as WSJ
// Tier-1 scores, two with no fullText at all). The id alone identifies AP copy.
const AP_WIRE_URL = /\/article\/AP[0-9a-f]{32}/i;

function detectAPContent(fullText, url = null) {
  if (url && AP_WIRE_URL.test(url)) return true;
  if (!fullText || fullText.length < 100) return false;
  const head = fullText.slice(0, 300);
  const tail = fullText.slice(-300);
  for (const sig of AP_STRONG_SIGNALS) {
    const text = sig.where === 'head' ? head : tail;
    if (sig.regex.test(text)) return true;
  }
  return false;
}

module.exports = { detectAPContent, AP_WIRE_URL, AP_STRONG_SIGNALS };
