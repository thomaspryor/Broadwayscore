/**
 * BRO-7780: cut a real review page down to what a byline reader looks at, so it can live in the
 * public repo as a fixture. Kept: markup, attributes the readers match on, <meta> tags, JSON-LD
 * (long string values blanked: articleBody/description are review text), and short text nodes
 * (names, dates, labels). Dropped: scripts/styles/svg/comments, and every text node over
 * MAX_TEXT chars unless it is a byline line ("By X", "Reviewed by X", "Review by X").
 * The review's prose never survives: body paragraphs are long text nodes.
 */
'use strict';

const MAX_TEXT = 60;
const KEEP_ATTRS = new Set(['class', 'id', 'rel', 'href', 'itemprop', 'name', 'property', 'content', 'alt', 'title', 'type', 'datetime', 'style']);
const BYLINE_TEXT_RE = /^\s*(?:(?:theatre\s+)?review(?:ed)?\s+by|written\s+by|by:?)\s+[A-Z]/i;
const LONG_META_RE = /^(?:description|og:description|twitter:description|keywords|news_keywords)$/i;

function blankLongStrings(v, key) {
  if (typeof v === 'string') return v.length > 120 && !/^(?:@id|url|@type|name)$/.test(key || '') ? '' : v;
  if (Array.isArray(v)) return v.map((x) => blankLongStrings(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/^(?:articleBody|text|description|abstract|alternativeHeadline)$/i.test(k)) continue;
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

function stripAttrs(tag) {
  const m = /^<([a-z][a-z0-9-]*)\b([\s\S]*?)(\/?)>$/i.exec(tag);
  if (!m) return tag;
  const [, name, attrs, selfClose] = m;
  const kept = [];
  for (const a of attrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g)) {
    const key = a[1].toLowerCase();
    if (!KEEP_ATTRS.has(key)) continue;
    let val = a[2];
    if (key === 'style' && !/text-align/i.test(val)) continue;
    if (name.toLowerCase() === 'meta' && key === 'content' && LONG_META_RE.test((/(?:name|property)=["']([^"']+)/i.exec(attrs) || [])[1] || '')) val = '""';
    kept.push(`${a[1]}=${val}`);
  }
  return `<${name}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose}>`;
}

function stripPageForBylineFixture(html) {
  let s = String(html || '');
  const ld = [];
  s = s.replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, (b) => { ld.push(stripJsonLd(b)); return `\u0000LD${ld.length - 1}\u0000`; });
  s = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript|iframe|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');
  // A paragraph is judged whole: an inline tag splits a sentence into short text nodes that would
  // each pass the length test below, so a long paragraph is emptied as a unit.
  s = s.replace(/<(p|blockquote|li|figcaption|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (m, t, attrs, inner) => {
    const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length <= MAX_TEXT || (BYLINE_TEXT_RE.test(plain) && plain.length <= 120)) return m;
    return `<${t}${attrs}>…</${t}>`;
  });
  // Tags: prune attributes. Text: keep short nodes and byline lines only.
  s = s.replace(/(<[^>]+>)|([^<]+)/g, (all, tag, text) => {
    if (tag) return /^<\//.test(tag) ? tag : stripAttrs(tag);
    const t = text.replace(/\s+/g, ' ');
    if (!t.trim()) return t === '' ? '' : ' ';
    if (t.trim().length <= MAX_TEXT || BYLINE_TEXT_RE.test(t) && t.trim().length <= 120) return t;
    return '…';
  });
  // Empty wrappers left behind by the drops.
  for (let i = 0; i < 4; i++) s = s.replace(/<(div|span|p|li|ul|section|figure|a)\b[^>]*>\s*(?:…\s*)?<\/\1>/gi, (m, t) => (/(author|byline)/i.test(m) ? m : ''));
  s = s.replace(/\u0000LD(\d+)\u0000/g, (m, i) => ld[Number(i)]);
  return s.replace(/\n\s*\n+/g, '\n').replace(/[ \t]{2,}/g, ' ');
}

module.exports = { stripPageForBylineFixture, MAX_TEXT };
