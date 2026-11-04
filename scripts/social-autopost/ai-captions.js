// AI-written score posts (BRO-6959). Claude writes each post from the show's fact pool (facts.js),
// code checks every number and rule, and GPT-5.5 reads the post next to the facts and flags any
// claim they don't support. Anything that fails falls back to the template caption (captions.js),
// so a bad draft never posts. Kill switch: SOCIAL_AI_CAPTIONS_DISABLED=true.

const crypto = require('crypto');
const { SOCIAL_WRITER, GPT55 } = require('../lib/models.js');
const { finalResponseText, firstJsonObject } = require('../lib/anthropic-response-text.js');
const { callWithTimeout } = require('../lib/llm-call-budget.js');
const { buildFactPool, factSheet } = require('./facts');
const { buildCaptions, showUrl, showPath, hashtagLine, audienceNumber, strayNumbers, LIMITS, SHORT_BUDGET, SCORE_SENTENCE } = require('./captions');
const { MARKETS, marketOf } = require('./config');

const LONG_MAX = 420; // Facebook, Instagram, Threads when it fits
const X_MAX = LIMITS.twitter - 23 - 2; // X counts any link as 23 characters
const CALL_MS = 120000;
const MAX_ATTEMPTS = 2; // one rewrite with the problems listed, then the template

const BANNED = [
  [/[–—]|\s-\s|--/, 'a dash used as punctuation'],
  [/https?:|www\.|[#@]/i, 'a link, hashtag or handle'],
  [/\p{Extended_Pictographic}/u, 'an emoji'],
  [/["“”]/, 'a quotation mark (no quotes from reviews)'],
  [/\b(?:delve|robust|leverage|unlock|tapestry|realm|journey|landscape|navigate|deep dive|not just|moreover|furthermore|additionally|truly|genuinely|buckle up|game[- ]changer)\b/i, 'an AI-sounding word'],
  [/\bit'?s not\b[^.]{0,60}\bit'?s\b/i, 'the "it\'s not X, it\'s Y" construction'],
  [/\b(?:reviews|verdict|votes|results) (?:are|is) in\b/i, 'a stock opener ("the reviews are in")'],
  [/\bcritics we weight\b/i, '"critics we weight" (say top-tier critics)'],
  [/\bpapers?\b/i, '"paper" (not every top-tier outlet is a newspaper)'],
  [/\bperfect\b/i, '"perfect"'],
];

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINALS = { dozen: 12, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const WORD_RE = new RegExp(`\\b(?:(${Object.keys(TENS).join('|')})(?:[- ](${ONES.slice(1, 10).join('|')}))?|(${ONES.join('|')})|(hundred)|(${Object.keys(ORDINALS).join('|')}))\\b`, 'gi');

/** Numbers written as words ("twenty-six", "nine", "second"), as digit strings. */
function wordNumbers(text) {
  // Idioms that carry no count.
  const t = String(text).replace(/\b(?:no one|one of|one another|a third|one third|in second place)\b/gi, ' ');
  const out = [];
  for (const m of t.matchAll(WORD_RE)) {
    if (m[1]) out.push(String(TENS[m[1].toLowerCase()] + (m[2] ? ONES.indexOf(m[2].toLowerCase()) : 0)));
    else if (m[3]) out.push(String(ONES.indexOf(m[3].toLowerCase())));
    else if (m[4]) out.push('100');
    else if (m[5]) out.push(String(ORDINALS[m[5].toLowerCase()]));
  }
  return out;
}

/** Everything code can check about one draft. Empty means it passed. */
function checkDraft(draft, pool, title) {
  const problems = [];
  if (!draft || typeof draft.post !== 'string' || typeof draft.x !== 'string') return ['the reply was not {"post": ..., "x": ...}'];
  for (const [field, text, max] of [['post', draft.post, LONG_MAX], ['x', draft.x, X_MAX]]) {
    if (!text.trim()) { problems.push(`${field} is empty`); continue; }
    if (text.length > max) problems.push(`${field} is ${text.length} characters, at most ${max}`);
    if (!text.toLowerCase().includes(String(title).toLowerCase())) problems.push(`${field} must name the show as "${title}"`);
    // The duplicate-post guard (captions.js postMarkers) finds a score post by "Critic Score".
    if (!SCORE_SENTENCE.test(text)) problems.push(`${field} must say "Critic Score" and must not read like a comparison, roundup or closing post`);
    for (const [re, what] of BANNED) if (re.test(text)) problems.push(`${field} contains ${what}`);
    const aud = audienceNumber(text);
    if (aud) problems.push(`${field} gives audiences a number ("${aud}"); audiences get a letter grade only`);
    // The title is removed first, so a number in it ("The Fear of 13") never vouches for "13 reviews".
    const body = text.split(String(title)).join(' ');
    const stray = [...new Set([...strayNumbers(body, pool.numbers), ...wordNumbers(body).filter(n => !pool.numbers.has(n))])];
    if (/\d[.,]\d/.test(body.replace(/\d{1,3}(?:,\d{3})+/g, '0'))) problems.push(`${field} has a decimal; every figure on the site is a whole number`);
    if (stray.length) problems.push(`${field} has numbers that are not in the facts: ${stray.join(', ')}`);
  }
  if (draft.post.length < 150) problems.push(`post is only ${draft.post.length} characters; write at least 150`);
  return problems;
}

const EXAMPLE = `Of the 5 Broadway shows that opened since September 1 and have at least 8 reviews, A Few Good Men has the lowest Critic Score: 61 (Mixed).

The top-tier critics were rough on it. Only 2 of 9 were positive, and 4 were negative: the New York Post, Vulture, The Wall Street Journal and The Guardian.

All 26 reviews: 1 rave, 10 positive, 9 mixed, 6 negative.

Audiences don't seem to mind. They give it a B+, and it played to full houses last week.`;

function writerPrompt(sheet, feedback) {
  return `You write the social media posts for Broadway Scorecard and West End Scorecard, review aggregators. For every show we collect the critics' reviews, label each one (rave, positive, mixed, negative, pan), weight top-tier outlets most, and publish one Critic Score from 0 to 100, plus a letter grade for audiences. Our edge is that data: how the critics actually split, how the top-tier outlets voted, how a show ranks against this season's openings, how critics and audiences compare.

Write one post about the show below for Facebook, Threads and Instagram (200 to ${LONG_MAX} characters, short paragraphs), plus a separate X version (at most ${X_MAX} characters; the link is added after it). Lead with one of the STANDOUT FACTS, the way a sharp theater fan who loves numbers would tell a friend. Always give the Critic Score and its label. The long post also gives the full tally (raves, positive, mixed, negative). Sound like a person: plain, specific, a little dry. Short sentences are fine.

Hard rules:
1. Use only the facts given. Every number you write must appear in the facts. Add nothing from memory: no awards, names, history or opinions that are not listed.
2. A rank must keep its qualifier exactly as the fact states it (which shows, since when, how many reviews). Never say "of the shows that opened" with a count unless the fact says that count opened.
3. Audiences get a letter grade only ("audiences give it a B+"). Never a number, percentage or point gap for audiences.
4. Say "top-tier critics". Name an outlet only where the facts name it, and call outlets by name, never "papers".
5. Opinions about the show belong to critics ("critics praised the lead"), never to us.
6. No dashes as punctuation, no hashtags, emoji, links or quotation marks. No quotes from reviews.
7. Avoid AI tells: "the reviews are in", "delve", "landscape", "it's not X, it's Y", "buckle up", lists of three adjectives, a closing question unless it is specific and natural.
8. Write the show title exactly as given.

An example the owner liked (for tone and density only; vary the opening and structure, don't copy it):
${EXAMPLE}

${sheet}
${feedback ? `\nYour previous draft was rejected for these reasons. Fix every one:\n${feedback.map(f => `- ${f}`).join('\n')}\n` : ''}
Reply with only a JSON object: {"lead": "<tag of the fact you led with>", "post": "<long post>", "x": "<X post>"}`;
}

function checkerPrompt(sheet, draft) {
  return `You fact-check a social media post for a theater review aggregator against the facts it was written from. The facts are correct by definition. Flag:
- any claim, number, name or comparison the facts do not support (including small embellishments like "sold out" when it sold 93% of seats, or "every critic" when one was mixed)
- a rank stated without the qualifier the fact gives, or with a different group of shows
- an opinion about the show stated as the aggregator's own rather than the critics'
- any number, percentage or point gap given for audiences (they get a letter grade only)
Do not flag style, tone or omissions. Wording that restates a fact faithfully is fine.

FACTS:
${sheet}

POST (long version):
${draft.post}

POST (X version):
${draft.x}

Reply with only a JSON object: {"supported": true|false, "problems": ["<each unsupported claim and why>"]}`;
}

async function postJson(url, body, headers, ms, label) {
  return callWithTimeout(async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const txt = await res.text();
    // Status only: an auth error body can echo a masked key, and this message lands in the committed ledger.
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return JSON.parse(txt);
  }, ms + 5000, label);
}

async function claudeWriter(prompt, env = process.env) {
  const j = await postJson('https://api.anthropic.com/v1/messages', { model: SOCIAL_WRITER, max_tokens: 6000, messages: [{ role: 'user', content: prompt }] },
    { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, CALL_MS, 'Claude writer');
  const json = firstJsonObject(finalResponseText(j.content));
  if (!json) throw new Error(`Claude writer: no JSON in reply (stop_reason ${j.stop_reason})`);
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

/** The captions object in buildCaptions' shape, from an approved draft. */
function captionsFromDraft(desc, draft) {
  const { show } = desc;
  const template = buildCaptions(desc);
  const withUrl = (text, network) => `${text}\n\n${showUrl(show, network)}`;
  const fits = (text, network, max = LIMITS[network]) => text.length + 2 + showUrl(show, network).length <= max;
  return {
    twitter: withUrl(draft.x, 'twitter'),
    // Bluesky counts the whole link; the X cut rarely fits beside it, so the template stands in.
    bluesky: fits(draft.x, 'bluesky', Math.min(SHORT_BUDGET, LIMITS.bluesky)) ? withUrl(draft.x, 'bluesky') : template.bluesky,
    threads: withUrl(fits(draft.post, 'threads') ? draft.post : draft.x, 'threads'),
    instagram: `${draft.post}\n\nFull reviews: ${MARKETS[marketOf(show)].domain}${showPath(show)} (link in bio)\n\n${hashtagLine(show)}`,
    facebook: withUrl(draft.post, 'facebook'),
    altText: template.altText,
  };
}

/**
 * Why the AI writer is off for this run, or null when it may run. Off unless config enables it
 * or a dry run forces it (workflow input ai_captions); the kill switch beats both.
 */
function aiDisabledReason(env = process.env, { enabled = false, dryRun = false } = {}) {
  if (/^(1|true|yes)$/i.test(env.SOCIAL_AI_CAPTIONS_DISABLED || '')) return 'SOCIAL_AI_CAPTIONS_DISABLED';
  if (!enabled && !(dryRun && /^(1|true|yes)$/i.test(env.SOCIAL_AI_CAPTIONS_FORCE || ''))) return 'AI_CAPTIONS.enabled is false';
  if (!env.ANTHROPIC_API_KEY) return 'no ANTHROPIC_API_KEY';
  if (!env.OPENAI_API_KEY) return 'no OPENAI_API_KEY (posts are never sent unchecked)';
  return null;
}

/**
 * @param {object} desc  run.js describe() output
 * @param {{shows, slim}} ctx
 * @param {number} now
 * @param {{writer?, checker?, log?, deadline?, cache?}} deps  writer/checker stubs for tests; cache is
 *   ledger._meta.aiDrafts: an approved draft is reused only while the fact sheet is byte-identical
 * @returns {Promise<{captions, meta: {writer: 'ai'|'template', lead?, attempts, fallback?, problems?}}>}
 *   Never throws: any failure returns the template captions with the reason.
 */
async function writeScoreCaptions(desc, ctx, now, deps = {}) {
  const writer = deps.writer || claudeWriter, checker = deps.checker || gptChecker, log = deps.log || (() => {});
  const deadline = deps.deadline || Infinity; // ms timestamp shared by the whole run
  const late = () => Date.now() > deadline;
  if (late()) return { captions: buildCaptions(desc), meta: { writer: 'template', attempts: 0, fallback: 'run time budget for drafts used up' } };
  const template = () => buildCaptions(desc);
  let pool, sheet;
  try { pool = buildFactPool(desc.show, ctx, now); sheet = factSheet(pool); } catch (e) {
    return { captions: template(), meta: { writer: 'template', attempts: 0, fallback: `fact pool: ${e.message}` } };
  }
  const cache = deps.cache, sheetHash = crypto.createHash('sha1').update(sheet).digest('hex').slice(0, 16);
  const kept = cache && cache[desc.show.id];
  if (kept && kept.sheetHash === sheetHash) return { captions: kept.captions, meta: { ...kept.meta, reused: true } };
  let feedback = null, attempts = 0, outOfTime = false;
  try {
    while (attempts < MAX_ATTEMPTS) {
      if (late()) { outOfTime = true; break; }
      attempts++;
      const draft = await writer(writerPrompt(sheet, feedback));
      let problems = checkDraft(draft, pool, desc.show.title);
      if (!problems.length) {
        if (late()) { outOfTime = true; break; }
        const verdict = await checker(checkerPrompt(sheet, draft));
        // A "supported" verdict that still lists a problem is a rejection.
        if (!verdict.supported || verdict.problems.length) problems = verdict.problems.length ? verdict.problems.map(p => `fact check: ${p}`) : ['fact check: unsupported (no reason given)'];
      }
      if (!problems.length) {
        const out = { captions: captionsFromDraft(desc, draft), meta: { writer: 'ai', lead: String(draft.lead || ''), attempts } };
        if (cache) cache[desc.show.id] = { sheetHash, at: new Date(Date.now()).toISOString(), ...out };
        return out;
      }
      log(`  [ai-caption] ${desc.show.id} draft ${attempts} rejected: ${problems.join(' | ')}`);
      feedback = problems;
    }
    return { captions: template(), meta: { writer: 'template', attempts, fallback: outOfTime ? 'run time budget for drafts used up' : 'drafts failed checks', ...(feedback ? { problems: feedback.slice(0, 5) } : {}) } };
  } catch (e) {
    return { captions: template(), meta: { writer: 'template', attempts, fallback: String(e.message || e).slice(0, 200) } };
  }
}

module.exports = { _internals: { claudeWriter, gptChecker }, writeScoreCaptions, aiDisabledReason, checkDraft, wordNumbers, captionsFromDraft, writerPrompt, checkerPrompt, LONG_MAX, X_MAX };
