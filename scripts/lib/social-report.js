/**
 * social-report.js — the Social section of the Monday traffic email (BRO-6377).
 *
 * Pure: takes Buffer's sent posts (with their metrics), the autopost ledger
 * and PostHog visit rows, returns the report scripts/build-social-report.js
 * writes and scripts/lib/traffic-report-email.js renders. No I/O here.
 *
 * Visits: a post's link carries utm_source=<network>&utm_campaign=autopost (brief for brief posts)
 * (scripts/social-autopost/captions.js), so a pageview of /show/<slug> with
 * those tags belongs to the latest post of that show on that network sent on
 * or before the visit day. Instagram captions carry no link ("link in bio"),
 * so its visits are clicks on /links (the bio page) through to a show page.
 *
 * Coming up / skipped: scheduled posts from Buffer, plus score posts the
 * autopost will make this week (it creates each in Buffer only about an hour
 * ahead, so most are not in Buffer yet), and for shows that did not post, the
 * reason from the autopost's own rules (select.js scoreDecision).
 *
 * Ranking is by site visits first (the reason we post), then interactions,
 * then views: networks report different metrics (Bluesky has no views, X and
 * Facebook have clicks, Instagram has reach), but every network can send a visit.
 */

const { scoreDecision, doneKeys, isEligibleShow, morningAfter } = require('../social-autopost/select');
const C = require('../social-autopost/config');

const NETWORK_NAMES = { twitter: 'X', bluesky: 'Bluesky', threads: 'Threads', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube' };
const LANE_NAMES = { score: 'review score posts', brief: 'compare posts', 'london-compare': 'London comparison posts', 'weekly-roundup': 'weekly roundup posts', 'closing-soon': 'closing soon posts', video: 'videos', other: 'other posts' };
const INTERACTION_TYPES = ['reactions', 'comments', 'shares', 'reposts', 'quotes', 'saves'];
const DAY_MS = 86400000;
// Fewer posts than this in a group and an average means nothing.
const MIN_POSTS_TO_JUDGE = 3;

const networkName = (s) => NETWORK_NAMES[s] || s;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Buffer metrics [{type, value}] → {views, interactions, clicks, comments}. views is null when the network reports none. */
function normalizeMetrics(metrics) {
  const m = {};
  for (const { type, value } of metrics || []) if (Number.isFinite(value)) m[type] = value;
  const views = m.views ?? m.impressions ?? null;
  return {
    views,
    interactions: INTERACTION_TYPES.reduce((s, t) => s + (m[t] || 0), 0),
    clicks: m.clicks ?? null,
    comments: m.comments || 0,
  };
}

function slugFromText(text) {
  const hit = /\/show\/([a-z0-9-]+)/i.exec(text || '');
  return hit ? hit[1] : null;
}

/** Every distinct /show/<slug> in a post's text (a compare post links both productions). */
function slugsFromText(text) {
  return [...new Set([...String(text || '').matchAll(/\/show\/([a-z0-9-]+)/gi)].map((m) => m[1]))];
}

/** Ledger entries indexed by Buffer post id → {entry, service}. */
function indexLedger(ledger) {
  const byPostId = new Map();
  for (const entry of (ledger && ledger.posts) || []) {
    for (const [service, ch] of Object.entries(entry.channels || {})) {
      if (ch && ch.postId) byPostId.set(ch.postId, { entry, service });
    }
  }
  return byPostId;
}

/**
 * The show a caption names, for posts the ledger does not know (the video lane
 * has no show link). Longest title wins; titles under 6 letters ("Chess") are
 * too likely to be an ordinary word.
 */
function showInCaption(text, shows) {
  const first = String(text || '').split('\n')[0];
  let best = null;
  for (const s of shows || []) {
    const t = s && s.title;
    if (!t || t.length < 6 || (best && t.length <= best.title.length)) continue;
    const at = first.indexOf(t);
    if (at < 0 || /\w/.test(first[at - 1] || '') || /\w/.test(first[at + t.length] || '')) continue;
    best = s;
  }
  return best;
}

/**
 * One row per Buffer post: lane, title, slug, link, metrics, visits.
 * bufferPosts: [{id, sentAt, text, externalLink, service, isVideo, metrics:[{type,value}]}]
 * shows: optional, names the show in a video caption (the slug stays null, so
 * visits are still credited only to posts that link the show).
 */
function buildPostRows(bufferPosts, ledger, shows = []) {
  const byPostId = indexLedger(ledger);
  return (bufferPosts || []).filter((p) => p && p.sentAt).map((p) => {
    const hit = byPostId.get(p.id);
    const entry = hit && hit.entry;
    const firstLine = String(p.text || '').split('\n')[0].trim();
    const named = !entry && p.isVideo ? showInCaption(p.text, shows) : null;
    return {
      id: p.id,
      service: p.service,
      sentAt: p.sentAt,
      lane: entry ? (entry.type || 'score') : (p.isVideo ? 'video' : 'other'),
      title: (entry && entry.title) || (named && `${named.title} (video)`) || (firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine) || 'Untitled post',
      slug: (entry && entry.slug) || slugFromText(p.text),
      // Slugs whose visits count for this post: a compare post links both shows.
      slugs: [...new Set([(entry && entry.slug) || slugFromText(p.text), ...slugsFromText(p.text)].filter(Boolean))],
      reviewCount: entry ? Number((/from (\d+) critics/.exec(entry.text || '') || [])[1]) || null : null,
      // hit.service is the ledger's channel key ('instagram', or 'instagram@westend' for a
      // second account set), so read the link from that key, not the network name.
      link: p.externalLink || (entry && entry.channels[hit.service] && entry.channels[hit.service].link) || null,
      ...normalizeMetrics(p.metrics),
      visits: 0,
    };
  });
}

/**
 * Latest post linking `slug` on `service` sent on or before `day` (YYYY-MM-DD).
 * campaign (the visit's utm_campaign) keeps lanes apart: 'brief' visits go only
 * to compare posts, 'autopost' visits never do; a bio click (no campaign) can be either.
 */
function findPost(rows, service, slug, day, campaign) {
  let best = null;
  for (const r of rows) {
    if (r.service !== service || !(r.slugs || [r.slug]).includes(slug) || ymd(Date.parse(r.sentAt)) > day) continue;
    if (campaign === 'brief' ? r.lane !== 'brief' : campaign && r.lane === 'brief') continue;
    if (!best || r.sentAt > best.sentAt) best = r;
  }
  return best;
}

/**
 * Add visits to the post rows (mutates rows[].visits). Returns the visits
 * that matched no post (a show posted before the window, a hand-made post).
 * utmRows: [{source, path, day, views, campaign}] for utm_campaign=autopost or brief.
 * bioRows: [{source, path, day, views}] show pageviews whose previous page was
 *   /links; source is the utm_source the visitor reached /links with (each
 *   profile's bio link carries its own), 'none' when it had none.
 * day is a UTC YYYY-MM-DD, the same clock as sentAt.
 */
function attributeVisits(rows, { utmRows = [], bioRows = [] } = {}) {
  let unmatched = 0;
  const add = (service, path, day, views, campaign) => {
    const slug = (/^\/show\/([^/?#]+)/.exec(path || '') || [])[1];
    const post = slug && findPost(rows, service, slug, day, campaign);
    if (post) post.visits += views; else unmatched += views;
  };
  for (const r of utmRows) add(r.source, r.path, r.day, r.views, r.campaign);
  // A bio click with no network tag can't be credited to a post.
  for (const r of bioRows) {
    if (r.source && r.source !== 'none') add(r.source, r.path, r.day, r.views);
    else unmatched += r.views;
  }
  return unmatched;
}

const rankKey = (r) => [r.visits, r.interactions, r.views || 0];
function compareRank(a, b) {
  const ka = rankKey(a); const kb = rankKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
  return 0;
}

function describePost(r) {
  const bits = [];
  if (r.views != null) bits.push(plural(r.views, 'view'));
  bits.push(plural(r.interactions, 'like or share', 'likes and shares'));
  bits.push(plural(r.visits, 'site visit'));
  return `${r.title} on ${networkName(r.service)} (${bits.join(', ')})`;
}

function totalsByNetwork(rows) {
  const out = {};
  for (const r of rows) {
    const t = out[r.service] || (out[r.service] = { posts: 0, views: 0, interactions: 0, visits: 0, reportsViews: false });
    t.posts++; t.interactions += r.interactions; t.visits += r.visits;
    if (r.views != null) { t.views += r.views; t.reportsViews = true; }
  }
  return out;
}

/** One line per show (or per untitled post): totals across networks, readable on a phone. */
function showLines(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.slug || r.id;
    const g = groups.get(k) || { title: r.title, link: r.slug ? `https://${/westendscorecard\.com/.test(r.link || '') ? 'westendscorecard.com' : 'broadwayscorecard.com'}/show/${r.slug}` : r.link, views: 0, interactions: 0, comments: 0, visits: 0, visitsBy: {}, networks: [] };
    g.views += r.views || 0; g.interactions += r.interactions; g.comments += r.comments; g.visits += r.visits;
    if (r.visits) g.visitsBy[networkName(r.service)] = (g.visitsBy[networkName(r.service)] || 0) + r.visits;
    g.networks.push(networkName(r.service));
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.visits - a.visits || b.interactions - a.interactions || b.views - a.views).map((g) => {
    const where = Object.entries(g.visitsBy).map(([n, v]) => `${n} ${v}`).join(', ');
    const bits = [plural(g.views, 'view'), plural(g.interactions, 'like or share', 'likes and shares')];
    if (g.comments) bits.push(plural(g.comments, 'comment'));
    bits.push(`${plural(g.visits, 'site visit')}${where ? ` (${where})` : ''}`);
    return { title: g.title, link: g.link, line: `${bits.join(', ')}. Posted on ${g.networks.join(', ')}.` };
  });
}

/** One plain-English sentence on the week. */
function weeklyTakeaway(rows) {
  if (!rows.length) return 'No posts went out this week.';
  const nets = totalsByNetwork(rows);
  const visits = rows.reduce((s, r) => s + r.visits, 0);
  const byVisits = Object.entries(nets).sort((a, b) => b[1].visits - a[1].visits);
  const byViews = Object.entries(nets).filter(([, t]) => t.reportsViews).sort((a, b) => b[1].views - a[1].views);
  const dead = Object.entries(nets).filter(([, t]) => !t.views && !t.interactions && !t.visits).map(([s]) => networkName(s));
  const parts = [];
  if (visits === 0) parts.push(`${plural(rows.length, 'post')} sent nobody to the site yet`);
  else parts.push(`${plural(rows.length, 'post')} brought ${plural(visits, 'site visit')}, most from ${networkName(byVisits[0][0])} (${byVisits[0][1].visits})`);
  if (byViews.length && byViews[0][1].views > 0) parts.push(`${networkName(byViews[0][0])} got the most eyes (${plural(byViews[0][1].views, 'view')})`);
  let s = `${parts.join('; ')}.`;
  if (dead.length) s += ` ${dead.join(', ')} got nothing at all.`;
  return s;
}

/**
 * Buffer cannot read comment text, so this is a starting point the owner
 * adapts after reading the comment, never something posted automatically.
 */
function suggestedReply(r) {
  if (r.lane === 'video') return 'Thanks for watching! Every show we cover has its full review breakdown on broadwayscorecard.com. Which show do you think the critics got most wrong this season?';
  if (r.lane === 'score' && r.slug) {
    const n = r.reviewCount ? `all ${r.reviewCount} critic reviews` : 'every critic review';
    return `Thanks! You can read ${n} for ${r.title} here: broadwayscorecard.com/show/${r.slug} What did you see in it that the critics missed, or caught?`;
  }
  return 'Thanks for the comment! What did you make of it, and why?';
}

function groupStats(rows, keyFn) {
  const groups = {};
  for (const r of rows) {
    const k = keyFn(r);
    const g = groups[k] || (groups[k] = { posts: 0, visits: 0, interactions: 0 });
    g.posts++; g.visits += r.visits; g.interactions += r.interactions;
  }
  return groups;
}

/** Monthly keep/drop suggestion over `rows` (the last 30 days). */
function monthlySuggestion(rows) {
  const judged = (groups, nameFn) => Object.entries(groups)
    .filter(([, g]) => g.posts >= MIN_POSTS_TO_JUDGE)
    .map(([k, g]) => ({ key: k, name: nameFn(k), ...g, perPost: (g.visits * 3 + g.interactions) / g.posts }))
    .sort((a, b) => b.perPost - a.perPost);
  const lanes = judged(groupStats(rows, (r) => r.lane), (k) => LANE_NAMES[k] || k);
  const nets = judged(groupStats(rows, (r) => r.service), networkName);
  const lines = [];
  if (lanes.length >= 2) {
    lines.push(`Do more ${lanes[0].name}: ${(lanes[0].visits / lanes[0].posts).toFixed(1)} visits per post, against ${(lanes[lanes.length - 1].visits / lanes[lanes.length - 1].posts).toFixed(1)} for ${lanes[lanes.length - 1].name}.`);
  } else if (lanes.length === 1) {
    lines.push(`Only ${lanes[0].name} have enough posts to judge so far (${lanes[0].posts}); keep going and next month can compare.`);
  }
  if (nets.length) {
    lines.push(`Best network: ${nets[0].name} (${plural(nets[0].visits, 'visit')}, ${plural(nets[0].interactions, 'like or share', 'likes and shares')} from ${plural(nets[0].posts, 'post')}).`);
    const drop = nets.filter((n) => n.posts >= 5 && n.visits === 0 && n.interactions === 0);
    if (drop.length) lines.push(`Think about dropping ${drop.map((n) => n.name).join(' and ')}: ${drop.length === 1 ? 'it' : 'they'} got no visits and no likes in ${plural(drop[0].posts, 'post')}.`);
  }
  if (!lines.length) lines.push(`Not enough posts yet to compare (${plural(rows.length, 'post')} in 30 days). Next month's email will have a real comparison.`);
  return lines;
}

const TZ_LABELS = { 'America/New_York': 'ET', 'Europe/London': 'UK time' };
/** "Tue Oct 27, 10:00 AM ET" */
function localTime(ms, tz = 'America/New_York') {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  return `${s} ${TZ_LABELS[tz] || tz}`;
}

const showName = (show) => {
  const m = C.MARKETS[show.category];
  return m && show.category !== 'broadway' ? `${show.title} (${m.label})` : show.title;
};
const showLink = (show) => `https://${(C.MARKETS[show.category] || C.MARKETS.broadway).domain}/show/${show.slug || show.id}`;

/** "T1:1/2" style confidence-gate reasons → what the show still lacks, in words. */
function gateWords(gate) {
  const words = [];
  for (const r of (gate && gate.reasons) || []) {
    const m = /(\d+)\/(\d+)/.exec(r);
    if (!m) continue;
    const [have, need] = [m[1], m[2]];
    if (/total/.test(r)) words.push(`${have} of the ${need} reviews it needs`);
    else if (/^T1/.test(r)) words.push(`${have} of ${need} reviews from the top outlets`);
    else if (/^T2/.test(r)) words.push(`${have} of ${need} reviews from the next tier of outlets`);
    else if (/^hi-conf/.test(r)) words.push(`${have} of ${need} reviews with a clear rating`);
    else if (/^this-run/.test(r)) words.push(`${have} of ${need} reviews of this new run`);
  }
  return words.slice(0, 2).join(', ');
}

function plainReason(d) {
  if (d.why === 'no-score') return 'no score on the site yet';
  if (d.why === 'too-few-reviews') return 'not enough reviews yet';
  if (d.why === 'not-confident') {
    const w = gateWords(d.gate);
    return `score not confident yet${w ? ` (has ${w})` : ''}`;
  }
  return 'not ready to post yet'; // never show an internal code to the owner
}

/**
 * Shows that reached their post time in the last week but did not post, and why.
 * ctx: {shows, reviewsByShow, slim, getOutletTier} as social-autopost/run.js loadContext().
 * Shows still inside the lookback window are "still waiting" (they can post
 * later); ones that aged out this week are final. A show that aged out before
 * the autopost's first run (its first ledger entry) never had a chance, so it
 * is left out. Sorted final first, then Broadway, West End, Off-Broadway,
 * Off-West End.
 */
const CATEGORY_ORDER = ['broadway', 'west-end', 'off-broadway', 'off-west-end'];
// Shows the autopost stopped retrying (run.js skips them once rendering or
// posting failed MAX_SHOW_ATTEMPTS runs in a row).
function gaveUpIds(ledger) {
  const { MAX_SHOW_ATTEMPTS } = require('../social-autopost/run.js');
  const failures = (ledger && ledger._meta && ledger._meta.failures) || {};
  return new Set(Object.keys(failures).filter((id) => failures[id] && failures[id].count >= MAX_SHOW_ATTEMPTS));
}
function skippedShows({ ctx, ledger, now }) {
  if (!ctx) return [];
  const posts = (ledger && ledger.posts) || [];
  const goLive = Math.min(...posts.map((p) => Date.parse(p.dueAt || `${p.date}T00:00:00Z`)).filter(Number.isFinite));
  if (!Number.isFinite(goLive)) return [];
  const showsById = new Map(ctx.shows.map((s) => [s.id, s]));
  const dctx = { ...ctx, done: doneKeys(ledger), now };
  const lookbackMs = C.SCORE_LOOKBACK_DAYS * DAY_MS;
  const gaveUp = gaveUpIds(ledger);
  const out = [];
  for (const show of ctx.shows) {
    if (!isEligibleShow(show)) continue;
    const slot = morningAfter(show);
    if (slot > now || now - slot > lookbackMs + 7 * DAY_MS || slot + lookbackMs < goLive) continue;
    const d = scoreDecision(show, dctx);
    if (d.why === 'done' || d.why === 'not-yet') continue;
    if (gaveUp.has(show.id)) {
      out.push({ title: showName(show), link: showLink(show), reason: 'posting failed 3 times in a row, so it stopped trying (needs a look)', final: true, category: show.category });
      continue;
    }
    if (d.due) continue;
    let reason; let final = false;
    if (d.why === 'too-old') {
      const u = scoreDecision(show, dctx, { ignoreAge: true });
      reason = u.due
        ? `has a score now, but it was not ready within ${C.SCORE_LOOKBACK_DAYS} days of opening`
        : `gave up ${C.SCORE_LOOKBACK_DAYS} days after opening: ${plainReason(u)}`;
      final = true;
    } else {
      reason = plainReason(d);
    }
    out.push({ title: showName(show), link: showLink(show), reason, final, category: show.category });
  }
  for (const p of posts) {
    if (!p.skipped || !p.date || now - Date.parse(`${p.date}T12:00:00Z`) > 7 * DAY_MS) continue;
    const show = showsById.get(p.showId);
    const reason = p.skipped === 'backlog at go-live' ? 'opened before automatic posting was switched on' : p.skipped;
    out.push({ title: show ? showName(show) : p.showId, link: show ? showLink(show) : null, reason, final: true, category: show && show.category });
  }
  const rank = (c) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length);
  return out.sort((a, b) => b.final - a.final || rank(a.category) - rank(b.category) || a.title.localeCompare(b.title))
    .map(({ category, ...rest }) => rest);
}

/**
 * Posts going out in the next 7 days: what is already scheduled in Buffer
 * (both lanes), then score posts the autopost will make this week if the score
 * is ready by then. scheduled: [{id, service, dueAt, text}] from Buffer.
 */
function upcomingPosts({ scheduled = [], ctx, ledger, now }) {
  const end = now + 7 * DAY_MS;
  const byPostId = indexLedger(ledger);
  const showsBySlug = new Map(((ctx && ctx.shows) || []).map((s) => [s.slug || s.id, s]));
  const groups = new Map();
  const stuck = [];
  for (const p of scheduled) {
    const due = Date.parse(p.dueAt || '');
    // Past due but still unsent: a paused queue or a post waiting for approval.
    if (due <= now && now - due <= 7 * DAY_MS) { stuck.push(p); continue; }
    if (!(due > now && due <= end)) continue;
    const hit = byPostId.get(p.id);
    const slug = (hit && hit.entry.slug) || slugFromText(p.text);
    const show = slug && showsBySlug.get(slug);
    const firstLine = String(p.text || '').split('\n')[0].trim();
    const title = show ? showName(show) : (hit && hit.entry.title) || (firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine) || 'Untitled post';
    const tz = show && C.MARKETS[show.category] ? C.MARKETS[show.category].tz : 'America/New_York';
    const key = `${slug || title}|${Math.floor(due / 3600000)}`;
    const g = groups.get(key) || { title, due, when: localTime(due, tz), networks: [], slug, brief: !!(hit && hit.entry.type === 'brief') };
    g.networks.push(networkName(p.service));
    groups.set(key, g);
  }
  const out = [...groups.values()].map((g) => ({ ...g, line: `${g.when} on ${g.networks.join(', ')}` }));
  // A queued compare post is not that show's score post, so it doesn't hide the projected one.
  const inBuffer = new Set(out.filter((g) => !g.brief).map((g) => g.slug).filter(Boolean));
  if (ctx) {
    const done = doneKeys(ledger);
    const gaveUp = gaveUpIds(ledger);
    for (const show of ctx.shows) {
      if (!isEligibleShow(show) || done.has(`score:${show.id}`) || gaveUp.has(show.id) || inBuffer.has(show.slug || show.id)) continue;
      const slot = morningAfter(show);
      if (slot <= now || slot > end) continue;
      out.push({ title: showName(show), due: slot, line: `${localTime(slot, C.MARKETS[show.category].tz)}, score post on every network if the score is ready by then` });
    }
  }
  const sorted = out.sort((a, b) => a.due - b.due).map(({ title, line }) => ({ title, line }));
  if (stuck.length) {
    sorted.unshift({ title: 'Stuck in Buffer', line: `${plural(stuck.length, 'post')} passed ${stuck.length === 1 ? 'its' : 'their'} time without going out; check the Buffer queue` });
  }
  return sorted;
}

const TIME_BLOCKS = [['morning', 'before noon', 12], ['afternoon', '12 to 5pm', 17], ['evening', 'after 5pm', 24]];
function timeBlock(ms) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' }).format(new Date(ms)));
  return TIME_BLOCKS.find(([, , end]) => h < end)[0];
}

/**
 * Posting-time advice once there are 4 weeks of posts: per network, compare
 * time-of-day blocks (Eastern) by visits and likes per post, and suggest a move
 * only when another block clearly beats the one most posts go out in.
 */
// Score and compare posts go out at the autopost's fixed window slots, so only the
// other lanes (videos, hand posts) say anything about posting time.
const MIN_POSTS_PER_TIME_BLOCK = 5;
function postingTimeAdvice(allRows, now) {
  const rows = allRows.filter((r) => r.lane !== 'score' && r.lane !== 'brief');
  if (!rows.length) return ['Posting-time advice starts once there are 4 weeks of posts.'];
  const first = Math.min(...rows.map((r) => Date.parse(r.sentAt)));
  const days = Math.floor((now - first) / DAY_MS);
  if (days < 28) return [`Posting-time advice starts once there are 4 weeks of posts (${plural(days, 'day')} so far).`];
  const lines = [];
  for (const [service, list] of Object.entries(groupBy(rows, (r) => r.service))) {
    const blocks = Object.entries(groupStats(list, (r) => timeBlock(Date.parse(r.sentAt))))
      .filter(([, g]) => g.posts >= MIN_POSTS_PER_TIME_BLOCK)
      .map(([k, g]) => ({ key: k, ...g, perPost: (g.visits * 3 + g.interactions) / g.posts }));
    if (blocks.length < 2) continue;
    const habit = blocks.reduce((a, b) => (b.posts > a.posts ? b : a));
    const best = blocks.reduce((a, b) => (b.perPost > a.perPost ? b : a));
    if (best === habit || best.perPost <= 0 || best.perPost < 1.5 * habit.perPost) continue;
    const label = (k) => { const b = TIME_BLOCKS.find(([n]) => n === k); return `${b[0]} (${b[1]} ET)`; };
    const ratio = habit.perPost > 0 ? `${(best.perPost / habit.perPost).toFixed(1)} times as well as` : 'better than';
    lines.push(`${networkName(service)}: ${label(best.key)} posts did ${ratio} ${label(habit.key)} posts (${best.posts} against ${habit.posts} posts). Try moving ${networkName(service)} posts to the ${best.key}.`);
  }
  return lines.length ? lines.slice(0, 3) : ['No posting time clearly does better yet, so keep the current times.'];
}

function groupBy(rows, keyFn) {
  const out = {};
  for (const r of rows) (out[keyFn(r)] = out[keyFn(r)] || []).push(r);
  return out;
}

/**
 * @param o.bufferPosts  sent posts from Buffer (see buildPostRows)
 * @param o.ledger       data/social-autopost-ledger.json
 * @param o.utmRows/bioRows  PostHog visit rows (see attributeVisits)
 * @param o.bioPageViews [{source, views}] /links pageviews in the last 7 days by utm_source
 * @param o.scheduled    Buffer posts not yet sent [{id, service, dueAt, text}] (see upcomingPosts)
 * @param o.ctx          autopost context {shows, reviewsByShow, slim, getOutletTier}; null leaves out upcoming score posts and skips
 * @param o.now          ms; the monthly block appears when it is day 1-7 of the month (UTC)
 */
function buildSocialReport({ bufferPosts, ledger, utmRows, bioRows, bioPageViews = [], scheduled = [], ctx = null, now = Date.now() }) {
  const rows = buildPostRows(bufferPosts, ledger, ctx && ctx.shows);
  const unmatchedVisits = attributeVisits(rows, { utmRows, bioRows });
  const weekRows = rows.filter((r) => now - Date.parse(r.sentAt) <= 7 * DAY_MS).sort(compareRank);
  const settled = weekRows.filter((r) => now - Date.parse(r.sentAt) >= DAY_MS);
  // On a week where every post scored the same (often all zeros) there is no
  // best or worst to name.
  const allTied = weekRows.length > 0 && weekRows.every((r) => compareRank(r, weekRows[0]) === 0);
  const best = allTied ? null : weekRows[0] || null;
  const worstPool = settled.filter((r) => r !== best && compareRank(r, best || r) !== 0);
  const worst = !allTied && worstPool.length ? worstPool[worstPool.length - 1] : null;
  const report = {
    generatedAt: new Date(now).toISOString(),
    weekly: {
      posts: weekRows,
      takeaway: weeklyTakeaway(weekRows),
      shows: showLines(weekRows),
      best: best && { ...best, line: describePost(best) },
      worst: worst && { ...worst, line: describePost(worst) },
      comments: weekRows.filter((r) => r.comments > 0).map((r) => ({ title: r.title, network: networkName(r.service), comments: r.comments, link: r.link, suggestedReply: suggestedReply(r) })),
      bio: { views: bioPageViews.reduce((s, r) => s + r.views, 0), bySource: bioPageViews },
      unmatchedVisits,
      upcoming: upcomingPosts({ scheduled, ctx, ledger, now }),
      skipped: skippedShows({ ctx, ledger, now }),
      timing: postingTimeAdvice(rows.filter((r) => now - Date.parse(r.sentAt) <= 35 * DAY_MS), now),
    },
    monthly: null,
  };
  if (new Date(now).getUTCDate() <= 7) {
    const monthRows = rows.filter((r) => now - Date.parse(r.sentAt) <= 30 * DAY_MS);
    report.monthly = { posts: monthRows.length, lines: monthlySuggestion(monthRows) };
  }
  return report;
}

module.exports = { buildSocialReport, buildPostRows, showInCaption, skippedShows, upcomingPosts, postingTimeAdvice, gateWords, plainReason, localTime, showLines, attributeVisits, normalizeMetrics, weeklyTakeaway, monthlySuggestion, suggestedReply, networkName, slugFromText, slugsFromText };
