/**
 * social-report.js — the Social section of the Monday traffic email (BRO-6377).
 *
 * Pure: takes Buffer's sent posts (with their metrics), the autopost ledger
 * and PostHog visit rows, returns the report scripts/build-social-report.js
 * writes and scripts/lib/traffic-report-email.js renders. No I/O here.
 *
 * Visits: a post's link carries utm_source=<network>&utm_campaign=autopost
 * (scripts/social-autopost/captions.js), so a pageview of /show/<slug> with
 * those tags belongs to the latest post of that show on that network sent on
 * or before the visit day. Instagram captions carry no link ("link in bio"),
 * so its visits are clicks on /links (the bio page) through to a show page.
 *
 * Ranking is by site visits first (the reason we post), then interactions,
 * then views: networks report different metrics (Bluesky has no views, X and
 * Facebook have clicks, Instagram has reach), but every network can send a visit.
 */

const NETWORK_NAMES = { twitter: 'X', bluesky: 'Bluesky', threads: 'Threads', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube' };
const LANE_NAMES = { score: 'review score posts', video: 'videos', other: 'other posts' };
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
 * One row per Buffer post: lane, title, slug, link, metrics, visits.
 * bufferPosts: [{id, sentAt, text, externalLink, service, isVideo, metrics:[{type,value}]}]
 */
function buildPostRows(bufferPosts, ledger) {
  const byPostId = indexLedger(ledger);
  return (bufferPosts || []).filter((p) => p && p.sentAt).map((p) => {
    const hit = byPostId.get(p.id);
    const entry = hit && hit.entry;
    const firstLine = String(p.text || '').split('\n')[0].trim();
    return {
      id: p.id,
      service: p.service,
      sentAt: p.sentAt,
      lane: entry ? (entry.type || 'score') : (p.isVideo ? 'video' : 'other'),
      title: (entry && entry.title) || (firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine) || 'Untitled post',
      slug: (entry && entry.slug) || slugFromText(p.text),
      reviewCount: entry ? Number((/from (\d+) critics/.exec(entry.text || '') || [])[1]) || null : null,
      // hit.service is the ledger's channel key ('instagram', or 'instagram@westend' for a
      // second account set), so read the link from that key, not the network name.
      link: p.externalLink || (entry && entry.channels[hit.service] && entry.channels[hit.service].link) || null,
      ...normalizeMetrics(p.metrics),
      visits: 0,
    };
  });
}

/** Latest post of `slug` on `service` sent on or before `day` (YYYY-MM-DD). */
function findPost(rows, service, slug, day) {
  let best = null;
  for (const r of rows) {
    if (r.service !== service || r.slug !== slug || ymd(Date.parse(r.sentAt)) > day) continue;
    if (!best || r.sentAt > best.sentAt) best = r;
  }
  return best;
}

/**
 * Add visits to the post rows (mutates rows[].visits). Returns the visits
 * that matched no post (a show posted before the window, a hand-made post).
 * utmRows: [{source, path, day, views}] for utm_campaign=autopost.
 * bioRows: [{source, path, day, views}] show pageviews whose previous page was
 *   /links; source is the utm_source the visitor reached /links with (each
 *   profile's bio link carries its own), 'none' when it had none.
 * day is a UTC YYYY-MM-DD, the same clock as sentAt.
 */
function attributeVisits(rows, { utmRows = [], bioRows = [] } = {}) {
  let unmatched = 0;
  const add = (service, path, day, views) => {
    const slug = (/^\/show\/([^/?#]+)/.exec(path || '') || [])[1];
    const post = slug && findPost(rows, service, slug, day);
    if (post) post.visits += views; else unmatched += views;
  };
  for (const r of utmRows) add(r.source, r.path, r.day, r.views);
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
    const g = groups.get(k) || { title: r.title, link: r.slug ? `https://broadwayscorecard.com/show/${r.slug}` : r.link, views: 0, interactions: 0, comments: 0, visits: 0, visitsBy: {}, networks: [] };
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
  if (r.lane === 'video') return 'Thanks for watching! Every show we cover has its full review breakdown on broadwayscorecard.com.';
  if (r.lane === 'score' && r.slug) {
    const n = r.reviewCount ? `all ${r.reviewCount} critic reviews` : 'every critic review';
    return `Thanks! You can read ${n} for ${r.title} here: broadwayscorecard.com/show/${r.slug}`;
  }
  return 'Thanks for the comment! What did you think of it?';
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

/**
 * @param o.bufferPosts  sent posts from Buffer (see buildPostRows)
 * @param o.ledger       data/social-autopost-ledger.json
 * @param o.utmRows/bioRows  PostHog visit rows (see attributeVisits)
 * @param o.bioPageViews [{source, views}] /links pageviews in the last 7 days by utm_source
 * @param o.now          ms; the monthly block appears when it is day 1-7 of the month (UTC)
 */
function buildSocialReport({ bufferPosts, ledger, utmRows, bioRows, bioPageViews = [], now = Date.now() }) {
  const rows = buildPostRows(bufferPosts, ledger);
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
    },
    monthly: null,
  };
  if (new Date(now).getUTCDate() <= 7) {
    const monthRows = rows.filter((r) => now - Date.parse(r.sentAt) <= 30 * DAY_MS);
    report.monthly = { posts: monthRows.length, lines: monthlySuggestion(monthRows) };
  }
  return report;
}

module.exports = { buildSocialReport, buildPostRows, showLines, attributeVisits, normalizeMetrics, weeklyTakeaway, monthlySuggestion, suggestedReply, networkName, slugFromText };
