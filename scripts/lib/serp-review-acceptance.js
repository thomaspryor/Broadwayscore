'use strict';

/**
 * serp-review-acceptance.js — pure "may this SERP hit be adopted as THIS
 * show's review URL" gate for link rediscovery (BRO-4409).
 *
 * discoverCorrectUrl's token match let three non-reviews through in run
 * 36656521609 (2026-09-30): a New Yorker film piece about "Wonder Woman 1984"
 * for the show "1984", a New Yorker Radio Hour podcast page, and a
 * "Goings On" listings blurb. Layers, all pure (no fs/network):
 *   1. classifyReviewUrl (canonical never-a-review URL shapes)
 *   2. SERP-only path shapes: podcasts, radio hour, goings-on listings
 *   3. bare-number titles ("1984") need a stage signal in the
 *      url/title/snippet, so a film/TV page sharing the token is refused
 *   4. a quoted work in the result title that CONTAINS the show title but is
 *      longer ("Wonder Woman 1984") is a different work
 *
 * Consumers: url-discovery.js discoverCorrectUrl, scan-serp-adoptions.js.
 */

const { classifyReviewUrl } = require('./non-review-url-patterns');
const { foldDiacritics } = require('./title-match');

// Podcast outlets we deliberately ingest; their URLs legitimately contain /podcast(s)/.
const PODCAST_OUTLET_HOSTS = new Set(['broadwaypodcastnetwork.com', 'zeno.fm', 'pod.wave.co']);

// Shapes measured 2026-09-30 over 45,777 review files: /goings-on/ 3 hits
// (2 non-reviews, 1 phantom), /radio-hour/ 1 real (Theatre Weekly "Radio Hours"
// is a show name in the slug, not a path segment), /podcast(s)/ hits are only
// the exempt hosts above plus the bad New Yorker page.
const SERP_NON_REVIEW_PATHS = [
  { re: /\/goings-on(\/|$)/i, reason: 'listings-blurb' },
  { re: /\/radio-hour(\/|$)/i, reason: 'radio-podcast' },
  { re: /\/podcasts?(\/|$)/i, reason: 'podcast-page', exemptHosts: PODCAST_OUTLET_HOSTS },
];

const STAGE_SIGNAL_RE = /\b(theat(er|re)s?|broadway|stage|play(house|wright)?|musical|revival|off[- ]broadway|west[- ]end|opera|ballet|playbill|previews?|cast|onstage)\b/i;

function norm(s) {
  return foldDiacritics(String(s || '')).toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9\s']/g, ' ').replace(/'/g, '')
    .replace(/\s+/g, ' ').trim();
}

function coreTitleTokens(showTitle) {
  return norm(showTitle).replace(/^(the|a|an) /, '').split(' ').filter(Boolean);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * A quoted span in the result title that contains the whole show title but has
 * extra non-stage tokens is a different work. Returns the span or null.
 */
function longerQuotedWork(rawTitle, showTitle) {
  const want = norm(showTitle).replace(/^(the|a|an) /, '');
  if (!want) return null;
  const spans = String(rawTitle || '').match(/[“"]([^”"]{2,80})[”"]/g) || [];
  for (const sp of spans) {
    const inner = norm(sp.slice(1, -1)).replace(/^(the|a|an) /, '');
    if (!inner || inner === want) continue;
    const padded = ` ${inner} `;
    if (!padded.includes(` ${want} `)) continue;
    const extra = inner.split(' ').filter(t => !want.split(' ').includes(t) && !STAGE_SIGNAL_RE.test(t));
    if (extra.length > 0) return sp;
  }
  return null;
}

/**
 * @param {{url: string, title?: string, snippet?: string, showTitle: string}} c
 * @returns {{ok: boolean, reason: string|null}}
 */
function evaluateSerpAcceptance({ url, title = '', snippet = '', showTitle } = {}) {
  const cls = classifyReviewUrl(url);
  if (!cls.ok) return { ok: false, reason: `non-review-url:${cls.reason}` };

  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { return { ok: false, reason: 'unparseable-url' }; }
  const host = hostOf(url);
  for (const { re, reason, exemptHosts } of SERP_NON_REVIEW_PATHS) {
    if (re.test(pathname) && !(exemptHosts && exemptHosts.has(host))) {
      return { ok: false, reason: `non-review-path:${reason}` };
    }
  }

  const quoted = longerQuotedWork(title, showTitle);
  if (quoted) return { ok: false, reason: `different-work:${quoted}` };

  // A bare-number title ("1984") is shared by films, novels and years; only
  // trust the hit when the page itself talks about theatre. Other one-word
  // titles are covered by url-discovery's generic-title disambiguator, and a
  // blanket stage-signal rule there would cost real recall (a "Hadestown"
  // review slug carries no theatre word).
  const tokens = coreTitleTokens(showTitle);
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    const hay = `${pathname.replace(/[-_/]+/g, ' ')} ${title} ${snippet}`;
    if (!STAGE_SIGNAL_RE.test(hay)) return { ok: false, reason: 'lone-token-title-without-stage-signal' };
  }
  return { ok: true, reason: null };
}

module.exports = { evaluateSerpAcceptance, longerQuotedWork, SERP_NON_REVIEW_PATHS, PODCAST_OUTLET_HOSTS };
