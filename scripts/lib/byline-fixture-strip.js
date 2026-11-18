/**
 * BRO-7780: cut a real review page down to what a byline reader looks at, so it can live in the
 * public repo as a fixture (tests/fixtures/byline-outlets/). No review prose survives:
 *  - markup is kept, with only the attributes the readers match on;
 *  - <meta> tags are kept, long descriptions blanked;
 *  - JSON-LD is re-serialized without articleBody / description / text and with long strings blanked;
 *  - scripts, styles, svg, comments and <link>s are dropped;
 *  - a text node survives only when it is a byline-shaped line ("By X", "Reviewer: X", "--X"),
 *    a short label inside an author / byline / date / credit element, the <title> / <h1>, or the
 *    "SHARE THIS POST" marker a sign-off reader keys on. Every other text node becomes "…".
 * Pure; used by scripts/build-byline-fixtures.js.
 */
'use strict';

const MAX_LABEL = 60;
const KEEP_ATTRS = new Set(['class', 'id', 'rel', 'href', 'itemprop', 'name', 'property', 'content', 'alt', 'title', 'type', 'datetime']);
const BYLINE_TEXT_RE = /^\s*(?:(?:[Tt]heatre\s+)?[Rr]eview(?:ed)?\s+by|[Rr]eviewer:|[Ww]ritten\s+by|[Bb]y:?|(?:--|—)\s*)\s*[A-Z][A-Za-zÀ-ÿ.'’-]*(?:,?\s+(?:[A-Z][A-Za-zÀ-ÿ.'’-]*|and|&amp;|for|in|on|\d{1,2},?|\d{4}|\||[A-Z][a-z]+\.?))*\s*$/;
const LONG_META_RE = /^(?:description|og:description|twitter:description|keywords|news_keywords)$/i;
const BYLINE_CONTEXT_RE = /author|byline|contributor|credit|writer|reviewer|date|time|posted|meta|sign/i;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function blankLongStrings(v, key) {
  if (typeof v === 'string') return v.length > 120 && !/^(?:@id|url|@type|name)$/.test(key || '') ? '' : v;
  if (Array.isArray(v)) return v.map((x) => blankLongStrings(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/^(?:articleBody|text|description|abstract|alternativeHeadline|reviewBody|caption)$/i.test(k)) continue;
      o[k] = blankLongStrings(x, k);
    }
    return o;
  }
  return v;
}

function stripJsonLd(block) {
  const body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
  try {
    return `<script type="application/ld+json">${JSON.stringify(blankLongStrings(JSON.parse(body)))}</script>`;
  } catch { return ''; }
}

function stripAttrs(name, attrs, selfClose) {
  const kept = [];
  for (const a of attrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g)) {
    const key = a[1].toLowerCase();
    if (!KEEP_ATTRS.has(key)) continue;
    let val = a[2];
    // Links matter only when they point at a person's page (TheaterMania /authors/<slug>, rel=author).
    if (key === 'href' && !/author|contributor|staff|profile|user|people|writer|critic|byline/i.test(val)) continue;
    if (name === 'meta' && key === 'content' && LONG_META_RE.test((/(?:name|property)=["']([^"']+)/i.exec(attrs) || [])[1] || '')) val = '""';
    if ((key === 'alt' || key === 'title') && val.length > MAX_LABEL + 2) continue;
    kept.push(`${a[1]}=${val}`);
  }
  return `<${name}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose}>`;
}

function stripPageForBylineFixture(html) {
  let s = String(html || '');
  const ld = [];
  s = s.replace(/<script\b[^>]*type=["']?application\/ld\+json["']?[^>]*>[\s\S]*?<\/script>/gi, (b) => { ld.push(stripJsonLd(b)); return `\u0000LD${ld.length - 1}\u0000`; });
  s = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript|iframe|template|picture|video|audio)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    // Chrome with no byline in it: navigation, footers, forms, menus.
    .replace(/<(nav|footer|form|select|button)\b[\s\S]*?<\/\1>/gi, (x) => (/author|byline/i.test(x) ? x : ''));
  // Walk tags with a stack so a text node knows whether it sits in a byline-ish element.
  const stack = []; // {name, ctx}
  const inCtx = () => stack.some((e) => e.ctx);
  const inTag = (n) => stack.some((e) => e.name === n);
  let out = '';
  for (const m of s.matchAll(/(<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>)|([^<]+)|(<)/g)) {
    if (m[1]) {
      const name = m[2].toLowerCase();
      if (m[1].startsWith('</')) {
        const i = stack.map((e) => e.name).lastIndexOf(name);
        if (i >= 0) stack.length = i;
        out += `</${name}>`;
        continue;
      }
      if (VOID.has(name) && name !== 'meta' && !inCtx() && !/author|byline/i.test(m[3] || '')) continue;
      out += stripAttrs(name, m[3] || '', m[4] || '');
      if (!VOID.has(name) && !m[4]) {
        const attrs = (m[3] || '').match(/\b(?:class|id|rel|itemprop)\s*=\s*("[^"]*"|'[^']*')/gi) || [];
        stack.push({ name, ctx: attrs.some((a) => BYLINE_CONTEXT_RE.test(a)) });
      }
      continue;
    }
    if (m[6]) { out += '&lt;'; continue; }
    const t = m[5];
    if (/\u0000LD\d+\u0000/.test(t)) { out += t; continue; }
    const trimmed = t.replace(/\s+/g, ' ').trim();
    if (!trimmed) { out += t ? ' ' : ''; continue; }
    const keep = (BYLINE_TEXT_RE.test(trimmed) && trimmed.length <= 90)
      || (inCtx() && trimmed.length <= MAX_LABEL)
      || ((inTag('title') || inTag('h1')) && trimmed.length <= 160)
      || /^SHARE THIS POST$/i.test(trimmed)
      || (/^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,2}$/.test(trimmed) && (inTag('strong') || inTag('b') || inTag('a')) && trimmed.length <= 40)
      || /^(?:By|by:?|\||,|&amp;|and|Review|Reviewer:?)$/.test(trimmed);
    out += keep ? t.replace(/\s+/g, ' ') : '…';
  }
  // Empty wrappers left behind by the drops.
  for (let i = 0; i < 6; i++) out = out.replace(/<(div|span|p|li|ul|ol|section|figure|a|article|aside|header|main|h[2-6]|em|strong|i|b|small|time)\b[^>]*>\s*(?:…\s*)*<\/\1>/gi, (x) => (/(author|byline)/i.test(x) ? x : ''));
  out = out.replace(/(?:…\s*){2,}/g, '… ');
  out = out.replace(/\u0000LD(\d+)\u0000/g, (x, i) => ld[Number(i)]);
  return out.replace(/\n\s*\n+/g, '\n').replace(/[ \t]{2,}/g, ' ');
}

module.exports = { stripPageForBylineFixture };
