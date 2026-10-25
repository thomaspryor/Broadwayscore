'use strict';
// BRO-6074: decide whether press-night-probe.yml should start the opening-night lane shadow
// (opening-night-lane-live.yml mode=shadow: no lease, no publish) for a show-night.
//
// Pure decision + a tiny CLI so the workflow step and the test share one implementation.
//   node scripts/lib/lane-shadow-dispatch.js --show=ID --night=YYYY-MM-DD --market=broadway \
//        --embargo-at=ISO [--active="title1\ntitle2"]   -> prints {dispatch, reason, windowMin}

const SHADOW_END_AFTER_EMBARGO_MIN = 300; // shadow covers up to embargo +5h
const MAX_WINDOW_MIN = 320; // opening-night-lane-live.yml validates window_min 1-320

/** Run title the lane-live workflow gets from its run-name (see opening-night-lane-live.yml). */
function shadowRunTitle(show, night) {
  return `Opening-night lane shadow ${show} ${night}`;
}

function planShadowDispatch({ show, night, market, embargoAt, nowMs = Date.now(), activeTitles = [] }) {
  if (market !== 'broadway') return { dispatch: false, reason: `market ${market || '(none)'} is not broadway`, windowMin: 0 };
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
  return { dispatch: true, reason: 'broadway press night', windowMin };
}

module.exports = { planShadowDispatch, shadowRunTitle, SHADOW_END_AFTER_EMBARGO_MIN, MAX_WINDOW_MIN };

if (require.main === module) {
  const arg = (k) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : '';
  };
  const plan = planShadowDispatch({
    show: arg('show'),
    night: arg('night'),
    market: arg('market'),
    embargoAt: arg('embargo-at'),
    activeTitles: arg('active').split('\n').filter(Boolean),
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
