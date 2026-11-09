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
export const LEDE_MAX = 650;
const CALL_MS = 90000;
const MAX_ROUNDS = 2;               // one rewrite with the problems listed
const DEADLINE_MS = 4 * 60 * 1000;  // whole pass; the draft job has 25 minutes

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Phrasing the template used, plus AI tells. Any hit rejects the candidate.
export const BANNED = [
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
    edition: facts.edition,
  };
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

Write ${count} candidates, each from a DIFFERENT angle. Angles to consider: last chance (a well-reviewed show closing soon, whenever it opened), the one to book, the split verdict, the surprise, the flop everyone was talking about, a perfect or record score, a famous title or name, what's coming next. Pick the angles the facts make strongest; a great show closing in a few days usually beats a count of openings.

Rules:
1. Every claim, number, name and day must come from the facts below. Don't round, don't embellish, don't add context the facts don't give. Opinions belong to critics ("critics loved it"), never to us.
2. Subject: 30 to 50 characters is best, never over ${SUBJECT_MAX}. One story. Sound like a friend who reads every review, not a database. Specific beats clever. Name a show when it helps.
3. Preview text (shown after the subject in the inbox): 40 to ${PREHEADER_MAX} characters. It adds the next thing a reader wants to know; never repeat the subject.
4. Opening paragraph: 2 to 4 short sentences that tell the story the subject promised, then mention the other notable news. Use the Critic Score number in parentheses after a show the first time you cite its score, e.g. The Bridge (76).
5. Never use: "opens to X reviews", "with critics", "big/busy/packed week", "scoring 75 or higher", "the reviews are in", dashes as punctuation, quotation marks, exclamation marks, emoji, clickbait, "not X, but Y".
6. Vary the shape between candidates: a statement, a verdict, a recommendation, a question only if it is specific.
${recent.length ? `\nRecent subject lines. Do not resemble these in wording, shape or opening words:\n${recent.map(r => `- ${r}`).join('\n')}\n` : ''}
FACTS:
${pool.sheet}
${feedback ? `\nYour previous candidates were rejected for these reasons. Fix every one:\n${feedback.map(f => `- ${f}`).join('\n')}\n` : ''}
Reply with only a JSON object: {"candidates": [{"angle": "<short angle name>", "subject": "...", "preheader": "...", "lede": "..."}]}`;
}

export function checkerPrompt(pool, c) {
  return `You fact-check a newsletter's subject line, preview text and opening paragraph against the facts they were written from. The facts are correct by definition. Flag any claim, number, name, day, ranking or comparison the facts do not support, including small embellishments ("sold out", "every critic", "the best of the year", "closes tomorrow" when the facts give a weekday). Flag an opinion stated as the newsletter's own rather than the critics'. Do not flag style, tone or omissions.

FACTS:
${pool.sheet}

SUBJECT: ${c.subject}
PREVIEW: ${c.preheader}
OPENING: ${c.lede}

Reply with only a JSON object: {"supported": true|false, "problems": ["<each unsupported claim and why>"]}`;
}

export function judgePrompt(pool, cands) {
  return `You are the editor of a theatre newsletter choosing this week's subject line. Rank these candidates by how likely a theatregoer is to open the email AND feel it was worth it: a clear, specific reason to open now, natural human voice, short enough for a phone, honest. Penalize anything vague, generic, mechanical or that oversells.

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
