'use strict';

/**
 * Opaque article URLs (BRO-7163 F02): story.asp?ID=48291, post.cfm?id=7, /p/48291, /2026/11/48291.
 * The path says nothing about the show, so URL-title matching can never accept them; the headline
 * (SERP title, roundup link text) has to carry the show-identity evidence instead.
 */
const SLUG_NOISE = new Set(['story', 'post', 'article', 'articles', 'news', 'review', 'reviews', 'content', 'blog', 'node', 'view',
  'detail', 'details', 'page', 'index', 'default', 'show', 'main', 'read', 'item', 'entry', 'html', 'www']);

function isOpaqueArticleUrl(u) {
  let pathname = '';
  try { pathname = new URL(u).pathname; } catch { pathname = String(u || '').split(/[?#]/)[0]; }
  const words = pathname.toLowerCase().replace(/\.(?:html?|php|aspx?|cfm|jsp)$/i, '')
    .split(/[^a-z]+/).filter((w) => w.length >= 3 && !SLUG_NOISE.has(w));
  return words.length < 2;
}

/** A URL whose path carries the words of `text` (a headline), for running URL-title matchers on a headline. */
function headlineAsUrl(text) {
  const slug = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `https://headline.invalid/${slug}/` : null;
}

module.exports = { isOpaqueArticleUrl, headlineAsUrl };
