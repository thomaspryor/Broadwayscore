/**
 * BLOX CMS (Tulsa World, Buffalo News, Sioux City Journal, Journal Times, ...) serves
 * paywalled paragraphs ROT47-scrambled in the page: "<p>" becomes "kAm" and "</p>"
 * becomes "k^Am". decodeBloxRot47(html) swaps every scrambled block for its plain HTML
 * so the normal article extractor sees the full review. BRO-4221.
 */
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&#34;': '"' };

function unescapeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(?:amp|lt|gt|quot);/g, m => ENTITIES[m]);
}

function rot47(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 33 && c <= 126 ? String.fromCharCode(33 + ((c - 33 + 47) % 94)) : ch;
  }
  return out;
}

function decodeBloxRot47(html) {
  if (typeof html !== 'string' || !html.includes('kAm')) return html;
  return html.replace(/kAm[^<>]*?k\^Am/g, block => {
    const decoded = rot47(unescapeEntities(block));
    return /^<p>[\s\S]*<\/p>$/.test(decoded) ? decoded : block;
  });
}

module.exports = { decodeBloxRot47, rot47 };
