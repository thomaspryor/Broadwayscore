/**
 * BLOX CMS (Tulsa World, Buffalo News, Sioux City Journal, Journal Times, ...) serves
 * paywalled paragraphs ROT47-scrambled in the page: "<p>" becomes "kAm" and "</p>"
 * becomes "k^Am". decodeBloxRot47(html) swaps every scrambled run for its plain HTML
 * so the normal article extractor sees the full review. BRO-4221.
 *
 * decodeBloxRot47InDocument(document) does the same on a live DOM (the Playwright
 * path, where the run is one text node with entities already decoded).
 */

// Full HTML entity table, single pass, exact code points ('entities', in the
// lockfile via jsdom/cheerio; not a direct dependency, hence the fallback).
// The fallback covers the entities a CMS escapes when it serializes text.
let decodeHTML;
try {
  ({ decodeHTML } = require('entities'));
} catch {
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  decodeHTML = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
    const c = dec ? +dec : hex ? parseInt(hex, 16) : null;
    if (c !== null) return c <= 0x10ffff ? String.fromCodePoint(c) : m;
    return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m;
  });
}

function rot47(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 33 && c <= 126 ? String.fromCharCode(33 + ((c - 33 + 47) % 94)) : ch;
  }
  return out;
}

/**
 * A decoded run is real BLOX content only if it is paragraph markup AND reads as
 * prose. kAm always rotates to <p>, so the tag check alone passed any text that
 * merely contained kAm...k^Am. ROT47 of English prose is mostly digits and
 * punctuation (a-o rotate to 2-@), so a letter share under 55% means the input was
 * not scrambled text. Runs too short to judge pass on the tag check.
 */
function looksLikeDecodedProse(decoded) {
  if (!/^<p>[\s\S]*<\/p>$/.test(decoded)) return false;
  const chars = decoded.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  if (chars.length < 20) return true;
  const letters = (chars.match(/\p{L}/gu) || []).length;
  return letters / chars.length >= 0.55;
}

// Tags and <script>/<style> bodies are matched first and passed through, so a run
// is decoded only in text content (never in an attribute value or JSON-LD). A
// scrambled run holds no raw < or > (they are entity-escaped), so one run spans
// every scrambled block in a text node, including <h2>/<blockquote> between <p>s.
// Case-insensitive tag names spelled out: an /i flag would also loosen kAm.
const RUN = /(<[sS][cC][rR][iI][pP][tT]\b[\s\S]*?<\/[sS][cC][rR][iI][pP][tT]\s*>|<[sS][tT][yY][lL][eE]\b[\s\S]*?<\/[sS][tT][yY][lL][eE]\s*>|<[!/?a-zA-Z][^>]*>)|kAm[^<>]*k\^Am/g;

function decodeBloxRot47(html) {
  if (typeof html !== 'string' || !html.includes('kAm')) return html;
  return html.replace(RUN, (block, passthrough) => {
    if (passthrough) return block;
    const decoded = rot47(decodeHTML(block));
    return looksLikeDecodedProse(decoded) ? decoded : block;
  });
}

/**
 * DOM variant for page.evaluate: self-contained (no closures), serialized into the
 * browser. Replaces each scrambled text node with its decoded markup.
 * @returns {number} runs decoded
 */
function decodeBloxRot47InDocument(doc) {
  if (!doc || !doc.body || !/kAm/.test(doc.body.textContent || '')) return 0;
  const rot = (s) => {
    let o = '';
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      o += c >= 33 && c <= 126 ? String.fromCharCode(33 + ((c - 33 + 47) % 94)) : ch;
    }
    return o;
  };
  const prose = (d) => {
    if (!/^<p>[\s\S]*<\/p>$/.test(d)) return false;
    const chars = d.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
    if (chars.length < 20) return true;
    return (chars.match(/\p{L}/gu) || []).length / chars.length >= 0.55;
  };
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentNode && n.parentNode.nodeName;
    if (parent === 'SCRIPT' || parent === 'STYLE' || parent === 'TEXTAREA') continue;
    if (/kAm[\s\S]*k\^Am/.test(n.nodeValue || '')) hits.push(n);
  }
  let count = 0;
  for (const n of hits) {
    let changed = false;
    const html = n.nodeValue.replace(/kAm[\s\S]*k\^Am/g, (run) => {
      const d = rot(run);
      if (!prose(d)) return run;
      changed = true;
      return d;
    });
    if (!changed) continue;
    // Text outside the run stays text: escape it before parsing the whole node.
    const [pre, post] = [n.nodeValue.indexOf('kAm'), n.nodeValue.lastIndexOf('k^Am') + 4];
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const t = doc.createElement('template');
    t.innerHTML = esc(n.nodeValue.slice(0, pre)) + html.slice(pre, html.length - (n.nodeValue.length - post)) + esc(n.nodeValue.slice(post));
    n.parentNode.replaceChild(t.content, n);
    count++;
  }
  return count;
}

module.exports = { decodeBloxRot47, decodeBloxRot47InDocument, rot47 };
