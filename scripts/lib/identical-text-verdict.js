/**
 * Pure helpers for verify-identical-text-bylines.js (BRO-5321): one article's
 * text stored under two critics on a show. Given the stored text and each
 * group url's fetched page, say whose article the text is and which stored
 * critic, if any, carries that byline. No I/O.
 */
'use strict';

const { pageText } = require('./byline-evidence');

const normWords = (t) => String(t || '').toLowerCase().normalize('NFKD')
  .replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Share of evenly spaced 8-word runs of the stored text that appear in the page
 * text. 1 = the page carries this text; ~0 = a different article (or a paywall).
 * @param {string} storedText
 * @param {string} html
 * @param {number} [samples]
 * @returns {number|null} null when the stored text is too short to sample
 */
function textOverlap(storedText, html, samples = 24) {
  const w = normWords(storedText);
  const N = 8;
  if (w.length < N * 3) return null;
  const page = ` ${normWords(pageText(html)).join(' ')} `;
  const step = Math.max(1, Math.floor((w.length - N) / (samples - 1)));
  let hit = 0;
  let tot = 0;
  for (let i = 0; i + N <= w.length && tot < samples; i += step) {
    tot++;
    if (page.includes(` ${w.slice(i, i + N).join(' ')} `)) hit++;
  }
  return tot ? Math.round((hit / tot) * 100) / 100 : null;
}

const NOT_A_NAME = /^(?:https?:|www\.)|\b(?:staff|editors?|team|desk|newsroom|contributors?|reporters?|correspondents?|wire|press|associated|reuters|entertainment weekly|variety|guardian|times|post|news|magazine)\b/i;

/**
 * Structured author names from extractAuthorSignals() output: JSON-LD and meta
 * author tags only. Free-text "By X" lines are page chrome too often (Variety's
 * footer, EW's related-story cards) to name the article's author.
 * @param {string[]} signals e.g. ['meta: David Rooney', 'jsonld: David Rooney', 'byline: By ...']
 * @returns {string[]}
 */
function structuredAuthors(signals) {
  const out = [];
  for (const s of signals || []) {
    const m = String(s).match(/^(jsonld|meta): (.+)$/);
    if (!m) continue;
    for (const part of m[2].split(/\s*(?:,|\band\b|&)\s*/)) {
      const n = part.trim();
      if (n.split(/\s+/).length < 2 || n.length > 60 || NOT_A_NAME.test(n)) continue;
      if (!out.some((x) => sameCritic(x, n))) out.push(n);
    }
  }
  return out;
}

const normName = (c) => String(c || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ').trim().split(/\s+/).filter(Boolean);

/** Same person: full-name match, or same surname and same first initial. */
function sameCritic(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  if (x.length < 2 || y.length < 2) return false;
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}

const canonUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

/**
 * Whose article is the stored text?
 *
 * Evidence, strongest first: a fetched page that carries the text (overlap
 * >= 0.6) and names its author in JSON-LD/meta. Failing that, when every copy
 * holds the same url, that url's structured author (the text was fetched from
 * it; paywalls hide the body, not the byline).
 *
 * @param {{critic:string, url:string}[]} members  stored copies (critic as shown)
 * @param {{url:string, authors:string[], overlap:number|null}[]} pages  one per fetched url
 * @returns {{author:string|null, basis:string, url:string|null}}
 */
function textAuthor(members, pages) {
  const withText = (pages || []).filter((p) => typeof p.overlap === 'number' && p.overlap >= 0.6);
  const named = withText.map((p) => ({ p, names: structuredAuthors(p.authors) })).filter((x) => x.names.length);
  const sole = named.filter((x) => x.names.length === 1);
  const distinct = [];
  for (const x of sole) if (!distinct.some((d) => sameCritic(d.names[0], x.names[0]))) distinct.push(x);
  if (distinct.length === 1) return { author: distinct[0].names[0], basis: 'page-with-text', url: distinct[0].p.url };
  if (distinct.length > 1) return { author: null, basis: 'conflicting-bylines', url: null };
  if (named.length) return { author: null, basis: 'multi-author-page', url: null };
  const urls = new Set((members || []).map((m) => canonUrl(m.url)).filter(Boolean));
  if (urls.size === 1) {
    const p = (pages || []).find((q) => canonUrl(q.url) === [...urls][0]);
    const names = p ? structuredAuthors(p.authors) : [];
    if (names.length === 1) return { author: names[0], basis: 'same-url-byline', url: p.url };
  }
  return { author: null, basis: 'unverified', url: null };
}

/**
 * Verdict for one group.
 * @param {{file:string, critic:string, url:string, shown:boolean}[]} members
 * @param {{url:string, authors:string[], overlap:number|null}[]} pages
 * @returns {{kind:'shown-correct'|'shown-wrong'|'none-shown'|'author-not-stored'|'unverified', author:string|null, basis:string, evidenceUrl:string|null, shown:string[], right:string[]}}
 */
function groupVerdict(members, pages) {
  const t = textAuthor(members, pages);
  const shown = members.filter((m) => m.shown).map((m) => m.file);
  const right = t.author ? members.filter((m) => sameCritic(m.critic, t.author)).map((m) => m.file) : [];
  const base = { author: t.author, basis: t.basis, evidenceUrl: t.url, shown, right };
  if (!t.author) return { kind: 'unverified', ...base };
  if (!shown.length) return { kind: 'none-shown', ...base };
  if (shown.every((f) => right.includes(f))) return { kind: 'shown-correct', ...base };
  if (!right.length) return { kind: 'author-not-stored', ...base };
  return { kind: 'shown-wrong', ...base };
}

module.exports = { textOverlap, structuredAuthors, sameCritic, canonUrl, textAuthor, groupVerdict };
