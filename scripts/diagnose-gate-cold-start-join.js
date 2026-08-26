#!/usr/bin/env node
/**
 * diagnose-gate-cold-start-join.js — one-off diagnostic for the 2026-08-26
 * finding: analyze-gate-cold-start.js reports 0.00% captures/exposed in BOTH
 * arms since experiment start, while the overall email-gate funnel
 * (analyze-email-gate-funnel.js) shows healthy modal volume (~600+
 * impressions/wk) over the same period. That combination only makes sense if
 * the JOIN between $feature_flag_called exposure events and
 * gate_modal_shown/dismissed/email_captured events (both keyed on person_id)
 * is broken — not that the modal stopped firing.
 *
 * This script does NOT trust the join. It independently samples person_ids
 * from each side and checks for overlap + inspects what's actually on each
 * person's timeline, to find WHERE the break is:
 *   1. exposed person_ids (from $feature_flag_called, arm=control/cold-start)
 *      — do ANY of them have a gate_modal_shown event at all (regardless of
 *      ab_cold_start property presence)?
 *   2. shown person_ids (from gate_modal_shown with ab_cold_start=control or
 *      cold-start) — do they have a matching $feature_flag_called event?
 *   3. Person-profile check: since AnalyticsWrapper.tsx sets
 *      person_profiles:'identified_only' and this site never calls
 *      posthog.identify(), sample whether `person_id` on these events is even
 *      a distinct, non-null value per visitor (vs collapsing to one row).
 *
 * Usage: node scripts/diagnose-gate-cold-start-join.js
 * Env: POSTHOG_PERSONAL_API_KEY
 */

const PROJECT_ID = '332742';
const FLAG_KEY = 'gate-cold-start';
const EXPERIMENT_START = '2026-07-21';
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) { console.error('POSTHOG_PERSONAL_API_KEY not set'); process.exit(1); }

async function hogql(query) {
  const res = await fetch(`https://us.posthog.com/api/projects/${PROJECT_ID}/query/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).results || [];
}

const WINDOW = `timestamp > toDateTime('${EXPERIMENT_START} 00:00:00')`;

async function main() {
  console.log(`diagnose-gate-cold-start-join — since ${EXPERIMENT_START}\n${'='.repeat(64)}`);

  // 1. Raw counts, no grouping games — just how many rows of each event exist.
  const rawCounts = await hogql(`
    SELECT event, count() AS n, count(DISTINCT person_id) AS distinctPeople,
      count(DISTINCT distinct_id) AS distinctIds
    FROM events
    WHERE event IN ('$feature_flag_called','gate_modal_shown','gate_modal_dismissed','email_captured')
      AND ${WINDOW}
    GROUP BY event ORDER BY n DESC`);
  console.log('\n-- Raw event counts (all traffic, no REAL_USERS filter, no property filter) --');
  for (const [event, n, people, ids] of rawCounts) {
    console.log(`  ${event}: ${n} events, ${people} distinct person_id, ${ids} distinct distinct_id`);
  }

  // 2. Of the $feature_flag_called rows, how many are for OUR flag specifically,
  // and what values does $feature_flag_response actually take?
  const flagValues = await hogql(`
    SELECT JSONExtractString(properties,'$feature_flag') AS flag,
      JSONExtractString(properties,'$feature_flag_response') AS response, count() AS n
    FROM events
    WHERE event = '$feature_flag_called' AND ${WINDOW}
    GROUP BY flag, response ORDER BY n DESC LIMIT 20`);
  console.log('\n-- $feature_flag_called breakdown by flag + response value --');
  for (const [flag, response, n] of flagValues) {
    console.log(`  flag="${flag}" response="${response}": ${n}`);
  }

  // 3. Sample 10 person_ids exposed to gate-cold-start (control/cold-start),
  // check what OTHER events those exact person_ids have in-window.
  const exposedSample = await hogql(`
    SELECT person_id, argMin(JSONExtractString(properties,'$feature_flag_response'), timestamp) AS arm
    FROM events
    WHERE event = '$feature_flag_called' AND JSONExtractString(properties,'$feature_flag') = '${FLAG_KEY}'
      AND ${WINDOW}
    GROUP BY person_id
    HAVING arm IN ('control','cold-start')
    LIMIT 10`);
  console.log(`\n-- Sample of ${exposedSample.length} exposed person_ids (control/cold-start) --`);
  for (const [pid, arm] of exposedSample) {
    const timeline = await hogql(`
      SELECT event, count() AS n, min(timestamp) AS first, max(timestamp) AS last
      FROM events WHERE person_id = '${pid}' AND ${WINDOW}
      GROUP BY event ORDER BY n DESC LIMIT 15`);
    console.log(`  person_id=${pid} arm=${arm}:`);
    for (const [event, n, first, last] of timeline) {
      console.log(`      ${event}: ${n} (${first} .. ${last})`);
    }
  }

  // 4. Sample 10 person_ids that DID get gate_modal_shown with ab_cold_start
  // set (i.e. came through triggerGate), check if THEY have a matching
  // $feature_flag_called row for our flag under the same person_id.
  const shownSample = await hogql(`
    SELECT person_id, JSONExtractString(properties,'ab_cold_start') AS arm, count() AS n
    FROM events
    WHERE event = 'gate_modal_shown' AND JSONExtractString(properties,'ab_cold_start') != ''
      AND ${WINDOW}
    GROUP BY person_id, arm
    ORDER BY n DESC LIMIT 10`);
  console.log(`\n-- Sample of ${shownSample.length} gate_modal_shown person_ids (by ab_cold_start value) --`);
  for (const [pid, arm, n] of shownSample) {
    const ff = await hogql(`
      SELECT JSONExtractString(properties,'$feature_flag'), JSONExtractString(properties,'$feature_flag_response'), timestamp
      FROM events WHERE person_id = '${pid}' AND event = '$feature_flag_called' AND ${WINDOW}
      ORDER BY timestamp LIMIT 10`);
    console.log(`  person_id=${pid} client_ab_cold_start="${arm}" shown_count=${n} — $feature_flag_called rows: ${ff.length}`);
    for (const [flag, resp, ts] of ff) console.log(`      flag=${flag} response=${resp} at ${ts}`);
  }

  // 5. ab_cold_start value distribution on gate_modal_shown — does the CLIENT
  // think it knows the arm (stamps 'control'/'cold-start'/'fallback') even
  // when the SERVER-recorded $feature_flag_called never shows it?
  const abDist = await hogql(`
    SELECT JSONExtractString(properties,'ab_cold_start') AS arm, count() AS n, count(DISTINCT person_id) AS people
    FROM events WHERE event = 'gate_modal_shown' AND ${WINDOW}
    GROUP BY arm ORDER BY n DESC`);
  console.log('\n-- gate_modal_shown by client-stamped ab_cold_start value --');
  for (const [arm, n, people] of abDist) {
    console.log(`  ab_cold_start="${arm}": ${n} events, ${people} people`);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
