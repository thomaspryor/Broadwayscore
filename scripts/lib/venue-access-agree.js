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
// Narrow on purpose (BRO-8112 review): "hearing" or "loop" alone must not prove an assistive
// listening claim, "lift" alone must not prove step-free, bare "accessible" must not prove wheelchair.
const TOPIC = {
  wheelchair: /wheelchair|step[- ]?free|level access|ramp|mobility|\bada\b|accessible (seat|space|entrance|toilet|bay|place)/i,
  stepFree: /step[- ]?free|level access|no steps|ramp|stair[- ]?free|without (any )?steps/i,
  elevator: /\blifts?\b|elevators?/i,
  hearingLoop: /loop|induction|t[- ]?coil|telecoil/i,
  assistiveListening: /assistive|infra-?red|listening|headset|headphone|receiver|captio|amplif|hearing|loop|induction/i,
};
// A denial ("No assistive listening") is held to a stricter topic than a yes: a loop being absent says
// nothing about infra-red or headset systems, so only a quote about assistive listening itself may deny it.
const TOPIC_DENY = { assistiveListening: /assistive|infra-?red|listening|headset|headphone|receiver|captio|amplif/i };

// A "no lift" that is only about one level, or a loop that is only in the foyer / box office,
// says nothing about the building as a whole: do not turn it into a flat yes or no.
const PARTIAL = {
  elevator: /\b(to|up to|access to|reach)\s+(the\s+)?(circle|balcony|gallery|upper|bar|first|second|third|fourth|floor|level|dress|grand|studio|rehearsal|offices?|roof)/i,
  hearingLoop: /box office|foyer|kiosk|\bbar\b|reception|portable|neck[- ]?loop|personal|on request|upon request|available to (borrow|request)/i,
};
// A yes for step-free or lift that is scoped to one area (foyer, bar, studio, one row, car park) does not
// tell a visitor they can reach the auditorium, unless the same quote also says all levels / the auditorium.
const PARTIAL_YES = /\b(car park|foyer|bars?|caf[eé]|restaurant|toilets?|box office|studio|cinema|roof garden|rehearsal|offices?|row [a-z]\b|limited|only|some|several|certain|first two rows|freight|by request)\b/i;
const COVERS_ALL = /all (levels|floors|areas|spaces|3 levels)|each (floor|level)|every (floor|level)|throughout|auditorium|\bstalls\b|to the (theatre|theater)\b/i;
const WHOLE_VENUE = /auditorium|theatre|theater|stalls|performance|seating|seats/i;
const NEGATION_BEFORE = /\b(no|not|cannot|without|nor|never|isn t|aren t|don t|doesn t|unable)\s*$/;

const MAX_NOTE = 240;
// The page note must itself be about access, not a slogan.
// Concrete access wording only: slogans ("aims to be as accessible as possible") and plain seating
// descriptions do not qualify as a note.
const NOTE_TOPIC = /wheelchair|step[- ]?free|level access|ramp|accessib|\bada\b|disabled|mobility|\blifts?\b|elevator|hearing|loop|induction|infra-?red|assistive|listening|captio/i;
// Slogans, promotion and pointers are not facts, whatever access word they contain.
const NOTE_SLOGAN = /\b(aims?|aspires?|strives?|committed|commitment|proud|voted|award|believe|pride|welcoming|inclusive|inclusion|everyone|all visitors|contact|please|learn more|visit our|details about|questions|range of|variety of)\b/i;

/** Lowercase, strip accents/punctuation, collapse whitespace: the form quotes are compared in. */
function normalize(t) {
  return String(t || '')
    // The raw checkpoint stores emails as [email] (public-repo PII lint), so compare both forms alike.
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, ' email ')
    .replace(/\[email\]/g, ' email ')
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

/** True when the 1-3 words right before the quote's first occurrence in text are a negation. */
function negatedInText(quote, text) {
  const q = normalize(quote);
  const hay = ` ${normalize(text)} `;
  const at = hay.indexOf(` ${q} `);
  if (at < 0) return false;
  const before = hay.slice(0, at).trim().split(' ').slice(-1).join(' ');
  return NEGATION_BEFORE.test(before + ' ') || NEGATION_BEFORE.test(before);
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
    const topic = a.value === false && TOPIC_DENY[f] ? TOPIC_DENY[f] : TOPIC[f];
    if (!topic.test(a.quote) || !topic.test(b.quote)) { rejected.push({ field: f, reason: 'quote is off topic' }); continue; }
    const texts = pages.map((p) => p.text).join(' ');
    // A yes whose quote sits right after "no" / "not" in the page is a cut-off negation.
    if (a.value === true && (negatedInText(a.quote, texts) || negatedInText(b.quote, texts))) { rejected.push({ field: f, reason: 'quote follows a negation' }); continue; }
    // A partial claim (one floor, box office only, loop on request) is not a whole-venue fact.
    const partial = (q) => {
      if ((f === 'elevator' || f === 'stepFree') && a.value === true && PARTIAL_YES.test(q) && !COVERS_ALL.test(q)) return true;
      if (f === 'elevator') return PARTIAL.elevator.test(q);
      if (f === 'hearingLoop') return a.value === false ? PARTIAL.hearingLoop.test(q) || /\b(but|however)\b/i.test(q) : PARTIAL.hearingLoop.test(q) && !WHOLE_VENUE.test(q);
      return false;
    };
    if (partial(a.quote) || partial(b.quote)) { rejected.push({ field: f, reason: 'quote is about part of the venue, not the whole building' }); continue; }
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
    // A note that talks about a feature the flags deny would contradict the pill next to it.
    const affirmative = !/\b(no|not|cannot|unfortunately|regret|only|except|unable)\b/i.test(note);
    const contradicts = affirmative && FIELDS.some((f) => access[f] === false && TOPIC[f].test(note));
    const noteUrl = urlOf(note);
    if (note.length <= MAX_NOTE && NOTE_TOPIC.test(note) && !NOTE_SLOGAN.test(note) && Object.keys(access).length && !contradicts && noteUrl) {
      access.note = note;
      evidence.note = { quote: note, url: noteUrl };
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

module.exports = { FIELDS, TOPIC, PARTIAL, PARTIAL_YES, COVERS_ALL, normalize, quoteInText, negatedInText, agreeAccess, htmlToText, accessLinks, titleNamesVenue };
