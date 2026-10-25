/**
 * Pure helpers for scripts/check-byline-evidence.js (BRO-5232): pull the
 * author signals out of an article page and short contexts around a byline
 * match. No I/O.
 */
'use strict';

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#8211;|&#8212;/g, '-').replace(/\s+/g, ' ').trim();
}

function pageText(html) {
  return decode(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

/**
 * Author signals: meta author tags, JSON-LD author names, rel=author links and
 * "By Name" lines. Deduped, each capped at 80 chars.
 * @param {string} html
 * @returns {string[]}
 */
function extractAuthorSignals(html) {
  const s = String(html || '');
  const out = [];
  const add = (kind, v) => { const t = decode(v).slice(0, 80); if (t && !out.includes(`${kind}: ${t}`)) out.push(`${kind}: ${t}`); };
  for (const m of s.matchAll(/<meta[^>]+(?:name|property)=["'](?:author|article:author|parsely-author|sailthru\.author|byl)["'][^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']*)["']/i);
    if (c) add('meta', c[1]);
  }
  for (const m of s.matchAll(/"author"\s*:\s*(\{[^}]*\}|\[[^\]]*\])/g)) {
    for (const n of m[1].matchAll(/"name"\s*:\s*"([^"]+)"/g)) add('jsonld', n[1]);
  }
  for (const m of s.matchAll(/<a[^>]+rel=["']author["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) add('rel-author', m[1].replace(/<[^>]+>/g, ' '));
  const text = pageText(s);
  for (const m of text.matchAll(/\b(?:By|Reviewed by|Reviewer:?)\s+([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){1,3})/g)) add('byline', m[0]);
  return out.slice(0, 12);
}

/**
 * Up to 5 contexts (±60 chars) around matches of `re` in the page text.
 * @param {string} html
 * @param {RegExp} re
 * @returns {string[]}
 */
function matchContexts(html, re) {
  const text = pageText(html);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = [];
  for (const m of text.matchAll(g)) {
    out.push(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60));
    if (out.length >= 5) break;
  }
  return out;
}

/** Wayback timestamp hint: the first plausible year in the url, else 2015. */
function waybackTimestamp(url) {
  const m = String(url || '').match(/(?:^|[^\d])(199\d|20[0-2]\d)(?:[^\d]|$)/);
  return m ? `${m[1]}1231` : '20151231';
}

module.exports = { extractAuthorSignals, matchContexts, waybackTimestamp, pageText };
