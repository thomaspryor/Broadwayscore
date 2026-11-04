// The fact pool for an AI-written score post (BRO-6959). Code computes every fact from the
// site's own data; the writer may only use these facts, and every number in its post must be
// one of `numbers`. Each fact carries a weight so the writer sees what is unusual first.

const { getScoreTierId, getScoreTierLabel, getReviewBreakdownTierId } = require('../lib/score-tiers.js');
const { getAudienceGrade, totalAudienceReviews, MIN_AUDIENCE_REVIEWS } = require('../lib/audience-grade.js');
const { sameTitle, findLondonRun } = require('../lib/transfer-detection.js');
const { MARKETS, marketOf } = require('./config');
const TOURING = new Set(['regional', 'tour']); // posting markets since BRO-6935, but never cited as an "earlier production"

const MIN_RANK_REVIEWS = 8; // a show needs this many reviews to be ranked against its peers
const MIN_PEERS = 4; // a rank among fewer shows says nothing
const DAY_MS = 864e5;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Most recent September 1 or March 1 on or before `now`: the start of the season half we rank within. */
function seasonStart(now) {
  const d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 8) return Date.UTC(y, 8, 1);
  if (m >= 2) return Date.UTC(y, 2, 1);
  return Date.UTC(y - 1, 8, 1);
}

/** Counts in the site's breakdown-bar buckets (the same rule as run.js breakdownFor). */
function tally(reviews, category, filter = () => true) {
  const b = { rave: 0, positive: 0, mixed: 0, negative: 0 };
  for (const r of reviews || []) {
    if (!filter(r)) continue;
    const k = getReviewBreakdownTierId(r && r.v, r && r.s, category);
    if (k) b[k]++;
  }
  return b;
}
const total = b => b.rave + b.positive + b.mixed + b.negative;

/** The label shown next to a review on the site, when it agrees with the bar's bucket (pan counts as negative). */
function agreedLabel(r, category) {
  const k = getReviewBreakdownTierId(r.v, r.s, category);
  const b = String(r.b || '').toLowerCase();
  if (!k || !b) return null;
  if (b === k || (b === 'pan' && k === 'negative')) return b;
  return null;
}

function audienceGrade(pub) {
  const au = pub && pub.au;
  if (!au || !Number.isFinite(au.score) || totalAudienceReviews(au) < MIN_AUDIENCE_REVIEWS) return null;
  return { score: au.score, grade: getAudienceGrade(au.score).grade };
}

const opened = s => Date.parse(`${String(s.openingDate || '').slice(0, 10)}T00:00:00Z`);
const hasRankableScore = p => p && Number.isFinite(p.cs) && (p.rc || 0) >= MIN_RANK_REVIEWS;

/**
 * @param {object} show  shows.json row
 * @param {{shows: object[], slim: object}} ctx  slim[id] is public/data/shows/<id>.json
 * @param {number} now   ms; the post date
 * @returns {{facts: {tag, weight, text}[], numbers: Set<string>, title: string, market: string}}
 */
function buildFactPool(show, ctx, now) {
  const pub = ctx.slim[show.id];
  if (!pub || !Number.isFinite(pub.cs)) throw new Error(`${show.id}: no Critic Score`);
  const market = marketOf(show), cat = show.category;
  if (!MARKETS[market]) throw new Error(`${show.id}: no social market for ${market}`);
  const label = MARKETS[market].label;
  const score = Math.round(pub.cs), tierId = getScoreTierId(score, cat), tierLabel = getScoreTierLabel(score, cat);
  const facts = [], nums = new Set();
  const add = (tag, weight, text, numbers = []) => { facts.push({ tag, weight, text }); numbers.forEach(n => nums.add(String(n))); };

  // Core facts: always given, never the lead on their own.
  add('score', 1, `Critic Score: ${score} (${tierLabel}) from ${pub.rc} critics' reviews. It is a weighted average; top-tier outlets count most.`, [score, pub.rc]);
  const b = tally(pub.rv, cat);
  const pans = (pub.rv || []).filter(r => String(r.b).toLowerCase() === 'pan' && agreedLabel(r, cat) === 'pan');
  add('tally', 1, `All reviews: ${b.rave} rave, ${b.positive} positive, ${b.mixed} mixed, ${b.negative} negative${pans.length ? ` (the negatives include ${pans.length} pans: ${pans.slice(0, 4).map(r => r.o).join(', ')})` : ''}.`, [b.rave, b.positive, b.mixed, b.negative, pans.length, b.rave + b.positive, b.mixed + b.negative]);

  const top = (pub.rv || []).filter(r => r.t === 1);
  const t = tally(top, cat), tn = total(t);
  if (tn >= 3) {
    const named = {};
    for (const r of top) { const l = agreedLabel(r, cat); if (l) (named[l] = named[l] || []).push(r.o); }
    const pos = t.rave + t.positive, neg = t.negative;
    const allPos = pos === tn, allNeg = neg === tn;
    add('top-tier', allPos || allNeg ? 3 : (pos && neg ? 2 : 1),
      `Top-tier critics (${tn} of them): ${t.rave} rave, ${t.positive} positive, ${t.mixed} mixed, ${t.negative} negative.${allPos ? ' Every one was positive.' : allNeg ? ' Every one was negative.' : ''}${Object.keys(named).length ? ` Outlets you may name (the site labels these reviews the same way; the list may be shorter than the counts, so never pair a count with this list): ${Object.entries(named).map(([k, v]) => `${k}: ${[...new Set(v)].join(', ')}`).join('; ')}.` : ''}`,
      [tn, t.rave, t.positive, t.mixed, t.negative, pos, t.mixed + t.negative]);
  }
  if (total(b) >= 15 && b.negative === 0) add('no-negatives', b.mixed === 0 ? 3 : 2, b.mixed === 0 ? `Not one of the ${pub.rc} reviews was mixed or negative.` : `None of the ${pub.rc} reviews was negative.`, [pub.rc]);

  // Rank among this season half's openings in the same market, counting only shows with enough reviews.
  const start = seasonStart(now);
  const since = `${MONTHS[new Date(start).getUTCMonth()]} 1`;
  const peers = ctx.shows.filter(s => s.category === cat && marketOf(s) === market && opened(s) >= start && opened(s) <= now && hasRankableScore(ctx.slim[s.id]));
  if (peers.length >= MIN_PEERS && peers.some(s => s.id === show.id)) {
    // Ranked on the rounded score the site shows, so two shows both showing 72 are tied.
    const shown = s => Math.round(ctx.slim[s.id].cs);
    const others = peers.filter(s => s.id !== show.id), n = peers.length;
    const rank = 1 + others.filter(s => shown(s) > score).length, tied = others.filter(s => shown(s) === score).length;
    const top = rank === 1, bottom = rank + tied === n;
    const where = top ? (tied ? 'tied for the highest' : 'the highest') : bottom ? (tied ? 'tied for the lowest' : 'the lowest') : `number ${rank}${tied ? ' (tied)' : ''}`;
    add('season-rank', top || bottom ? 3 : rank <= 3 && n >= 10 ? 2 : 0,
      `Critic Score rank: ${where} of the ${n} ${label} shows that opened since ${since} and have at least ${MIN_RANK_REVIEWS} reviews (always keep that qualifier; ${n} is not the number of shows that opened).`,
      [rank, n, MIN_RANK_REVIEWS, 1]);
  }

  // Audiences: a letter grade only (VOICE.md rule 8). Its rank uses the same peers.
  const g = audienceGrade(pub);
  if (g) {
    let rankText = '', w = 1;
    const ap = peers.filter(s => audienceGrade(ctx.slim[s.id]));
    if (ap.length >= MIN_PEERS && ap.some(s => s.id === show.id)) {
      // Compared by the grade the site shows: a higher score inside the same grade is a tie.
      const others = ap.filter(s => s.id !== show.id).map(s => audienceGrade(ctx.slim[s.id]));
      const higher = others.some(o => o.score > g.score && o.grade !== g.grade), same = others.filter(o => o.grade === g.grade).length;
      if (!higher) { rankText = ` ${same ? `It is tied for the best audience grade (with ${same} other show${same > 1 ? 's' : ''})` : 'It is the best audience grade'} among those same ${ap.length} shows that have one.`; w = 2; nums.add(String(ap.length)); if (same) nums.add(String(same)); }
    }
    const critLow = ['skippable', 'stay-away'].includes(tierId), critHigh = ['must-see', 'recommended'].includes(tierId);
    const audHigh = /^A/.test(g.grade) || (tierId === 'stay-away' && /^B/.test(g.grade)), audLow = /^[CDF]/.test(g.grade);
    if ((critLow && audHigh) || (critHigh && audLow)) w = 3;
    add('audience', w, `Audience grade: ${g.grade}. Audiences get a letter grade only; never write a number, percentage or point gap for audiences.${rankText}${w === 3 ? ' Critics and audiences disagree on this one.' : ''}`);
  }

  // Weekly ticket sales (Broadway grosses reports only).
  const cap = pub.bo && pub.bo.tw && Number.isFinite(pub.bo.tw.c) ? Math.round(pub.bo.tw.c) : null;
  if (cap != null) {
    const w = (cap >= 97 && !['must-see', 'recommended'].includes(tierId)) || (cap < 60 && ['must-see', 'recommended'].includes(tierId)) ? 2 : 0;
    add('capacity', w, `Last week it sold ${cap}% of its seats.`, [cap]);
  }

  // An earlier production of the same title with a score. A New York show's London run gets its own
  // comparison post the next day (select.js findLondonCompareEvents), so it is left out here.
  // Same score rule as select.js hasSiteScore, so the run the compare post covers is the one left out.
  const london = findLondonRun(show, ctx.shows, { hasScore: id => { const p = ctx.slim[id]; return !!p && Number.isFinite(p.cs) && !!p.rc; } }).london;
  const earlier = ctx.shows
    .filter(s => s.id !== show.id && (!london || s.id !== london.id) && MARKETS[marketOf(s)] && !TOURING.has(s.category) && s.type && s.type === show.type && opened(s) < opened(show) && sameTitle(s.title, show.title) && hasRankableScore(ctx.slim[s.id]))
    .sort((x, y) => opened(y) - opened(x))[0];
  if (earlier) {
    const e = ctx.slim[earlier.id], es = Math.round(e.cs), yr = String(earlier.openingDate).slice(0, 4);
    add('earlier-production', Math.abs(es - score) >= 5 ? 3 : 1, `Earlier production: ${MARKETS[marketOf(earlier)].label} ${yr}, Critic Score ${es} from ${e.rc} critics' reviews.`, [es, e.rc, yr]);
  }

  // Closing soon.
  if (show.closingDate) {
    // Calendar days in the market's time zone: a 10am New York post is 14:00Z, so timestamps would be a day short.
    const postDay = new Intl.DateTimeFormat('en-CA', { timeZone: MARKETS[market].tz }).format(new Date(now));
    const days = Math.round((Date.parse(`${show.closingDate}T00:00:00Z`) - Date.parse(`${postDay}T00:00:00Z`)) / DAY_MS);
    if (days >= 0 && days <= 21) add('closing', ['must-see', 'recommended'].includes(tierId) ? 2 : 1, `It closes on ${MONTHS[+show.closingDate.slice(5, 7) - 1]} ${+show.closingDate.slice(8, 10)}, ${days} days after this post.`, [days, +show.closingDate.slice(8, 10)]);
  }

  // No cast list: pub.ca is alphabetical, not billing order, so it would put minor actors forward.
  // The critics' summary names the performers critics singled out.
  const cn = pub.cn && pub.cn.t;
  if (cn) add('critics-summary', 0, `What critics said, summarized on the site (use for color only; attribute any opinion to critics, never state it as ours): ${cn}`);

  facts.sort((x, y) => y.weight - x.weight);
  return { title: show.title, market: label, facts, numbers: nums };
}

/** The pool as the text block the writer and the checker both read. */
function factSheet(pool) {
  const standout = pool.facts.filter(f => f.weight >= 2);
  const rest = pool.facts.filter(f => f.weight < 2);
  return [
    `SHOW: ${pool.title} (${pool.market})`,
    standout.length ? `STANDOUT FACTS (most unusual first; lead with one of these):\n${standout.map(f => `- [${f.tag}] ${f.text}`).join('\n')}` : 'STANDOUT FACTS: none; lead with whatever is most interesting below.',
    `OTHER FACTS:\n${rest.map(f => `- [${f.tag}] ${f.text}`).join('\n')}`,
  ].join('\n\n');
}

module.exports = { buildFactPool, factSheet, seasonStart, tally, MIN_RANK_REVIEWS };
