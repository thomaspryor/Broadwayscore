#!/usr/bin/env node
'use strict';
// BRO-6134 backtest: replay scripts/lib/codex-lane-health.js hour by hour over the 30-day history
// and report, per known episode, when it would first have alarmed, plus false alarms on healthy days.
// Inputs are rebuilt from the same outside sources the hourly alarm reads (no hand-typed numbers):
//   --summaries=FILE  JSON [{createdAt, body}]  (every BRO-4745 comment, paginated)
//   --landed=FILE     TSV  "<iso date>\t<author>\t<co-authors>\t<subject>"  (main's commits)
//   --runs=FILE       JSON [{created_at|run_started_at, updated_at, conclusion}]  (codex-runner.yml runs)
// Fetch them with: node scripts/codex-lane-alarm.js --dump-sources=DIR
const fs = require('fs');
const { codexLaneHealth, confirmedBreaches, codexLandedEvents } = require('./lib/codex-lane-health.js');
const { LANDED_LOG_FORMAT } = require('./lib/codex-runner.js');
void LANDED_LOG_FORMAT;

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const U = (s) => Date.parse(`2026-${s}:00Z`);
const EPISODES = [
  { id: 'E1', what: 'harness broke', from: '10-10T18:00', to: '10-11T00:00' },
  { id: 'E2', what: 'hook-refused lock stamps', from: '10-12T06:00', to: '10-14T12:00' },
  { id: 'E3', what: '3-slot launch disk / Done refusal', from: '10-15T06:00', to: '10-18T13:00' },
  { id: 'E4', what: 'Claude usage limit', from: '10-21T12:00', to: '10-22T00:00' },
  { id: 'E5', what: 'land queue starvation', from: '10-22T06:00', to: '10-23T01:00' },
  { id: 'E6', what: 'gha lane stands down (exits 0)', from: '10-22T20:02', to: '10-24T12:00' },
  { id: 'E7', what: 'volume 58 -> 13 / day', from: '10-23T18:55', to: '10-24T12:00' },
];
const HEALTHY = { from: U('10-19T00:00'), to: U('10-21T12:00') };
const GHA_ENROLLED = U('10-18T00:00'); // codex-runner.yml's gha lane first ran 10-18; earlier runs list is a single failed trial

function main() {
  const summaries = JSON.parse(fs.readFileSync(arg('summaries'), 'utf8'));
  const runsRaw = JSON.parse(fs.readFileSync(arg('runs'), 'utf8'));
  const lines = fs.readFileSync(arg('landed'), 'utf8').split('\n').filter(Boolean).map((l) => {
    const [d, a, co, ...s] = l.split('\t');
    return `${Date.parse(d)}\t${[a, co, s.join('\t')].join('\t')}`;
  });
  const landed = codexLandedEvents([...new Set(lines)].join('\n'));
  const runs = runsRaw.map((r) => ({
    startMs: Date.parse(r.run_started_at || r.created_at), endMs: Date.parse(r.updated_at), conclusion: r.conclusion,
    durationMin: (Date.parse(r.updated_at) - Date.parse(r.run_started_at || r.created_at)) / 60000,
  }));
  const start = U('10-10T13:37'); const end = U('10-24T12:37');
  const timeline = [];
  for (let t = start; t <= end; t += 3600_000) {
    const ghRuns = t < GHA_ENROLLED ? [] : runs.filter((r) => r.startMs <= t).map((r) => ({ ...r, conclusion: r.endMs <= t ? r.conclusion : null }));
    const { now, confirmed } = confirmedBreaches({ nowMs: t, landed, summaries, ghRuns });
    timeline.push({ t, raw: now.breaches, confirmed });
  }
  const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
  const out = [];
  out.push('| Episode | Onset (UTC) | First confirmed alarm | Delay | First raw breach | Classes |', '|---|---|---|---|---|---|');
  for (const e of EPISODES) {
    const from = U(e.from); const to = U(e.to);
    const hit = timeline.find((x) => x.t >= from && x.t <= to && x.confirmed.length);
    const rawHit = timeline.find((x) => x.t >= from && x.t <= to && x.raw.length);
    const d = (x) => (x ? `${((x.t - from) / 3600_000).toFixed(1)}h` : 'MISSED');
    out.push(`| ${e.id} ${e.what} | ${fmt(from)} | ${hit ? fmt(hit.t) : 'none'} | ${d(hit)} | ${rawHit ? fmt(rawHit.t) : 'none'} | ${hit ? [...new Set(hit.confirmed.map((b) => `${b.lane}:${b.cls}`))].join(', ') : ''} |`);
  }
  const inEpisode = (t) => EPISODES.some((e) => t >= U(e.from) && t <= U(e.to));
  const healthy = timeline.filter((x) => x.t >= HEALTHY.from && x.t < HEALTHY.to);
  const falseAlarm = healthy.filter((x) => x.confirmed.length && !inEpisode(x.t));
  const rawHealthy = healthy.filter((x) => x.raw.length);
  out.push('', `Healthy window ${fmt(HEALTHY.from)} .. ${fmt(HEALTHY.to)} (${healthy.length} hourly checks): confirmed alarms ${falseAlarm.length}, single-hour raw breaches ${rawHealthy.length}.`);
  const classes = {};
  for (const x of falseAlarm) for (const b of x.confirmed) (classes[`${b.lane}:${b.cls}`] ??= []).push(fmt(x.t));
  for (const k of Object.keys(classes)) out.push(`  false-alarm ${k}: ${classes[k].length} checks, first ${classes[k][0]}, last ${classes[k][classes[k].length - 1]}`);
  const raws = {};
  for (const x of rawHealthy) for (const b of x.raw) (raws[`${b.lane}:${b.cls}`] ??= []).push(fmt(x.t));
  for (const k of Object.keys(raws)) out.push(`  raw ${k}: ${raws[k].length} checks, first ${raws[k][0]}`);
  const outside = timeline.filter((x) => x.confirmed.length && !inEpisode(x.t) && !(x.t >= HEALTHY.from && x.t < HEALTHY.to));
  out.push(`Confirmed alarms outside any listed episode and outside the healthy window: ${outside.length} checks.`);
  const oc = {};
  for (const x of outside) for (const b of x.confirmed) (oc[`${b.lane}:${b.cls}`] ??= []).push(fmt(x.t));
  for (const k of Object.keys(oc)) out.push(`  ${k}: ${oc[k].length} checks, ${oc[k][0]} .. ${oc[k][oc[k].length - 1]}`);
  console.log(out.join('\n'));
}
if (require.main === module) main();
