'use strict';

/**
 * new-show-types.js (BRO-6542)
 *
 * Pure helpers behind the morning email's "new tour, pre-Broadway and regional
 * shows" block. The email's older score-drift line lumped every new show into
 * one list capped at 8 under a count of hundreds, so a new tour stop or
 * out-of-town tryout was easy to miss. This pulls those three kinds out on
 * their own, and drafts a Reddit post for each new pre-Broadway show.
 *
 * Kinds (the same split the site makes, see src/lib/market-utils.ts):
 *   tour          category 'tour'
 *   pre-broadway  category 'regional' at a US/Canada house (the homepage
 *                 "Pre-Broadway: Out-of-Town Shows" shelf)
 *   regional      category 'regional' at a UK flagship house (RSC, Chichester;
 *                 the "Beyond London" shelf)
 * Local-only shows (Chicago listings, BRO-6518) are withheld everywhere on the
 * site, so they are skipped here too.
 *
 * "New" means "not in the seen ledger yet". The ledger is advanced by
 * scripts/produce-new-show-types-snapshot.js; a first run seeds it with
 * everything except shows discovered in the last SEED_RECENT_DAYS, so the
 * owner is not sent the whole back catalogue.
 *
 * No network, no filesystem: everything is injected so tests can require()
 * the real functions.
 */

const { isUkRegionalVenue } = require('./market-label');
const { isLocalOnlyShow } = require('./local-market');
const { submitUrl, showUrl, stripDashes } = require('./reddit-opening-post');

const KIND_LABEL = {
  'tour': 'Tour',
  'pre-broadway': 'Pre-Broadway',
  'regional': 'UK regional',
};
const KIND_ORDER = ['pre-broadway', 'tour', 'regional'];

const SEED_RECENT_DAYS = 7;
// An item stays in the snapshot for this long after it was first seen, so one
// missed or late email does not lose it. It can show in two mornings in a row.
const KEEP_HOURS = 48;
const MAX_ITEMS = 8;
const MAX_REDDIT_DRAFTS = 3;
const REDDIT_SUBREDDIT = 'Broadway';
// Reddit drafts only for runs the owner can still talk about: a closed run
// is listed but gets no post.
const POSTABLE_STATUS = new Set(['open', 'previews', 'upcoming', 'announced']);
// A critic score is quoted only when enough reviews stand behind it.
const MIN_REVIEWS_FOR_SCORE = 5;

function kindOf(show) {
  if (!show) return null;
  if (show.category === 'tour') return 'tour';
  if (show.category !== 'regional') return null;
  if (isLocalOnlyShow(show)) return null;
  return isUkRegionalVenue(show.venue) ? 'regional' : 'pre-broadway';
}

// UK regional pages belong to the West End site (src/lib/data-core.ts maps
// them to the London market); showUrl() would send them to the Broadway one.
function urlFor(show) {
  if (kindOf(show) === 'regional') return `https://westendscorecard.com/show/${show.slug || show.id}`;
  return showUrl(show);
}

// The producer runs overnight UTC, which is still the previous evening in New York.
function easternDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

function daysAgoIso(nowMs, days) {
  return new Date(nowMs - days * 86400000).toISOString();
}

/**
 * Decide the ledger update and which shows are new this run.
 * ledger: { seen: { [showId]: firstSeenIso } } or null on the first run.
 * Returns { ledger, fresh } where fresh is the shows first seen now.
 */
function diffAgainstLedger(shows, ledger, now = new Date()) {
  const nowIso = now.toISOString();
  const seen = { ...((ledger && ledger.seen) || {}) };
  const firstRun = !ledger || !ledger.seen;
  const cutoff = daysAgoIso(now.getTime(), SEED_RECENT_DAYS);
  const fresh = [];
  for (const show of shows) {
    if (!show || !show.id || !kindOf(show)) continue;
    if (seen[show.id]) continue;
    // A closed run is not worth announcing (backfills, id renames); record it so it stays quiet.
    if (show.status === 'closed' || (firstRun && !(show.discoveredAt && show.discoveredAt >= cutoff))) {
      seen[show.id] = 'seeded';
      continue;
    }
    seen[show.id] = nowIso;
    fresh.push(show);
  }
  return { ledger: { seen }, fresh };
}

/** Shows whose first-seen stamp is within KEEP_HOURS, newest first. */
function recentlySeen(shows, ledger, now = new Date()) {
  const cutoff = now.getTime() - KEEP_HOURS * 3600e3;
  const seen = (ledger && ledger.seen) || {};
  return shows
    .filter(s => s && kindOf(s) && seen[s.id] && seen[s.id] !== 'seeded' && Date.parse(seen[s.id]) >= cutoff)
    .sort((a, b) => Date.parse(seen[b.id]) - Date.parse(seen[a.id]));
}

function city(venue) {
  // "Goodspeed Opera House, East Haddam, CT" -> "East Haddam, CT"
  const parts = String(venue || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(', ') : '';
}

function venueName(venue) {
  return String(venue || '').split(',')[0].trim();
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function plainDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

function firstSentence(text, max = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = (m ? m[1] : t);
  return s.length > max ? '' : s;
}

/**
 * A suggested r/Broadway post for a pre-Broadway show. Facts only: venue, dates,
 * the show's own synopsis line and, with enough reviews, the site's critic
 * score. It never says the show is Broadway-bound (the data does not know) and
 * never speaks for the owner's experience of it. Returns null for a closed run.
 *
 * slim: the public/data/shows/{id}.json file for the show, or null.
 */
function buildRedditSuggestion(show, slim = null, { today = easternDate() } = {}) {
  if (kindOf(show) !== 'pre-broadway') return null;
  if (!POSTABLE_STATUS.has(show.status)) return null;
  const where = venueName(show.venue);
  const place = city(show.venue);
  const at = where ? `${where}${place ? ` in ${place}` : ''}` : 'a regional theatre';
  const playing = show.status === 'open' || show.status === 'previews';
  const when = plainDate(show.openingDate);
  const close = plainDate(show.closingDate);
  const rc = slim ? Number(slim.rc) : 0;
  const cs = slim ? Number(slim.cs) : NaN;
  const hasScore = rc >= MIN_REVIEWS_FOR_SCORE && Number.isFinite(cs) && cs > 0;

  const lines = [];
  if (show.status === 'previews') {
    const upcoming = when && show.openingDate > today;
    lines.push(`It is in previews${upcoming ? ` and opens on ${when}` : ''}${close ? `, running through ${close}` : ''}.`);
  } else if (when) {
    const opened = show.openingDate <= today;
    lines.push(`${opened ? 'It opened' : 'It opens'} on ${when}${close ? ` and runs through ${close}` : ''}.`);
  }
  const blurb = firstSentence(show.synopsis);
  if (blurb) lines.push(blurb);
  // A post that is only a title and a link is not worth the owner's time.
  if (!lines.length) return null;
  lines.push(urlFor(show));

  const title = hasScore
    ? `${show.title} at ${at}: ${Math.round(cs)}/100 from ${rc} critics so far. Anyone seen it?`
    : `${show.title} ${playing ? 'is playing' : 'is coming'} at ${at}. Anyone seen it, or know where it goes next?`;
  const t = stripDashes(title);
  const body = stripDashes(lines.join('\n\n'));
  return {
    subreddit: REDDIT_SUBREDDIT,
    title: t,
    body,
    note: 'Our data does not say whether this is headed to Broadway. If you know, add a line about it before posting.',
    url: submitUrl(REDDIT_SUBREDDIT, t, body),
  };
}

function itemFor(show, { firstSeen, slim, now }) {
  const kind = kindOf(show);
  const where = [venueName(show.venue), city(show.venue)].filter(Boolean).join(', ');
  const when = plainDate(show.openingDate);
  const dateNote = when ? `${show.openingDate <= now.toISOString().slice(0, 10) ? 'opened' : 'opens'} ${when}` : '';
  // 'open' adds nothing next to an "opened" date; the other states do.
  const status = show.status && show.status !== 'open' ? String(show.status) : '';
  const detail = [KIND_LABEL[kind], where, dateNote, status].filter(Boolean).join(' · ');
  const item = { id: show.id, kind, title: show.title, detail, url: urlFor(show), firstSeen };
  const reddit = buildRedditSuggestion(show, slim, { today: now.toISOString().slice(0, 10) });
  if (reddit) item.reddit = reddit;
  return item;
}

/**
 * Build the snapshot the morning digest reads. Same {generatedAt, bannerText,
 * items, moreCount} shape as the other digest snapshots.
 * slims: Map showId -> slim json (optional).
 */
function buildSnapshot({ shows, ledger, slims = new Map(), now = new Date() }) {
  const recent = recentlySeen(shows, ledger, now);
  const rank = k => KIND_ORDER.indexOf(k);
  recent.sort((a, b) => rank(kindOf(a)) - rank(kindOf(b)));
  const all = recent.map(s => itemFor(s, { firstSeen: ledger.seen[s.id], slim: slims.get(s.id) || null, now }));
  // Drafts beyond the cap are dropped from the items (the show stays listed).
  let drafts = 0;
  for (const it of all) {
    if (!it.reddit) continue;
    if (++drafts > MAX_REDDIT_DRAFTS) delete it.reddit;
  }
  const items = all.slice(0, MAX_ITEMS);
  const counts = KIND_ORDER
    .map(k => [k, all.filter(i => i.kind === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${KIND_LABEL[k]}`);
  return {
    generatedAt: now.toISOString(),
    bannerText: all.length ? `${all.length} new: ${counts.join(', ')}` : 'No new tour, pre-Broadway or regional shows',
    items,
    moreCount: Math.max(0, all.length - items.length),
  };
}

// ── Email block ──────────────────────────────────────────────────────────────

function defaultEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ageNote(firstSeen, now) {
  const t = Date.parse(firstSeen);
  if (!Number.isFinite(t)) return '';
  return now.getTime() - t < 20 * 3600e3 ? 'added overnight' : 'added yesterday';
}

function renderRedditBox(r, esc) {
  const body = esc(r.body).replace(/\n/g, '<br>');
  const link = r.url
    ? `<a href="${esc(r.url)}" style="color:#1d4ed8;font-weight:600;">Open the post in Reddit</a> (title and text are filled in)`
    : '';
  return `<div style="background-color:#f6f7f8;border:1px solid #e5e5e5;border-radius:8px;padding:8px 10px;margin:6px 0 0;font-size:13px;color:#222;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#777;margin-bottom:4px;">Suggested post for r/${esc(r.subreddit)}</div>
      <div style="font-weight:600;margin-bottom:4px;">${esc(r.title)}</div>
      <div style="margin-bottom:6px;">${body}</div>
      ${r.note ? `<div style="font-size:12px;color:#666;margin-bottom:6px;">${esc(r.note)}</div>` : ''}
      <div style="font-size:12px;">${link}</div>
    </div>`;
}

/**
 * HTML for the digest. Quiet day (no items) renders nothing; a stale snapshot
 * is already flagged by the freshness banner. Items without the optional
 * fields (kind, url, reddit) render as plain rows.
 */
function renderNewShowTypesBlock(snapshot, { esc = defaultEsc, now = new Date() } = {}) {
  if (!snapshot || !Array.isArray(snapshot.items) || !snapshot.items.length) return '';
  const rows = snapshot.items.map(it => {
    const name = it.url
      ? `<a href="${esc(it.url)}" style="color:#111;font-weight:700;text-decoration:none;">${esc(it.title)}</a>`
      : `<b>${esc(it.title)}</b>`;
    const age = it.firstSeen ? ageNote(it.firstSeen, now) : '';
    const detail = [it.detail, age].filter(Boolean).map(esc).join(' · ');
    return `<div style="margin:0 0 10px;">
      <div style="font-size:14px;">${name}</div>
      <div style="font-size:12px;color:#666;">${detail}</div>
      ${it.reddit ? renderRedditBox(it.reddit, esc) : ''}
    </div>`;
  }).join('\n');
  const more = snapshot.moreCount > 0
    ? `<p style="font-size:12px;color:#666;margin:0 0 8px;">Plus ${snapshot.moreCount} more, in the browse pages on the site.</p>`
    : '';
  return `<div style="margin:0 0 16px;">
    <p style="font-size:14px;font-weight:700;margin:0 0 8px;">New tour, pre-Broadway and UK regional shows${snapshot.bannerText ? ` (${esc(snapshot.bannerText)})` : ''}</p>
    ${rows}
    ${more}
  </div>`;
}

module.exports = {
  KIND_LABEL,
  KEEP_HOURS,
  SEED_RECENT_DAYS,
  MAX_ITEMS,
  MAX_REDDIT_DRAFTS,
  kindOf,
  diffAgainstLedger,
  recentlySeen,
  buildRedditSuggestion,
  urlFor,
  buildSnapshot,
  renderNewShowTypesBlock,
};
