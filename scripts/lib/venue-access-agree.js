'use strict';
/**
 * venue-access-agree.js — decide which accessibility facts for a venue may be published (BRO-8112).
 *
 * Wrong access information can strand a wheelchair user, so the bar is higher than for the
 * other venue facts (venue-info-agree.js). A fact is published ONLY when
 *   1. both independent models, reading the same text from the venue's own website, give the
 *      same answer (true or false), and
 *   2. each model backs it with a quote that appears word for word in that text, and
 *   3. the quote is on topic for the fact (a wheelchair claim must quote something about
 *      wheelchairs, steps, lifts or access).
 * Anything else is omitted. The note shown on the page is a word-for-word sentence from the
 * official page, never model prose.
 *
 * Pure functions, no I/O (tests: scripts/lib/venue-access-agree.test.js).
 */

const FIELDS = ['wheelchair', 'stepFree', 'elevator', 'hearingLoop', 'assistiveListening'];

// A quote must mention the topic it is offered as evidence for.
const TOPIC = {
  wheelchair: /wheelchair|step[- ]?free|level access|ramp|accessible|disabled|mobility/i,
  stepFree: /step[- ]?free|level access|no steps|ramp|lift|elevator|flat|ground floor|stair[- ]?free|without (any )?steps/i,
  elevator: /\blifts?\b|elevators?/i,
  hearingLoop: /loop|induction|t[- ]?coil|telecoil/i,
  assistiveListening: /assistive|infra-?red|listening|headset|headphone|receiver|hearing|loop|captio|induction|amplif/i,
};

const MAX_NOTE = 240;
// The page note must itself be about access, not a slogan.
const NOTE_TOPIC = /wheelchair|step[- ]?free|level access|ramp|accessib|disabled|mobility|\blifts?\b|elevator|hearing|loop|induction|infra-?red|assistive|listening|captio|seat/i;

/** Lowercase, strip accents/punctuation, collapse whitespace: the form quotes are compared in. */
function normalize(t) {
  return String(t || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Does the quote appear word for word in the text (ignoring case, punctuation, spacing)? */
function quoteInText(quote, text) {
  const q = normalize(quote);
  if (q.split(' ').length < 3) return false; // a one or two word "quote" proves nothing
  return ` ${normalize(text)} `.includes(` ${q} `);
}

/** Answer shape per field: {value: true|false|null, quote: string|null}. */
function cleanAnswer(a) {
  if (!a || typeof a !== 'object') return { value: null, quote: null };
  const value = a.value === true || a.value === false ? a.value : null;
  const quote = typeof a.quote === 'string' && a.quote.trim() ? a.quote.trim() : null;
  return { value, quote };
}

/**
 * Merge two independent extractions over the same page texts.
 * g / o: {wheelchair:{value,quote}, ..., note: string|null} or null.
 * pages: [{url, text}] the texts both models read.
 * Returns {access, evidence, rejected}; access holds only agreed, evidenced facts.
 */
function agreeAccess(g, o, pages) {
  const access = {};
  const evidence = {};
  const rejected = [];
  if (!g || !o || g.error || o.error) return { access, evidence, rejected: [{ field: '*', reason: 'a model gave no answer' }] };

  const urlOf = (quote) => (pages.find((p) => quoteInText(quote, p.text)) || {}).url || null;

  for (const f of FIELDS) {
    const a = cleanAnswer(g[f]);
    const b = cleanAnswer(o[f]);
    if (a.value == null && b.value == null) continue; // nobody claims anything: omit silently
    if (a.value == null || b.value == null || a.value !== b.value) {
      rejected.push({ field: f, reason: 'models disagree', gemini: a.value, openai: b.value });
      continue;
    }
    if (!a.quote || !b.quote) { rejected.push({ field: f, reason: 'no quote' }); continue; }
    const ua = urlOf(a.quote);
    const ub = urlOf(b.quote);
    if (!ua || !ub) { rejected.push({ field: f, reason: 'quote not found in the official page text' }); continue; }
    if (!TOPIC[f].test(a.quote) || !TOPIC[f].test(b.quote)) { rejected.push({ field: f, reason: 'quote is off topic' }); continue; }
    access[f] = a.value;
    // Keep the shorter of the two verified quotes as the audit record.
    const [q, url] = a.quote.length <= b.quote.length ? [a.quote, ua] : [b.quote, ub];
    evidence[f] = { quote: q.slice(0, 400), url };
  }

  // Note: a verbatim sentence from the page that both models picked out, shorter one wins.
  const na = typeof g.note === 'string' ? g.note.trim() : '';
  const nb = typeof o.note === 'string' ? o.note.trim() : '';
  if (na && nb && quoteInText(na, pages.map((p) => p.text).join(' ')) && quoteInText(nb, pages.map((p) => p.text).join(' '))) {
    const note = (na.length <= nb.length ? na : nb);
    if (note.length <= MAX_NOTE && NOTE_TOPIC.test(note) && Object.keys(access).length) {
      access.note = note;
      evidence.note = { quote: note, url: urlOf(note) };
    }
  }
  // Nothing agreed on a flag: a bare note would float free of any fact, so drop it.
  if (!FIELDS.some((f) => f in access)) return { access: {}, evidence: {}, rejected };
  return { access, evidence, rejected };
}

/** Strip a page's HTML to plain text (scripts, styles and tags removed, entities decoded). */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;|&#39;|&apos;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

const ACCESS_LINK = /access|disab|wheelchair|a11y|inclusiv|plan-your-visit|visit-us|your-visit|know-before|getting-here|visitor|faq|hearing|sensory|relaxed/i;

/** Same-site links on a homepage that look like access or visitor-information pages. */
function accessLinks(html, baseUrl, max = 4) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const seen = new Set();
  const scored = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|docx?|zip)$/i.test(u.pathname)) continue;
    const label = htmlToText(m[2]);
    const hay = `${u.pathname} ${label}`;
    if (!ACCESS_LINK.test(hay)) continue;
    const key = u.origin + u.pathname.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    // Pages that say "access" outrank general visitor pages.
    const score = (/access|disab|wheelchair|a11y/i.test(hay) ? 2 : 0) + (/visit|know-before|getting/i.test(hay) ? 1 : 0);
    scored.push({ url: key, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.url);
}

/**
 * A seat-view page counts as that venue's own page only when its title names the venue and
 * is not a search / index / not-found page.
 */
function titleNamesVenue(title, venueName) {
  const t = normalize(title);
  if (!t || /not found|404|just a moment|security check|search results|^search|page not found|access denied/.test(t)) return false;
  const stop = new Set(['the', 'theatre', 'theater', 'of', 'and', 'at']);
  const words = normalize(venueName).split(' ').filter((w) => w.length > 1 && !stop.has(w));
  if (!words.length) return false;
  return words.every((w) => t.includes(w));
}

module.exports = { FIELDS, TOPIC, normalize, quoteInText, agreeAccess, htmlToText, accessLinks, titleNamesVenue };
