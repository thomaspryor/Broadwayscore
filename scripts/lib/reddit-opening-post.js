/**
 * reddit-opening-post.js
 *
 * Pure helpers for scripts/draft-reddit-opening-posts.js (BRO-4333): pick
 * West End / Off-West-End / Off-Broadway openings worth a "reviews are in"
 * Reddit post, build the verified fact sheet the draft is written from, lint
 * the LLM draft, and detect when the owner has actually posted.
 *
 * Every number that appears in a draft comes from the fact sheet here, which
 * reads public/data/shows/{id}.json (the same slim file the live site renders,
 * see scripts/lib/canonical-critic-scores.ts). The LLM only writes prose
 * around those facts; lintDraft() refuses a title whose score doesn't match.
 *
 * No network, no filesystem: everything is injected so tests can require()
 * the real functions.
 */

'use strict';

// venue-write-guard-ok: buildFacts only reads show.venue into an in-memory fact sheet for a Reddit draft; nothing writes it back to shows.json.

const { foldDiacritics } = require('./title-match');

const SUBREDDIT_BY_MARKET = {
  'west-end': 'TheWestEnd',
  'off-west-end': 'TheWestEnd',
  'off-broadway': 'Broadway',
};

// Minimum critic reviews before a roundup is worth posting. Lower than the
// broadcast gate: a Reddit post is conversational and names its review count.
const MIN_REVIEWS = { 'west-end': 8, 'off-west-end': 8, 'off-broadway': 5 };

// Opened 1..MAX_AGE_DAYS days ago. The owner's best roundups went up the
// morning after opening; past ~5 days the moment has gone.
const MIN_AGE_DAYS = 1;
const MAX_AGE_DAYS = 5;

// A draft the owner hasn't posted stops showing in the email after this.
const DRAFT_TTL_DAYS = 4;

// Per run caps: the email should hand over one or two posts, not a chore list.
const MAX_DRAFTS_PER_RUN = 2;
const MAX_OB_DRAFTS_PER_RUN = 1;

const MIN_AUDIENCE_REVIEWS = 15; // parity with src/lib/audience-grade-utils.ts

function marketOf(show) {
  return show.category || show.market || 'broadway';
}

function daysBetween(fromYmd, toYmd) {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function showUrl(show) {
  const slug = show.slug || show.id;
  const m = marketOf(show);
  const host = (m === 'west-end' || m === 'off-west-end') ? 'westendscorecard.com' : 'broadwayscorecard.com';
  return `https://${host}/show/${slug}`;
}

// Same thresholds as scripts/lib/email-components.js audienceGrade().
function audienceGradeLetter(score) {
  if (score == null) return null;
  if (score >= 90) return 'A+';
  if (score >= 88) return 'A';
  if (score >= 83) return 'A-';
  if (score >= 78) return 'B+';
  if (score >= 73) return 'B';
  if (score >= 68) return 'B-';
  if (score >= 63) return 'C+';
  if (score >= 58) return 'C';
  if (score >= 53) return 'C-';
  if (score >= 48) return 'D';
  return 'F';
}

function audienceReviewCount(au) {
  if (!au || !au.sources) return 0;
  return Object.values(au.sources).reduce((n, s) => n + (Number(s && s.c) || 0), 0);
}

function bucketCounts(slim) {
  const out = { rave: 0, positive: 0, mixed: 0, negative: 0 };
  for (const r of slim.rv || []) {
    const b = String(r.b || '').toLowerCase();
    if (b === 'rave') out.rave++;
    else if (b === 'positive') out.positive++;
    else if (b === 'mixed') out.mixed++;
    else if (b === 'negative' || b === 'pan') out.negative++;
  }
  return out;
}

/**
 * Rank a show among currently open shows in the same market (by rounded
 * critic score). peers: [{ id, cs }] of open shows that have a score.
 */
function rankAmongPeers(showId, cs, peers) {
  const scored = peers.filter(p => typeof p.cs === 'number');
  if (!scored.some(p => p.id === showId)) scored.push({ id: showId, cs });
  const sorted = scored.slice().sort((a, b) => b.cs - a.cs);
  const pos = sorted.findIndex(p => p.id === showId) + 1;
  return { position: pos, of: sorted.length };
}

/**
 * The verified fact sheet. Returns null when the slim file has no score.
 */
function buildFacts(show, slim, peers, { seen = null } = {}) {
  if (!slim || typeof slim.cs !== 'number') return null;
  const market = marketOf(show);
  const score = Math.round(slim.cs);
  const buckets = bucketCounts(slim);
  const reviewCount = slim.rc || (slim.rv || []).length;
  const auCount = audienceReviewCount(slim.au);
  const audienceGrade = auCount >= MIN_AUDIENCE_REVIEWS && slim.au ? audienceGradeLetter(slim.au.score) : null;
  const rank = rankAmongPeers(show.id, slim.cs, peers || []);

  const reviews = (slim.rv || []).filter(r => r && r.q);
  const byScore = reviews.slice().sort((a, b) => (b.s || 0) - (a.s || 0));
  const quote = r => r && { outlet: r.o, critic: r.cn || null, score: r.s, bucket: r.b, quote: r.q };
  // Quote the outlets readers recognize (tier 1-2) when there are any.
  const known = byScore.filter(r => r.t && r.t <= 2);
  const pool = known.length >= 3 ? known : byScore;
  const best = pool.slice(0, 2).map(quote);
  const worst = pool.length > 3 ? pool.slice(-2).reverse().map(quote) : [];
  // A lone dissenter is a recurring hook in the owner's best posts.
  const dissenters = (buckets.rave + buckets.positive >= reviewCount - 1 && buckets.negative + buckets.mixed === 1)
    ? byScore.slice(-1).map(quote)
    : [];

  let rankNote = null;
  const label = { 'west-end': 'West End', 'off-west-end': 'Off-West End', 'off-broadway': 'Off-Broadway' }[market];
  const inLabel = market === 'west-end' ? 'the West End' : label;
  if (rank.of >= 5) {
    if (rank.position === 1) rankNote = `highest critic score of any show currently running in ${inLabel}`;
    else if (rank.position === rank.of) rankNote = `lowest critic score of any show currently running in ${inLabel}`;
    else if (rank.position <= 3) rankNote = `#${rank.position} of ${rank.of} ${label} shows currently running`;
    else if (rank.position >= rank.of - 2) rankNote = `#${rank.position} of ${rank.of} ${label} shows currently running (near the bottom)`;
  }

  return {
    showId: show.id,
    title: show.title,
    market,
    marketLabel: label,
    subreddit: SUBREDDIT_BY_MARKET[market],
    venue: typeof show.venue === 'string' ? show.venue : (show.venue && show.venue.name) || null,
    openingDate: show.openingDate,
    type: show.type || null,
    isRevival: show.isRevival === true,
    cast: (show.cast || []).slice(0, 4).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean),
    score,
    reviewCount,
    buckets,
    audienceGrade,
    audienceCount: audienceGrade ? auCount : null,
    consensus: slim.cn && slim.cn.t ? slim.cn.t : null,
    rankNote,
    rankPosition: rankNote ? rank.position : null,
    rankOf: rankNote ? rank.of : null,
    bestQuotes: best,
    worstQuotes: worst,
    loneDissenter: dissenters[0] || null,
    url: showUrl(show),
    ownerHistory: seen, // { seen: bool, rating, upcomingDate } or null
  };
}

/**
 * How post-worthy an opening is. Higher first. Extreme scores, rank extremes
 * and big review counts are the hooks that carried the owner's best posts.
 */
function notability(facts) {
  let n = 0;
  if (facts.market === 'west-end') n += 30;
  if (facts.score >= 85 || facts.score <= 45) n += 25;
  else if (facts.score >= 80 || facts.score <= 55) n += 12;
  if (facts.rankNote) n += 15;
  n += Math.min(facts.reviewCount, 30) / 2;
  if (facts.loneDissenter) n += 5;
  if (facts.audienceGrade) n += 3;
  return n;
}

// A template draft made only because the LLM call errored gets another try
// on the next run (while still unposted), instead of sticking for good.
function isRetryableDraft(d) {
  return !!d && d.status === 'ready' && d.source === 'template'
    && (d.lintProblems || []).some(p => String(p).startsWith('llm error'));
}

/**
 * Pick the openings to draft today.
 * shows: shows.json array. slims: Map id -> slim json. drafts: existing
 * drafts file ({ drafts: { [showId]: {...} } }). peersByMarket: market -> [{id, cs}].
 */
function selectCandidates({ shows, slims, drafts, peersByMarket, today, seenLookup = () => null, forceShowId = null }) {
  const already = (drafts && drafts.drafts) || {};
  const out = [];
  for (const show of shows) {
    const market = marketOf(show);
    if (!SUBREDDIT_BY_MARKET[market]) continue;
    if (forceShowId) {
      if (show.id !== forceShowId) continue;
    } else {
      if (already[show.id] && !isRetryableDraft(already[show.id])) continue;
      if (!show.openingDate) continue;
      const age = daysBetween(show.openingDate, today);
      if (age < MIN_AGE_DAYS || age > MAX_AGE_DAYS) continue;
    }
    const slim = slims.get(show.id);
    if (!slim) continue;
    const reviewCount = slim.rc || (slim.rv || []).length;
    if (!forceShowId && reviewCount < MIN_REVIEWS[market]) continue;
    const facts = buildFacts(show, slim, peersByMarket[market] || [], { seen: seenLookup(show.title) });
    if (!facts) continue;
    // Off-West End shows only when they'd carry a post on their own.
    if (!forceShowId && market === 'off-west-end' && notability(facts) < 25) continue;
    out.push({ show, facts, notability: notability(facts) });
  }
  out.sort((a, b) => b.notability - a.notability);
  if (forceShowId) return out;
  const picked = [];
  let ob = 0;
  for (const c of out) {
    if (picked.length >= MAX_DRAFTS_PER_RUN) break;
    if (c.facts.market === 'off-broadway') {
      if (ob >= MAX_OB_DRAFTS_PER_RUN) continue;
      ob++;
    }
    picked.push(c);
  }
  return picked;
}

// ── Owner's show history (data/shows-seen.json) ──────────────────────────────

function normTitle(t) {
  return foldDiacritics(String(t || ''))
    .toLowerCase()
    .replace(/\((?:west end|off-broadway|broadway)[^)]*\)/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function makeSeenLookup(seenData, { sinceYear } = {}) {
  const seen = new Map();
  for (const s of (seenData && seenData.shows) || []) {
    if (sinceYear && s.year && s.year < sinceYear) continue;
    seen.set(normTitle(s.title), s);
  }
  const upcoming = new Map();
  for (const u of (seenData && seenData.upcoming) || []) upcoming.set(normTitle(u.title), u);
  return title => {
    const k = normTitle(title);
    const s = seen.get(k);
    const u = upcoming.get(k);
    if (!s && !u) return null;
    return { seen: !!s, rating: s ? s.rating : null, upcomingDate: u ? u.date : null };
  };
}

// ── Style guide (distilled from u/thomaspryor's 58 posts, Feb-Sep 2026) ───────

const STYLE_GUIDE = `
You are drafting a Reddit post for Tom (u/thomaspryor), a theater lover in NYC who
sees most things on Broadway, visits London often, and built Broadway Scorecard /
West End Scorecard (a Rotten Tomatoes style aggregator of critic reviews). The
post announces that reviews are in for a show that just opened.

WHAT WORKED IN HIS REAL POSTS (upvotes in brackets):
- A title that leads with the show and the number, plus ONE hook that gives the
  number meaning: a record, a rank, a comparison, a surprise.
  "CATS scores 88/100. Highest-scoring Broadway musical revival on the site. Ever." [575]
  "Rocky Horror gets a 69. Not as high as they would have liked, but a number they'd appreciate" [346]
  "Reviews are in for Trainspotting the Musical. 36/100 from critics, the lowest critic score in the West End right now" [95 on r/TheWestEnd]
  "Reviews are in for Every Brilliant Thing! 80/100 and every single review is basically about Radcliffe" [226]
- The body opens with the number and the breakdown in plain words:
  "22 reviews, 16 raves, 5 positive, 1 mixed, zero negative."
- One specific, interesting thing the critics agreed on (praised the lead but
  blamed the book, everyone mentions the set, a lone dissenter).
- Audience grade next to the critics when it exists, and whether they agree.
- A little personality: a wry aside, honest uncertainty, light humor.
- Ends by asking the sub something real ("Anyone caught it in previews? Does
  that match what you saw?").
- One link, at the very end, bare.

A FULL REAL POST OF HIS (95 upvotes, r/TheWestEnd). Match this energy and shape,
not its facts:
---
Hi all, Tom here. I launched WestEndScorecard a few weeks back, and this is my first review roundup post. And it's a doozy!

Trainspotting the Musical opened Tuesday at the Theatre Royal Haymarket. 36/100 across 19 reviews. 15 negative, 2 mixed, 1 positive, and one lone rave (The Upcoming gave it a 91). Audiences aren't much kinder at a C+ grade.

The interesting part: nearly every review, including the pans, praised Lewis Kidd's Renton. Critics blamed the format, not the cast. The Evening Standard said the show doesn't even seem to want to be a musical.

Anyone catch it recently? We're coming over from NYC in two weeks before Fringe, and ofc this is at the bottom of our list. But I think that was the case even before the reviews came out.

westendscorecard.com/show/trainspotting-the-musical-west-end
---
Another (Aug 2026, 39 upvotes), short and personal, with a real question:
---
As a Jellicle Ball lover, this feels a little too soon lol
(I know it's a very different market, very different show, etc)

31 reviews, too?! It's wild to me how many more theater critics London has compared to Broadway. A broadway show is lucky to hit 20, and most of those are theater specific online outlets now. Does anyone know the real story behind that?
---

WHAT GOT HIM DOWNVOTED OR PILED ON:
- Treating art like a math test, or ranking a show people love as "low scoring"
  ("Who cares about these arbitrary, fake scores? It's art" got 51 upvotes on
  his 0-point post). Never say a show is bad because of a number. Report what
  critics said; let readers decide.
- Roundups of several small shows with no personal hook (6 and 14 upvotes).
- Sounding like marketing. He built the site and says so plainly when it comes
  up, but the post is about the show, never the site.

VOICE:
- Warm, curious, a bit nerdy about the data, genuinely into theater.
- Short paragraphs. 80-170 words in the body. Contractions. Casual.
- In r/TheWestEnd he's a friendly visitor from NYC; don't fake British idiom.
- At most one "lol" or "haha". Emoji: none, or one at most.

HARD RULES:
- Use ONLY the facts in the FACT SHEET. Never invent quotes, critics, box
  office, transfers, awards, cast, or comparisons that aren't given.
- Quote critics only with words that appear in the FACT SHEET quotes.
- Do not claim he has seen the show unless OWNER HISTORY says seen=true. If he
  has tickets, you may say he's going soon. Otherwise don't mention seeing it.
- Never invent his plans, trips, dates, or opinions (no "planning to see it next
  month", no "the film, which I love"). The same goes for personalLines: write
  them as honest options he can pick only if true, e.g. "Would you see it?"
  style questions, or "[if true] We've got tickets for later this month."
- Read like a person texting theater friends, not a press release or a
  customer-service reply. No "the critics have spoken", no "Absolutely!", no
  "high marks", no "must-see", no "passion project".
- The suggestedReply is calm and a little self-deprecating, never defensive,
  and never just agrees with a pile-on. One or two sentences. It must not
  explain how the site calculates or ranks anything beyond this, which is
  true: the Critic Score is a weighted average of the published critic
  reviews, and the rank compares critic scores of shows currently running.
- No em dashes (—) or en dashes (–) anywhere. Use commas, periods, parentheses.
- No "It's not X, it's Y", no "Not just X, but Y", no "The verdict? ..." style
  fragments, no "delve", "tapestry", "landscape", "robust", "Moreover".
- No hashtags, no "EDIT:", no "TL;DR", no bold-first bullet lists.
- The score in the title must be exactly the SCORE in the fact sheet, written
  as "NN/100" or "a NN".
`.trim();

/**
 * His best recent "reviews are in" style posts, freshest voice first. Pulled
 * live each run so the examples never go stale (owner ask 2026-09-29: keep the
 * examples recent). posts: Arctic Shift rows.
 */
function pickRecentExamples(posts, { nowMs = Date.now(), maxAgeDays = 120, n = 3 } = {}) {
  const cutoff = nowMs / 1000 - maxAgeDays * 86400;
  return (posts || [])
    .filter(p => p && p.selftext && p.selftext.length > 150 && (p.created_utc || 0) >= cutoff)
    .filter(p => THEATER_SUBS.has(String(p.subreddit || '').toLowerCase()))
    .filter(p => /\d{1,3}\s*\/\s*100|\bscores? (an? )?\d{2}\b|\bgets an? \d{2}\b|reviews are in/i.test(p.title))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, n)
    .map(p => ({
      date: new Date(p.created_utc * 1000).toISOString().slice(0, 10),
      subreddit: p.subreddit,
      upvotes: p.score,
      title: p.title,
      body: p.selftext.replace(/https?:\/\/preview\.redd\.it\S+/g, '').trim().slice(0, 1400),
    }));
}

function buildUserPrompt(facts, examples = []) {
  const ex = examples.length
    ? `HIS MOST RECENT WELL-RECEIVED POSTS (match this voice, not these facts):\n${examples.map(e =>
      `--- r/${e.subreddit}, ${e.date}, ${e.upvotes} upvotes\nTITLE: ${e.title}\n${e.body}`).join('\n\n')}\n---\n\n`
    : '';
  return `${ex}FACT SHEET (JSON):
${JSON.stringify(facts, null, 2)}

Write the post for r/${facts.subreddit}.

Return JSON only, no prose around it:
{
  "title": "post title, under 200 characters",
  "body": "post body in Reddit markdown, ending with the link ${facts.url}",
  "why": "one sentence: the hook you chose and why it should land",
  "expectedPushback": "one sentence: the most likely snarky or critical comment",
  "suggestedReply": "a short, friendly reply Tom could give to that comment, in his voice",
  "personalLines": ["2 optional one-line additions Tom could paste in to make it personal, e.g. whether he plans to see it. Must not claim he has seen it unless OWNER HISTORY says so."]
}`;
}

// ── Lint ──────────────────────────────────────────────────────────────────────

const BANNED = [
  /\bdelve\b/i, /\btapestry\b/i, /\brobust\b/i, /\blandscape of\b/i, /\bmoreover\b/i,
  /\bfurthermore\b/i, /\bit'?s not just\b/i, /\bnot just [^.]{1,40}, but\b/i,
  /\bTL;?DR\b/, /^EDIT:/m, /(^|\s)#[A-Za-z]\w*/,
  /critics have spoken/i, /^absolutely\b/im, /\bhigh marks\b/i, /\bmust-see\b/i, /\bdive into\b/i,
  /\bpassion project\b/i, /\bnavigat/i, /\bjourney\b/i,
  /\bhey (broadway|theatre|theater|west end) (fans|folks)\b/i, /\b(I'?d|would) love to\b/i, /\bbuzzing about\b/i,
  /\bmaking waves\b/i,
  /\bhope this finds\b/i, /\bexcited to share\b/i,
];

function normQuote(s) {
  return String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
}

// Spans inside "straight" or “curly” double quotes.
function quotedSpans(text) {
  const out = [];
  const re = /["“]([^"”\n]{3,400})["”]/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1].replace(/[.,!?]+$/, ''));
  return out;
}

function stripDashes(s) {
  return String(s || '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?])/g, '$1');
}

/**
 * Clean and check a draft. Returns { ok, draft, problems }. Dashes are fixed
 * in place; anything that would put a wrong fact or AI tell in front of
 * Reddit is a problem and the caller falls back to the template draft.
 */
function lintDraft(raw, facts) {
  const problems = [];
  const draft = {
    title: stripDashes(raw && raw.title).trim(),
    body: stripDashes(raw && raw.body).trim(),
    why: stripDashes(raw && raw.why).trim(),
    expectedPushback: stripDashes(raw && raw.expectedPushback).trim(),
    suggestedReply: stripDashes(raw && raw.suggestedReply).trim(),
    personalLines: Array.isArray(raw && raw.personalLines) ? raw.personalLines.map(stripDashes).map(s => s.trim()).filter(Boolean).slice(0, 3) : [],
  };
  if (!draft.title) problems.push('empty title');
  if (draft.title.length > 300) problems.push('title over Reddit 300-char limit');
  if (!draft.body) problems.push('empty body');

  const titleNums = (draft.title.match(/\b\d{1,3}\b/g) || []).map(Number);
  if (!titleNums.includes(facts.score)) problems.push(`title does not state the score ${facts.score}`);

  // Every number in the post must exist somewhere in the fact sheet (score,
  // counts, rank, quotes, venue, url). A wrong number is what gets a post
  // torn apart, so an unsupported one sends the draft back.
  const allowed = new Set([0, 1, 100, ...(JSON.stringify(facts).match(/\d+/g) || []).map(Number)]);
  const noUrl = s => s.replace(/https?:\/\/\S+/g, '');
  for (const [where, text] of [['title', draft.title], ['body', draft.body]]) {
    for (const n of (noUrl(text).match(/\d+/g) || []).map(Number)) {
      if (!allowed.has(n)) problems.push(`${where} has number ${n} that is not in the fact sheet`);
    }
    for (const m of text.match(/\b\d{1,3}\s*\/\s*100\b/g) || []) {
      if (parseInt(m, 10) !== facts.score) problems.push(`${where} cites ${m}, fact sheet says ${facts.score}/100`);
    }
    if (/\d\s*(%|percent)/i.test(text)) problems.push(`${where} uses a percentage the fact sheet doesn't give`);
    for (const g of noUrl(text).match(/(?<![A-Za-z])[A-D][+-](?![A-Za-z0-9])/g) || []) {
      if (g !== facts.audienceGrade) problems.push(`${where} cites grade ${g}, fact sheet says ${facts.audienceGrade || 'none'}`);
    }
  }

  if (!draft.body.includes(facts.url)) {
    draft.body = `${draft.body}\n\n${facts.url}`;
  }
  // The reply and personal lines get pasted to Reddit too.
  const extras = [draft.suggestedReply, ...draft.personalLines];
  for (const re of BANNED) {
    if ([draft.title, draft.body, ...extras].some(t => re.test(t))) problems.push(`banned phrasing ${re}`);
  }
  if (/\brank(ing|ings|ed)?\b[^.]*\b(consider|factor|weigh|include)/i.test(draft.suggestedReply)) {
    problems.push('suggestedReply explains the ranking method (not supported by facts)');
  }
  const words = draft.body.split(/\s+/).filter(Boolean).length;
  if (words > 260) problems.push(`body too long (${words} words)`);

  // Anything in quotation marks must be a real critic line from the fact
  // sheet: a made-up quote attributed to a critic is the one thing Reddit
  // would rightly never forgive.
  const sources = [facts.consensus, ...[facts.bestQuotes, facts.worstQuotes, [facts.loneDissenter]]
    .flat().filter(Boolean).map(q => q.quote)].map(normQuote).join(' | ');
  for (const span of quotedSpans(draft.body)) {
    if (span.split(/\s+/).length < 3) continue;
    if (!sources.includes(normQuote(span))) problems.push(`quote not found in the reviews: "${span.slice(0, 60)}"`);
  }

  const h = facts.ownerHistory;
  if (!(h && h.seen) && /\b(I|we) (saw|caught|watched)\b/i.test(draft.body)) {
    problems.push('claims owner saw a show his history does not list');
  }
  return { ok: problems.length === 0, draft, problems };
}

// ── Template fallback (no LLM, or the LLM draft failed lint) ─────────────────

function breakdownSentence(b) {
  const parts = [];
  if (b.rave) parts.push(`${b.rave} rave${b.rave === 1 ? '' : 's'}`);
  if (b.positive) parts.push(`${b.positive} positive`);
  if (b.mixed) parts.push(`${b.mixed} mixed`);
  if (b.negative) parts.push(`${b.negative} negative`);
  return parts.join(', ');
}

// "an 80", "an 11", "an 18", "a 75"
function aOrAn(n) {
  const s = String(n);
  return (s.startsWith('8') || s === '11' || s === '18') ? 'an' : 'a';
}

function templateDraft(facts) {
  // Only the clean superlatives make a good title hook.
  const hook = facts.rankNote && !facts.rankNote.startsWith('#') ? `, the ${facts.rankNote}` : '';
  const title = `Reviews are in for ${facts.title}: ${facts.score}/100 from critics${hook}`;
  const lines = [];
  lines.push(`${facts.title} opened ${facts.venue ? `at ${facts.venue} ` : ''}with ${aOrAn(facts.score)} ${facts.score}/100 critic score across ${facts.reviewCount} reviews. ${breakdownSentence(facts.buckets)}.`);
  if (facts.consensus) lines.push(facts.consensus);
  if (facts.audienceGrade) lines.push(`Audiences have it at ${facts.audienceGrade} so far.`);
  if (facts.loneDissenter) lines.push(`${facts.loneDissenter.outlet} is the lone holdout.`);
  lines.push('Anyone caught it yet? Curious whether it matches what you saw in the room.');
  lines.push(facts.url);
  return {
    title: stripDashes(title),
    body: stripDashes(lines.join('\n\n')),
    why: 'Template fallback: plain roundup with the score, breakdown and critic consensus.',
    expectedPushback: 'Someone may say numbers can\'t capture theater.',
    suggestedReply: 'Totally fair, the number is just a quick way to see where critics landed. The reviews themselves are the fun part.',
    personalLines: [],
  };
}

// ── Reddit plumbing ───────────────────────────────────────────────────────────

/** Prefilled submit link: opens Reddit's post form with title + body filled in. */
function submitUrl(subreddit, title, body) {
  const q = new URLSearchParams({ type: 'TEXT', title, text: body });
  return `https://www.reddit.com/r/${subreddit}/submit?${q.toString()}`;
}

function oldRedditSubmitUrl(subreddit, title, body) {
  const q = new URLSearchParams({ selftext: 'true', title, text: body });
  return `https://old.reddit.com/r/${subreddit}/submit?${q.toString()}`;
}

const THEATER_SUBS = new Set(['broadway', 'thewestend', 'offbroadway', 'musicals', 'theatre', 'londontheatre']);

/**
 * Mark drafts posted when one of the owner's recent Reddit posts is about the
 * same show. posts: [{ title, created_utc, permalink, score, num_comments, subreddit }].
 * Returns a new drafts object; never mutates input.
 */
function applyPostedDetection(drafts, posts) {
  const out = { ...drafts, drafts: { ...(drafts.drafts || {}) } };
  for (const [id, d] of Object.entries(out.drafts)) {
    if (d.status === 'posted') continue;
    const key = normTitle(d.showTitle);
    // The show-page slug catches posts whose title shortens the show name
    // ("Rocky Horror gets a 69") but which link the page, as his always do.
    const slug = d.url ? String(d.url).replace(/\/+$/, '').split('/').pop() : null;
    if ((!key || key.length < 3) && !slug) continue;
    const createdSec = Date.parse(d.createdAt) / 1000 - 3 * 86400; // allow posting a bit before the draft
    const hit = (posts || []).find(p => {
      if (!p || (p.created_utc || 0) < createdSec) return false;
      if (slug && `${p.selftext || ''} ${p.url || ''}`.includes(`/show/${slug}`)) return true;
      // Title fallback: whole-word match, and only in a theater sub, so a
      // show called "Rent" isn't cleared by a post saying "currently".
      if (!key || key.length < 3 || !THEATER_SUBS.has(String(p.subreddit || '').toLowerCase())) return false;
      return ` ${normTitle(p.title)} `.includes(` ${key} `);
    });
    if (hit) {
      out.drafts[id] = {
        ...d,
        status: 'posted',
        postedAt: new Date(hit.created_utc * 1000).toISOString(),
        postedUrl: hit.permalink ? `https://www.reddit.com${hit.permalink}` : null,
        postedSubreddit: hit.subreddit || null,
        postedScore: hit.score ?? null,
      };
    }
  }
  return out;
}

/** Drafts the email should show today: ready, not posted, not stale. */
function activeDrafts(drafts, nowMs) {
  return Object.values((drafts && drafts.drafts) || {})
    .filter(d => d.status === 'ready')
    .filter(d => (nowMs - Date.parse(d.createdAt)) / 86400000 <= DRAFT_TTL_DAYS)
    .sort((a, b) => (b.notability || 0) - (a.notability || 0));
}

module.exports = {
  SUBREDDIT_BY_MARKET,
  MIN_REVIEWS,
  MAX_AGE_DAYS,
  DRAFT_TTL_DAYS,
  STYLE_GUIDE,
  marketOf,
  showUrl,
  audienceGradeLetter,
  buildFacts,
  notability,
  selectCandidates,
  makeSeenLookup,
  normTitle,
  buildUserPrompt,
  pickRecentExamples,
  lintDraft,
  stripDashes,
  quotedSpans,
  templateDraft,
  submitUrl,
  oldRedditSubmitUrl,
  applyPostedDetection,
  activeDrafts,
};
