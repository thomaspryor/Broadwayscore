/** Read-only cumulative readout for docs/experiments/related-shows-position.md. */
const { phQuery, REAL_USERS_WHERE } = require('./posthog-query');
const { REGISTERED_FLAGS, evaluateFlagHealth } = require('./flag-registry');
const { twoProportionZTest } = require('./significance');
const { RELATED_SHOWS_FLAG, VARIANT_COMPACT } = require('./related-shows-ab');

const ARMS = ['control', VARIANT_COMPACT];
const CUTOVER = '2026-10-23 02:11:00';
const STOPPING_N = 3140;
const FLOOR_N = 906;

// Aggregate in PostHog so no person identifiers leave the service. Choose the
// first exposed session BEFORE testing its landing conditions. Returning on a
// later search session must never give a person another chance to convert.
const READOUT_QUERY = `
WITH exposed AS (
  SELECT person_id,
    argMin(coalesce(properties.$session_id, ''), tuple(timestamp, uuid)) AS sid,
    argMin(properties.variant, tuple(timestamp, uuid)) AS variant,
    count(DISTINCT properties.variant) AS arms
  FROM events
  WHERE event = 'related_shows_ab_exposed'
    AND properties.flag = '${RELATED_SHOWS_FLAG}'
    AND timestamp >= toDateTime('${CUTOVER}', 'UTC')
    AND ${REAL_USERS_WHERE}
  GROUP BY person_id
), pages AS (
  SELECT person_id, properties.$session_id AS sid, count() AS views,
    argMin(coalesce(session.$entry_pathname, ''), tuple(timestamp, uuid)) AS landing,
    argMin(coalesce(session.$channel_type, ''), tuple(timestamp, uuid)) AS channel
  FROM events
  WHERE event = '$pageview'
    AND timestamp >= toDateTime('${CUTOVER}', 'UTC')
    AND ${REAL_USERS_WHERE}
  GROUP BY person_id, sid
)
SELECT exposed.variant AS variant, count() AS n,
  countIf(startsWith(pages.landing, '/show/') AND pages.channel IN ('Organic Search', 'Paid Search') AND pages.views >= 2) AS converted,
  countIf(startsWith(pages.landing, '/show/') AND pages.channel IN ('Organic Search', 'Paid Search')) AS search_landers,
  countIf(exposed.sid = '' OR coalesce(pages.views, 0) = 0) AS missing_session,
  countIf(exposed.arms > 1) AS cross_variant_people
FROM exposed LEFT JOIN pages ON exposed.person_id = pages.person_id AND exposed.sid = pages.sid
GROUP BY variant
LIMIT 100`;

function summarizeRelatedShows(rows, flagHealth, now = new Date()) {
  const problems = [];
  if (!Array.isArray(rows) || rows.length >= 100) throw new Error('Invalid or capped related-shows readout');
  const seen = new Set();
  for (const row of rows) {
    const [name, n, conv, landers, missing, crossed] = row;
    if (!ARMS.includes(name) || seen.has(name)) problems.push('unexpected or duplicate exposure arm');
    seen.add(name);
    if (![n, conv, landers, missing, crossed].every(Number.isSafeInteger)
      || n < 0 || conv < 0 || conv > landers || landers > n
      || missing < 0 || missing > n || crossed < 0 || crossed > n) {
      problems.push('invalid person counts');
    }
    if (missing > 0) problems.push('exposed people without a usable first-session pageview join');
    if (crossed > 0) problems.push('people exposed in multiple arms');
  }
  if (!flagHealth?.ok) problems.push('flag health failed or unavailable');
  const variants = ARMS.map(name => {
    const row = rows.find(r => r[0] === name) || [name, 0, 0, 0, 0, 0];
    return { name, n: row[1], conv: row[2], searchLanders: row[3], missingSession: row[4], crossVariantPeople: row[5] };
  });
  const primary = {
    metric: 'person-level first-exposed-session search show landing and second pageview / exposed people',
    p: null, z: null, suppressed: problems.length ? [...new Set(problems)].join('; ') : null, degenerate: null,
  };
  if (!primary.suppressed) {
    const result = twoProportionZTest(variants[0], variants[1]);
    if (result.degenerate) primary.degenerate = result.degenerate;
    else Object.assign(primary, { p: result.p, z: result.z, note: result.note || null });
  }
  return {
    flag: RELATED_SHOWS_FLAG, startDate: CUTOVER, endDate: now.toISOString(),
    stoppingNPerArm: STOPPING_N, floorNPerArm: FLOOR_N, flagHealth, variants, primary,
  };
}

async function analyzeRelatedShows({ query = phQuery, fetchFlag, now } = {}) {
  // Use a GET only. Never update rollout, active, variants, or sticky assignment.
  const getFlag = fetchFlag || (async () => {
    const key = process.env.POSTHOG_PERSONAL_API_KEY;
    if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY not set');
    const response = await fetch('https://us.posthog.com/api/projects/332742/feature_flags/992842/', {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`PostHog flag read failed: HTTP ${response.status}`);
    const f = await response.json();
    return {
      active: f.active, variants: f.filters?.multivariate?.variants,
      rollout: f.filters?.groups?.length === 1 ? f.filters.groups[0].rollout_percentage : null,
      ensure_experience_continuity: f.ensure_experience_continuity,
    };
  });
  const expected = REGISTERED_FLAGS.find(f => f.key === RELATED_SHOWS_FLAG).expected;
  const flagHealth = evaluateFlagHealth(await getFlag(), expected);
  return summarizeRelatedShows(await query(READOUT_QUERY), flagHealth, now);
}

module.exports = { ARMS, CUTOVER, STOPPING_N, FLOOR_N, READOUT_QUERY, summarizeRelatedShows, analyzeRelatedShows };
