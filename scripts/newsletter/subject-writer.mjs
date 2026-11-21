// AI subject lines for the weekly newsletter (owner, 2026-11-08, BRO-7168).
//
// The template subjects read like a database ("Speculations opens to rough
// reviews, The Bridge opens to strong reviews.", "8 shows open in London, with
// three scoring over 80 with critics") and opened every issue the same way.
// Owner chose option A: the system writes the subject, preview text and
// opening paragraph like an editor, picks the best, and the owner's [DRAFT]
// preview lists the runners-up to swap in by hand.
//
// Same shape as social-autopost/ai-captions.js (BRO-6959):
//   1. generate.mjs builds a fact sheet of THIS issue (only shows the email
//      renders, including well-reviewed shows closing soon whatever week they
//      opened: owner, 2026-11-08).
//   2. Claude writes several candidates, each from a different angle.
//   3. Code checks each one: length, banned template phrasing, every number and
//      weekday must be in the facts, no repeat of recent subjects.
//   4. GPT-5.5 fact-checks the survivors against the sheet.
//   5. Claude ranks what is left; the best goes in the draft, two more become
//      alternates.
// Any failure returns null and generate.mjs keeps its template subject, so a
// draft is never held up. Kill switch: NEWSLETTER_AI_SUBJECT_DISABLED=true.
//
// Pure except for the two network calls, which tests replace via deps.
import '../lib/llm-usage-install.js'; // LLM spend meter: keep it the first import (BRO-5043)
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { SOCIAL_WRITER, GPT55 } = require_('../lib/models.js');
const { finalResponseText, firstJsonObject } = require_('../lib/anthropic-response-text.js');
const { callWithTimeout } = require_('../lib/llm-call-budget.js');
const { foldDiacritics } = require_('../lib/title-match.js');

export const SUBJECT_MAX = 60;      // phones show about 40; hard stop at 60
export const PREHEADER_MAX = 110;
export const LEDE_MAX = 380;
const CALL_MS = 90000;
const MAX_ROUNDS = 2;               // one rewrite with the problems listed
const DEADLINE_MS = 4 * 60 * 1000;  // whole pass; the draft job has 25 minutes

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// First sentence of a lede. Does not split after an abbreviation ("St. Ann's
// Warehouse", "Ms. Blakk for President"), which would cut the sentence before
// its Critic Score and reject a good lede (ship-check, 2026-11-15).
export function firstSentence(text) {
  return String(text || '').split(/(?<!\b(?:St|Mr|Ms|Mrs|Dr|Mt|Jr|Sr|vs|No|Co|Inc|Ltd)\.)(?<=[.!?])\s+/)[0] || '';
}

// Phrasing the template used, plus AI tells. Any hit rejects the candidate.
const BANNED = [
  [/[–—]|\s-\s|--/, 'a dash used as punctuation'],
  [/\p{Extended_Pictographic}/u, 'an emoji'],
  [/["“”]/, 'a quotation mark'],
  [/\bopens? to (?:rave|strong|solid|decent|mixed|rough|poor|warm|glowing|positive|negative) reviews\b/i, 'the template phrase "opens to X reviews"'],
  [/\bwith critics\b/i, 'the template phrase "with critics"'],
  [/\b(?:big|busy|packed|huge|bumper) week\b/i, 'a week-size claim (generate.mjs decides those)'],
  [/\bscor(?:ing|ed) (?:\d+ )?(?:or )?(?:higher|more|over|above)\b/i, 'a score band ("scoring 75 or higher")'],
  [/\b(?:reviews|verdict|votes|results) (?:are|is) in\b/i, 'a stock opener ("the reviews are in")'],
  [/\b(?:you won'?t believe|must[- ]see|don'?t miss|act now|hurry|breaking)\b/i, 'clickbait'],
  [/\b(?:delve|robust|leverage|unlock|tapestry|realm|landscape|navigate|deep dive|buckle up|game[- ]changer|truly|genuinely|moreover|furthermore|additionally)\b/i, 'an AI-sounding word'],
  [/\bit'?s not\b[^.]{0,60}\bit'?s\b|\bnot (?:just )?\w+(?: \w+)?, but\b/i, 'the "not X, but Y" construction'],
  // The Critic Score is the product, not our tier label (owner, 2026-11-15:
  // "Cloud 9 (77) is Recommended from 33 reviews" and "Dogstar gets a Mixed 64").
  // Titles are stripped before this runs, so a show called "Mixed Feelings" is safe.
  [/\b(?:Recommended|Critical Gold|Critical Miss|Worth Seeing)\b|\bMixed\s*\(?\d|\bmixed\s+\d{2,3}\b/, 'one of our tier labels (Recommended, Worth Seeing, Mixed, Critical Gold or Miss); state the Critic Score number instead'],
  [/\brecommend(?:s|ed|ing|ation|ations)?\b/i, 'the word "recommend" standing in for the score; state the Critic Score number instead'],
  [/!/, 'an exclamation mark'],
  // The send day moves (late owner sends, recovery runs): name the weekday.
  [/\b(?:today|tonight|tomorrow|yesterday|this weekend|next weekend|this morning|this evening)\b/i, 'a relative date (name the weekday instead)'],
];

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const DATE_RE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`, 'g');

/** Calendar dates a text names ("Nov 14", "14 November"), as "M-D"-ish keys. */
export function datesIn(text) {
  return [...String(text || '').matchAll(DATE_RE)].map(m => `${(m[0].match(/[A-Za-z]{3}/) || [''])[0].toLowerCase()}|${Number(m[1] || m[2])}`);
}

/** Every number a text states outside dates, as exact strings ("2.35", "13", "83"). */
export function numbersIn(text) {
  const t = String(text || '').replace(DATE_RE, ' ')
    .replace(/\b(?:no one|one of|one another|one critic|one more|the one|one show|one to)\b/gi, ' ');
  const out = (t.match(/\d+(?:\.\d+)?/g) || []).map(n => String(Number(n)));
  for (const m of t.matchAll(new RegExp(`\\b(${ONES.join('|')})\\b`, 'gi'))) out.push(String(ONES.indexOf(m[1].toLowerCase())));
  return out;
}

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Remove whole-title mentions (word boundaries, so "Tru" never eats "Truly"). */
function stripTitles(text, titles) {
  let out = String(text || '');
  for (const t of [...titles].sort((x, y) => y.length - x.length)) {
    if (!t) continue;
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(t)}(?![\\p{L}\\p{N}])`, 'gu'), '$1 ');
  }
  return out;
}
const mentions = (text, title) => !!title && new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(title)}(?![\\p{L}\\p{N}])`, 'u').test(String(text || ''));

const weekdaysIn = (text) => WEEKDAYS.filter(d => new RegExp(`\\b${d}s?\\b`, 'i').test(String(text || '')));
const words = (t) => new Set(foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(w => w.length > 2));
function jaccard(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}
const firstWords = (t, n = 2) => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().split(/\s+/).slice(0, n).join(' ');

/**
 * The fact pool behind one issue.
 * @param {{edition: 'broadway'|'west-end', lines: string[], titles: Array<{id, slug, title}>}} facts
 *   lines are complete, true sentences built by generate.mjs from data the
 *   email renders; titles are the shows those lines name.
 */
/** A title plus its short forms: "School Girls; Or, The African Mean Girls Play" -> also "School Girls". */
export function titleForms(title) {
  const t = String(title || '').trim();
  const short = t.split(/\s*[:;(]\s*|\s+-\s+/)[0].trim();
  return short && short !== t && short.length >= 4 ? [t, short] : [t];
}

export function buildPool(facts) {
  const sheet = facts.lines.map(l => `- ${l}`).join('\n');
  const titleNames = facts.titles.flatMap(t => titleForms(t.title));
  // Show lines only: the coverage-dates line would vouch for any weekday.
  const showLines = facts.lines.filter(l => titleNames.some(t => mentions(l, t))).join('\n');
  const bare = stripTitles(sheet, titleNames);
  return {
    sheet,
    numbers: new Set(numbersIn(bare)),
    // Critic Scores the facts state ("Critic Score 77/100"): a subject that
    // names a show must carry one of them.
    scoreNumbers: new Set([...facts.lines.join('\n').matchAll(/Critic Score (\d{1,3})\/100/g)].map(m => String(Number(m[1])))),
    dates: new Set(datesIn(bare)),
    weekdays: new Set(weekdaysIn(stripTitles(showLines, titleNames))),
    titles: facts.titles,
    // Every show title the site knows (generate.mjs passes them): naming one
    // that is not in the facts rejects the candidate.
    // A known title that sits inside one of this email's titles ("Mean Girls"
    // in "School Girls; Or, The African Mean Girls Play") is not another show.
    otherTitles: (facts.knownTitles || []).filter(t => t && t.length >= 4 && !titleNames.includes(t)
      && !facts.titles.some(x => mentions(x.title, t))),
    titleNames,
    // This week's primary-market openings, the roundup's main story (owner,
    // 2026-11-09). When there are any, the subject and the first sentence of
    // the opening paragraph must be about them.
    leadTitles: (facts.leadTitles || []).flatMap(t => titleForms(t)),
    // The edition's main-market openings (Broadway / West End). When there are
    // any, the lede leads with one, never with an off-market show (owner, 2026-11-15).
    topLeadTitles: (facts.topLeadTitles || []).flatMap(t => titleForms(t)),
    edition: facts.edition,
    // Venues, critics and outlets the facts name: the cards already show the
    // venue, and the lede is not the place for a critic (owner, 2026-11-15).
    venueNames: [...new Set(facts.lines.flatMap(l => [...l.matchAll(/(?:^|[ ,])at ([A-Z][^,.]*?)(?:, opened|\. |\.$|, [a-z])/g)].flatMap(m => m[1].split('/')).map(v => v.trim()).filter(v => v.length >= 5)))],
    criticNames: [...new Set(facts.lines.flatMap(l => [...l.matchAll(/(?:Rave|Pan) of the week: our score for (.+?) \((.+?)\)'s review of /g)].flatMap(m => [m[1], m[2]])))].filter(n => n.trim().toLowerCase() !== 'a critic'),
  };
}

/**
 * Detail the show cards below the lede already carry (owner, 2026-11-15: "we
 * already say the theater and the date it opened, that's not editorial"). The
 * lede is the voice: a score, a verdict, a point of view. Returns the reasons a
 * lede repeats card detail; empty means it does not.
 */
export function cardDetailRepeats(lede, { venues = [], critics = [] } = {}) {
  const t = String(lede || '');
  const why = [];
  // "opened at <Place>" / "opened on <day>" / "opened Nov 9", past tense only: "opens at 77/100"
  // is a score, and "opens Monday" is an upcoming show, neither is card detail.
  if (/\b(?:opened|premiered)\s+(?:at|in)\s+(?:the\s+)?[A-Z]/.test(t) || /\b(?:opened|premiered)\s+(?:on\s+)?(?:(?:this|last)\s+)?(?:Mon|Tues?|Wednes|Thurs?|Fri|Satur|Sun)(?:day)?\b/i.test(t)
    || /\b(?:opened|premiered)\s+(?:on\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b/.test(t)) why.push('says where or when a show opened; the cards show that');
  if (/\bat (?:the )?[A-Z][\w'.&-]*(?: [A-Z][\w'.&-]*)* (?:Theatre|Theater|Playhouse|Horizons|Center|Centre|Hall|House|Rep)\b/.test(t)) why.push('names a theatre; the cards show that');
  const v = venues.find(x => x && t.includes(x));
  if (v) why.push(`names a venue (${v}); the cards show that`);
  if (/\b(?:gave|gives|give|giving|awarded|awards|handed)\b[^.]{0,60}?\b\d{1,3}(?: out of 100|\/100)/i.test(t)
    || /\b(?:critics?|reviewers?)\b[^.]{0,40}\b(?:gave|gives|awarded|rated)\b[^.]{0,30}\b\d{2,3}\b/i.test(t)) why.push("says a critic gave a score; the Critic Score is ours, critics do not give one");
  // The cards carry the critic count; the lede is the voice (owner, 2026-11-15).
  if (/\b\d{1,3}\s+(?:critics|reviews|reviewers)\b/i.test(t)) why.push('states a review or critic count; the cards show that');
  const c = critics.find(x => x && t.includes(x));
  if (c) why.push(`names a critic or outlet (${c}); keep to our Critic Score`);
  return why;
}

/** Everything code can check about one candidate. Empty means it passed. */
export function checkCandidate(c, pool, recent = []) {
  const p = [];
  if (!c || typeof c.subject !== 'string' || typeof c.preheader !== 'string' || typeof c.lede !== 'string') return ['not {"angle", "subject", "preheader", "lede"}'];
  const subject = c.subject.trim(), pre = c.preheader.trim(), lede = c.lede.trim();
  if (subject.length < 15 || subject.length > SUBJECT_MAX) p.push(`subject is ${subject.length} characters; keep it 15 to ${SUBJECT_MAX} (30 to 50 is best)`);
  if (pre.length < 30 || pre.length > PREHEADER_MAX) p.push(`preheader is ${pre.length} characters; keep it 30 to ${PREHEADER_MAX}`);
  if (lede.length < 80 || lede.length > LEDE_MAX) p.push(`lede is ${lede.length} characters; keep it 80 to ${LEDE_MAX}`);
  for (const [field, text] of [['subject', subject], ['preheader', pre], ['lede', lede]]) {
    // Titles out first: a dash, "!" or number inside a title ("Iphigenie en
    // Tauride - English National Opera", "2:22") is not our prose.
    const body = stripTitles(text, pool.titleNames || pool.titles.map(t => t.title));
    for (const [re, what] of BANNED) if (re.test(body)) p.push(`${field} contains ${what}`);
    const stray = [...new Set(numbersIn(body).filter(n => !pool.numbers.has(n)))];
    if (stray.length) p.push(`${field} has numbers that are not in the facts: ${stray.join(', ')}`);
    const badDates = datesIn(body).filter(d => !pool.dates.has(d));
    if (badDates.length) p.push(`${field} names a date the facts do not`);
    const others = (pool.otherTitles || []).filter(t => mentions(body, t));
    if (others.length) p.push(`${field} names a show that is not in this email: ${others.slice(0, 3).join(', ')}`);
    const days = weekdaysIn(body).filter(d => !pool.weekdays.has(d));
    if (days.length) p.push(`${field} names a day the facts do not: ${days.join(', ')}`);
  }
  for (const why of cardDetailRepeats(lede, { venues: pool.venueNames, critics: pool.criticNames })) p.push(`lede ${why}`);
  const leads = pool.leadTitles || [];
  if (leads.length) {
    const namesLead = (t) => leads.some(l => mentions(t, l));
    if (!namesLead(subject) && !/\b(?:open(?:s|ed|ing|ings)?|premieres?|debuts?|new shows?)\b/i.test(subject)) {
      p.push("subject must be about this week's openings (name one, or say how the openings went); closings and other news go in the preview text or later in the paragraph");
    }
    const first = firstSentence(lede);
    if (!namesLead(first)) p.push("the opening paragraph's first sentence must name one of this week's openings");
    const tops = pool.topLeadTitles || [];
    if (tops.length) {
      const namesTop = (t) => tops.some(l => mentions(t, l));
      const mainMkt = pool.edition === 'west-end' ? 'West End' : 'Broadway';
      if (!namesTop(first)) p.push(`the opening paragraph must lead with a ${mainMkt} opening (${[...new Set(tops)].slice(0, 3).join(', ')}), not an off-market show`);
      if (namesLead(subject) && !namesTop(subject)) p.push(`a subject that names an opening must name a ${mainMkt} one, not an off-market show`);
    }
  }
  // Score first: a subject that names a show leads with its Critic Score
  // ("Cloud 9 lands at a solid 77/100 from 33 critics"). Group subjects that
  // name no show ("Four London openings, one standout") are exempt.
  if (pool.scoreNumbers && pool.scoreNumbers.size && (pool.titleNames || []).some(t => mentions(subject, t))) {
    const subjNums = numbersIn(stripTitles(subject, pool.titleNames || []));
    if (!subjNums.some(n => pool.scoreNumbers.has(n))) p.push("a subject that names a show must state that show's Critic Score number (e.g. 77/100)");
  }
  if (lede.length >= 80) {
    const first = firstSentence(lede);
    if (pool.scoreNumbers && pool.scoreNumbers.size && (pool.titleNames || []).some(t => mentions(first, t))
      && !numbersIn(stripTitles(first, pool.titleNames || [])).some(n => pool.scoreNumbers.has(n))) {
      p.push("the opening paragraph's first sentence names a show, so it must give that show's Critic Score number");
    }
  }
  if (jaccard(subject, pre) > 0.5) p.push('preheader repeats the subject; it should add the next thing a reader wants to know');
  for (const r of recent) {
    if (!r) continue;
    if (firstWords(subject) === firstWords(r)) p.push(`subject starts like a recent one ("${r}")`);
    else if (jaccard(subject, r) > 0.5) p.push(`subject is too close to a recent one ("${r}")`);
  }
  return p;
}

export function writerPrompt(pool, { recent = [], feedback = null, count = 6 } = {}) {
  const brand = pool.edition === 'west-end' ? 'West End Scorecard (London theatre)' : 'Broadway Scorecard (New York theatre)';
  return `You write the subject line, inbox preview text and opening paragraph for this week's ${brand} email newsletter. Subscribers are theatregoers deciding what to see. Never say today, tonight, tomorrow or this weekend: the send day can move, so name the weekday the facts give.

This is the weekly opening-night roundup. Its main story is THIS WEEK'S OPENINGS and how critics received them.${pool.leadTitles && pool.leadTitles.length ? ` Every subject line must be about this week's openings (lines starting "Opening:" that say "opened this week" in the ${pool.edition === 'west-end' ? 'West End or Off West End' : 'Broadway or Off-Broadway'}), and the opening paragraph must start with them.` : ''} A Broadway (or West End) opening outranks an Off-Broadway (or Off West End) one; a widely reviewed show outranks a thinly reviewed one. Closings, the rave and pan, box office and what's coming next are supporting news: use them in the preview text or later in the paragraph, never as the lead${pool.leadTitles && pool.leadTitles.length ? '' : ' unless the week had no openings'}.

Write ${count} candidates, each from a DIFFERENT angle on the openings: the best-reviewed opening, the most-talked-about opening, the split verdict, the surprise, the flop, a perfect or record score, a famous title or name, how the week's openings went as a group.

Rules:
1. Every claim, number, name and day must come from the facts below. Don't round, don't embellish, don't add context the facts don't give. Opinions belong to critics ("critics loved it"), never to us.
2. Subject: 30 to 50 characters is best, never over ${SUBJECT_MAX}. One story. Sound like a friend who reads every review, not a database. Specific beats clever. Name a show when it helps.
   THE CRITIC SCORE IS THE STAR. It is our own number, 0 to 100, built from every critic's review. Lead with it as "77/100 from 33 critics" (the critic count belongs in the subject only, never in the opening paragraph). Never use our tier labels (Recommended, Worth Seeing, Mixed, Critical Gold, Critical Miss) and never write "recommended" or "recommend": the label is not the news, the number is. You may add ONE plain word that fits the number (solid for the 70s, strong for the 80s, exceptional for 90+, middling for the 60s, weak below 55). A subject that names a show must carry that show's score. Good: "Cloud 9 lands at a solid 77/100 from 33 critics". "Hamlet Hail to the Thief hits 78/100 from 26 critics". Bad: "Critics recommend Cloud 9", "Dogstar gets a Mixed 64", "Cloud 9 (77) is Recommended from 33 reviews".
3. Preview text (shown after the subject in the inbox): 40 to ${PREHEADER_MAX} characters. It adds the next thing a reader wants to know; never repeat the subject.
4. Opening paragraph: the editorial voice, 2 or 3 short sentences, like a friend telling you what happened this week. Lead with the Critic Score as a number out of 100, then say what it means or what stood out. Do NOT give the number of critics or reviews: the cards show it. Lead with the edition's main-market opening (Broadway or West End) whenever one opened this week, never an Off-Broadway or Off West End show. Scores are OURS: never say a critic or reviewer "gave", "awarded" or "rated" a show a score. If a critic matters, name no critic: say the show "scores" or "lands at" a number. The show cards below it already show every theatre, opening date, score and critic count, so NEVER repeat venues, opening dates or days of the week for an opening ("opened at the Lyttelton Theatre on Tuesday"), and never name a critic or outlet or quote a critic's score. Use plain words and contractions; no stiff phrases like "the only Broadway opening this week" or "the most of any". Good: "Cloud 9 lands at a solid 77/100, the best of a quiet week. Dogstar trails at 64." Bad: "Cloud 9 opened at the Lyttelton Theatre on Tuesday and scores 77/100 from 33 critics, the most of any London opening this week." Bad: "The pan of the week went to Nero, which a critic gave 13 out of 100." Later mentions can use parentheses, e.g. The Bridge (76). Do not describe a score with a tier label.
5. Never use: "opens to X reviews", "with critics", "big/busy/packed week", "scoring 75 or higher", "the reviews are in", dashes as punctuation, quotation marks, exclamation marks, emoji, clickbait, "not X, but Y".
6. Vary the shape between candidates: a statement, a verdict, a score-first line, a question only if it is specific.
${recent.length ? `\nRecent subject lines. Do not resemble these in wording, shape or opening words:\n${recent.map(r => `- ${r}`).join('\n')}\n` : ''}
FACTS:
${pool.sheet}
${feedback ? `\nYour previous candidates were rejected for these reasons. Fix every one:\n${feedback.map(f => `- ${f}`).join('\n')}\n` : ''}
Reply with only a JSON object: {"candidates": [{"angle": "<short angle name>", "subject": "...", "preheader": "...", "lede": "..."}]}`;
}

export function checkerPrompt(pool, c) {
  return `You fact-check a newsletter's subject line, preview text and opening paragraph against the facts they were written from. The facts are correct by definition. Flag any claim, number, name, day, ranking or comparison the facts do not support, including small embellishments ("sold out", "every critic", "the best of the year", "closes tomorrow" when the facts give a weekday). Flag an opinion stated as the newsletter's own rather than the critics'. One plain word describing a Critic Score is allowed (solid for the 70s, strong for the 80s, exceptional for 90+, middling for the 60s, weak below 55). "From N critics" is the same fact as "from N reviews". Do not flag style, tone or omissions.

FACTS:
${pool.sheet}

SUBJECT: ${c.subject}
PREVIEW: ${c.preheader}
OPENING: ${c.lede}

Reply with only a JSON object: {"supported": true|false, "problems": ["<each unsupported claim and why>"]}`;
}

export function judgePrompt(pool, cands) {
  return `You are the editor of a theatre newsletter choosing this week's subject line. This is the weekly opening-night roundup, so this week's openings are the story; prefer candidates that lead with them. Rank these candidates by how likely a theatregoer is to open the email AND feel it was worth it: a clear, specific reason to open now, natural human voice, short enough for a phone, honest. Penalize anything vague, generic, mechanical or that oversells.

FACTS (for context):
${pool.sheet}

CANDIDATES:
${cands.map((c, i) => `${i}. SUBJECT: ${c.subject}\n   PREVIEW: ${c.preheader}`).join('\n')}

Reply with only a JSON object: {"ranking": [<candidate numbers, best first>], "why": "<one sentence on the winner>"}`;
}

async function postJson(url, body, headers, ms, label) {
  return callWithTimeout(async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const txt = await res.text();
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`); // status only: error bodies can echo key fragments
    return JSON.parse(txt);
  }, ms + 5000, label);
}

async function claude(prompt, env = process.env) {
  const j = await postJson('https://api.anthropic.com/v1/messages', { model: SOCIAL_WRITER, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] },
    { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, CALL_MS, 'Claude');
  const json = firstJsonObject(finalResponseText(j.content));
  if (!json) throw new Error(`Claude: no JSON in reply (stop_reason ${j.stop_reason})`);
  return JSON.parse(json);
}

async function gptChecker(prompt, env = process.env) {
  const j = await postJson('https://api.openai.com/v1/responses', { model: GPT55, input: prompt, reasoning: { effort: 'low' } },
    { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, CALL_MS, 'GPT checker');
  const text = (j.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []).map(c => c.text || '').join('');
  const json = firstJsonObject(text);
  if (!json) throw new Error('GPT checker: no JSON in reply');
  const v = JSON.parse(json);
  if (typeof v.supported !== 'boolean') throw new Error('GPT checker: reply has no "supported" field');
  return { supported: v.supported, problems: Array.isArray(v.problems) ? v.problems.map(String) : [] };
}

/** Why the AI writer is off for this run, or null when it may run. */
export function aiSubjectDisabledReason(env = process.env) {
  if (/^(1|true|yes)$/i.test(env.NEWSLETTER_AI_SUBJECT_DISABLED || '')) return 'NEWSLETTER_AI_SUBJECT_DISABLED';
  if (env.SUBJECT_OVERRIDE || env.LEDE_OVERRIDE) return 'hand-written SUBJECT_OVERRIDE / LEDE_OVERRIDE';
  if (!env.ANTHROPIC_API_KEY) return 'no ANTHROPIC_API_KEY';
  if (!env.OPENAI_API_KEY) return 'no OPENAI_API_KEY (subjects are never used unchecked)';
  return null;
}

/** Shows (from the pool) a text names, for the lede-in-body gate. */
export function showsNamed(text, pool) {
  return pool.titles.filter(t => titleForms(t.title).some(f => mentions(text, f))).map(({ id, slug, title }) => ({ id, slug, title }));
}

/**
 * Reuse a subject written earlier for this same issue when it still passes
 * every code check against today's facts (the Sunday refresh must not
 * replace what the owner already previewed). Returns it, or null.
 */
export function reusable(prev, facts) {
  if (!prev || !prev.subject || !prev.lede) return null;
  try {
    const pool = buildPool(facts);
    if (checkCandidate(prev, pool, []).length) return null;
    return { ...prev, showRefs: showsNamed(`${prev.subject} ${prev.preheader} ${prev.lede}`, pool), reused: true, alternates: prev.alternates || [] };
  } catch { return null; }
}

/**
 * @returns {Promise<null | {subject, preheader, lede, angle, why, alternates: Array<{subject, preheader, angle}>, attempts, rejected: number}>}
 *   null on any failure or when nothing survives; never throws.
 */
export async function writeSubject(facts, { recent = [], deps = {}, log = () => {} } = {}) {
  const write = deps.writer || claude, check = deps.checker || gptChecker, judge = deps.judge || claude;
  let pool;
  try { pool = buildPool(facts); } catch (e) { log(`[subject-writer] fact pool: ${e.message}`); return null; }
  if (!pool.titles.length) return null; // no show facts, nothing to write about
  const deadline = Date.now() + (deps.deadlineMs || DEADLINE_MS);
  const late = () => Date.now() > deadline;
  let feedback = null, attempts = 0, rejected = 0;
  try {
    while (attempts < MAX_ROUNDS) {
      if (late()) { log('[subject-writer] out of time'); return null; }
      attempts++;
      const reply = await write(writerPrompt(pool, { recent, feedback }));
      const cands = (Array.isArray(reply && reply.candidates) ? reply.candidates : [])
        .map(c => ({ angle: String(c.angle || ''), subject: String(c.subject || '').trim(), preheader: String(c.preheader || '').trim(), lede: String(c.lede || '').trim() }));
      if (late()) { log('[subject-writer] out of time'); return null; }
      const problemsAll = [];
      const passed = [];
      // Code checks first, then GPT on the survivors in parallel. A checker
      // error rejects that candidate only.
      const results = await Promise.all(cands.map(async (c) => {
        let problems = checkCandidate(c, pool, recent);
        if (!problems.length) {
          try {
            const v = await check(checkerPrompt(pool, c));
            if (!v.supported || v.problems.length) problems = v.problems.length ? v.problems.map(x => `fact check: ${x}`) : ['fact check: unsupported'];
          } catch (e) { problems = [`fact check failed: ${String(e.message || e).slice(0, 80)}`]; }
        }
        return { c, problems };
      }));
      for (const { c, problems } of results) {
        if (problems.length) { rejected++; problemsAll.push(`"${c.subject}": ${problems.join('; ')}`); log(`[subject-writer] rejected "${c.subject}": ${problems.join(' | ')}`); }
        else passed.push(c);
      }
      if (passed.length) {
        let order = passed.map((_, i) => i), why = '';
        if (passed.length > 1 && !late()) {
          try {
            const r = await judge(judgePrompt(pool, passed));
            const rank = (Array.isArray(r && r.ranking) ? r.ranking : []).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < passed.length);
            order = [...new Set([...rank, ...order])];
            why = String((r && r.why) || '');
          } catch (e) { log(`[subject-writer] judge failed, keeping writer order: ${e.message}`); }
        }
        const ranked = order.map(i => passed[i]);
        const best = ranked[0];
        return {
          subject: best.subject, preheader: best.preheader, lede: best.lede, angle: best.angle, why,
          alternates: ranked.slice(1, 3).map(({ subject, preheader, angle }) => ({ subject, preheader, angle })),
          showRefs: showsNamed(`${best.subject} ${best.preheader} ${best.lede}`, pool),
          attempts, rejected,
        };
      }
      feedback = problemsAll.slice(0, 12);
    }
    log('[subject-writer] no candidate passed; keeping the template subject');
    return null;
  } catch (e) {
    log(`[subject-writer] ${String(e.message || e).slice(0, 200)}; keeping the template subject`);
    return null;
  }
}
