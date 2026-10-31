// Per-channel video captions (BRO-6737). A video plan carries one caption that ends in the plain line
// "See every review at broadwayscorecard.com". That line goes to every network unchanged, and it earned 0 site
// visits from 19 video posts (1,663 views, week of 2026-10-26). Each network treats links differently:
//   facebook   the line carries the utm-tagged show page. Whether a Reel caption makes it tappable is NOT verified
//              (only marketing blogs say yes; Meta documents nothing), so BRO-6737 rechecks for utm_source=facebook
//              visits with utm_campaign=video after the first Facebook reel goes out.
//   tiktok     captions never carry live links, so the line says "link in bio" (the bio page is /links).
//   instagram  same as TikTok.
//   youtube    Shorts descriptions and comments do not make URLs clickable (YouTube Help, "Sharing links with your
//              audiences": "URLs placed in YouTube Shorts comments and Shorts descriptions are non-clickable"). A
//              tagged URL would be dead, long text, so a Short leads with the plain domain. A video that is not a
//              Short (isShort: false) gets the tagged link at the top, where a clickable link is read first.
// The plan's caption is the copy-reviewed text. Only the link line changes here, never a number, a question or a tag.
const { MARKETS } = require('../social-autopost/config');

// optional trailing period: "...broadwayscorecard.com." must not leave a stray "." or end a URL with one
const TAIL = /See every review at [a-z0-9.-]+\.com\.?/i;
const NETWORKS = ['facebook', 'tiktok', 'instagram', 'youtube'];

/** utm-tagged link: captions.js showUrl's shape (source, medium, campaign) plus utm_content to tell videos apart. */
function taggedUrl(url, network, content, campaign = 'video') {
  return `${url}?utm_source=${network}&utm_medium=social&utm_campaign=${campaign}${content ? `&utm_content=${encodeURIComponent(content)}` : ''}`;
}

/**
 * Where a video's link goes. lookup(id) -> {slug, category, openingDate}. Throws on an unknown show, so a typo
 * cannot ship a dead link.
 *   compare  the newest production, by openingDate (never by the order the ids were typed), at its page slug
 *   how      the example show named by plan.key (the show the video is about); plan.compare is only the second show
 *   others   the market's home page, from the first show
 */
function videoLink(plan, lookup) {
  const shows = plan.shows || (plan.compare && plan.compare.id ? [plan.compare] : []);
  const subject = plan.fmt === 'how' ? [{ id: plan.key }] : shows;
  if (!subject.length) throw new Error(`plan ${plan.key}: no shows, so no link target`);
  const entries = subject.map((s) => ({ id: s.id, m: lookup(s.id) }));
  const bad = entries.find((e) => !e.m || !MARKETS[e.m.category]);
  if (bad) throw new Error(`plan ${plan.key}: no site entry for ${bad.id}`);
  let target = entries[0];
  if (plan.fmt === 'compare') {
    if (entries.some((e) => !e.m.openingDate)) throw new Error(`plan ${plan.key}: a compared show has no openingDate, cannot pick the newest`);
    target = entries.reduce((a, b) => (b.m.openingDate >= a.m.openingDate ? b : a));
  }
  const domain = MARKETS[target.m.category].domain;
  return { domain, key: plan.key, url: plan.fmt === 'compare' ? `https://${domain}/show/${target.m.slug || target.id}` : `https://${domain}/` };
}

/** The caption for one network. caption: the plan's caption; link: {domain, url} from videoLink. */
function channelCaption(caption, network, link, { isShort = true } = {}) {
  if (!NETWORKS.includes(network)) throw new Error(`no video caption rule for ${network}`);
  if (!TAIL.test(caption)) throw new Error('caption has no "See every review at <domain>" line to carry the link');
  const { domain, url, key } = link;
  if (network === 'facebook') return caption.replace(TAIL, `See every review: ${taggedUrl(url, 'facebook', key)}`);
  if (network === 'tiktok' || network === 'instagram') return caption.replace(TAIL, `See every review at ${domain} (link in bio)`);
  // youtube: the link line moves to the top of the description
  const top = isShort ? `See every review at ${domain}` : `See every review: ${taggedUrl(url, 'youtube', key)}`;
  const rest = caption.replace(TAIL, '').replace(/ {2,}/g, ' ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').replace(/ +$/, '');
  return `${top}\n\n${rest}`;
}

module.exports = { channelCaption, videoLink, taggedUrl, NETWORKS };

// node channel-captions.js <plan.json> <network> [--not-short]: print the caption a network would get
if (require.main === module) {
  const [file, network, flag] = process.argv.slice(2);
  if (!file || !network) { console.error('usage: node channel-captions.js <plan.json> <facebook|tiktok|instagram|youtube> [--not-short]'); process.exit(2); }
  const plan = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const { meta } = require('./showdata');
  process.stdout.write(channelCaption(plan.caption, network, videoLink(plan, meta), { isShort: flag !== '--not-short' }));
}
