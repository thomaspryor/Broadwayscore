'use strict';
// BRO-6074: decide whether press-night-probe.yml should start the opening-night lane shadow
// (opening-night-lane-live.yml mode=shadow: no lease, no publish) for a show-night.
//
// Pure decision + a tiny CLI so the workflow step and the test share one implementation.
//   node scripts/lib/lane-shadow-dispatch.js --show=ID --night=YYYY-MM-DD --market=broadway \
//        --embargo-at=ISO [--active="title1\ntitle2"] [--shows-file=data/shows.json]   -> prints {dispatch, reason, windowMin}
//
// BRO-7231: no shadow when the real night lane runs the show (LANE_ONLY_MARKETS covers it: the shadow is a redundant
// copy), and no shadow whose window overlaps another covered show's lane window that night (shadows are the biggest
// runner consumer on press night, BRO-7198). Fail-safe: LANE_ONLY_MARKETS unread or the show not found = no shadow.
// The CLI reads LANE_ONLY_MARKETS with readOnlyMarkets (job env, else a live read with REVIEW_TEXTS_TOKEN).

const fs = require('fs');
const path = require('path');
const { coversShow, readOnlyMarkets } = require('./opening-night-lane/lane-only-markets');
const { nightTimes } = require('./opening-night-lane/auto-fallback');

const SHADOW_END_AFTER_EMBARGO_MIN = 300; // shadow covers up to embargo +5h
// BRO-6802: off-Broadway press nights are shadow nights too. Shadow takes no lease and publishes nothing, so it
// measures the lane on real nights before the Broadway ones (BRO-5955 evidence needs >= 2 nights before 2026-11-09).
const SHADOW_MARKETS = ['broadway', 'off-broadway'];
const MAX_WINDOW_MIN = 320; // opening-night-lane-live.yml validates window_min 1-320

/** Run title the lane-live workflow gets from its run-name (see opening-night-lane-live.yml). */
function shadowRunTitle(show, night) {
  return `Opening-night lane shadow ${show} ${night}`;
}

const DAY_MS = 24 * 3600000;

/** shows.json as an array ({_meta, shows} or a bare array). */
function loadShows(file = path.join(__dirname, '../../data/shows.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.shows) ? raw.shows : []);
}

/**
 * Pure. onlyMarkets: LANE_ONLY_MARKETS as {ok, value} (unread = no shadow). shows: shows.json records (the show itself
 * must be among them, for its market and category; other covered shows' lane windows block an overlapping shadow).
 */
function planShadowDispatch({ show, night, market, embargoAt, nowMs = Date.now(), activeTitles = [], onlyMarkets, shows = [] }) {
  if (!SHADOW_MARKETS.includes(market)) return { dispatch: false, reason: `market ${market || '(none)'} is not a shadow market`, windowMin: 0 };
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(show || '')) return { dispatch: false, reason: 'bad show id', windowMin: 0 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night || '')) return { dispatch: false, reason: 'bad night', windowMin: 0 };
  const embMs = Date.parse(embargoAt);
  if (!Number.isFinite(embMs)) return { dispatch: false, reason: 'bad embargo_at', windowMin: 0 };

  const endMs = embMs + SHADOW_END_AFTER_EMBARGO_MIN * 60000;
  const windowMin = Math.min(MAX_WINDOW_MIN, Math.ceil((endMs - nowMs) / 60000));
  if (windowMin < 1) return { dispatch: false, reason: 'past embargo +5h', windowMin: 0 };

  const title = shadowRunTitle(show, night);
  if (activeTitles.some((t) => String(t).trim() === title)) {
    return { dispatch: false, reason: `shadow already queued or running for ${show} ${night}`, windowMin: 0 };
  }

  // BRO-7231 live-lane checks (fail-safe: anything unknown = no shadow; the shadow is optional).
  if (!onlyMarkets || !onlyMarkets.ok) return { dispatch: false, reason: 'LANE_ONLY_MARKETS unread: no shadow (fail-safe)', windowMin: 0 };
  const list = Array.isArray(shows) ? shows : [];
  const rec = list.find((s) => s && (s.id === show || s.slug === show));
  if (!rec) return { dispatch: false, reason: `show ${show} not in shows.json: no shadow (fail-safe)`, windowMin: 0 };
  if (coversShow(onlyMarkets, rec)) {
    return { dispatch: false, reason: `live lane covers ${show} (LANE_ONLY_MARKETS=${onlyMarkets.value}): shadow would be a copy`, windowMin: 0 };
  }
  const shadowEndMs = nowMs + windowMin * 60000;
  const nightMs = Date.parse(`${night}T00:00:00Z`);
  for (const s of list) {
    if (!s || s.id === rec.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.openingDate || ''))) continue;
    if (Math.abs(Date.parse(`${s.openingDate}T00:00:00Z`) - nightMs) > DAY_MS) continue;
    if (!coversShow(onlyMarkets, s)) continue;
    const t = nightTimes(s, s.openingDate, { preembargo: require('./opening-night-lane/preembargo-window').parseFlag(process.env.LANE_PREEMBARGO_DIRECT_ONLY) });
    if (!t) continue;
    if (nowMs < t.watchEndMs && shadowEndMs > t.laneStartMs) {
      return { dispatch: false, reason: `live-lane night: runners reserved for ${s.id} (lane ${new Date(t.laneStartMs).toISOString()} to ${new Date(t.watchEndMs).toISOString()})`, windowMin: 0 };
    }
  }
  return { dispatch: true, reason: `${market} press night`, windowMin };
}

module.exports = { planShadowDispatch, loadShows, SHADOW_MARKETS, shadowRunTitle, SHADOW_END_AFTER_EMBARGO_MIN, MAX_WINDOW_MIN };

if (require.main === module) {
  const arg = (k) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : '';
  };
  let plan;
  try {
    plan = planShadowDispatch({
      show: arg('show'),
      night: arg('night'),
      market: arg('market'),
      embargoAt: arg('embargo-at'),
      activeTitles: arg('active').split('\n').filter(Boolean),
      onlyMarkets: readOnlyMarkets(process.env),
      shows: loadShows(arg('shows-file') || undefined),
    });
  } catch (e) {
    plan = { dispatch: false, reason: `plan error: ${e && e.message} (fail-safe: no shadow)`, windowMin: 0 };
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
