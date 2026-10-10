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
  // r/offbroadwayNYC: ~4.2k weekly visitors, 112 contributions/week, Top 50
  // in Performing Arts (owner screenshot 2026-09-30). r/Broadway is the
  // crosspost for these.
  'off-broadway': 'offbroadwayNYC',
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

// Slim-file audience keys (generate-mobile-show-details.js KEY_MAP, plus ltd)
// to the names the owner writes in posts ("across Mezzanine, Seatplan, ...").
const AUDIENCE_SOURCE_NAMES = {
  ss: 'Show Score', mz: 'Mezzanine', rd: 'Reddit', th: 'Theatr', bc: 'Broadway.com',
  sp: 'Seatplan', lb: 'London Box Office', ltd: 'London Theatre Direct',
};

/** Audience sources with at least one review, biggest first. */
function audienceSourceNames(au) {
  if (!au || !au.sources) return [];
  return Object.entries(au.sources)
    .filter(([, s]) => s && Number(s.c) > 0)
    .sort((a, b) => Number(b[1].c) - Number(a[1].c))
    .map(([k]) => AUDIENCE_SOURCE_NAMES[k] || null)
    .filter(Boolean);
}

/**
 * What Tom can honestly say about his own plans, from data/shows-seen.json.
 * 'seen' and 'has-tickets' are facts; 'not-seen' only means the show is not on
 * the seen list, so drafts may say "haven't seen it yet" and nothing stronger.
 */
function ownerStance(seen) {
  if (seen && seen.seen) return 'seen';
  if (seen && seen.upcomingDate) return 'has-tickets';
  return 'not-seen';
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
  // Rank on the whole numbers the site shows: 89.9 vs 89.8 both read "90",
  // so neither may claim "highest" (ship-check 2026-09-29).
  const mine = Math.round(cs);
  const others = peers.filter(p => typeof p.cs === 'number' && p.id !== showId).map(p => Math.round(p.cs));
  const position = 1 + others.filter(v => v > mine).length;
  const tied = others.some(v => v === mine);
  return { position, of: others.length + 1, tied };
}

/**
 * Rank cohort per market: open/previews shows whose score rests on at least
 * as many reviews as a draft needs itself (MIN_REVIEWS). A thinner peer makes
 * "#3 of 25 currently running" a claim Reddit would rightly pick apart
 * (ship-check 2026-09-29: Delirium ranked behind a 3-review opera).
 */
function buildPeers(shows, slims) {
  const out = {};
  for (const s of shows) {
    const m = marketOf(s);
    if (!SUBREDDIT_BY_MARKET[m]) continue;
    if (s.status !== 'open') continue; // "currently running" means open, not in previews
    const slim = slims.get(s.id);
    if (!slim || typeof slim.cs !== 'number') continue;
    if ((slim.rc || (slim.rv || []).length) < MIN_REVIEWS[m]) continue;
    (out[m] = out[m] || []).push({ id: s.id, cs: slim.cs });
  }
  return out;
}

/**
 * The verified fact sheet. Returns null when the slim file has no score.
 */
function buildFacts(show, slim, peers, { seen = null, crosspost = null } = {}) {
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
  if (rank.of >= 5 && !rank.tied) {
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
    crosspostSubreddit: crosspost,
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
    audienceSources: audienceSourceNames(slim.au),
    ownerStance: ownerStance(seen),
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

// Unposted and still due one more email (the first, or the reminder).
function isRefreshable(d) {
  return !!d && d.status === 'ready' && !d.reminderAt;
}

/**
 * A second, bigger audience worth a crosspost to r/Broadway (282k):
 *  - every Off-Broadway show (primary is the smaller r/offbroadwayNYC, and
 *    the owner's Off-Broadway posts did well on r/Broadway);
 *  - West End / Off-West End shows with a current or recent Broadway
 *    production of the same title (Trainspotting: 95 on r/TheWestEnd, then
 *    74 on r/Broadway).
 */
function crosspostSubreddit(show, broadwayTitles) {
  const m = marketOf(show);
  if (m === 'off-broadway') return 'Broadway';
  if (m !== 'west-end' && m !== 'off-west-end') return null;
  return broadwayTitles.has(normTitle(show.title)) ? 'Broadway' : null;
}

/**
 * Pick the openings to draft today.
 * shows: shows.json array. slims: Map id -> slim json. drafts: existing
 * drafts file ({ drafts: { [showId]: {...} } }). peersByMarket: market -> [{id, cs}].
 */
function selectCandidates({ shows, slims, drafts, peersByMarket, today, seenLookup = () => null, forceShowId = null }) {
  const already = (drafts && drafts.drafts) || {};
  // One id, an array, or "a,b,c": the owner can ask for several redrafts at once.
  const forced = forceShowId ? new Set([].concat(forceShowId).flatMap(x => String(x).split(',')).map(x => x.trim()).filter(Boolean)) : null;
  // Broadway productions that are current, upcoming, or opened in the last
  // 5 years: a 1990s revival doesn't make a Globe Shakespeare r/Broadway news.
  const recentYear = Number(String(today).slice(0, 4)) - 5;
  const broadwayTitles = new Set(shows
    .filter(x => marketOf(x) === 'broadway')
    .filter(x => ['open', 'previews', 'upcoming'].includes(x.status) || Number(String(x.openingDate || '').slice(0, 4)) >= recentYear)
    .map(x => normTitle(x.title)));
  const out = [];
  for (const show of shows) {
    const market = marketOf(show);
    if (!SUBREDDIT_BY_MARKET[market]) continue;
    if (forced) {
      if (!forced.has(show.id)) continue;
    } else {
      const prev = already[show.id];
      // An existing draft is left alone, unless its LLM call failed, or it is
      // still unposted with its reminder not sent yet and no longer matches
      // today's numbers (counts and ranks move as reviews land): then it is
      // redrafted (see below), so the reminder email carries fresh numbers.
      // The owner posted the first two with stale counts (Woolf drafted at 21
      // reviews, 24 by the time they posted; BRO-4597).
      if (prev && !isRetryableDraft(prev) && !isRefreshable(prev)) continue;
      if (!show.openingDate) continue;
      const age = daysBetween(show.openingDate, today);
      if (age < MIN_AGE_DAYS || age > MAX_AGE_DAYS) continue;
    }
    const slim = slims.get(show.id);
    if (!slim) continue;
    const reviewCount = slim.rc || (slim.rv || []).length;
    if (!forceShowId && reviewCount < MIN_REVIEWS[market]) continue;
    const facts = buildFacts(show, slim, peersByMarket[market] || [], { seen: seenLookup(show.title), crosspost: crosspostSubreddit(show, broadwayTitles) });
    if (!facts) continue;
    const prev = already[show.id];
    if (!forceShowId && prev && !isRetryableDraft(prev) && prev.subreddit === facts.subreddit && lintDraft(prev, facts).ok) continue; // unsent but still accurate
    // Off-West End shows only when they'd carry a post on their own.
    if (!forceShowId && market === 'off-west-end' && notability(facts) < 25) continue;
    out.push({ show, facts, notability: notability(facts), refresh: !!(prev && prev.emailedAt) });
  }
  // New openings first: a refresh of an already-emailed draft must never
  // take a run's slot from a show the owner hasn't heard about yet.
  out.sort((a, b) => (a.refresh - b.refresh) || (b.notability - a.notability));
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

THE VOICE TOM WANTS (he rewrote the first two drafts by hand, Oct 2026; copy
what he changed):
- Tom collected these reviews himself, so he talks like it. First person:
  "I found 11 reviews: 3 raves, 3 positive, 4 mixed, 1 negative." Never the
  detached "it's an 84/100 across 21 reviews" or "That's a 68/100 for X".
- The review count goes in the title next to the score: "84/100 from 24
  critics!" or "11 reviews are in for X. 69/100, with ...". An exclamation
  mark is fine when the news is good.
- When there's an audience grade, say where it comes from, in plain words:
  "Audiences are at an A- (across Mezzanine, Seatplan, London Theatre Direct,
  and Reddit)." Use the names in audienceSources. With no grade, say why in
  human terms: "No audience grade yet, since hardly any users have reviewed it
  on any of the sites."
- Quotes carry the post. Two or three short ones, each introduced plainly
  ("Laura Collins-Hughes at the NYT called it ...", "Meanwhile Sara Holdren at
  Vulture wrote ..."). Cut the analyst sentences around them: no "The
  interesting part is how the critics split", no "The fans loved X. The
  skeptics found Y." summary paragraph, no "Critics are split on ..., and it
  mostly comes down to style."
- Tom's own reaction is short and casual, even blunt: "Which I GET." He ends
  with where he stands personally, then (optionally) one question to the sub.
  ownerStance tells you what is true:
    seen        -> he can mention he saw it (no opinion beyond OWNER HISTORY rating)
    has-tickets -> he's going soon
    not-seen    -> "I haven't seen this one yet" style, plus a feeling about
                   whether he wants to go ("So I remain undecided on going to
                   this one still." / "and am desperate to."). Pick the feeling
                   that fits the reviews; Tom checks it before posting.
- One question at most. He cut "Does the length feel earned, or do you start
  checking your watch?" and kept just "Anyone seen it?".

TOM'S TWO HAND-EDITED POSTS (the target voice; match the shape, not the facts):
---
TITLE: Reviews are in for Who's Afraid of Virginia Woolf? 84/100 from 24 critics!
It opened at Soho Place with Gillian Anderson and Billy Crudup, and I found 13 raves, 7 positive, 3 mixed, and 1 negative review. Audiences are at an A- (across Mezzanine, Seatplan, London Theatre Direct, and Reddit).

https://westendscorecard.com/show/whos-afraid-of-virginia-woolf-west-end

The raves are all about the intensity. The Independent's Alice Saville wrote "If you want to be deeply, profoundly disturbed by a night at the theatre, there's no finer way to do it than this." The mixed ones are mostly about stamina and sameness. The Times wrote "There's so much to admire here, but too little range." Some also found the three-hour runtime a lot. Which I GET.

So it sounds like a punishing evening, but the kind people seem to want. Anyone seen it?

I've never seen this show somehow, and am desperate to.
---
TITLE: 11 reviews are in for Creation Stories and all the important importants. 69/100, with a NYT rave and a Vulture pan in the same pile
I found 11 reviews: 3 raves, 3 positive, 4 mixed, 1 negative.

Laura Collins-Hughes at the NYT called it a "haunted, surreally comic, tender heartbreaker of a play." Meanwhile Sara Holdren at Vulture wrote "Oh, the fallacy of thinking that just because something hurts, it is profound." Michael Sommers was one of the mixed reviews, saying stretches of the play "escaped me entirely."

No audience grade yet, since hardly any users have reviewed it on any of the sites. So I remain undecided on going to this one still.

https://broadwayscorecard.com/show/creation-stories-and-all-the-important-importants-off-broadway
---

WHAT WORKED IN TOM'S EARLIER POSTS (upvotes in brackets):
- A title that leads with the show and the number, plus ONE hook that gives the
  number meaning: a record, a rank, a comparison, a surprise.
  "CATS scores 88/100. Highest-scoring Broadway musical revival on the site. Ever." [575]
  "Rocky Horror gets a 69. Not as high as they would have liked, but a number they'd appreciate" [346]
  "Reviews are in for Trainspotting the Musical. 36/100 from critics, the lowest critic score in the West End right now" [95 on r/TheWestEnd]
  "Reviews are in for Every Brilliant Thing! 80/100 and every single review is basically about Radcliffe" [226]
- The body opens with what Tom found, in plain words:
  "I found 22 reviews: 16 raves, 5 positive, 1 mixed, zero negative."
- One specific, interesting thing the critics agreed on (praised the lead but
  blamed the book, everyone mentions the set, a lone dissenter).
- Audience grade next to the critics when it exists, and whether they agree.
- A little personality: a wry aside, honest uncertainty, light humor.
- Ends by asking the sub something real ("Anyone caught it in previews? Does
  that match what you saw?").
- One link, bare, either right after the opening paragraph or at the very end.

A FULL REAL POST OF TOM'S (95 upvotes, r/TheWestEnd). Match this energy and shape,
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
  Tom's 0-point post). Never say a show is bad because of a number. Report what
  critics said; let readers decide.
- Roundups of several small shows with no personal hook (6 and 14 upvotes).
- Sounding like marketing. Tom built the site and says so plainly when it comes
  up, but the post is about the show, never the site.

VOICE:
- Warm, curious, a bit nerdy about the data, genuinely into theater.
- Short paragraphs. 80-160 words in the body. Contractions. Casual, first
  person, like someone who read all the reviews and is telling friends.
- In r/TheWestEnd Tom is a friendly visitor from NYC; don't fake British idiom.
- At most one "lol" or "haha". Emoji: none, or one at most.

HARD RULES:
- Use ONLY the facts in the FACT SHEET. Never invent quotes, critics, box
  office, transfers, awards, cast, or comparisons that aren't given.
- Quote critics only with words that appear in the FACT SHEET quotes, copied
  exactly, and name that quote's outlet or critic in the same sentence. Don't
  quote the consensus text; paraphrase it.
- Never use these phrases (they read as AI or marketing): "I'd love to",
  "would love to", "making waves", "buzzing about", "Hey Broadway fans",
  "passion project", "must-see", "high marks", "the critics have spoken",
  "dive into", "delve", "journey", "navigate", "Absolutely!", or a dramatic
  "The big question? ..." fragment.
- Do not claim Tom has seen the show unless ownerStance is "seen". If it is
  "has-tickets", you may say he's going soon. If "not-seen", he may say he
  hasn't seen it yet; never that he saw it.
- Never invent Tom's plans, trips, dates, or opinions (no "planning to see it next
  month", no "the film, which I love"). The same goes for personalLines: write
  them as honest options Tom can pick only if true, e.g. "Would you see it?"
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
 * The owner's best recent "reviews are in" style posts, freshest voice first. Pulled
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
    ? `TOM'S MOST RECENT WELL-RECEIVED POSTS (match this voice, not these facts):\n${examples.map(e =>
      `--- r/${e.subreddit}, ${e.date}, ${e.upvotes} upvotes\nTITLE: ${e.title}\n${e.body}`).join('\n\n')}\n---\n\n`
    : '';
  return `${ex}FACT SHEET (JSON):
${JSON.stringify(facts, null, 2)}

Write the post for r/${facts.subreddit}.

Return JSON only, no prose around it:
{
  "title": "post title, under 200 characters",
  "body": "post body in Reddit markdown, first person ('I found ...'), with the link ${facts.url} after the opening paragraph or at the end",
  "why": "one sentence: the hook you chose and why it should land",
  "expectedPushback": "one sentence: the most likely snarky or critical comment",
  "suggestedReply": "a short, friendly reply Tom could give to that comment, in Tom's voice",
  "personalLines": ["2 or 3 alternative closing lines in Tom's voice for where he stands (e.g. 'Still undecided on this one.', 'Now I'm desperate to see it.', 'Not sure this one's for me.'), so he can swap the body's closer. Must fit ownerStance; never claim he saw it unless it is 'seen'."]
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
  // "The big talking point? Critics..." dramatic fragment (anti-slop rule).
  /(^|[.!]\s+)The [a-z][a-z ]{1,30}\? [A-Z]/m,
  /\bhope this finds\b/i, /\bexcited to share\b/i,
];

function normQuote(s) {
  return String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
}

// Spans that read as quotations: "double", “curly”, ‘curly single’, 'single'
// (opening quote after a space or start, so apostrophes don't count), and
// *italic* / _italic_ markdown.
function quotedSpans(text) {
  const out = [];
  const t = String(text || '');
  const res = [
    /["“]([^"”\n]{2,400})["”]/g,
    /‘([^’\n]{2,400})’/g,
    /(?:^|[\s(])'([^'\n]{2,400}?)'(?=[\s.,!?;:)]|$)/g,
    /(?:^|[^*])\*([^*\n]{2,400})\*(?!\*)/g,
    /(?:^|\s)_([^_\n]{2,400})_(?=[\s.,!?;:]|$)/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(t))) out.push({ text: m[1].replace(/[.,!?]+$/, ''), index: m.index });
  }
  return out;
}

const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

// "twenty-three raves" -> "23 raves", so word numbers get the same checks.
function wordsToDigits(text) {
  return String(text || '').replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_, a, b) => String(NUM_WORDS[a.toLowerCase()] + NUM_WORDS[b.toLowerCase()]))
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi,
      w => String(NUM_WORDS[w.toLowerCase()]));
}

// The sentence around position i (for quote attribution).
function sentenceAt(text, i) {
  const start = Math.max(text.lastIndexOf('. ', i), text.lastIndexOf('\n', i), text.lastIndexOf('! ', i), text.lastIndexOf('? ', i)) + 1;
  const ends = ['. ', '\n', '! ', '? '].map(x => text.indexOf(x, i + 1)).filter(x => x >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length);
}

/**
 * Fact checks shared by every piece of text that could end up on Reddit
 * (title, body, the suggested reply, the optional personal lines).
 */
function factProblems(where, raw, facts, { isPersonal = false } = {}) {
  const problems = [];
  const text = wordsToDigits(String(raw || '').replace(/https?:\/\/\S+/g, ''));
  const allowed = allowedNumbers(facts);
  for (const n of (text.match(/\d+/g) || []).map(Number)) {
    if (!allowed.has(n)) problems.push(`${where} has number ${n} that is not in the fact sheet`);
  }
  for (const m of text.match(/\b\d{1,3}\s*\/\s*100\b/g) || []) {
    if (parseInt(m, 10) !== facts.score) problems.push(`${where} cites ${m}, fact sheet says ${facts.score}/100`);
  }
  if (/\d\s*(%|percent)/i.test(text)) problems.push(`${where} uses a percentage the fact sheet doesn't give`);

  // Counts must match what they count ("24 raves" is wrong even if 24 is the opening day).
  const b = facts.buckets || {};
  const counted = [
    [/(\d+)\s+(?:raves?)\b/gi, b.rave, 'raves'],
    [/(\d+)\s+(?:positives?)\b/gi, b.positive, 'positive'],
    [/(\d+)\s+(?:mixed)\b/gi, b.mixed, 'mixed'],
    [/(\d+)\s+(?:negatives?|pans?)\b/gi, b.negative, 'negative'],
    [/(\d+)\s+(?:critic\s+)?reviews?\b/gi, facts.reviewCount, 'reviews'],
    [/(\d+)\s+(?:critics)\b/gi, facts.reviewCount, 'critics'],
  ];
  for (const [re, want, label] of counted) {
    let m;
    while ((m = re.exec(text))) {
      const n = Number(m[1]);
      // "5 reviews" may be a subset ("only 5 reviews are negative"), but can't exceed the total.
      const ok = label === 'reviews' || label === 'critics' ? n <= (want || 0) : n === (want || 0);
      if (!ok) problems.push(`${where} says ${n} ${label}, fact sheet says ${want || 0}`);
    }
  }

  // Grades, with or without +/- ("a B", "an F", "a B+ grade").
  const rawStr = String(raw || '');
  const gradeRe = /\b(?:at|is|gets?|got|given|of|with|an?|grade)\s+(?:an?\s+)?([A-DF][+-]?)(?![A-Za-z0-9]|-[a-z])|\b([A-DF][+-]?)\s+grade\b/g;
  let g;
  while ((g = gradeRe.exec(rawStr))) {
    const grade = g[1] || g[2];
    // "a" / "A" is usually the article; only treat a bare A as a grade when the sentence is about grades or audiences.
    if (grade === 'A' && !/grade|audience/i.test(sentenceAt(rawStr, g.index))) continue;
    if (grade !== facts.audienceGrade) problems.push(`${where} cites grade ${grade}, fact sheet says ${facts.audienceGrade || 'none'}`);
  }

  // "#N of M" must be exactly the computed rank.
  let rk;
  const rankRe = /#(\d+)\s+of\s+(?:the\s+)?(\d+)/g;
  while ((rk = rankRe.exec(text))) {
    if (Number(rk[1]) !== facts.rankPosition || Number(rk[2]) !== facts.rankOf) {
      problems.push(`${where} says #${rk[1]} of ${rk[2]}, the computed rank is ${facts.rankPosition ? `#${facts.rankPosition} of ${facts.rankOf}` : 'none'}`);
    }
  }
  // Rank and superlative claims need a computed, untied rank behind them.
  if (!facts.rankNote && (/#\d+\s+of\s+\d+/.test(text) || /\b(highest|lowest|best|worst|top|bottom)[- ](rated|scoring|reviewed|score|scored)\b/i.test(text))) {
    problems.push(`${where} makes a rank claim the fact sheet doesn't support`);
  }

  // No claim the owner saw it unless their history says so. Personal lines
  // may say it only as an explicit "[if true]" option they pick themselves.
  const h = facts.ownerHistory;
  const saw = /\b(I|we)\s*(saw|caught|watched|'ve seen|'ve caught|have seen|have caught)\b|\bsaw it\b/i;
  if (!(h && h.seen) && saw.test(rawStr) && !(isPersonal && /^\[if true\]/i.test(rawStr.trim()))) {
    problems.push(`${where} claims owner saw a show their history does not list`);
  }
  return problems;
}

function stripDashes(s) {
  return String(s || '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?])/g, '$1');
}

/**
 * Numbers a draft may state: the counts and ranks we computed, the critic
 * scores behind the quotes, the opening date, and digits that appear in the
 * show's own name, venue, consensus or quotes ("Table 17", "after 39 years").
 * Deliberately NOT every digit in the fact sheet: that let any stray small
 * number through (ship-check 2026-09-29).
 */
function allowedNumbers(facts) {
  const nums = new Set([0, 1, 100]);
  const add = v => { if (typeof v === 'number' && Number.isFinite(v)) nums.add(v); };
  [facts.score, facts.reviewCount, facts.audienceCount, facts.rankPosition, facts.rankOf].forEach(add);
  Object.values(facts.buckets || {}).forEach(add);
  const quotes = [...(facts.bestQuotes || []), ...(facts.worstQuotes || []), facts.loneDissenter].filter(Boolean);
  quotes.forEach(q => add(q.score));
  if (facts.openingDate) facts.openingDate.split('-').map(Number).forEach(add);
  const texts = [facts.title, facts.venue, facts.consensus, facts.rankNote, ...(facts.cast || []), ...quotes.map(q => q.quote)];
  for (const t of texts) for (const d of String(t || '').match(/\d+/g) || []) add(Number(d));
  return nums;
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

  // Every number, count, grade, rank and "I saw it" claim in anything that
  // gets pasted to Reddit must be backed by the fact sheet.
  problems.push(...factProblems('title', draft.title, facts));
  problems.push(...factProblems('body', draft.body, facts));
  problems.push(...factProblems('suggestedReply', draft.suggestedReply, facts));
  draft.personalLines.forEach((l, i) => problems.push(...factProblems(`personalLine${i + 1}`, l, facts, { isPersonal: true })));

  if (!draft.body.includes(facts.url)) {
    draft.body = `${draft.body}\n\n${facts.url}`;
  }
  // The reply and personal lines get pasted to Reddit too.
  const extras = [draft.suggestedReply, ...draft.personalLines];
  for (const re of BANNED) {
    for (const t of [draft.title, draft.body, ...extras]) {
      const m = t.match(re);
      // Quote the offending words, not the regex: the retry prompt feeds this back to the model.
      if (m) { problems.push(`remove the phrase "${m[0].trim()}"`); break; }
    }
  }
  if (/\brank(ing|ings|ed)?\b[^.]*\b(consider|factor|weigh|include)/i.test(draft.suggestedReply)) {
    problems.push('suggestedReply explains the ranking method (not supported by facts)');
  }
  const words = draft.body.split(/\s+/).filter(Boolean).length;
  if (words > 260) problems.push(`body too long (${words} words)`);

  // Anything that reads as a quotation must be a real critic line, credited
  // in the same sentence to an outlet or critic that actually wrote it, and
  // not a fragment lifted out of a negation ("a triumph" from "not a
  // triumph"). A made-up or misattributed quote is the one thing Reddit
  // would rightly never forgive. The site's own consensus is not a quote.
  const critics = [facts.bestQuotes, facts.worstQuotes, [facts.loneDissenter]].flat().filter(Boolean);
  for (const [where, text] of [['title', draft.title], ['body', draft.body], ['suggestedReply', draft.suggestedReply]]) {
    for (const span of quotedSpans(text)) {
      const q = normQuote(span.text);
      if (!q || q.split(' ').length < 2) continue;
      if (q === normQuote(facts.title)) continue; // the show's own title in quotes is not a critic quote
      const hits = critics.filter(c => {
        const src = ` ${normQuote(c.quote)} `;
        const at = src.indexOf(` ${q} `);
        if (at < 0) return false;
        return !/\b(not|never|hardly|no)\s*$|n't\s*$/.test(src.slice(Math.max(0, at - 12), at + 1));
      });
      if (!hits.length) { problems.push(`${where}: quote not found in the reviews: "${span.text.slice(0, 60)}"`); continue; }
      const sentence = sentenceAt(text, span.index).toLowerCase();
      const credited = hits.some(c => [c.outlet, c.critic].filter(Boolean).some(n => sentence.includes(String(n).toLowerCase())));
      if (!credited) problems.push(`${where}: quote "${span.text.slice(0, 40)}" is not credited to the outlet that wrote it`);
    }
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

function aOrAnGrade(g) {
  return /^[AEF]/.test(g) ? 'an' : 'a';
}

// " (across Mezzanine, Seatplan, and Reddit)", or "" with no named source.
function audienceAcross(facts) {
  const n = facts.audienceSources || [];
  if (!n.length) return '';
  const list = n.length === 1 ? n[0] : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0, -1).join(', ')}, and ${n[n.length - 1]}`;
  return ` (across ${list})`;
}

// Tom's closer, only ever claiming what data/shows-seen.json supports.
function stanceLine(facts) {
  if (facts.ownerStance === 'seen') return 'I saw this one. Anyone else been yet?';
  if (facts.ownerStance === 'has-tickets') return "I've got tickets, so I'll report back. Anyone seen it yet?";
  return "I haven't seen it yet. Anyone been?";
}

function templateDraft(facts) {
  // Only the clean superlatives make a good title hook.
  const hook = facts.rankNote && !facts.rankNote.startsWith('#') ? `, the ${facts.rankNote}` : '';
  // "Virginia Woolf?" already ends the sentence: no "Woolf?." in the title.
  const stop = /[.?!]$/.test(facts.title) ? '' : '.';
  const title = `${facts.reviewCount} reviews are in for ${facts.title}${stop} ${facts.score}/100${hook}`;
  const lines = [];
  lines.push(`It opened${facts.venue ? ` at ${facts.venue}` : ''}, and I found ${facts.reviewCount} reviews: ${breakdownSentence(facts.buckets)}. That works out to ${aOrAn(facts.score)} ${facts.score}/100.`);
  const consensus = stripDashes(facts.consensus || '');
  // The consensus is the site's own summary: use it only if it passes the
  // same checks and quotes nobody (a quoted phrase would read as a critic quote).
  const quotesSomeone = quotedSpans(consensus).some(sp => normQuote(sp.text) !== normQuote(facts.title));
  if (consensus && !quotesSomeone && !BANNED.some(re => re.test(consensus)) && !factProblems('consensus', consensus, facts).length) lines.push(consensus);
  if (facts.audienceGrade) lines.push(`Audiences are at ${aOrAnGrade(facts.audienceGrade)} ${facts.audienceGrade}${audienceAcross(facts)}.`);
  else lines.push('No audience grade yet, since hardly any users have reviewed it on any of the sites.');
  if (facts.loneDissenter) lines.push(`${facts.loneDissenter.outlet} is the lone holdout.`);
  lines.push(stanceLine(facts));
  lines.push(facts.url);
  return {
    title: stripDashes(title),
    body: stripDashes(lines.join('\n\n')),
    why: 'Template fallback: plain roundup with the score, breakdown and critic consensus.',
    expectedPushback: 'Someone may say numbers can\'t capture theater.',
    suggestedReply: 'Totally fair, the number is just a quick way to see where critics landed. The reviews themselves are the fun part.',
    personalLines: facts.ownerStance === 'not-seen'
      ? ["I haven't seen it yet, and now I really want to.", 'Still undecided on going to this one.']
      : [],
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

const THEATER_SUBS = new Set(['broadway', 'thewestend', 'offbroadwaynyc', 'offbroadway', 'musicals', 'theatre', 'londontheatre']);

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
    // ("Rocky Horror gets a 69") but which link the page, as the owner's always do.
    const slug = d.url ? String(d.url).replace(/\/+$/, '').split('/').pop() : null;
    if ((!key || key.length < 3) && !slug) continue;
    const createdSec = Date.parse(d.createdAt) / 1000 - 3 * 86400; // allow posting a bit before the draft
    const hit = (posts || []).find(p => {
      if (!p || (p.created_utc || 0) < createdSec) return false;
      // A post removed by mods or AutoModerator isn't posted.
      if (p.removed_by_category || /^\[(removed|deleted)\]$/.test(String(p.selftext || '').trim())) return false;
      const hay = `${p.selftext || ''} ${p.url || ''}`.toLowerCase();
      if (slug) {
        const needle = `/show/${slug.toLowerCase()}`;
        let at = hay.indexOf(needle);
        while (at >= 0) {
          if (!/[a-z0-9-]/.test(hay[at + needle.length] || '')) return true; // not a prefix of a longer slug
          at = hay.indexOf(needle, at + 1);
        }
      }
      // Title fallback: whole-word match, and only in the draft's own
      // subreddit, so a r/Broadway post about the Broadway Kimberly Akimbo
      // doesn't clear the Off-West End transfer's draft.
      if (!key || key.length < 3) return false;
      const subs = [d.subreddit, d.crosspostSubreddit].filter(Boolean).map(x => String(x).toLowerCase());
      if (!subs.includes(String(p.subreddit || '').toLowerCase())) return false;
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

/**
 * A redraft whose LLM calls all failed falls back to the plain template. That
 * must not replace a voiced draft the owner hasn't posted yet: keep the old one.
 */
function keepPreviousDraft(prev, source) {
  return !!prev && prev.status === 'ready' && source === 'template' && !!prev.source && prev.source !== 'template';
}

/** Drafts the email should show today: ready, not posted, not stale. */
function activeDrafts(drafts, nowMs) {
  return Object.values((drafts && drafts.drafts) || {})
    .filter(d => d.status === 'ready')
    .filter(d => (nowMs - Date.parse(d.createdAt)) / 86400000 <= DRAFT_TTL_DAYS)
    .sort((a, b) => (b.notability || 0) - (a.notability || 0));
}

module.exports = {
  keepPreviousDraft,
  SUBREDDIT_BY_MARKET,
  MIN_REVIEWS,
  audienceSourceNames,
  ownerStance,
  MAX_AGE_DAYS,
  DRAFT_TTL_DAYS,
  STYLE_GUIDE,
  marketOf,
  showUrl,
  audienceGradeLetter,
  buildPeers,
  buildFacts,
  allowedNumbers,
  notability,
  selectCandidates,
  crosspostSubreddit,
  makeSeenLookup,
  normTitle,
  buildUserPrompt,
  pickRecentExamples,
  lintDraft,
  stripDashes,
  quotedSpans,
  factProblems,
  wordsToDigits,
  templateDraft,
  submitUrl,
  oldRedditSubmitUrl,
  applyPostedDetection,
  activeDrafts,
};
