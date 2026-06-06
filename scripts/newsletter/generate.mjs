// Newsletter generator — Direction A (card stack), site-canonical
// Usage: node gen-newsletter.mjs YYYY-MM-DD (week-start Monday)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Path setup: `repo` resolves to the repo root via __dirname so the generator
// runs identically on macOS local dev, Linux CI, and from a git worktree.
// `scriptDir` is for sibling lookups (dump-tony-predictions.ts).
//
// Output directory defaults to ~/Documents/claude-outputs/newsletter-mocks
// for local runs (matches the prior macOS behavior + the user's iCloud sync
// path). CI overrides via NEWSLETTER_OUT_DIR — a Linux runner doesn't have
// that path, but it does have $GITHUB_WORKSPACE/data/newsletter-drafts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptDir = __dirname;
const repo = path.resolve(__dirname, '..', '..');

// Bridge to the canonical CJS email-templates lib. Imports use repo-relative
// paths now (was hardcoded /Users/tompryor/... — broke on CI).
const cjsRequire = createRequire(import.meta.url);
const { buildUnsubscribeUrl } = cjsRequire(path.join(repo, 'scripts/lib/email-templates'));
const { reconcileClosure, reconcileClosureDateWithClosingDate } = cjsRequire(path.join(repo, 'scripts/lib/cast-changes-filters'));
const { reviews } = JSON.parse(fs.readFileSync(path.join(repo, 'data/reviews.json'), 'utf8'));
const { shows } = JSON.parse(fs.readFileSync(path.join(repo, 'data/shows.json'), 'utf8'));
const castData = JSON.parse(fs.readFileSync(path.join(repo, 'data/cast-changes.json'), 'utf8'));
const buzzRaw = JSON.parse(fs.readFileSync(path.join(repo, 'data/audience-buzz.json'), 'utf8'));
const audienceBuzz = buzzRaw.shows;

const argDate = process.argv[2]; // YYYY-MM-DD (Monday)
if (!argDate) { console.error('Usage: node gen-newsletter.mjs YYYY-MM-DD'); process.exit(1); }
// String-compare dates to avoid TZ issues — openingDate is 'YYYY-MM-DD'
const weekStartStr = argDate;
const weekEndDate = new Date(argDate + 'T12:00:00'); weekEndDate.setDate(weekEndDate.getDate() + 6);
const weekEndStr = weekEndDate.toISOString().slice(0, 10);
const horizon7Date = new Date(weekEndDate); horizon7Date.setDate(horizon7Date.getDate() + 7);
const horizon7Str = horizon7Date.toISOString().slice(0, 10);

// --- Cross-issue memory (data/newsletter-state.json) ---------------------------
// Persisted week-over-week so the digest never re-features last week's biggest
// mover or re-announces a closing it already announced. Best-effort: a missing
// or corrupt file degrades to "no memory" (everything is fair game).
const STATE_PATH = path.join(repo, 'data/newsletter-state.json');
let _priorState = { issues: [] };
try { _priorState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || { issues: [] }; } catch {}
const _priorIssues = (_priorState.issues || [])
  .filter(i => i && i.weekStart && i.weekStart < weekStartStr)
  .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
const _lastIssue = _priorIssues[0] || null;
const lastMoverIds = new Set(_lastIssue ? (_lastIssue.moverShowIds || []) : []);
const recentAnnouncedIds = new Set(_priorIssues.slice(0, 4).flatMap(i => i.announcedClosingShowIds || []));
// Suppress any show that appeared in last week's email from the OB Openings
// section. The 14-day grace window causes OB shows to re-surface the following
// week even though subscribers already saw them. featuredShowIds was always
// saved; this wires it back up on the read side.
const lastFeaturedIds = new Set(_lastIssue ? (_lastIssue.featuredShowIds || []) : []);

// --- Within-issue cross-section de-dup -----------------------------------------
// A show featured in a higher section is suppressed from every lower one, so a
// single show (e.g. Fallen Angels) never appears in Movers AND Closings AND
// Casting in the same email. Sections add their rendered ids as a side effect,
// in render order; lower sections skip anything already claimed.
const featuredShowIds = new Set();
const _moverShowIds = [];
const _announcedShowIds = [];
const notFeatured = (id) => !featuredShowIds.has(id);
const markFeatured = (...ids) => { for (const id of ids) if (id) featuredShowIds.add(id); };

function inWeek(dateStr) { if (!dateStr) return false; return dateStr >= weekStartStr && dateStr <= weekEndStr; }
function inWeekDateOnly(d) { if (!d) return false; const s = (typeof d === 'string') ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10); return s >= weekStartStr && s <= weekEndStr; }
function fmt(dateStr) { const d = new Date(dateStr + (dateStr.length === 10 ? 'T12:00:00' : '')); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }); }
function fmtFull(dateStr) { const d = (typeof dateStr === 'string') ? new Date(dateStr + 'T12:00:00') : dateStr; return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }); }
function dayOf(dateStr) { const d = new Date(dateStr + (dateStr.length === 10 ? 'T12:00:00' : '')); return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }); }

// Composite score cache, lazy-loaded from public/data/shows/{id}.json. These
// per-show files are the SAME canonical compositeScore (tier-weighted, not
// arithmetic) the live site renders — `cs` is compositeScore, `rc` is
// reviewCount. Using arithmetic means here was a long-standing bug: per
// CLAUDE.md the project uses tier-weighted averages everywhere (T1=1.0,
// T2=0.75, T3=0.35), and the newsletter must match the site's published
// number show-for-show.
const _compositeCache = new Map();
function loadCompositeScore(showId) {
  if (_compositeCache.has(showId)) return _compositeCache.get(showId);
  const p = path.join(repo, 'public/data/shows', `${showId}.json`);
  let result = null;
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof d.cs === 'number' && typeof d.rc === 'number') {
      result = { avg: Math.round(d.cs), count: d.rc, raw: d.cs };
    }
  } catch {}
  _compositeCache.set(showId, result);
  return result;
}

function aggregateScore(showId) {
  // Prefer the canonical compositeScore (tier-weighted). This matches every
  // place the score is displayed on the site. Falls back to arithmetic mean
  // only if the per-show JSON is missing — in that case the show wouldn't be
  // renderable on the site either, so a fallback is acceptable for the
  // newsletter to still emit something.
  const composite = loadCompositeScore(showId);
  if (composite) return composite;
  const rs = reviews.filter(r => r.showId === showId && r.assignedScore != null && (r.publishDate || '').slice(0, 10) <= weekEndStr);
  if (!rs.length) return null;
  return { avg: Math.round(rs.reduce((a, r) => a + r.assignedScore, 0) / rs.length), count: rs.length };
}

function minReviews(category) {
  return (category === 'off-broadway' || category === 'off-west-end') ? 3 : 5;
}

function getImage(show) {
  if (show.images && show.images.thumbnail) {
    const p = show.images.thumbnail.startsWith('/') ? show.images.thumbnail : '/' + show.images.thumbnail;
    return 'https://broadwayscorecard.com' + p;
  }
  return null;
}

function scoreTier(score, category) {
  if (score == null) return null;
  const goldMin = (category === 'west-end' || category === 'off-west-end') ? 85 : 83;
  if (score >= goldMin) return { id: 'gold', label: 'Critical Gold', bg: 'linear-gradient(135deg,#DAA520 0%,#FFD700 30%,#FFF0A0 50%,#FFD700 70%,#DAA520 100%)', solid: '#FFD700', text: '#1a1a1a', border: '#C8960E', glow: '0 0 24px rgba(218,165,32,0.55),0 4px 12px rgba(0,0,0,0.3)' };
  if (score >= 75) return { id: 'rec', label: 'Recommended', bg: '#22c55e', solid: '#22c55e', text: '#fff', glow: '0 2px 8px rgba(34,197,94,0.3)' };
  if (score >= 65) return { id: 'worth', label: 'Worth Seeing', bg: '#14b8a6', solid: '#14b8a6', text: '#fff', glow: '0 2px 8px rgba(20,184,166,0.3)' };
  if (score >= 55) return { id: 'skip', label: 'Skippable', bg: '#d97706', solid: '#d97706', text: '#1a1a1a', glow: '0 2px 8px rgba(217,119,6,0.3)' };
  return { id: 'miss', label: 'Critical Miss', bg: '#ef4444', solid: '#ef4444', text: '#fff', glow: '0 2px 8px rgba(239,68,68,0.3)' };
}
function isGoldTier(score, category) { return scoreTier(score, category)?.id === 'gold'; }

// `box-sizing:border-box` is the fix — Critical Gold has a 2px border which would
// otherwise expand the box past nominal `size`; with border-box the border lives
// inside the declared width/height so all tiers render at the same visual size.
// line-height === size keeps the number vertically centered for every tier.
function badgeHtml(score, size = 64, category) {
  const t = scoreTier(score, category);
  if (!t) return `<div style="display:inline-block;width:${size}px;height:${size}px;border-radius:12px;background:#2a2a38;color:#9ca3af;border:1px solid rgba(255,255,255,0.1);font-size:${Math.round(size*0.22)}px;font-weight:700;line-height:${size}px;text-align:center;">TBD</div>`;
  const isGold = t.id === 'gold';
  const fontSize = Math.round(size * 0.47);
  // Default to content-box (no box-sizing) and shrink inner gold size by 4px
  // so border doesn't push total visual size past peers in Gmail iOS/Android.
  const innerSize = isGold ? size - 4 : size;
  const lineHeight = innerSize;
  const extra = isGold ? `border:2px solid ${t.border};` : '';
  return `<div style="display:inline-block;width:${innerSize}px;height:${innerSize}px;border-radius:12px;background:${t.bg};color:${t.text};font-size:${fontSize}px;font-weight:700;line-height:${lineHeight}px;text-align:center;${extra}box-shadow:${t.glow};">${score}</div>`;
}

function smallBadge(score, size = 36, category) {
  const t = scoreTier(score, category);
  if (!t) return `<div style="display:inline-block;width:${size}px;height:${size}px;border-radius:8px;background:#2a2a38;color:#9ca3af;border:1px solid rgba(255,255,255,0.1);font-size:11px;font-weight:700;line-height:${size}px;text-align:center;">TBD</div>`;
  const isGold = t.id === 'gold';
  const fontSize = 15;
  // Some email clients (notably Gmail Android) don't respect box-sizing:border-box,
  // which makes the 2px gold border push total dimensions to 44px while peers stay
  // at 40px. Compensate by shrinking the inner width/height so total visual = size.
  const innerSize = isGold ? size - 4 : size;
  const lineHeight = innerSize;
  const extra = isGold ? `border:2px solid ${t.border};` : '';
  const smallShadow = isGold
    ? '0 0 8px rgba(218,165,32,0.4),0 2px 6px rgba(0,0,0,0.3)'
    : `0 2px 6px ${t.solid}40`;
  return `<div style="display:inline-block;width:${innerSize}px;height:${innerSize}px;border-radius:8px;background:${t.bg};color:${t.text};font-size:${fontSize}px;font-weight:700;line-height:${lineHeight}px;text-align:center;${extra}box-shadow:${smallShadow};">${score}</div>`;
}

function tierLabel(score, category) {
  const t = scoreTier(score, category);
  if (!t) return '';
  return `<div style="font-size:9px;font-weight:600;color:${t.solid};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${t.label}</div>`;
}

// Audience grade — secondary, shown as small letter chip
function getAudienceGrade(score) {
  if (score == null) return null;
  if (score >= 90) return { grade: 'A+', label: 'Loving It', color: '#22c55e', textColor: '#fff' };
  if (score >= 88) return { grade: 'A',  label: 'Loving It', color: '#16a34a', textColor: '#fff' };
  if (score >= 83) return { grade: 'A-', label: 'Liking It', color: '#14b8a6', textColor: '#fff' };
  if (score >= 78) return { grade: 'B+', label: 'Liking It', color: '#0ea5e9', textColor: '#fff' };
  if (score >= 73) return { grade: 'B',  label: 'Shrugging', color: '#f59e0b', textColor: '#1a1a1a' };
  if (score >= 68) return { grade: 'B-', label: 'Shrugging', color: '#f97316', textColor: '#1a1a1a' };
  if (score >= 63) return { grade: 'C+', label: 'Disliking', color: '#ef4444', textColor: '#fff' };
  if (score >= 58) return { grade: 'C',  label: 'Disliking', color: '#dc2626', textColor: '#fff' };
  if (score >= 53) return { grade: 'C-', label: 'Disliking', color: '#b91c1c', textColor: '#fff' };
  if (score >= 48) return { grade: 'D',  label: 'Loathing',  color: '#991b1b', textColor: '#fff' };
  return { grade: 'F', label: 'Loathing', color: '#6b7280', textColor: '#fff' };
}

// Canonical AudienceChip — mirrors src/components/show-cards/ShowPills.tsx
// Sits BELOW the critic score badge in the score column.
function audienceChip(showId) {
  const buzz = audienceBuzz[showId];
  if (!buzz || buzz.combinedScore == null) return '';
  const totalReviews = Object.values(buzz.sources || {}).reduce((a, s) => a + (s?.reviewCount ?? 0), 0);
  if (totalReviews < 15) return '';
  const g = getAudienceGrade(buzz.combinedScore);
  // 12% alpha bg + solid text color, 10px leading-none
  const bg = g.color + '20';
  return `<div style="display:inline-flex;align-items:center;gap:3px;padding:3px 7px;background:${bg};color:${g.color};border-radius:999px;font-size:10px;font-weight:700;line-height:1;margin-top:8px;">
    <span style="opacity:0.6;">Audience:&nbsp;</span><span>${g.grade}</span>
  </div>`;
}

function marketLabel(category) {
  if (category === 'broadway') return 'Bway';
  if (category === 'off-broadway') return 'Off-Bway';
  if (category === 'west-end') return 'West End';
  if (category === 'off-west-end') return 'Off West End';
  return category;
}

// Wrap content in a link to the show page. Inline-block + color:inherit keeps
// the existing typography intact while making the whole title tappable. Used
// across every section that mentions a show.
const SITE = 'https://broadwayscorecard.com';
function showHref(show) { return show && show.slug ? `${SITE}/show/${show.slug}` : SITE; }

// Opera shows (type='opera') are surfaced in their own dedicated Opera
// Openings section and EXCLUDED from every other section. Opera coverage
// follows different conventions: T1-flat weighting (per src/lib/engine.ts
// isOpera path), different audience expectations, narrower critic pool.
// Mixing them into Broadway/Off-Broadway feeds skews subjects and stats.
function isOperaShow(s) { return !!s && s.type === 'opera'; }
function showLink(show, inner) {
  if (!show || !show.slug) return inner;
  return `<a href="${showHref(show)}" style="color:inherit;text-decoration:none">${inner}</a>`;
}

// Per-section "see all" footer. One <tr> with a hairline border-top — much
// tighter than the previous two-row layout (which added a stray &nbsp; line
// that read as a stranded blank between the last show row and the link).
// colspan="9" is intentional over-padding so the link spans the full width
// of 3-col cards (London / Box Office / Tony) and HTML clamps to the real
// column count. NYC sections use brand gold; London uses pink.
function seeAllLink(href, label, opts = {}) {
  const color = opts.color || '#d4a574';
  return `<tr><td colspan="9" style="padding:8px 16px 10px;border-top:1px solid rgba(255,255,255,0.05);">
      <a href="${href}" style="font-size:12px;color:${color};text-decoration:none;font-weight:600;">${label} →</a>
    </td></tr>`;
}

// Critic + outlet registries — look up the slug for a critic / outlet name so
// we can deep-link to /critics/{slug} and /critics/outlets/{slug}.
let _criticReg, _outletReg;
function loadCriticReg() {
  if (_criticReg) return _criticReg;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repo, 'data/critic-registry.json'), 'utf8'));
    const byName = new Map();
    for (const [slug, c] of Object.entries(raw.critics || {})) {
      if (c.displayName) byName.set(c.displayName.toLowerCase(), slug);
    }
    _criticReg = byName;
  } catch { _criticReg = new Map(); }
  return _criticReg;
}
function loadOutletReg() {
  if (_outletReg) return _outletReg;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repo, 'data/outlet-registry.json'), 'utf8'));
    const byName = new Map();
    for (const [slug, o] of Object.entries(raw.outlets || {})) {
      if (o.displayName) byName.set(o.displayName.toLowerCase(), slug);
      for (const alias of (o.aliases || [])) byName.set(alias.toLowerCase(), slug);
    }
    _outletReg = byName;
  } catch { _outletReg = new Map(); }
  return _outletReg;
}

// Outlet → tier map, also from data/outlet-registry.json. Used by the
// tier-weighted average helper below. Canonical weights per
// src/config/scoring.ts: T1=1.0, T2=0.75, T3=0.40, T4=0.20.
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.40, 4: 0.20 };
const DEFAULT_TIER = 3;
let _outletTierMap = null;
function loadOutletTierMap() {
  if (_outletTierMap) return _outletTierMap;
  const m = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repo, 'data/outlet-registry.json'), 'utf8'));
    for (const [slug, o] of Object.entries(raw.outlets || {})) {
      if (o.tier) m.set(slug, o.tier);
      if (o.displayName) m.set(o.displayName.toLowerCase(), o.tier || DEFAULT_TIER);
      for (const alias of (o.aliases || [])) m.set(alias.toLowerCase(), o.tier || DEFAULT_TIER);
    }
  } catch {}
  _outletTierMap = m;
  return m;
}

// Tier-weighted mean — matches src/lib/scoring.ts calculateCriticScore().
// CLAUDE.md rule: never use arithmetic means for score aggregation. Every
// call site that compares review subsets (biggest mover before/after,
// outlier peer-avg) routes through this.
function tierWeightedAverage(reviewList) {
  if (!reviewList || reviewList.length === 0) return null;
  const tierMap = loadOutletTierMap();
  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of reviewList) {
    if (r.assignedScore == null) continue;
    const tier = tierMap.get(r.outletId) || tierMap.get((r.outlet || '').toLowerCase()) || DEFAULT_TIER;
    const w = TIER_WEIGHTS[tier] || TIER_WEIGHTS[DEFAULT_TIER];
    weightedSum += r.assignedScore * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}
function criticLink(name, inner) {
  if (!name || name === 'Unknown') return inner;
  const slug = loadCriticReg().get(name.toLowerCase());
  if (!slug) return inner;
  return `<a href="${SITE}/critics/${slug}" style="color:inherit;text-decoration:none">${inner}</a>`;
}
function outletLink(name, inner) {
  if (!name) return inner;
  const slug = loadOutletReg().get(name.toLowerCase());
  if (!slug) return inner;
  return `<a href="${SITE}/critics/outlets/${slug}" style="color:inherit;text-decoration:none">${inner}</a>`;
}
function castSlugify(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function castLink(name, inner) {
  if (!name) return inner;
  const slug = castSlugify(name);
  if (!slug) return inner;
  return `<a href="${SITE}/cast/${slug}" style="color:inherit;text-decoration:none">${inner}</a>`;
}

// Canonical market tag pill — matches the closings/announced-closings style.
// Use this everywhere a category label is rendered next to a title, instead of
// the older uppercase-gray text. Two palettes: gold for NYC, pink for London.
function marketPill(category) {
  const isLondon = category === 'west-end' || category === 'off-west-end';
  const color = isLondon ? '#f472b6' : '#d4a574';
  const bg = isLondon ? 'rgba(244,114,182,0.12)' : 'rgba(212,165,116,0.12)';
  const label = (category === 'broadway' ? 'BWAY'
    : category === 'off-broadway' ? 'OFF-BWAY'
    : category === 'west-end' ? 'WEST END'
    : category === 'off-west-end' ? 'OFF WEST END'
    : (marketLabel(category) || '').toUpperCase());
  return `<span class="mp" style="background:${bg};color:${color}">${label}</span>`;
}

function pill(label, color = '#c084fc', bg = 'rgba(168,85,247,0.15)') {
  return `<span class="gp" style="background:${bg};color:${color}">${label}</span>`;
}

function thumb(show, size = 64) {
  const url = getImage(show);
  const inner = url
    ? `<img src="${url}" alt="${show.title}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;background:#2a2a38;">`
    : `<div style="width:${size}px;height:${size}px;border-radius:8px;background:#2a2a38;text-align:center;line-height:${size}px;font-size:24px;color:#6b7280;">🎭</div>`;
  // Wrap in an anchor so the thumbnail itself is tappable — every show
  // mention in the email leads to its show page.
  return show && show.slug
    ? `<a href="${SITE}/show/${show.slug}" class="tdec">${inner}</a>`
    : inner;
}

// Poster image (taller, 2:3) for opening cards that have a poster available.
// Falls back to square thumb if no poster.
function posterOrThumb(show, posterW = 80, posterH = 120) {
  if (show.images && show.images.poster) {
    const p = show.images.poster.startsWith('/') ? show.images.poster : '/' + show.images.poster;
    const url = 'https://broadwayscorecard.com' + p;
    const img = `<img src="${url}" alt="${show.title}" width="${posterW}" height="${posterH}" style="display:block;width:${posterW}px;height:${posterH}px;object-fit:cover;border-radius:8px;background:#2a2a38;">`;
    return show && show.slug
      ? `<a href="${SITE}/show/${show.slug}" class="tdec">${img}</a>`
      : img;
  }
  return thumb(show, posterW);
}

// Compute a show's rank by critic score among open shows in the same market.
// Returns { position, total } or null when not scoreable / market too small.
function openMarketRank(show) {
  if (!show || !show.category) return null;
  const peers = shows.filter(s =>
    s.category === show.category
    && s.status === 'open'
  );
  if (peers.length < 5) return null;
  const scored = peers.map(s => {
    const a = aggregateScore(s.id);
    return { id: s.id, score: a && a.count >= minReviews(s.category) ? a.avg : null };
  }).filter(x => x.score != null);
  // Competition ranking (1,1,3) per memory feedback_competition_rank_for_leaderboards
  scored.sort((a, b) => b.score - a.score);
  const idx = scored.findIndex(x => x.id === show.id);
  if (idx === -1) return null;
  // Find position handling ties
  let position = idx + 1;
  for (let i = 0; i < idx; i++) {
    if (scored[i].score === scored[idx].score) { position = i + 1; break; }
  }
  return { position, total: peers.length };
}

// SHOW ROW — uses POSTER image (2:3) on left for vertical fill; audience chip lives in score column under the critic badge
function showRow(show, opts = {}) {
  const a = aggregateScore(show.id);
  const eligible = a && a.count >= minReviews(show.category);
  const score = eligible ? a.avg : null;
  const rank = score != null ? openMarketRank(show) : null;
  const formatPill = show.type ? pill(show.type.toUpperCase(), '#c084fc', 'rgba(168,85,247,0.15)') : '';
  const revivalPill = show.isRevival ? pill('REVIVAL', '#d4a574', 'rgba(212,165,116,0.15)') : '';
  const reopenPill = opts.isReopening ? pill('REOPENED', '#a78bfa', 'rgba(167,139,250,0.18)') : '';
  const venue = (show.venue || '').split(' / ')[0];
  // Date label flips for reopenings: "Reopened <day> <date>" instead of
  // "Opened…". reopeningDate is used when present, falls back to openingDate.
  const eventDate = opts.isReopening && show.reopeningDate ? show.reopeningDate : show.openingDate;
  const eventVerb = opts.isReopening ? 'Reopened' : 'Opened';
  const metaDate = `${eventVerb} ${dayOf(eventDate)} ${fmt(eventDate)}`;
  const metaVenue = venue;
  const audChip = audienceChip(show.id);
  const scoreCol = score != null
    ? `<td valign="middle" width="92" style="padding:14px 16px 14px 4px;text-align:center;">
        ${tierLabel(score, show.category)}
        ${badgeHtml(score, 64, show.category)}
        <div style="font-size:10px;color:#9ca3af;margin-top:6px;">${a.count} reviews</div>
        ${audChip}
      </td>`
    : `<td valign="middle" width="92" style="padding:14px 16px 14px 4px;text-align:center;">
        <div style="font-size:9px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Pending</div>
        ${badgeHtml(null, 64)}
        <div style="font-size:10px;color:#9ca3af;margin-top:6px;">${a ? a.count + ' rev' : '0 reviews'}</div>
        ${audChip}
      </td>`;
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" style="background:#1a1a24;border-radius:16px;border:1px solid rgba(255,255,255,0.05);box-shadow:0 2px 8px -2px rgba(0,0,0,0.5);margin-bottom:10px;">
    <tr>
      <td valign="top" width="96" style="padding:14px 0 14px 16px;">${posterOrThumb(show, 80, 120)}</td>
      <td valign="top" style="padding:14px 8px 14px 12px;">
        <div style="font-size:17px;font-weight:700;color:#fff;line-height:1.25;">${showLink(show, show.title)}</div>
        <div style="margin-top:6px;">${formatPill}${revivalPill}${reopenPill}</div>
        <div style="font-size:13px;color:#9ca3af;margin-top:8px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${metaDate}</div>
        <div style="font-size:13px;color:#9ca3af;margin-top:2px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${metaVenue}</div>
      </td>
      ${scoreCol}
    </tr>
  </table>`;
}

function sectionHeading(title, countNote, opts = {}) {
  // opts.href makes the heading title a link (e.g. Box Office heading → /box-office).
  const titleHtml = opts.href
    ? `<a href="${opts.href}" style="color:#fff;text-decoration:none;">${title}</a>`
    : title;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
    <td><h2 class="showttl">${titleHtml}</h2></td>
    ${countNote ? `<td align="right"><span style="font-size:12px;color:#9ca3af;font-weight:400;">${countNote}</span></td>` : ''}
  </tr></table>`;
}

function sectionWrap(headingHtml, bodyHtml) {
  return `<tr><td style="padding:24px 4px 12px;">${headingHtml}</td></tr><tr><td style="padding:0 4px 4px;">${bodyHtml}</td></tr>`;
}

// "Opening event" helper — a show qualifies for an Openings section if its
// openingDate OR its reopeningDate falls within the week window. Returns
// `{ show, isReopening }` so downstream rendering + newsworthiness scoring
// can use the right verbiage ("Opens on Broadway" vs "Reopens on Broadway").
// reopeningDate is a manual data-repo field; populated when a show closes
// and returns mid-season (e.g. Can I Be Frank, off-Broadway, May 2026).
function openingEventsForWeek(category) {
  const out = [];
  for (const s of shows) {
    if (s.category !== category) continue;
    if (isOperaShow(s)) continue;
    if (inWeek(s.openingDate)) {
      out.push({ show: s, isReopening: false });
      continue;
    }
    if (inWeek(s.reopeningDate)) {
      out.push({ show: s, isReopening: true });
    }
  }
  return out;
}

// SECTION: BW openings (includes reopenings — see openingEventsForWeek)
function broadwayOpenings() {
  // Only feature shows we actually have reviews for (never name a no-review show).
  const events = openingEventsForWeek('broadway')
    .filter(e => notFeatured(e.show.id))
    .filter(e => { const a = aggregateScore(e.show.id); return a && a.count >= minReviews('broadway'); });
  if (!events.length) return { html: null, list: [] };
  const reopeningIds = new Set(events.filter(e => e.isReopening).map(e => e.show.id));
  const list = events.map(e => e.show);
  markFeatured(...list.map(s => s.id));
  const hasOpen = events.some(e => !e.isReopening);
  const hasReopen = events.some(e => e.isReopening);
  const title = hasOpen && hasReopen ? 'Opened on Broadway'
    : hasReopen && !hasOpen ? 'Reopened on Broadway'
    : 'Opened on Broadway';
  return { html: sectionWrap(sectionHeading(title), list.map(s => showRow(s, { isReopening: reopeningIds.has(s.id) })).join('')), list };
}

// SECTION: OB openings — only show scored, mention count of pending.
// Empty-shelf guard (2026-05-24): if there are NO scored shows to render, the
// section is dropped entirely. Previously it surfaced a heading + "+N needs
// more reviews" with an empty body — visually broken and uninformative. The
// pending count gets promoted to the heading subtitle only when there's at
// least one show to render alongside it.
function offBroadwayOpenings() {
  // Grace window: include OB shows that opened in the last 14 days, not just the
  // strict in-week opening — this catches shows that were added to our DB late.
  // Opera is excluded (it has its own section); only shows with reviews qualify;
  // the highest-scored show leads as the featured opening.
  const cutoffDate = new Date(weekStartStr + 'T12:00:00'); cutoffDate.setDate(cutoffDate.getDate() - 14);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const withScore = shows
    .filter(s => s.category === 'off-broadway' && s.status === 'open' && !isOperaShow(s)
      && s.openingDate && s.openingDate >= cutoff && s.openingDate <= weekEndStr
      && notFeatured(s.id) && !lastFeaturedIds.has(s.id)) // suppress last week's shows
    .map(s => ({ s, agg: aggregateScore(s.id) }))
    .filter(x => x.agg && x.agg.count >= minReviews('off-broadway'))
    .sort((a, b) => ((b.agg.raw ?? b.agg.avg) - (a.agg.raw ?? a.agg.avg)));
  if (!withScore.length) return { html: null, list: [] };
  const list = withScore.slice(0, 8).map(x => x.s); // cap the recent-openings list
  markFeatured(...list.map(s => s.id));
  const body = list.map(s => showRow(s, {})).join('');
  return { html: sectionWrap(sectionHeading('Opened Off-Broadway'), body), list };
}

// Tracks whether the most recent Coming Up render included a Broadway show.
// Set as a side-effect of upcomingOpeningsSection() so the assembly block
// can decide where to place the card (top vs bottom) without re-running the
// full filter. Reset each render via createSectionRunner.
let _upcomingHasBroadway = false;

// SECTION: Coming Up — forward-looking openings + starting previews.
// Looks 14 days ahead for openingDate, 7 days ahead for previewsStartDate.
// Distinct from the "Opened" sections which look BACKWARD at the past week.
// Surfaces in a single compact card for both BW + OB; opera excluded (lives
// in its own Opera section); West End covered by the dedicated London card.
function upcomingOpeningsSection() {
  const today = weekEndStr; // anchor on the week's last day
  const horizon14 = (() => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); })();
  const horizon7 = (() => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
  const items = [];
  for (const s of shows) {
    if (s.category !== 'broadway' && s.category !== 'off-broadway') continue;
    if (isOperaShow(s)) continue;
    const opensSoon = s.openingDate && s.openingDate > today && s.openingDate <= horizon14;
    const previewsSoon = s.previewsStartDate && s.previewsStartDate > today && s.previewsStartDate <= horizon7
      && (!s.openingDate || s.openingDate > today);
    if (!opensSoon && !previewsSoon) continue;
    // Sort key: nearest event date. Opening takes precedence over previews if
    // both fall in their respective windows — the audience cares more about
    // "opens Monday" than "previews started Tuesday".
    const eventDate = opensSoon ? s.openingDate : s.previewsStartDate;
    const eventLabel = opensSoon ? 'Opens' : 'Previews start';
    items.push({ show: s, eventDate, eventLabel, isPreview: !opensSoon });
  }
  if (!items.length) return null;
  items.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const top = items.slice(0, 4); // cap card height — surface the closest 4
  const remaining = items.length - top.length;
  // Placement signal: when Coming Up has a Broadway entry it earns a slot near
  // the top of the email (just after the openings cards). An OB-only slate is
  // less prominent news, so the assembly block drops it toward the bottom.
  _upcomingHasBroadway = top.some(it => it.show.category === 'broadway');
  const rows = top.map((it, i, arr) => {
    const isLast = i === arr.length - 1;
    const s = it.show;
    const formatPill = s.type ? pill(s.type.toUpperCase(), '#c084fc', 'rgba(168,85,247,0.15)') : '';
    const revivalPill = s.isRevival ? pill('REVIVAL', '#d4a574', 'rgba(212,165,116,0.15)') : '';
    const venue = (s.venue || '').split(' / ')[0];
    return `<tr>
      <td valign="middle" width="60" style="padding:${i===0?'14':'10'}px 0 ${isLast?'14':'10'}px 16px;">${thumb(s, 48)}</td>
      <td valign="middle" style="padding:${i===0?'14':'10'}px 8px ${isLast?'14':'10'}px 12px;">
        <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.25;">${showLink(s, s.title)} ${marketPill(s.category)} ${formatPill}${revivalPill}</div>
        <div style="font-size:13px;color:#9ca3af;margin-top:6px;line-height:1.4;">
          ${it.eventLabel} ${dayOf(it.eventDate)} ${fmt(it.eventDate)}${venue ? ` · ${venue}` : ''}
        </div>
      </td>
    </tr>${!isLast ? '<tr><td colspan="2" style="padding:0 16px;"><div style="border-top:1px solid rgba(255,255,255,0.05);"></div></td></tr>' : ''}`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">${rows}
    ${seeAllLink(`${SITE}/browse/upcoming-broadway-shows`, remaining > 0 ? `See ${remaining} more upcoming` : 'See all upcoming openings')}
  </table>`;
  return sectionWrap(sectionHeading('Coming Up', 'next 14 days'), body);
}

// SECTION: Biggest Mover — show whose critic score moved most this week from NEW reviews
// Single source of truth for "which shows are critic-mover-worthy this week."
// Used by BOTH biggestMoverSection (renders the cards) AND the newsworthiness
// scorer (decides what goes in the subject). They MUST agree — otherwise the
// subject can advertise a show that no card surfaces (Can I Be Frank case).
// Memoized so neither caller pays for the recomputation.
let _topMoversCache = null;
function findRenderableCriticMovers() {
  if (_topMoversCache) return _topMoversCache;
  const movers = {};
  reviews.forEach(r => {
    if (r.assignedScore == null) return;
    if (!inWeekDateOnly(r.publishDate)) return;
    (movers[r.showId] ||= { thisWeek: [], before: [] }).thisWeek.push(r);
  });
  Object.keys(movers).forEach(id => {
    reviews.forEach(r => {
      if (r.showId !== id || r.assignedScore == null) return;
      if ((r.publishDate || '').slice(0, 10) < weekStartStr) movers[id].before.push(r);
    });
  });
  const candidates = [];
  for (const [id, x] of Object.entries(movers)) {
    if (x.before.length < 4) continue;
    if (x.thisWeek.length < 1) continue;
    const beforeAvg = tierWeightedAverage(x.before);
    const composite = loadCompositeScore(id);
    if (beforeAvg == null || !composite) continue;
    const allAvg = composite.raw;
    const delta = allAvg - beforeAvg;
    if (Math.abs(delta) < 1) continue;
    const show = shows.find(s => s.id === id);
    if (!show) continue;
    if (lastMoverIds.has(id) || !notFeatured(id)) continue; // no week-over-week repeat; no cross-section dupe
    if (show.category !== 'broadway' && show.category !== 'off-broadway') continue;
    if (isOperaShow(show)) continue;
    // Don't double-surface a show that's already in an Openings section.
    // Opens-this-week is the long-standing gate; reopens-this-week was missed,
    // so reopening shows (e.g. Can I Be Frank with reopeningDate=2026-05-21)
    // were appearing in BOTH OB Openings AND Biggest Movers. User-flagged
    // 2026-05-24. Both gates use the same week window helper.
    if (inWeek(show.openingDate)) continue;
    if (inWeek(show.reopeningDate)) continue;
    candidates.push({ show, before: Math.round(beforeAvg), after: Math.round(allAvg), delta, newCount: x.thisWeek.length });
  }
  candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  // Newsworthiness gate: rounded delta ≥ 3 pts, OR ≥ 2 pts AND ≥ 2 new
  // reviews. Filters single-review wobbles on small-n shows.
  const significant = candidates.filter(c => {
    const pts = Math.max(1, Math.abs(c.after - c.before));
    if (pts >= 3) return true;
    if (pts >= 2 && c.newCount >= 2) return true;
    return false;
  });
  _topMoversCache = significant;
  return significant;
}

function biggestMoverSection() {
  const moverList = findRenderableCriticMovers().slice(0, 3);

  // Audience grade movers — only surface when the LETTER GRADE changes
  // (users never see numeric audience values, so a 88.1 → 87.7 dip isn't a
  // user-visible move; an A → A- is). Compares latest audience snapshot
  // (~weekStart) against current audience-buzz.json. NYC only.
  function audienceGradeMovers() {
    const snapDir = path.join(repo, 'data/audience-snapshots');
    let snapFile;
    try {
      const candidatesSnap = fs.readdirSync(snapDir)
        .filter(f => f.startsWith('2025-26-') && f.endsWith('.json') && !f.includes('baseline'))
        .filter(f => {
          const m = f.match(/(\d{4}-\d{2}-\d{2})/);
          return m && m[1] <= weekStartStr;
        })
        .sort();
      snapFile = candidatesSnap[candidatesSnap.length - 1];
    } catch { return []; }
    if (!snapFile) return [];
    let before;
    try { before = JSON.parse(fs.readFileSync(path.join(snapDir, snapFile), 'utf8')); }
    catch { return []; }
    const totalReviewsFor = d => Object.values(d.sources || {}).reduce((a, s) => a + (s?.reviewCount ?? 0), 0);
    const grade = (s) => {
      if (s == null) return null;
      if (s >= 90) return 'A+'; if (s >= 88) return 'A'; if (s >= 83) return 'A-';
      if (s >= 78) return 'B+'; if (s >= 73) return 'B'; if (s >= 68) return 'B-';
      if (s >= 63) return 'C+'; if (s >= 58) return 'C'; if (s >= 53) return 'C-';
      if (s >= 48) return 'D'; return 'F';
    };
    const out = [];
    Object.entries(before.shows || {}).forEach(([id, b]) => {
      const n = audienceBuzz[id];
      if (!n || b.combinedScore == null || n.combinedScore == null) return;
      const nReviews = totalReviewsFor(n);
      const bReviews = totalReviewsFor(b);
      // Per-market review thresholds — Broadway shows pass at 15+, but Off-Broadway
      // needs 100+ to avoid niche shows where a few new reviews swing a small n
      // hard enough to cross a grade boundary.
      const show = shows.find(s => s.id === id);
      if (!show) return;
      if (lastMoverIds.has(id) || !notFeatured(id)) return; // no week-over-week repeat; no cross-section dupe
      if (show.category !== 'broadway' && show.category !== 'off-broadway') return;
    if (isOperaShow(show)) return;
      // Off-Broadway threshold lowered 100 → 50 (Gemini final review): 100
      // was effectively gating out every OB audience mover; many OB shows
      // have a steady-state audience review count in the 60–90 range, so a
      // genuine grade flip with ~10 new reviews was being suppressed. 50
      // still requires real sample size — a 5-review-base show flipping a
      // grade is noise, but a 50-review show flipping is signal.
      const minReviewsForMover = show.category === 'broadway' ? 15 : 50;
      if (bReviews < minReviewsForMover || nReviews < minReviewsForMover) return;
      const bg = grade(b.combinedScore);
      const ng = grade(n.combinedScore);
      if (!bg || !ng || bg === ng) return;
      if (Math.abs(n.combinedScore - b.combinedScore) < 2) return;
      const dir = n.combinedScore > b.combinedScore ? 'up' : 'down';
      out.push({
        show,
        beforeGrade: bg, afterGrade: ng,
        dir,
        magnitude: Math.abs(n.combinedScore - b.combinedScore),
        reviewCount: nReviews,
        reviewDelta: nReviews - bReviews,
        isBroadway: show.category === 'broadway',
      });
    });
    // Sort: Broadway first, then Off-Broadway by review-count (larger n = more
    // trustworthy mover, less likely to be a niche show swinging on small data).
    out.sort((a, b) => {
      if (a.isBroadway !== b.isBroadway) return a.isBroadway ? -1 : 1;
      if (a.isBroadway) return b.magnitude - a.magnitude; // among BW, biggest mover wins
      return b.reviewCount - a.reviewCount; // among OB, most-reviewed wins
    });
    return out.slice(0, 1);
  }
  const audMovers = audienceGradeMovers();
  // Record what the mover section actually rendered (for cross-section de-dup
  // below + next week's cross-issue memory).
  [...moverList, ...audMovers].forEach(m => { _moverShowIds.push(m.show.id); markFeatured(m.show.id); });
  function audGradeColor(g) {
    if (!g) return '#6b7280';
    if (g === 'A+' || g === 'A') return '#16a34a';
    if (g === 'A-') return '#14b8a6';
    if (g === 'B+') return '#0ea5e9';
    if (g === 'B') return '#f59e0b';
    if (g === 'B-') return '#f97316';
    if (g === 'C+' || g === 'C' || g === 'C-') return '#ef4444';
    if (g === 'D') return '#991b1b';
    return '#6b7280';
  }
  function audGradeBox(g) {
    const c = audGradeColor(g);
    return `<div style="box-sizing:border-box;display:inline-block;width:40px;height:40px;border-radius:8px;background:${c};color:#fff;font-size:15px;font-weight:700;line-height:40px;text-align:center;box-shadow:0 2px 6px ${c}40;">${g}</div>`;
  }
  const audRows = audMovers.map((m, i, arr) => {
    const isLast = i === arr.length - 1 && moverList.length === 0; // simpler: always show border between, drop on absolute last
    const dirColor = m.dir === 'up' ? '#22c55e' : '#ef4444';
    const dirArrow = m.dir === 'up' ? '▲' : '▼';
    return `<tr>
      <td valign="middle" width="80" style="padding:14px 0 14px 16px;border-bottom:1px solid rgba(255,255,255,0.05);">${thumb(m.show, 56)}</td>
      <td valign="middle" style="padding:14px 8px 14px 14px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.25;">${showLink(m.show, m.show.title)} ${marketPill(m.show.category)}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:6px;">${m.reviewDelta > 0 ? '+' : ''}${m.reviewDelta} audience review${Math.abs(m.reviewDelta) === 1 ? '' : 's'}</div>
      </td>
      <td valign="middle" width="120" align="center" style="padding:14px 16px 14px 4px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;"><tr>
          <td align="center" valign="middle">${audGradeBox(m.beforeGrade)}</td>
          <td valign="middle" style="padding:0 6px;color:#6b7280;font-size:14px;">→</td>
          <td align="center" valign="middle">${audGradeBox(m.afterGrade)}</td>
        </tr></table>
        <div style="font-size:11px;color:${dirColor};margin-top:6px;font-weight:700;">${dirArrow} ${m.dir} 1 grade</div>
      </td>
    </tr>`;
  }).join('');
  const rows = moverList.map((m, i, arr) => {
    const isLast = i === arr.length - 1;
    const dirColor = m.delta > 0 ? '#22c55e' : '#ef4444';
    const dirArrow = m.delta > 0 ? '▲' : '▼';
    const dirWord = m.delta > 0 ? 'up' : 'down';
    const ptsRounded = Math.max(1, Math.abs(m.after - m.before));
    // Always emit border-bottom; the strip-final-border block below removes
    // it from whichever row ends up last in the combined list.
    return `<tr>
      <td valign="middle" width="80" style="padding:14px 0 14px 16px;border-bottom:1px solid rgba(255,255,255,0.05);">${thumb(m.show, 56)}</td>
      <td valign="middle" style="padding:14px 8px 14px 14px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.25;">${showLink(m.show, m.show.title)} ${marketPill(m.show.category)}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:6px;">+${m.newCount} review${m.newCount!==1?'s':''}</div>
      </td>
      <td valign="middle" width="120" align="center" style="padding:14px 16px 14px 4px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;"><tr>
          <td align="center" valign="middle">${smallBadge(m.before, 40, m.show.category)}</td>
          <td valign="middle" style="padding:0 6px;color:#6b7280;font-size:14px;">→</td>
          <td align="center" valign="middle">${smallBadge(m.after, 40, m.show.category)}</td>
        </tr></table>
        <div style="font-size:11px;color:${dirColor};margin-top:6px;font-weight:700;">${dirArrow} ${dirWord} ${ptsRounded} pt${ptsRounded === 1 ? '' : 's'}</div>
      </td>
    </tr>`;
  }).join('');
  // Drop the trailing border from whichever row is last in the combined list.
  // Each row carries border-bottom on all 3 cells, so strip the last 3 to clear
  // the entire bottom edge — otherwise a partial line lingers under the card.
  let allRows = rows + audRows;
  const BORDER_STR = 'border-bottom:1px solid rgba(255,255,255,0.05);';
  for (let i = 0; i < 3; i++) {
    const last = allRows.lastIndexOf(BORDER_STR);
    if (last === -1) break;
    allRows = allRows.slice(0, last) + allRows.slice(last + BORDER_STR.length);
  }
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">${allRows}</table>`;
  const totalRows = moverList.length + audMovers.length;
  const title = totalRows > 1 ? 'Biggest Movers' : 'Biggest Mover';
  return sectionWrap(sectionHeading(title), body);
}

// SECTION: Awards Race Movers — Tony odds shifts week-over-week
// Source: data/tony-polymarket-odds.json already has nominees + prevNominees
function awardsMoversSection() {
  let pm;
  try { pm = JSON.parse(fs.readFileSync(path.join(repo, 'data/tony-polymarket-odds.json'), 'utf8')); }
  catch { return null; }
  const moves = [];
  Object.entries(pm.categories || {}).forEach(([category, c]) => {
    if (!c.nominees || !c.prevNominees) return;
    Object.entries(c.nominees).forEach(([nominee, current]) => {
      const prev = c.prevNominees[nominee];
      if (prev == null) return;
      const delta = (current - prev) * 100;
      if (Math.abs(delta) < 2) return; // suppress noise
      // Find matching show by title (loose)
      const show = shows.find(s => s.title.toLowerCase() === nominee.toLowerCase()) ||
                   shows.find(s => s.title.toLowerCase().replace(/[^\w]/g, '') === nominee.toLowerCase().replace(/[^\w]/g, ''));
      moves.push({ category, nominee, show, prev: Math.round(prev * 100), current: Math.round(current * 100), delta });
    });
  });
  if (!moves.length) return null;
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = moves.slice(0, 3);
  const rows = top.map((m, i, arr) => {
    const isLast = i === arr.length - 1;
    const dirColor = m.delta > 0 ? '#22c55e' : '#ef4444';
    const dirArrow = m.delta > 0 ? '▲' : '▼';
    const dirWord = m.delta > 0 ? 'up' : 'down';
    const pts = Math.round(Math.abs(m.delta));
    const thumbHtml = m.show ? thumb(m.show, 44) : `<div style="width:44px;height:44px;border-radius:8px;background:#2a2a38;text-align:center;line-height:44px;font-size:18px;color:#6b7280;">🏆</div>`;
    return `<tr>
      <td valign="middle" width="52" style="padding:10px 10px 10px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">${thumbHtml}</td>
      <td valign="middle" style="padding:10px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        <div style="font-size:14px;color:#fff;font-weight:700;line-height:1.25;">${m.nominee}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">${m.category}</div>
        <div style="font-size:12px;color:#d1d5db;margin-top:4px;"><span style="color:#9ca3af;">${m.prev}%</span> → <span style="font-weight:700;">${m.current}%</span> <span style="color:${dirColor};font-weight:700;margin-left:4px;">${dirArrow} ${dirWord} ${pts} pts</span></div>
      </td>
    </tr>`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:4px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
    </td></tr>
  </table>`;
  return sectionWrap(sectionHeading('Awards Race Movers', 'Tony odds · last 7 days'), body);
}

// SECTION: Tony Predictions — OUR pick for each major category.
// Source: live snapshot via scripts/newsletter/dump-tony-predictions.ts which
// imports data-tony-predictions.ts. This guarantees the numbers match
// /tony-awards/predictions/2025-2026 exactly (tier-weighted recipe +
// best-musical feasibility factor + tonyAudienceGrade, not a 50/50 blend).
function tonyWatchSection() {
  let snap;
  try {
    const dumpScript = path.join(scriptDir, 'dump-tony-predictions.ts');
    const json = execFileSync('node_modules/.bin/tsx', [dumpScript], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    snap = JSON.parse(json);
  } catch (e) {
    console.error('tony snapshot failed:', e.message);
    return null;
  }
  const major = ['best-musical', 'best-play', 'best-revival-musical', 'best-revival-play'];
  const eyebrowLabel = {
    'best-musical': 'BEST MUSICAL',
    'best-play': 'BEST PLAY',
    'best-revival-musical': 'BEST MUSICAL REVIVAL',
    'best-revival-play': 'BEST PLAY REVIVAL',
  };
  const races = [];
  for (const key of major) {
    const entries = snap.categories[key] || [];
    if (entries.length === 0) continue;
    const top = entries[0]; // already sorted desc by prob in dump script
    const show = shows.find(s => s.slug === top.slug);
    if (!show) continue;
    const pct = Math.round(top.prob * 100);
    races.push({ key, eyebrow: eyebrowLabel[key], show, pct });
  }
  const ceremonyDate = new Date('2026-06-08T00:00:00');
  const daysOut = Math.max(0, Math.ceil((ceremonyDate - new Date(weekEndStr + 'T12:00:00')) / 86400000));
  const subtitle = daysOut > 0 ? `ceremony in ${daysOut} days` : 'ceremony this week';
  // Every row gets the PREDICTED pill — one predicted winner per category.
  const rows = races.map((r, i, arr) => {
    const isLast = i === arr.length - 1;
    // Tightened: thumb 48→40, our-pick box 44→40, row padding 10→7. ~12px saved per row.
    const thumbHtml = r.show ? thumb(r.show, 40) : `<div style="width:40px;height:40px;border-radius:8px;background:#2a2a38;text-align:center;line-height:40px;font-size:18px;color:#6b7280;">🏆</div>`;
    const glow = '0 0 12px rgba(251,191,36,0.35),0 2px 8px rgba(0,0,0,0.4)';
    const borderColor = '#fbbf24';
    const ourPickBox = `<div style="box-sizing:border-box;display:inline-block;width:40px;height:40px;border-radius:8px;background:#1a1a24;border:2px solid ${borderColor};color:${borderColor};font-size:13px;font-weight:700;line-height:36px;text-align:center;box-shadow:${glow};">${r.pct}%</div>`;
    const predictedPill = `<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:#1a1a24;border:1px solid #fbbf24;color:#fbbf24;font-size:9px;font-weight:700;letter-spacing:0.08em;vertical-align:2px;margin-left:6px;">★ PREDICTED</span>`;
    const eyebrow = `<div style="font-size:10px;font-weight:700;color:#d4a574;letter-spacing:0.10em;text-transform:uppercase;margin-bottom:2px;">${r.eyebrow}</div>`;
    return `<tr>
      <td valign="middle" width="50" style="padding:7px 10px 7px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">${thumbHtml}</td>
      <td valign="middle" style="padding:7px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        ${eyebrow}
        <div style="font-size:14px;font-weight:700;color:#fff;line-height:1.25;">${showLink(r.show, r.show.title)}${predictedPill}</div>
      </td>
      <td valign="middle" width="56" align="center" style="padding:7px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        ${ourPickBox}
      </td>
    </tr>`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:4px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
    </td></tr>
    ${seeAllLink('https://broadwayscorecard.com/tony-awards/predictions', 'See all 26 Tony predictions')}
  </table>`;
  return sectionWrap(sectionHeading('Tony Predictions', subtitle, { href: `${SITE}/tony-awards/predictions` }), body);
}

// Quote-quality filter: pullQuote is auto-extracted and often starts mid-paragraph
// ("But for all their..."), references the creative team without context ("Lynn and
// director Rob Melrose..."), or is a photo caption ("John Foster (Joe Tapper, right)
// here with..."). Better to omit the blockquote than render a bad one.
function isLowQualityQuote(q) {
  if (!q) return true;
  const head = q.trim().slice(0, 80);
  if (/^(But|And|Yet|So|Still|Though|However|Unfortunately,|Fortunately,)\b/.test(head)) return true;
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+\s*\(/.test(head)) return true;
  if (/^[A-Z][a-z]+\s+and\s+(director|choreographer|composer|actor|writer|playwright|designer)\b/i.test(head)) return true;
  return false;
}

// Pick the best quote text from a review. Preference:
//   r.quote > r.summary > clean pullQuote > "second clause" of bad pullQuote > raw pullQuote
// We DOWNRANK low-quality pullQuotes but never drop them entirely — even an
// imperfect quote beats a quote-shaped void on the Outlier card. For flagged
// pullQuotes ("Lynn and director Rob Melrose do deserve praise…, but what we
// get is…") we try to extract the assertive second clause after a conjunction.
function pickReviewQuote(r) {
  if (r.quote) return truncateAtSentence(r.quote);
  if (r.summary) return truncateAtSentence(r.summary);
  const pq = r.pullQuote || '';
  if (!pq) return '';
  if (!isLowQualityQuote(pq)) return truncateAtSentence(pq);
  // Bad opener — try to extract a useful second clause after a conjunction.
  const conjMatch = pq.match(/^[^,]+,\s+(but|and|though|yet|however|still)\s+(.+)$/i);
  if (conjMatch && conjMatch[2].length >= 40) {
    const tail = conjMatch[2].charAt(0).toUpperCase() + conjMatch[2].slice(1);
    return truncateAtSentence(tail);
  }
  // Last resort — render the raw pullQuote. Better than nothing.
  return truncateAtSentence(pq);
}

function truncateAtSentence(source) {
  let clean = source.replace(/['’]/g, "'").replace(/[“”]/g, '"');
  if (clean.length > 200) {
    const w = clean.slice(0, 200);
    const lastBoundary = Math.max(w.lastIndexOf('. '), w.lastIndexOf('! '), w.lastIndexOf('? '));
    clean = lastBoundary >= 60 ? clean.slice(0, lastBoundary + 1) : w.replace(/\s+\S*$/, '') + '…';
  }
  return clean;
}

// Helper retained — used internally for diagnostics but no longer surfaces
// in the rendered email. Outlier of the Week was restored as its own section.
function findDrivingReviewForShow(showId) {
  const newRs = reviews.filter(r => r.showId === showId && r.assignedScore != null && inWeekDateOnly(r.publishDate));
  if (newRs.length === 0) return null;
  const priorRs = reviews.filter(r => r.showId === showId && r.assignedScore != null && (r.publishDate || '').slice(0, 10) < weekStartStr);
  if (priorRs.length < 2) return null;
  const priorAvg = tierWeightedAverage(priorRs);
  if (priorAvg == null) return null;
  let best = null;
  for (const r of newRs) {
    const diff = r.assignedScore - priorAvg;
    if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { review: r, diff, priorAvg };
  }
  return best;
}

// Returns the single most-divergent reviewer of the week (across all shows
// with ≥4 reviews this week). Threshold ≥12 pts below/above show average.
// Used by both the rendered Outlier section and the newsworthiness scorer.
function findWeekOutlier() {
  const wr = reviews.filter(r => inWeekDateOnly(r.publishDate) && r.assignedScore != null);
  const byShow = {};
  wr.forEach(r => { (byShow[r.showId] ||= []).push(r); });
  let best = null;
  for (const id of Object.keys(byShow)) {
    const rs = byShow[id];
    if (rs.length < 4) continue;
    for (const r of rs) {
      const others = rs.filter(x => x !== r);
      const avg = tierWeightedAverage(others);
      if (avg == null) continue;
      const diff = r.assignedScore - avg;
      // Only positive outliers — a lone rave is a delight; a lone pan just signals disagreement
      // without telling readers something actionable. If no positive outlier exists this week, skip.
      if (diff > 0 && (!best || diff > best.diff)) {
        const show = shows.find(s => s.id === id);
        if (show && (show.category === 'broadway' || show.category === 'off-broadway') && !isOperaShow(show)) {
          best = { review: r, show, diff, peerAvg: Math.round(avg), outlet: r.outlet };
        }
      }
    }
  }
  if (!best || best.diff < 12) return null;
  return best;
}

// SECTION: Outlier of the Week — single critic far from consensus.
// Reads from findWeekOutlier() so the newsworthiness scorer can score the
// same data point without re-running the loop.
function outlierSection() {
  const best = findWeekOutlier();
  if (!best) return null;
  const r = best.review;
  const outletMap = { 'Deadline': 'deadline.com', 'New York Theatre Guide': 'newyorktheatreguide.com', 'TheaterMania': 'theatermania.com', 'New York Stage Review': 'newyorkstagereview.com', "Talkin' Broadway": 'talkinbroadway.com', "New York Daily News": 'nydailynews.com', 'The Recs': 'therecs.com', '1 Minute Critic': '1minutecritic.com', 'Cititour': 'cititour.com', 'Time Out New York': 'timeout.com', 'Vulture': 'vulture.com', 'The New York Times': 'nytimes.com', 'Variety': 'variety.com', 'New York Post': 'nypost.com', 'The Hollywood Reporter': 'hollywoodreporter.com', 'TheWrap': 'thewrap.com', 'The Times (UK)': 'thetimes.com', 'Front Row Center': 'frontrowcenter.com', 'Theater Scene': 'theaterscene.net', 'The Guardian': 'theguardian.com', 'WhatsOnStage': 'whatsonstage.com', 'TheaterScene.net': 'theaterscene.net', 'The Stage': 'thestage.co.uk', 'Stage and Cinema': 'stageandcinema.com' };
  const domain = outletMap[r.outlet] || (r.outlet || '').toLowerCase().replace(/[^a-z0-9]+/g, '') + '.com';
  const logoUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  const directionWord = 'above'; // always positive outlier now
  const cleanQuote = pickReviewQuote(r);
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr>
      <td valign="middle" width="44" style="padding:14px 0 14px 14px;">${outletLink(r.outlet, `<img src="${logoUrl}" alt="${r.outlet}" width="32" height="32" style="display:block;border-radius:6px;background:#fff;">`)}</td>
      <td valign="middle" style="padding:14px 8px 14px 10px;">
        <div style="font-size:13px;color:#fff;font-weight:700;line-height:1.25;">${criticLink(r.criticName, r.criticName || 'Unknown critic')} <span style="color:#9ca3af;font-weight:400;">· ${outletLink(r.outlet, r.outlet)}</span></div>
        <div style="font-size:13px;color:#d1d5db;margin-top:2px;">on <strong style="color:#fff;">${showLink(best.show, best.show.title)}</strong> ${marketPill(best.show.category)}</div>
      </td>
      <td valign="middle" width="60" align="center" style="padding:14px 14px 14px 4px;">
        ${smallBadge(r.assignedScore, 40)}
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;font-weight:600;line-height:1.3;">${Math.abs(best.diff).toFixed(0)} ${directionWord}<br><span style="color:#6b7280;font-weight:400;">show avg ${best.peerAvg}</span></div>
      </td>
    </tr>
    ${cleanQuote ? `<tr><td colspan="3" style="padding:0 14px 14px;">
      <div style="font-size:12px;line-height:1.5;color:#9ca3af;font-style:italic;border-left:2px solid #d4a574;padding:2px 0 2px 10px;">&ldquo;${cleanQuote}&rdquo;</div>
    </td></tr>` : ''}
  </table>`;
  return sectionWrap(sectionHeading('Outlier of the Week'), body);
}

// SECTION: Recently Announced Closings (Broadway only)
// Reads first-class `closure` cast-events: any closure added IN THE WEEK
// WINDOW with a future date. Earlier versions used a 28-day lookback to give
// missed-the-newsletter readers a re-surface, but for a weekly digest that
// re-surfaces 3-week-old closures (e.g. Ragtime, added May 5, reappearing in
// the May 18 newsletter under "Recently Announced Closings" — user-flagged
// 2026-05-24). The weekly is "what happened this week"; stale announcements
// belong in the show page, not the digest.
function announcedClosingsSection() {
  const announcements = [];
  Object.entries(castData.shows).forEach(([showId, data]) => {
    const closures = (data.upcoming || []).filter(e =>
      e.type === 'closure'
      && e.addedDate && e.addedDate >= weekStartStr && e.addedDate <= weekEndStr
    );
    if (closures.length === 0) return;
    const show = shows.find(s => s.id === showId);
    if (!show || show.category !== 'broadway' || isOperaShow(show) || show.status !== 'open' || !show.closingDate) return;
    if (show.closingDate <= weekEndStr) return; // already passed
    if (!notFeatured(show.id) || recentAnnouncedIds.has(show.id)) return; // shown above, or already announced in a recent issue
    announcements.push({ show, closingDate: show.closingDate });
  });
  if (!announcements.length) return null;
  announcements.sort((a, b) => a.closingDate.localeCompare(b.closingDate));
  announcements.forEach(a => { _announcedShowIds.push(a.show.id); markFeatured(a.show.id); });
  const rows = announcements.map((a, i, arr) => {
    const isLast = i === arr.length - 1;
    const agg = aggregateScore(a.show.id);
    const score = agg && agg.count >= minReviews(a.show.category) ? agg.avg : null;
    const closingFmt = fmt(a.closingDate) + ', ' + a.closingDate.slice(0, 4);
    return `<tr>
      <td valign="middle" width="52" style="padding:12px 10px 12px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">${thumb(a.show, 40)}</td>
      <td valign="middle" style="padding:12px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        <div style="font-size:14px;color:#fff;font-weight:700;line-height:1.25;">${showLink(a.show, a.show.title)} ${marketPill(a.show.category)}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:3px;">Closes <span style="color:#fbbf24;font-weight:600;">${closingFmt}</span></div>
      </td>
      <td valign="middle" width="48" align="right" style="padding:12px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        ${score != null ? smallBadge(score, 40, a.show.category) : ''}
      </td>
    </tr>`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:4px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
    </td></tr>
  </table>`;
  return sectionWrap(sectionHeading('Recently Announced Closings', 'Broadway'), body);
}

// SECTION: Commercial — recoupment announcements this week (Broadway).
// News-freshness gate (revised 2026-05-24): recoupedDate must be a valid
// YYYY-MM (rejects year-only "2026") AND firstAdded must fall in the week
// window. Why firstAdded instead of "this/last month on recoupedDate":
// monthly granularity surfaces Giant (recouped 2026-05) in EVERY weekly
// newsletter sent in May AND June — 8+ repeats. firstAdded captures "we
// just learned about this," which is what readers actually want to see
// once. Falls back to weekStart-month match when firstAdded is missing
// (older entries pre-2026 don't have this field).
function commercialSection() {
  let comm;
  try { comm = JSON.parse(fs.readFileSync(path.join(repo, 'data/commercial.json'), 'utf8')); }
  catch { return null; }
  const slugToShow = new Map();
  shows.forEach(s => { if (s.category === 'broadway' && !isOperaShow(s) && s.slug) slugToShow.set(s.slug, s); });
  const fresh = [];
  Object.entries(comm.shows || {}).forEach(([slug, c]) => {
    if (!c.recouped || !c.recoupedDate) return;
    if (!/^\d{4}-\d{2}$/.test(c.recoupedDate)) return;
    // Primary gate: firstAdded falls in the week window.
    if (c.firstAdded) {
      const firstAddedDay = String(c.firstAdded).slice(0, 10);
      if (firstAddedDay < weekStartStr || firstAddedDay > weekEndStr) return;
    } else {
      // Fallback for older entries without firstAdded: recoupedDate matches
      // the week's month. Preserves backwards compat for legacy commercial
      // records that lack the timestamp field.
      const weekMonth = weekEndStr.slice(0, 7);
      if (c.recoupedDate !== weekMonth) return;
    }
    const show = slugToShow.get(slug);
    if (!show) return;
    fresh.push({ show, c });
  });
  if (!fresh.length) return null;
  // Compute weeks-to-recoup from show.openingDate to the middle of the
  // recoupedDate month (recoupedDate is YYYY-MM monthly granularity). Falls
  // back to "" when openingDate is missing so the row still renders.
  function weeksToRecoupLabel(show, recoupedDateYM) {
    if (!show?.openingDate || !recoupedDateYM) return '';
    const m = /^(\d{4})-(\d{2})$/.exec(recoupedDateYM);
    if (!m) return '';
    const recoupMid = new Date(`${m[1]}-${m[2]}-15T12:00:00`);
    const open = new Date(show.openingDate + 'T12:00:00');
    const weeks = Math.round((recoupMid - open) / (7 * 86400000));
    if (!isFinite(weeks) || weeks <= 0) return '';
    return ` in ${weeks} weeks`;
  }
  const rows = fresh.map((f, i, arr) => {
    const isLast = i === arr.length - 1;
    const cap = f.c.capitalization ? '$' + (f.c.capitalization / 1e6).toFixed(1) + 'M' : '—';
    const weeksTail = weeksToRecoupLabel(f.show, f.c.recoupedDate);
    return `<tr>
      <td valign="middle" width="52" style="padding:12px 10px 12px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">${thumb(f.show, 40)}</td>
      <td valign="middle" style="padding:12px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        <div style="font-size:14px;color:#fff;font-weight:700;line-height:1.25;">${showLink(f.show, f.show.title)}</div>
        <div style="font-size:11px;color:#22c55e;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-top:3px;">Recouped${weeksTail}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:3px;">Capitalization: ${cap}</div>
      </td>
    </tr>`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:4px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
    </td></tr>
  </table>`;
  return sectionWrap(sectionHeading('Recoupment', 'Broadway'), body);
}

// SECTION: closing (next 7d from weekEnd)
function closingSection() {
  const list = shows.filter(s => {
    if (!s.closingDate || s.closingDate <= weekEndStr || s.closingDate > horizon7Str) return false;
    if (s.status !== 'open') return false;
    if (!['broadway', 'off-broadway'].includes(s.category)) return false; // NYC only
    if (isOperaShow(s)) return false; // opera has its own section — never in NYC closings
    if (!notFeatured(s.id)) return false; // already surfaced in a higher section
    // Must have a qualifying critic score (drop pending/no-score shows)
    const a = aggregateScore(s.id);
    return a && a.count >= minReviews(s.category);
  }).sort((a, b) => a.closingDate.localeCompare(b.closingDate));
  if (!list.length) return null;
  markFeatured(...list.map(s => s.id));
  const rowFor = (s, isLast) => {
    const a = aggregateScore(s.id);
    const score = a && a.count >= minReviews(s.category) ? a.avg : null;
    const borderBottom = !isLast ? 'border-bottom:1px solid rgba(255,255,255,0.05);' : '';
    return `<tr>
      <td valign="middle" width="52" style="padding:12px 10px 12px 0;${borderBottom}">${thumb(s, 40)}</td>
      <td valign="middle" style="padding:12px 0;${borderBottom}">
        <div style="font-size:14px;color:#fff;font-weight:700;">${showLink(s, s.title)} ${marketPill(s.category)}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:3px;">Closes <span style="color:#fbbf24;font-weight:600;">${dayOf(s.closingDate)} ${fmt(s.closingDate)}</span></div>
      </td>
      <td valign="middle" width="48" align="right" style="padding:12px 0;${borderBottom}">
        ${score != null ? smallBadge(score, 40, s.category) : ''}
      </td>
    </tr>`;
  };
  // Split Broadway (top) and Off-Broadway (below) under their own sub-labels.
  const groupBlock = (label, items) => {
    if (!items.length) return '';
    const rows = items.map((s, i) => rowFor(s, i === items.length - 1)).join('');
    return `<tr><td style="padding:14px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#d4a574;">${label}</td></tr>
      <tr><td style="padding:0 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table></td></tr>`;
  };
  const bw = list.filter(s => s.category === 'broadway');
  const ob = list.filter(s => s.category === 'off-broadway');
  const divider = (bw.length && ob.length)
    ? '<tr><td style="padding:6px 16px;"><div style="border-top:1px solid rgba(255,255,255,0.08);"></div></td></tr>'
    : '';
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">${groupBlock('Broadway', bw)}${divider}${groupBlock('Off-Broadway', ob)}</table>`;
  return sectionWrap(sectionHeading('Closing this Week'), body);
}

// SECTION: casting (Broadway, prev 14 days)
function castingSection() {
  const eventsAll = [];
  Object.keys(castData.shows).forEach(showId => {
    const show = shows.find(s => s.id === showId);
    if (!show || show.category !== 'broadway' || isOperaShow(show)) return;
    const data = castData.shows[showId];
    // Defend at the READ boundary against a stale closure date: cast-changes.json
    // is only healed by the weekly audit, so between runs (or in local preview) a
    // closure event may still carry the pre-extension date. Reconcile it to the
    // broadway.com-audited shows.json closingDate FIRST so reconcileClosure folds
    // departures against the correct date. Then reconcileClosure PER SHOW (never
    // across shows — a closure in one show must not suppress a same-date departure
    // in another).
    const healed = reconcileClosureDateWithClosingDate(data.upcoming || [], show.closingDate).events;
    reconcileClosure(healed).forEach(u =>
      eventsAll.push({ ...u, showId, showTitle: show.title }),
    );
  });
  // Recent: addedDate IN THE WEEK WINDOW. Earlier versions used a 14-day
  // window (weekStart - 7d) but that resurfaces last-week's casting in this
  // week's email, which contradicts the weekly-digest premise. Aligned with
  // the announced-closings tightening per user note 2026-05-24.
  // Closures belong in the closing sections, never here — exclude them so this
  // section only ever shows real cast moves (joins / departures / swaps).
  // A renderable cast move must be an arrival/departure/swap with a REAL
  // performer name and at least one date. Filters out: closures (own section),
  // note/absence rows, placeholder names ("X replacement", "TBA"/"TBD"), and
  // dateless rows ("no dates means these aren't useful" — user, 2026-05-30).
  const PLACEHOLDER = /\breplacement\b|^tba$|^tbd$|^t\.?b\.?[ad]\.?$/i;
  // A "departure" whose name IS the production (e.g. "Moulin Rouge! The Musical
  // Company") is a show-wide closing restated as a per-actor row, not a person.
  // Rendering it prints "<Show> Company departs" — the closure-as-departure bug.
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const isProductionName = (e) => {
    const n = norm(e.name);
    const t = norm(e.showTitle);
    return !!n && !!t && (n === t || n.startsWith(t));
  };
  const isRealMove = (e) => {
    if (!['arrival', 'departure'].includes(e.type)) return false;
    const name = (e.name || '').trim();
    if (!name || PLACEHOLDER.test(name)) return false;
    if (isProductionName(e)) return false;
    if (!e.date && !e.endDate) return false;
    return true;
  };
  const recent = eventsAll.filter(e => isRealMove(e) && e.addedDate && e.addedDate >= weekStartStr && e.addedDate <= weekEndStr);
  if (!recent.length) return null;
  const byShow = {};
  recent.forEach(e => { (byShow[e.showId] ||= []).push(e); });
  const showEntries = Object.values(byShow);
  // cast-changes.json uses `date` (start) and `endDate` (last performance).
  function rangeOf(e) {
    const parts = [];
    if (e && e.date) parts.push(`from ${fmt(e.date)}`);
    if (e && e.endDate) parts.push(`through ${fmt(e.endDate)}`);
    return parts.length ? ` <span style="color:#fbbf24;">· ${parts.join(' · ')}</span>` : '';
  }
  // For each show, surface a single arrival/departure/swap row.
  const groups = [];
  showEntries
    .filter(events => events.length && notFeatured(events[0].showId))
    .slice(0, 5).forEach(events => {
    markFeatured(events[0].showId);
    const showTitle = events[0].showTitle;
    const arr = events.find(e => e.type === 'arrival');
    const dep = events.find(e => e.type === 'departure');
    const items = [];
    if (arr && dep) {
      const range = rangeOf(arr);
      items.push({ icon: '↻', color: '#d4a574', text: `${castLink(arr.name, `<strong style="color:#fff;">${arr.name}</strong>`)} in for ${castLink(dep.name, dep.name)}${range}` });
    } else if (arr) {
      const range = rangeOf(arr);
      items.push({ icon: '↗', color: '#22c55e', text: `${castLink(arr.name, `<strong style="color:#fff;">${arr.name}</strong>`)} joins${arr.role ? ' as ' + arr.role : ''}${range}` });
    } else if (dep) {
      const tail = dep.date ? ` <span style="color:#fbbf24;">· final ${fmt(dep.date)}</span>` : '';
      items.push({ icon: '↘', color: '#9ca3af', text: `${castLink(dep.name, `<strong style="color:#fff;">${dep.name}</strong>`)} departs${tail}` });
    }
    if (items.length) groups.push({ showTitle, items });
  });
  if (!groups.length) return null;
  const rows = groups.map((g, i) => `
    <div style="padding:12px 0;${i < groups.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.05);' : ''}">
      <div style="font-size:11px;color:#d4a574;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${g.showTitle}</div>
      ${g.items.map(it => `<div style="font-size:13px;color:#d1d5db;line-height:1.5;display:table;"><span style="display:table-cell;color:${it.color};font-weight:700;padding-right:8px;font-size:13px;width:18px;">${it.icon}</span><span style="display:table-cell;">${it.text}</span></div>`).join('')}
    </div>`).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:4px 16px;">${rows}</td></tr>
    ${seeAllLink(`${SITE}/cast-changes`, 'See all casting moves')}
  </table>`;
  return sectionWrap(sectionHeading('Casting Updates', 'Broadway'), body);
}

// SECTION: Box Office — top performers on Broadway this week (gross / capacity / ATP)
// Includes "vs market" delta for gross — isolates show-specific from seasonal industry moves
function boxOfficeSection() {
  let grosses;
  try { grosses = JSON.parse(fs.readFileSync(path.join(repo, 'data/grosses.json'), 'utf8')); }
  catch { return null; }
  // Grosses are keyed by SLUG, not show id. Build a slug→show map for open BW.
  const slugToShow = new Map();
  shows.forEach(s => { if (s.status === 'open' && s.category === 'broadway' && !isOperaShow(s) && s.slug) slugToShow.set(s.slug, s); });
  const entries = Object.entries(grosses.shows)
    .filter(([slug, g]) => slugToShow.has(slug) && g.thisWeek && g.thisWeek.gross > 0)
    .map(([slug, g]) => ({ slug, ...g.thisWeek, show: slugToShow.get(slug) }));
  if (entries.length < 3) return null;
  // Simple week-over-week — easier to grok than "vs market" framing.
  // Caveat: WoW alone is partly seasonal (school breaks, holidays lift everything).
  function wowChange(e, metric) {
    const prevKey = metric === 'gross' ? 'grossPrevWeek' : metric === 'capacity' ? 'capacityPrevWeek' : 'atpPrevWeek';
    if (!e[prevKey]) return null;
    const pct = ((e[metric] - e[prevKey]) / e[prevKey]) * 100;
    if (Math.abs(pct) < 1) return null;
    const sign = pct > 0 ? '+' : '−';
    const color = pct > 0 ? '#22c55e' : '#ef4444';
    return `<span style="font-size:10px;color:${color};font-weight:700;">${sign}${Math.abs(pct).toFixed(0)}% WoW</span>`;
  }
  const topGross = [...entries].sort((a, b) => b.gross - a.gross).slice(0, 1)[0];
  const topCap = [...entries].sort((a, b) => b.capacity - a.capacity).slice(0, 1)[0];
  const topAtp = [...entries].sort((a, b) => b.atp - a.atp).slice(0, 1)[0];
  // Market-wide WoW + YoY: sum gross across all open BW shows that have a comparable
  // previous-week / previous-year value. A show missing prev data is excluded from
  // BOTH numerator and denominator on that side so the ratio stays apples-to-apples.
  function fmtPct(pct) {
    if (pct == null || !isFinite(pct)) return null;
    // Suppress sub-1% noise — "↓ 0%" reads as broken even when accurate.
    if (Math.abs(pct) < 1) return 'flat';
    const arrow = pct >= 0 ? '↑' : '↓';
    return `${arrow} ${Math.abs(pct).toFixed(0)}%`;
  }
  function aggDelta(metricKey, prevKey) {
    let cur = 0, prev = 0, n = 0;
    for (const e of entries) {
      if (typeof e[metricKey] !== 'number' || typeof e[prevKey] !== 'number' || e[prevKey] <= 0) continue;
      cur += e[metricKey]; prev += e[prevKey]; n++;
    }
    if (n === 0 || prev === 0) return null;
    return ((cur - prev) / prev) * 100;
  }
  const wowPct = aggDelta('gross', 'grossPrevWeek');
  const yoyPct = aggDelta('gross', 'grossYoY');
  const wowStr = fmtPct(wowPct);
  const yoyStr = fmtPct(yoyPct);
  const marketDelta = [wowStr ? `${wowStr} WoW` : null, yoyStr ? `${yoyStr} YoY` : null].filter(Boolean).join(' · ');
  function row(label, entry, valueStr, sublabel, metric, isLast = false) {
    const vsm = wowChange(entry, metric);
    const borderStyle = isLast ? '' : 'border-bottom:1px solid rgba(255,255,255,0.05);';
    // Tightened: thumb 40→36, vertical padding 10→7. Each row ~10px shorter.
    return `<tr>
      <td valign="middle" width="40" style="padding:7px 8px 7px 0;${borderStyle}">${showLink(entry.show, `<img src="${getImage(entry.show) || ''}" alt="${entry.show.title}" width="36" height="36" style="display:block;width:36px;height:36px;object-fit:cover;border-radius:6px;background:#2a2a38;">`)}</td>
      <td valign="middle" style="padding:7px 0;${borderStyle}">
        <div style="font-size:10px;color:#d4a574;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">${label}</div>
        <div style="font-size:14px;color:#fff;font-weight:700;margin-top:1px;">${showLink(entry.show, entry.show.title)}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:1px;">${[sublabel, vsm].filter(Boolean).join(' · ')}</div>
      </td>
      <td valign="middle" width="80" align="right" style="padding:7px 0;${borderStyle}">
        <div style="font-size:16px;color:#fff;font-weight:700;">${valueStr}</div>
      </td>
    </tr>`;
  }
  const rowsClean = [
    row('Top Gross',        topGross, '$' + (topGross.gross / 1000000).toFixed(2) + 'M', `${topGross.performances} perf`, 'gross'),
    row('Highest Capacity', topCap,   topCap.capacity.toFixed(1) + '%', topCap.attendance.toLocaleString() + ' attendees', 'capacity'),
    row('Top Average Ticket Price', topAtp, '$' + Math.round(topAtp.atp), '', 'atp', true),
  ].join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:6px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rowsClean}</table>
    </td></tr>
    ${seeAllLink(`${SITE}/box-office`, 'See full box office')}
  </table>`;
  const subhead = [`Week of ${grosses.weekEnding}`, marketDelta].filter(Boolean).join(' · ');
  return sectionWrap(sectionHeading('Box Office', subhead, { href: 'https://broadwayscorecard.com/box-office' }), body);
}

// SECTION: Buzziest — uses canonical SocialPulseCard chrome (NOT critic score).
// Reads per-show .social.json files which contain the SocialPulsePayload schema
// (tier, rank, volume, sentiment %, platform breakdown).
function buzziestSection() {
  const TIER_RANK = { Buzzing: 0, Rising: 1, Steady: 2, BuildingBaseline: 2, Troubled: 3, Hidden: 99 };
  const TIER_DISPLAY = {
    Buzzing: { label: 'BUZZING', emoji: '🔥', color: '#f97316', sub: 'Trending hot right now' },
    Rising:  { label: 'RISING',  emoji: '📈', color: '#10b981', sub: 'Picking up momentum' },
    Steady:  { label: 'STEADY',  emoji: '⚪', color: '#3b82f6', sub: 'Consistent buzz' },
    BuildingBaseline: { label: 'STEADY', emoji: '⚪', color: '#3b82f6', sub: 'Consistent buzz' },
    Troubled:{ label: 'TROUBLED', emoji: '💔', color: '#ef4444', sub: 'Negative chatter outweighs positive' },
  };
  function rankBadgeColor(pos, total) {
    if (!total) return { bg: '#374151', text: '#9ca3af' };
    const pct = pos / total;
    if (pct <= 0.1) return { bg: '#f59e0b', text: '#1f2937' };
    if (pct <= 0.2) return { bg: '#f97316', text: '#fff' };
    if (pct <= 0.4) return { bg: '#10b981', text: '#fff' };
    if (pct <= 0.6) return { bg: '#3b82f6', text: '#fff' };
    return { bg: '#475569', text: '#cbd5e1' };
  }
  function parseRank(r) {
    if (!r) return null;
    const m = /^(\d+)\/(\d+)\s+(.+)$/.exec(r);
    if (!m) return null;
    return { position: +m[1], total: +m[2], market: m[3] };
  }
  // Load social pulse for open BW/OB shows. .social.json keyed by SHOW ID.
  // Only 'open'/'previews' shows are eligible: the social-pulse fetcher
  // (scripts/lib/list-running-shows.js) only refreshes running shows, so an
  // 'upcoming' or 'closed' show carries a frozen .social.json that would
  // surface stale data every week under the "last 7 days" heading.
  // (School Girls; Or, The African Mean Girls Play was stuck at its 2026-04-13
  // fetch for 6+ weeks because it's upcoming — opens 2026-09-08.)
  // Staleness guard below is the belt-and-suspenders backstop in case the
  // weekly cron skips a still-running show.
  const socialDir = path.join(repo, 'public/data/shows');
  // Reject pulse data fetched more than 10 days before this newsletter's week
  // end. The cron runs Mondays; fresh data is at most ~7 days old, +3 days slack
  // for a late/missed cron. Computed off argDate (not Date.now) to stay deterministic.
  const pulseStaleCutoff = new Date(weekEndDate); pulseStaleCutoff.setDate(pulseStaleCutoff.getDate() - 10);
  const candidates = [];
  shows.forEach(s => {
    if (!['open', 'previews'].includes(s.status)) return;
    if (s.category !== 'broadway' && s.category !== 'off-broadway') return;
    if (isOperaShow(s)) return;
    const f = path.join(socialDir, s.id + '.social.json');
    if (!fs.existsSync(f)) return;
    try {
      const sp = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (sp.t === 'Hidden') return;
      // Skip stale pulse data — `u` is the fetchedAt ISO timestamp.
      const fetchedAt = sp.u ? new Date(sp.u) : null;
      if (!fetchedAt || Number.isNaN(fetchedAt.getTime()) || fetchedAt < pulseStaleCutoff) return;
      candidates.push({ show: s, sp, rank: parseRank(sp.r) });
    } catch {}
  });
  if (!candidates.length) return null;
  // Sort: rank position only (lower = better). Keeps the list consecutive
  // (#1, #2, #3) rather than tier-grouped (#1, #3, #4) which surprises readers.
  // The tier label + emoji still surfaces the Buzzing/Rising distinction visually.
  candidates.sort((a, b) => {
    const ra = a.rank?.position ?? 999;
    const rb = b.rank?.position ?? 999;
    if (ra !== rb) return ra - rb;
    return (b.sp.v || 0) - (a.sp.v || 0);
  });
  const top = candidates[0];
  const display = TIER_DISPLAY[top.sp.t] || TIER_DISPLAY.Steady;
  const rankColors = top.rank ? rankBadgeColor(top.rank.position, top.rank.total) : null;
  // Real brand favicons via Google s2 — same pattern used for the Outlier outlet logo.
  // PNG, hosted, no email-client SVG compat issues.
  // Tiny inline platform glyphs — same line as mentions count, very small.
  // Used to be a standalone row of larger badges; collapsed here per design feedback
  // (hero card was too tall) — readers still get the "which platforms" signal.
  function platformGlyph(key, count) {
    if (!count) return '';
    const domain = { reddit: 'reddit.com', x: 'x.com', tiktok: 'tiktok.com', instagram: 'instagram.com' }[key];
    if (!domain) return '';
    return `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" alt="" width="12" height="12" style="display:inline-block;border-radius:2px;vertical-align:-2px;margin-right:3px;background:#fff;">`;
  }
  const xCount = top.sp.xv || top.sp.pl?.x || 0;
  const activePlatforms = [
    ['reddit', top.sp.pl?.r || 0],
    ['x', xCount],
    ['tiktok', top.sp.pl?.tt || 0],
    ['instagram', top.sp.pl?.ig || 0],
  ].filter(([, c]) => c > 0);
  const glyphs = activePlatforms.map(([k]) => platformGlyph(k, 1)).join('');
  const sentPct = top.sp.p || 0;
  // Sentiment bar + inline meta (platforms + mentions on one small line)
  const sentBar = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:10px;">
    <tr><td style="height:8px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
        <td style="width:${sentPct}%;height:8px;background:linear-gradient(90deg,#6366f1 0%,#3b82f6 50%,#10b981 100%);"></td>
        <td style="width:${100-sentPct}%;height:8px;background:transparent;"></td>
      </tr></table>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:6px;"><tr>
    <td align="left" style="font-size:11px;color:#d1d5db;font-weight:600;">${sentPct}% positive</td>
    <td align="right" style="font-size:11px;color:#6b7280;">${glyphs}${top.sp.v || 0} mentions</td>
  </tr></table>`;
  // Top 3 mini-cards: tier emoji + show + rank
  // Tier label moves ABOVE the rank box (same pattern as critic-score tier labels
  // sitting above the score badge in opening-card score columns).
  const restRows = candidates.slice(1, 3).map((c, i, arr) => {
    const d = TIER_DISPLAY[c.sp.t] || TIER_DISPLAY.Steady;
    const rc = c.rank ? rankBadgeColor(c.rank.position, c.rank.total) : null;
    const isLast = i === arr.length - 1;
    const sentP = c.sp.p || 0;
    const ment = c.sp.v || 0;
    // Tighter padding on #2/#3 rows + drop the redundant "of N" subtitle —
    // it's already on the hero. Frees ~14px per row of vertical space.
    return `<tr>
      <td valign="middle" width="56" style="padding:6px 10px 6px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">${thumb(c.show, 40)}</td>
      <td valign="middle" style="padding:6px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        <div style="font-size:14px;font-weight:700;color:#fff;line-height:1.25;">${showLink(c.show, c.show.title)}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">${sentP}% positive · ${ment} mentions</div>
      </td>
      ${rc && c.rank ? `<td valign="middle" width="60" align="center" style="padding:6px 0;${!isLast?'border-bottom:1px solid rgba(255,255,255,0.05);':''}">
        <div style="font-size:9px;font-weight:700;color:${d.color};letter-spacing:0.06em;text-transform:uppercase;margin-bottom:3px;">${d.label}</div>
        <div style="display:inline-block;width:36px;height:36px;border-radius:8px;background:${rc.bg};color:${rc.text};font-size:14px;font-weight:800;line-height:36px;text-align:center;box-shadow:0 2px 6px ${rc.bg}55;">#${c.rank.position}</div>
      </td>` : '<td></td>'}
    </tr>`;
  }).join('');
  // Hero mirrors the #2/#3 row layout: thumb left, title block middle, tier
  // label + rank box right. Sentiment bar lives below the row so the hero stays
  // visually consistent with the rest of the card stack across the email.
  const heroRow = `<tr>
      <td valign="middle" width="60" style="padding:10px 10px 10px 0;">${thumb(top.show, 48)}</td>
      <td valign="middle" style="padding:10px 0;">
        <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.25;">${showLink(top.show, top.show.title)} ${marketPill(top.show.category)}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:3px;">${top.rank ? `in <span style="color:#d1d5db;font-weight:600;">${top.rank.market}</span> social buzz` : display.sub}</div>
      </td>
      ${rankColors && top.rank ? `<td valign="middle" width="60" align="center" style="padding:10px 0;">
        <div style="font-size:9px;font-weight:700;color:${display.color};letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;">${display.label}</div>
        <div style="display:inline-block;width:40px;height:40px;border-radius:8px;background:${rankColors.bg};color:${rankColors.text};font-size:15px;font-weight:800;line-height:40px;text-align:center;box-shadow:0 2px 6px ${rankColors.bg}55;">#${top.rank.position}</div>
        <div style="font-size:9px;color:#9ca3af;margin-top:3px;font-weight:500;">of ${top.rank.total}</div>
      </td>` : `<td valign="middle" width="60" align="center" style="padding:10px 0;">
        <div style="width:40px;height:40px;border-radius:8px;background:${display.color}22;text-align:center;line-height:40px;font-size:20px;">${display.emoji}</div>
      </td>`}
    </tr>`;
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:10px 16px 4px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${heroRow}</table>
      ${sentBar}
    </td></tr>
    ${restRows ? `<tr><td style="padding:12px 16px 0;"><div style="border-top:1px solid rgba(255,255,255,0.1);"></div></td></tr>
    <tr><td style="padding:4px 16px 8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${restRows}</table></td></tr>` : ''}
    ${seeAllLink(`${SITE}/audience-buzz`, 'See the full Social Buzz')}
  </table>`;
  return sectionWrap(sectionHeading('Social Buzz', 'last 7 days', { href: `${SITE}/audience-buzz` }), body);
}

// SECTION: Season Standing — rank a newly-opened BW show against the season's same-category peers
function seasonStandingFor(openedShow) {
  // ONLY for NEW (non-revival) shows — revivals are judged differently
  if (openedShow.isRevival) return null;
  // Same season = openingDate within ~12 months before weekEnd (Tony eligibility window approximation)
  const seasonStart = new Date(weekEndStr + 'T12:00:00'); seasonStart.setMonth(seasonStart.getMonth() - 12);
  const seasonStartStr = seasonStart.toISOString().slice(0, 10);
  const peers = shows.filter(s =>
    s.category === 'broadway'
    && s.type === openedShow.type
    && !!s.isRevival === !!openedShow.isRevival
    && s.openingDate
    && s.openingDate >= seasonStartStr
    && s.openingDate <= weekEndStr
  );
  if (peers.length < 3) return null;
  const scored = peers.map(s => ({ s, agg: aggregateScore(s.id) })).filter(x => x.agg && x.agg.count >= minReviews(x.s.category));
  if (scored.length < 3) return null;
  scored.sort((a, b) => b.agg.avg - a.agg.avg);
  // Category label
  const typeWord = openedShow.type === 'musical' ? 'Musical' : 'Play';
  const seasonLabel = openedShow.isRevival ? `${typeWord} Revivals This Season` : `New ${typeWord}s This Season`;
  const rows = scored.slice(0, 8).map((x, i, arr) => {
    const isHighlight = x.s.id === openedShow.id;
    const isLast = i === arr.length - 1;
    const rank = i + 1;
    // Highlight row gets brand-gold left rule, slight bg tint, and JUST OPENED chip
    const rowBg = isHighlight ? 'background:rgba(212,165,116,0.06);' : '';
    const leftBorder = isHighlight ? 'border-left:3px solid #d4a574;padding-left:9px;' : 'padding-left:12px;';
    return `<tr>
      <td valign="middle" width="32" style="padding:10px 6px 10px 0;text-align:center;${rowBg}${leftBorder}">
        <div style="font-size:14px;font-weight:700;color:${isHighlight ? '#d4a574' : '#6b7280'};">${rank}</div>
      </td>
      <td valign="middle" width="48" style="padding:10px 10px 10px 0;${rowBg}">
        <img src="${getImage(x.s) || ''}" alt="${x.s.title}" width="44" height="44" style="display:block;width:44px;height:44px;object-fit:cover;border-radius:8px;background:#2a2a38;${isHighlight ? 'box-shadow:0 0 0 2px #d4a574;' : ''}">
      </td>
      <td valign="middle" style="padding:10px 0;${!isLast ? 'border-bottom:1px solid rgba(255,255,255,0.05);' : ''}${rowBg}">
        <div style="font-size:14px;font-weight:${isHighlight ? '700' : '600'};color:${isHighlight ? '#fff' : '#f3f4f6'};line-height:1.3;">${showLink(x.s, x.s.title)}</div>
        ${isHighlight ? '<div style="display:inline-block;margin-top:4px;padding:2px 7px;border-radius:999px;background:#d4a574;color:#0f0f14;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Just opened</div>' : ''}
        <div style="font-size:11px;color:#9ca3af;margin-top:${isHighlight ? '4' : '2'}px;">Opened ${fmt(x.s.openingDate)} · ${x.agg.count} reviews</div>
      </td>
      <td valign="middle" width="48" align="right" style="padding:10px 12px 10px 0;${!isLast ? 'border-bottom:1px solid rgba(255,255,255,0.05);' : ''}${rowBg}">
        ${smallBadge(x.agg.avg, 40)}
      </td>
    </tr>`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:4px 4px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
    </td></tr>
  </table>`;
  return sectionWrap(sectionHeading(`${seasonLabel} — How ${openedShow.title} stacks up`), body);
}

// Tracks whether London Openings contains a Critical Gold show this week.
// Set as side-effect of londonSection() so the assembly block can promote the
// section to an early slot (right after NYC openings) — same pattern as
// `_upcomingHasBroadway` for Coming Up.
let _londonHasGoldOpening = false;

// SECTION: From London — show market label per show.
// When a West End show opens to Critical Gold (≥85), it earns the full
// `showRow` treatment (poster + score badge + venue) and the section floats
// up next to the NYC opening cards. Non-gold shows keep the compact layout.
function londonSection() {
  const list = shows.filter(s => (s.category === 'west-end' || s.category === 'off-west-end') && inWeek(s.openingDate));
  if (!list.length) return null;
  const withScore = list.map(s => ({ s, agg: aggregateScore(s.id) })).filter(x => x.agg && x.agg.count >= minReviews(x.s.category));
  if (!withScore.length) return null;
  // Sort: Gold first, then by score desc
  withScore.sort((a, b) => {
    const ag = isGoldTier(a.agg.avg, a.s.category) ? 1 : 0;
    const bg = isGoldTier(b.agg.avg, b.s.category) ? 1 : 0;
    if (ag !== bg) return bg - ag;
    return (b.agg.raw ?? b.agg.avg) - (a.agg.raw ?? a.agg.avg);
  });
  _londonHasGoldOpening = withScore.some(x => isGoldTier(x.agg.avg, x.s.category));
  const marketColor = '#f472b6';
  const goldRows = withScore.filter(x => isGoldTier(x.agg.avg, x.s.category));
  const nonGoldRows = withScore.filter(x => !isGoldTier(x.agg.avg, x.s.category));
  // Gold-tier shows: full showRow (poster, venue, audience chip, score badge)
  const goldHtml = goldRows.map(x => showRow(x.s, {})).join('');
  // Non-gold shows: compact card (existing layout)
  const compactRows = nonGoldRows.map((x, i, arr) => {
    const score = x.agg.avg;
    const market = x.s.category === 'west-end' ? 'WEST END' : 'OFF WEST END';
    const isLast = i === arr.length - 1;
    return `<tr>
      <td valign="middle" width="60" style="padding:${i===0?'14':'10'}px 0 ${isLast?'14':'10'}px 16px;">${thumb(x.s, 48)}</td>
      <td valign="middle" style="padding:${i===0?'14':'10'}px 8px ${isLast?'14':'10'}px 12px;">
        <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.25;">${showLink(x.s, x.s.title)}</div>
        <div style="font-size:10px;color:${marketColor};font-weight:600;letter-spacing:0.06em;text-transform:uppercase;margin-top:3px;">${market}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px;">Opened ${fmt(x.s.openingDate)}</div>
      </td>
      <td valign="middle" width="84" align="center" style="padding:${i===0?'14':'10'}px 12px ${isLast?'14':'10'}px 4px;">
        ${tierLabel(score, x.s.category)}
        ${smallBadge(score, 40, x.s.category)}
      </td>
    </tr>${!isLast ? '<tr><td colspan="3" style="padding:0 16px;"><div style="border-top:1px solid rgba(255,255,255,0.05);"></div></td></tr>' : ''}`;
  }).join('');
  const seeAll = seeAllLink(`${SITE}/west-end`, 'Explore the full West End Scorecard', { color: '#f472b6' });
  const compactCard = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" style="background:#1a1a24;border-radius:16px;border:1px solid rgba(244,114,182,0.18);">${compactRows}${seeAll}</table>`;
  const seeAllOnlyCard = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" style="background:#1a1a24;border-radius:16px;border:1px solid rgba(244,114,182,0.18);">${seeAll}</table>`;
  const body = goldHtml + (nonGoldRows.length ? compactCard : seeAllOnlyCard);
  return sectionWrap(sectionHeading('London Openings', null, { href: `${SITE}/west-end` }), body);
}

// SECTION: Opera Openings — mirrors London Openings (compact card, themed
// accent color, see-all link to /opera). Opera shows are excluded from every
// other section because their tier model (T1-flat) and audience expectations
// differ from theatre. Indigo/violet accent picks a color distinct from
// gold (NYC) and pink (London) so the three feeds read as siblings.
function operaOpeningsSection() {
  const list = shows.filter(s => isOperaShow(s) && inWeek(s.openingDate));
  if (!list.length) return null;
  const withScore = list.map(s => ({ s, agg: aggregateScore(s.id) })).filter(x => x.agg && x.agg.count >= 3);
  if (!withScore.length) return null;
  const marketColor = '#a78bfa'; // indigo/violet — opera's accent
  const rows = withScore.map((x, i, arr) => {
    const score = x.agg.avg;
    const venueLabel = (x.s.category === 'broadway' ? 'BROADWAY OPERA'
      : x.s.category === 'off-broadway' ? 'OFF-BROADWAY OPERA'
      : x.s.category === 'west-end' ? 'WEST END OPERA'
      : x.s.category === 'off-west-end' ? 'OFF WEST END OPERA'
      : 'OPERA');
    const isLast = i === arr.length - 1;
    return `<tr>
      <td valign="middle" width="60" style="padding:${i===0?'14':'10'}px 0 ${isLast?'14':'10'}px 16px;">${thumb(x.s, 48)}</td>
      <td valign="middle" style="padding:${i===0?'14':'10'}px 8px ${isLast?'14':'10'}px 12px;">
        <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.25;">${showLink(x.s, x.s.title)}</div>
        <div style="font-size:10px;color:${marketColor};font-weight:600;letter-spacing:0.06em;text-transform:uppercase;margin-top:3px;">${venueLabel}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px;">Opened ${fmt(x.s.openingDate)}</div>
      </td>
      <td valign="middle" width="84" align="center" style="padding:${i===0?'14':'10'}px 12px ${isLast?'14':'10'}px 4px;">
        ${tierLabel(score, x.s.category)}
        ${smallBadge(score, 40, x.s.category)}
      </td>
    </tr>${!isLast ? '<tr><td colspan="3" style="padding:0 16px;"><div style="border-top:1px solid rgba(255,255,255,0.05);"></div></td></tr>' : ''}`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" style="background:#1a1a24;border-radius:16px;border:1px solid rgba(167,139,250,0.18);">${rows}
    ${seeAllLink(`${SITE}/opera`, 'Explore the full Opera Scorecard', { color: marketColor })}
  </table>`;
  return sectionWrap(sectionHeading('Opera Openings', null, { href: `${SITE}/opera` }), body);
}

// SECTION: Trending This Week — show pages with the biggest WoW page-view
// growth. Earlier "Most-Read" version was sorted by raw views and Hamilton +
// Wicked won every week (evergreen blockbusters). Climbers surface MOVEMENT,
// which is what a weekly digest is for. Source: popular-pages.mjs runs a
// multi-range GA4 query and returns {slug, views, prior, growth} sorted by
// growth desc. Section silently skips when GA4 creds are missing or no show
// crosses the noise floor.
function mostReadSection(climberList) {
  if (!Array.isArray(climberList) || climberList.length === 0) return null;
  const items = [];
  for (const p of climberList) {
    const show = shows.find(s => s.slug === p.slug);
    if (!show) continue;
    if (show.category !== 'broadway' && show.category !== 'off-broadway') continue;
    if (isOperaShow(show)) continue;
    const a = aggregateScore(show.id);
    const eligible = a && a.count >= minReviews(show.category);
    if (!eligible) continue; // Trending list: scored shows only (user 2026-05-24)
    items.push({
      show,
      title: show.title,
      slug: show.slug,
      category: show.category,
      score: a.avg,
      views: p.views,
      prior: p.prior,
      growth: p.growth,
    });
    if (items.length >= 3) break;
  }
  if (!items.length) return null;
  // Format growth as "↑ 3.2× from last week" — multiplicative reads better
  // than raw delta when the base is small. Round to 1 decimal.
  const fmtGrowth = (g) => `↑ ${g.toFixed(1)}× from last week`;
  const rows = items.map((it, i, arr) => {
    const border = i < arr.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.05);' : '';
    return `<tr>
    <td valign="middle" width="52" style="padding:7px 10px 7px 0;${border}">${thumb(it.show, 36)}</td>
    <td valign="middle" style="padding:7px 0;${border}">
      <a href="${SITE}/show/${it.slug}" style="text-decoration:none;display:block;">
        <div style="font-size:14px;font-weight:700;color:#fff;line-height:1.3;">${it.title} ${marketPill(it.category)}</div>
        <div style="font-size:11px;color:#22c55e;margin-top:2px;font-weight:600;">${fmtGrowth(it.growth)}</div>
      </a>
    </td>
    <td valign="middle" width="56" align="right" style="padding:7px 8px 7px 4px;${border}">
      ${it.score != null ? smallBadge(it.score, 36, it.category) : `<div style="box-sizing:border-box;display:inline-block;width:36px;height:36px;border-radius:8px;background:#2a2a38;color:#6b7280;font-size:12px;font-weight:700;line-height:36px;text-align:center;border:1px solid rgba(255,255,255,0.1);">—</div>`}
    </td>
  </tr>`;
  }).join('');
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg">
    <tr><td style="padding:4px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
    </td></tr>
  </table>`;
  return sectionWrap(sectionHeading('Trending This Week', 'biggest traffic gainers'), body);
}

// ──────────────────────────────────────────
// Section runner: every render goes through `sections.run(name, fn)` so we
// get a build report of which sections fired / which got skipped + why.
// Two sections (Broadway / Off-Broadway openings) return `{html, list}` so
// their `list` can be consumed by downstream sections (season standing).
// Those are called directly and recorded by passing the html through the runner.
const { createSectionRunner } = cjsRequire(path.join(scriptDir, '..', 'lib', 'newsletter-sections.js'));
const sections = createSectionRunner();

// ORDERING CONTRACT (do not reorder without care): sections that share the
// `featuredShowIds` cross-section de-dup MUST be CALLED in render order —
// openings → biggest-movers → closing-this-week → announced-closings →
// casting-updates. Each marks the shows it renders; later sections skip them.
// Reordering silently moves shows between sections (no crash). The subject/lede
// block (below) ALSO depends on bwO/obO being computed first — it reads
// bwO.list/obO.list, so it must stay after these calls.
const bwO = broadwayOpenings();
const obO = offBroadwayOpenings();
sections.run('broadway-openings', () => bwO.html);
sections.run('offbroadway-openings', () => obO.html);

const upcoming = sections.run('upcoming-openings', () => upcomingOpeningsSection());
const mover = sections.run('biggest-movers', () => biggestMoverSection());
const clo   = sections.run('closing-this-week', () => closingSection());
const announced = sections.run('announced-closings', () => announcedClosingsSection());
const box      = sections.run('box-office', () => boxOfficeSection());
const commercial = sections.run('recoupment', () => commercialSection());
const bz   = sections.run('social-buzz', () => buzziestSection());
const tony = sections.run('tony-predictions', () => tonyWatchSection());
// SECTION: Beat the Critics promo — mirrors src/components/FeaturedSpotSlim.tsx
// (btc accent = rose-500). Copy is identical to the on-site homepage shelf:
// eyebrow + title + description + CTA + $200 stat pill. Email-safe table render.
function btcPromoSection() {
  // Campaign date gate — mirror the on-site isBtcPromoActive() window so the
  // email promo auto-expires exactly like the homepage shelf. The contest is a
  // $200 TodayTix prize tied to the Tony ceremony; shipping it after the
  // ceremony would email subscribers an expired offer. Window = 35 days before
  // the ceremony through ceremony day (src/config/tony-ceremony.ts getBtcWindow).
  const TONY_CEREMONY = '2026-06-08';
  const campEnd = new Date(TONY_CEREMONY + 'T23:59:59');
  const campStart = new Date(campEnd.getTime() - 35 * 24 * 60 * 60 * 1000);
  const campStartStr = campStart.toISOString().slice(0, 10);
  // Active if this issue's week overlaps the campaign window.
  if (weekEndStr < campStartStr || weekStartStr > TONY_CEREMONY) return null;
  const href = `${SITE}/beat-the-critics`;
  const ROSE = '#f43f5e';
  const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" class="cardbg" style="border:1px solid rgba(255,255,255,0.06);border-top:2px solid ${ROSE};border-radius:12px;">
    <tr><td style="padding:20px;">
      <div style="margin-bottom:8px;"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${ROSE};vertical-align:middle;margin-right:7px;"></span><span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${ROSE};vertical-align:middle;">Beat the Critics</span></div>
      <div style="font-size:18px;font-weight:800;color:#ffffff;line-height:1.25;margin-bottom:8px;">Think you know Broadway better than the critics?</div>
      <div style="font-size:14px;color:#c8c8d0;line-height:1.5;margin-bottom:16px;">Pick the Tony winners against our model and the top critics. One entry wins a $200 TodayTix gift card.</div>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
        <td valign="middle" style="padding-right:14px;"><a href="${href}" style="display:inline-block;background:${ROSE};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:999px;">Make your picks &rarr;</a></td>
        <td valign="middle"><span style="display:inline-block;background:rgba(244,63,94,0.10);border:1px solid rgba(244,63,94,0.40);color:#fda4af;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;">$200 TodayTix gift card</span></td>
      </tr></table>
    </td></tr>
  </table>`;
  // No sectionHeading — the eyebrow inside the card is the label, matching the
  // standalone on-site shelf. sectionWrap with empty heading keeps spacing.
  return sectionWrap('', body);
}

const cas  = sections.run('casting-updates', () => castingSection());
const btcPromo = sections.run('btc-promo', () => btcPromoSection());

// Persist this issue's memory (mover + announced closings + everything featured)
// so next week's run suppresses repeats. Best-effort — never fail the build.
try {
  const _issues = (_priorState.issues || []).filter(i => i && i.weekStart !== weekStartStr);
  _issues.push({
    weekStart: weekStartStr,
    moverShowIds: _moverShowIds,
    announcedClosingShowIds: _announcedShowIds,
    featuredShowIds: Array.from(featuredShowIds),
  });
  _issues.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  fs.writeFileSync(STATE_PATH, JSON.stringify({ issues: _issues.slice(-12) }, null, 2) + '\n');
} catch (e) { process.stderr.write('[newsletter] state write failed: ' + e.message + '\n'); }
const lon  = sections.run('london-openings', () => londonSection());
const opera = sections.run('opera-openings', () => operaOpeningsSection());
const outlier = sections.run('outlier-of-the-week', () => outlierSection());

// Most-read show pages — real GA4 page-view data via popular-pages.mjs.
// Async because GA4 client returns a Promise. If creds missing or API errors,
// fetchPopularShowPages returns null and the section silently skips.
const { fetchPopularShowPages } = await import('./popular-pages.mjs');
const popularList = await fetchPopularShowPages({ repo, days: 7, limit: 8 });
const popular = sections.run('most-read-pages', () => mostReadSection(popularList));

// Season standing renders one card per qualifying BW opening (not strictly
// "a section"). Recorded as a single entry with the count baked in.
const seasonStandings = bwO.list.map(s => seasonStandingFor(s)).filter(Boolean);
if (seasonStandings.length) {
  sections.run('season-standing', () => seasonStandings.join(''));
}

// Order (2026-05-24): openings → biggest movers → outlier (review news first)
// → closings → box office → recoupment → social buzz → tony predictions →
// casting → London → season standing → most-read pages.
// Outlier of the Week sits AFTER Tony Predictions per user direction
// (2026-05-24): it's a satisfying coda to the awards-prediction storyline
// rather than a top-of-email surprise.
// Opera Openings sits directly after London Openings — both are the
// "secondary market" feeds that read as siblings to NYC theatre.
// "Coming Up" follows the just-opened sections so the reader sees the past
// week's drama, then naturally looks ahead to what's next, before pivoting
// to score movers / box office / etc.
// "Coming Up" placement is conditional (user direction 2026-05-24):
//   • Has a Broadway show → top slot (right after the just-opened cards).
//   • OB-only slate → drop to bottom, just above Most-Read Pages — still
//     in the email for fans planning ahead, but not leading.
// London Openings placement: when a Critical Gold West End show opens, it
// earns a slot right next to the NYC opening cards (before movers). A Gold
// West End opening is as significant as a Gold NYC opening. Non-gold weeks:
// London stays at the bottom alongside opera/casting.
const upcomingTop = upcoming && _upcomingHasBroadway ? upcoming : null;
const upcomingBottom = upcoming && !_upcomingHasBroadway ? upcoming : null;
const londonTop = lon && _londonHasGoldOpening ? lon : null;
const londonBottom = lon && !_londonHasGoldOpening ? lon : null;

// Tony Predictions is OPT-IN, not part of the default sectionOrder (user
// direction 2026-05-24). Reasoning: the section is only relevant for ~6-8
// weeks/year (nominations → ceremony), methodology + weights need manual
// re-tuning each season, and a dedicated Tony email reads better than a
// section buried in the weekly. Set NEWSLETTER_INCLUDE_SECTIONS=tony-predictions
// to add it back for a specific render (e.g. the ceremony-eve weekly).
// The tonyWatchSection() function still runs above so it's available for
// dedicated Tony emails — only the inclusion in the weekly's sectionOrder
// is opt-in. Drop list (NEWSLETTER_DROP_SECTIONS) is a one-off lever for
// suppressing any other section ad hoc.
const _dropEnv = (process.env.NEWSLETTER_DROP_SECTIONS || '').trim();
const _dropSet = new Set(_dropEnv ? _dropEnv.split(',').map(s => s.trim()).filter(Boolean) : []);
const _includeEnv = (process.env.NEWSLETTER_INCLUDE_SECTIONS || '').trim();
const _includeSet = new Set(_includeEnv ? _includeEnv.split(',').map(s => s.trim()).filter(Boolean) : []);
const OPT_IN_SECTIONS = new Set(['tony-predictions']);
function _slot(name, html) {
  if (_dropSet.has(name)) return null;
  if (OPT_IN_SECTIONS.has(name) && !_includeSet.has(name)) return null;
  return html;
}
if (_dropSet.size) process.stderr.write(`[newsletter] dropping sections: ${[..._dropSet].join(', ')}\n`);
if (_includeSet.size) process.stderr.write(`[newsletter] opt-in sections: ${[..._includeSet].join(', ')}\n`);
const sectionOrder = [
  _slot('broadway-openings', bwO.html),
  _slot('offbroadway-openings', obO.html),
  _slot('london-openings', londonTop),   // Gold WE openings float up to join NYC openers
  _slot('upcoming-openings', upcomingTop),
  _slot('biggest-movers', mover),
  _slot('closing-this-week', clo),
  _slot('announced-closings', announced),
  _slot('btc-promo', btcPromo),
  _slot('box-office', box),
  _slot('recoupment', commercial),
  _slot('social-buzz', bz),
  _slot('tony-predictions', tony),
  _slot('outlier-of-the-week', outlier),
  _slot('london-openings', londonBottom), // Non-gold WE openings stay at bottom
  _slot('opera-openings', opera),
  _slot('casting-updates', cas),
  ...(_dropSet.has('season-standing') ? [] : seasonStandings),
  _slot('upcoming-openings', upcomingBottom),
  _slot('most-read-pages', popular),
].filter(Boolean);

const headerCounts = [
  bwO.list.length ? `${bwO.list.length} BW opening${bwO.list.length!==1?'s':''}` : null,
  obO.list.length ? `${obO.list.length} OB` : null,
].filter(Boolean).join(' · ') || 'A quiet week';

// Subject + lede are driven by a cross-section newsworthiness scorer
// (see ./newsworthiness.mjs). Each candidate feed is queried below and passed
// through `scoreCandidates`, which orders them by importance. The top 3 drive
// both the subject line and the editorial lede paragraph.
const { scoreCandidates, buildSubjectFromCandidates, buildLedeFromCandidates } =
  await import('./newsworthiness.mjs');

// Gather candidate-source data from the same feeds the sections render from.
// Re-queries are cheap (everything is in-memory JSON already loaded).
// Compute the opening EVENTS (with isReopening flag) for the scorer so its
// verbiage matches the section's "Reopened" verb. broadwayOpenings()/
// offBroadwayOpenings() return shows-only; we re-derive the flag here.
// Never advertise a show in the subject/lede that has no reviews yet.
const _subjHasScore = (s) => { const a = aggregateScore(s.id); return a && a.count >= minReviews(s.category); };
// Subject/lede must describe the SAME shows the body actually renders. Use the
// section's returned lists (bwO.list / obO.list) — these already apply the
// review gate AND the OB 14-day grace window. Recomputing with the strict
// in-week window here was the bug that made the subject ignore Heated Rivalry
// (opened May 12, shown in the body) and fall back to an obscure closing.
const bwEvents = bwO.list.map(s => ({ show: s }));
const obEvents = obO.list.map(s => ({ show: s }));
// West End openings: only the Gold-tier ones enter the scorer (same threshold
// londonSection uses for the featured showRow format). Non-gold WE shows
// aren't subject-line news for a US-focused newsletter audience.
const weGoldEvents = shows
  .filter(s => (s.category === 'west-end' || s.category === 'off-west-end') && inWeek(s.openingDate))
  .filter(s => { const a = aggregateScore(s.id); return a && a.count >= minReviews(s.category) && isGoldTier(a.avg, s.category); })
  .map(s => ({ show: s }));

const newsworthyInputs = {
  bwOpenings: bwEvents,
  obOpenings: obEvents,
  weGoldOpenings: weGoldEvents,
  aggregateScore,
  recoupments: (() => {
    // Mirror commercialSection: firstAdded must be in this week's window.
    // (Was: this/last month on recoupedDate — caused 8+ repeats per show.)
    try {
      const comm = JSON.parse(fs.readFileSync(path.join(repo, 'data/commercial.json'), 'utf8'));
      const out = [];
      for (const [slug, c] of Object.entries(comm.shows || {})) {
        if (!c.recouped || !c.recoupedDate) continue;
        if (!/^\d{4}-\d{2}$/.test(c.recoupedDate)) continue;
        if (c.firstAdded) {
          const firstAddedDay = String(c.firstAdded).slice(0, 10);
          if (firstAddedDay < weekStartStr || firstAddedDay > weekEndStr) continue;
        } else {
          if (c.recoupedDate !== weekEndStr.slice(0, 7)) continue;
        }
        const show = shows.find(s => s.slug === slug && s.category === 'broadway');
        if (!show || isOperaShow(show)) continue;
        // Same weeks-to-recoup math the section uses.
        const m = /^(\d{4})-(\d{2})$/.exec(c.recoupedDate);
        let weeksToRecoup = null;
        if (m && show.openingDate) {
          const recoupMid = new Date(`${m[1]}-${m[2]}-15T12:00:00`);
          const open = new Date(show.openingDate + 'T12:00:00');
          const w = Math.round((recoupMid - open) / (7 * 86400000));
          if (isFinite(w) && w > 0) weeksToRecoup = w;
        }
        out.push({ show, weeksToRecoup });
      }
      return out;
    } catch { return []; }
  })(),
  closingsThisWeek: shows.filter(s =>
    s.closingDate && s.closingDate >= weekStartStr && s.closingDate <= weekEndStr
    && s.status === 'open' && (s.category === 'broadway' || s.category === 'off-broadway') && !isOperaShow(s)
    && _subjHasScore(s)), // never lead the subject with a show we have no reviews for
  announcedClosings: (() => {
    // Mirror announcedClosingsSection exactly: closure events added IN THE
    // WEEK WINDOW only. The prior 28-day lookback resurfaced 3-week-old
    // closures (Ragtime case, user-flagged 2026-05-24).
    const out = [];
    for (const [showId, data] of Object.entries(castData.shows)) {
      const closures = (data.upcoming || []).filter(e =>
        e.type === 'closure'
        && e.addedDate && e.addedDate >= weekStartStr && e.addedDate <= weekEndStr);
      if (closures.length === 0) continue;
      const show = shows.find(s => s.id === showId);
      if (!show || show.category !== 'broadway' || isOperaShow(show) || show.status !== 'open' || !show.closingDate) continue;
      if (show.closingDate <= weekEndStr) continue;
      out.push({ show });
    }
    return out;
  })(),
  // Outlier helper is shared with the section renderer above.
  topOutlier: findWeekOutlier(),
  // Biggest critic-mover: derive from same data biggestMoverSection uses.
  // Single show, single direction — small enough to recompute here.
  // Same source of truth biggestMoverSection uses — the scorer can never
  // surface a mover that the section doesn't actually render. Returns null
  // when no candidate passes the section's newsworthy gates.
  topMover: findRenderableCriticMovers()[0] || null,
  tonyDaysOut: (() => {
    const ceremony = new Date('2026-06-08T00:00:00');
    return Math.max(0, Math.ceil((ceremony - new Date(weekEndStr + 'T12:00:00')) / 86400000));
  })(),
};

const newsworthyCandidates = scoreCandidates(newsworthyInputs);
const subjectLine = buildSubjectFromCandidates(newsworthyCandidates);
const ledeText = process.env.LEDE_OVERRIDE || buildLedeFromCandidates(newsworthyCandidates) || '';

const yearForFooter = weekEndDate.getFullYear();

const html = `<!DOCTYPE html>
<!-- SUBJECT: ${subjectLine} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark only">
<meta name="supported-color-schemes" content="dark only">
<title>Broadway Scorecard · Weekly Round-up · ${fmt(weekStartStr)} – ${fmt(weekEndStr)}, ${yearForFooter}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  /* Color-scheme hints — Apple Mail and Outlook web respect these. */
  :root, body { color-scheme: dark only !important; supported-color-schemes: dark only !important; }
  body, html { background:#0f0f14 !important; }

  /* ---- Gmail iOS / Android dark-mode hardening ----
     Gmail re-paints dark emails on iOS by injecting CSS classes onto every
     element it recolors. Class names start with [data-ogsc] (Original Gmail
     Static Color) and [data-ogsb] (background). Selecting on those attributes
     lets us re-pin our intended colors AFTER Gmail's injection runs. We also
     pin via [bgcolor="…"] attribute selectors so any table cell carrying our
     dark surfaces is kept dark even when Gmail rewrites the inline style. */
  [data-ogsc] body, [data-ogsc] table, [data-ogsc] td,
  [data-ogsb] body, [data-ogsb] table, [data-ogsb] td {
    background-color: inherit !important;
    color: inherit !important;
  }
  [data-ogsc] [bgcolor="#0f0f14"], [data-ogsb] [bgcolor="#0f0f14"] { background-color: #0f0f14 !important; }
  [data-ogsc] [bgcolor="#1a1a24"], [data-ogsb] [bgcolor="#1a1a24"] { background-color: #1a1a24 !important; }
  /* Plain (non-Gmail-injected) attribute selectors as a baseline. */
  [bgcolor="#0f0f14"] { background-color: #0f0f14 !important; }
  [bgcolor="#1a1a24"] { background-color: #1a1a24 !important; }

  /* Gmail Android proprietary: u + #body wraps content; force bg via class
     selectors Gmail won't strip. */
  u + #body, u + #body .gmail-dark-bg { background:#0f0f14 !important; }

  /* Apple Mail / iOS Mail responds to prefers-color-scheme; Gmail iOS now
     does too on newer versions. Pin our surfaces in BOTH directions so the
     email looks the same whether the client thinks the user is in light or
     dark mode. */
  @media (prefers-color-scheme: light) {
    body, html, table, td { background-color:#0f0f14 !important; color:#f3f4f6 !important; }
  }
  @media (prefers-color-scheme: dark) {
    body, html { background-color:#0f0f14 !important; }
  }

  /* High-frequency repeated patterns. Pulled out of inline styles to keep
     total HTML under Gmail's ~102KB clip threshold (full-message MIME, not
     raw HTML). Background + color stay inline so they survive Outlook 2007+
     stripping <style> blocks; structural CSS lives here. See feedback note
     on Gmail clipping in newsletter-drafts. */
  /* Unified pill box model — market (.mp) and format/production (.gp) pills
     render at identical height so REVIVAL never sits taller than OFF-BWAY. */
  .mp,.gp{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.05em;line-height:1.5;vertical-align:middle;margin-right:4px}
  .tdec{text-decoration:none;display:inline-block}
  .cardbg{background:#1a1a24;border-radius:16px;border:1px solid rgba(255,255,255,.05)}
  .showttl{margin:0;font-size:16px;font-weight:600;color:#fff;letter-spacing:-.01em}
</style>
</head>
<!-- The empty <u></u> immediately before <body> is the "u-tag wrapper trick":
     Gmail iOS uses CSS rules like "u + .body" to inject its dark-mode color
     overrides. The <u> outside <body> moves our content out of that selector
     scope, so Gmail's injector skips our wrapper. See Litmus dark-mode guide. -->
<u></u>
<body id="body" class="gmail-dark-bg" style="margin:0;padding:0;background:#0f0f14;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f3f4f6;-webkit-font-smoothing:antialiased;">
<!-- Preheader: shown by inbox previews after the subject line. Hidden in the
     rendered email body. The empty span padding shoves any trailing "Broadway
     Scorecard"/header text out of the preview slot in Gmail/iOS. -->
<div style="display:none !important;max-height:0;overflow:hidden;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;opacity:0;">${ledeText || 'This week on Broadway and beyond.'}<span style="display:none !important;color:transparent;">${'&zwnj; &nbsp; '.repeat(40)}</span></div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#0f0f14" class="gmail-dark-bg"><tr><td align="center" bgcolor="#0f0f14" style="padding:24px 16px;background-color:#0f0f14;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
<tr><td align="left" style="padding:0 4px 8px;">
  <a href="https://broadwayscorecard.com" style="text-decoration:none;color:inherit;display:inline-block;"><span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.02em;">Broadway</span><span style="font-size:22px;font-weight:700;background:linear-gradient(135deg,#d4a574 0%,#b8956a 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:#d4a574;letter-spacing:-0.02em;">Scorecard</span><span style="font-size:9px;color:#6b7280;font-weight:400;vertical-align:super;margin-left:1px;">™</span></a>
</td></tr>
<tr><td style="padding:0 4px 8px;">
  <div style="font-size:13px;color:#9ca3af;">Weekly Round-up · ${fmt(weekStartStr)} – ${fmt(weekEndStr)}, ${yearForFooter}</div>
</td></tr>
${ledeText ? `<tr><td style="padding:6px 4px 20px;">
  <div style="font-size:14px;line-height:1.55;color:#d1d5db;border-left:2px solid #d4a574;padding-left:12px;">${ledeText}</div>
</td></tr>` : '<tr><td style="padding:0 4px 12px;"></td></tr>'}
${sectionOrder.join('')}
<tr><td align="center" style="padding:40px 4px 8px;">
  <div style="border-top:1px solid rgba(255,255,255,0.05);padding-top:24px;">
    <div style="font-size:18px;font-weight:700;">
      <a href="https://broadwayscorecard.com" style="text-decoration:none;color:inherit;"><span style="color:#fff;">Broadway</span><span style="background:linear-gradient(135deg,#d4a574 0%,#b8956a 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:#d4a574;">Scorecard</span><span style="font-size:8px;color:#6b7280;font-weight:400;vertical-align:super;">™</span></a>
    </div>
    <div style="font-size:13px;color:#9ca3af;margin-top:10px;">Every show. Every review. One score.</div>
    <div style="font-size:11px;color:#6b7280;margin-top:18px;">
      <a href="https://broadwayscorecard.com/about" style="color:#9ca3af;text-decoration:none;">About</a> &nbsp;·&nbsp;
      <a href="https://broadwayscorecard.com/methodology" style="color:#9ca3af;text-decoration:none;">Methodology</a> &nbsp;·&nbsp;
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#9ca3af;text-decoration:none;">Unsubscribe</a>
    </div>
    <div style="font-size:10px;color:#4b5563;margin-top:18px;">© ${yearForFooter} Broadway Scorecard™ LLC</div>
  </div>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;

// Output dir: env override > user's iCloud-synced claude-outputs > repo-local.
// CI sets NEWSLETTER_OUT_DIR=$GITHUB_WORKSPACE/data/newsletter-drafts so the
// runner has a writable directory. Local runs keep their existing iCloud
// path so the user's saved drafts don't move.
const outDir = process.env.NEWSLETTER_OUT_DIR
  || (fs.existsSync(path.join(process.env.HOME || '', 'Documents/claude-outputs'))
    ? path.join(process.env.HOME, 'Documents/claude-outputs/newsletter-mocks')
    : path.join(repo, 'data/newsletter-drafts'));
fs.mkdirSync(outDir, { recursive: true });
const slug = `A-${argDate}`;
// Tag every first-party link with UTMs for GA4/PostHog attribution before
// writing the draft (idempotent — see scripts/lib/email-utm.js). Resend
// click-tracking preserves the query string, so these survive the redirect.
const { applyUtm } = cjsRequire('../lib/email-utm.js');
fs.writeFileSync(`${outDir}/${slug}.html`, applyUtm(html, { source: 'newsletter', campaign: `weekly-${weekEndStr}` }));
// Sidecar JSON with subject + section-by-section run report so the send
// script can pick up the subject without parsing HTML, and so we can detect
// silently-skipped sections in regression tests / CI.
sections.writeMeta(`${outDir}/${slug}.meta.json`, {
  subject: subjectLine,
  weekStart: argDate,
  weekEnd: weekEndStr,
  htmlPath: `${outDir}/${slug}.html`,
  headerCounts,
});
sections.printSummary();
console.log(`Wrote ${outDir}/${slug}.html (${sectionOrder.length} sections, headerCounts="${headerCounts}")`);
