#!/usr/bin/env node
'use strict';
// BRO-6134 backtest: replay scripts/lib/codex-lane-health.js hour by hour over the 30-day history
// and report, per known episode, when it would first have alarmed, plus false alarms on healthy days.
// Inputs are rebuilt from the same outside sources the hourly alarm reads (no hand-typed numbers):
//   --summaries=FILE  JSON [{createdAt, body}]  (every BRO-4745 comment, paginated)
//   --landed=FILE     TSV  "<iso date>\t<author>\t<co-authors>\t<subject>"  (main's commits)
//   --runs=FILE       JSON [{created_at|run_started_at, updated_at, conclusion}]  (codex-runner.yml runs)
// Fetch them with: node scripts/codex-lane-alarm.js --dump-sources=DIR
//   --fixture=FILE     replay the committed compact history instead (tests/fixtures/codex-lane-history.json)
//   --write-fixture=FILE  write that compact history from the three dumps
if (require.main === module && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  console.log('Usage: node scripts/backtest-codex-lane-health.js --fixture=tests/fixtures/codex-lane-history.json\n   or: node scripts/backtest-codex-lane-health.js --summaries=FILE --runs=FILE --landed=FILE [--write-fixture=FILE]\nReplays scripts/lib/codex-lane-health.js hour by hour over the Codex-lane history (BRO-6134/BRO-6139). Read-only.');
  process.exit(0);
}
const fs = require('fs');
const { confirmedBreaches, codexLandedEvents } = require('./lib/codex-lane-health.js');

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

const fmt = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
const inEpisode = (t) => EPISODES.some((e) => t >= U(e.from) && t <= U(e.to));

/** The three dumps -> the replay's inputs { summaries, landed: [{ ms }], runs }. */
function inputsFromDumps({ summaries, runsRaw, landedTsv }) {
  const lines = String(landedTsv).split('\n').filter(Boolean).map((l) => {
    const [d, a, co, ...s] = l.split('\t');
    return `${Date.parse(d)}\t${[a, co, s.join('\t')].join('\t')}`;
  });
  const runs = runsRaw.map((r) => ({
    startMs: Date.parse(r.run_started_at || r.created_at), endMs: Date.parse(r.updated_at), conclusion: r.conclusion,
    durationMin: (Date.parse(r.updated_at) - Date.parse(r.run_started_at || r.created_at)) / 60000,
  }));
  return { summaries, landed: codexLandedEvents([...new Set(lines)].join('\n')), runs };
}

/**
 * Replay the health function hour by hour over the history. -> { timeline, episodes, healthy, outside }
 * episodes: [{ id, what, fromMs, hitMs|null, delayH|null, rawMs|null, classes }]
 */
function replay({ summaries, landed, runs }, { start = U('10-10T13:37'), end = U('10-24T12:37') } = {}) {
  const timeline = [];
  for (let t = start; t <= end; t += 3600_000) {
    const ghRuns = t < GHA_ENROLLED ? [] : runs.filter((r) => r.startMs <= t).map((r) => ({ ...r, conclusion: r.endMs <= t ? r.conclusion : null }));
    const { now, confirmed } = confirmedBreaches({ nowMs: t, landed, summaries, ghRuns });
    timeline.push({ t, raw: now.breaches, confirmed });
  }
  const episodes = EPISODES.map((e) => {
    const from = U(e.from); const to = U(e.to);
    const hit = timeline.find((x) => x.t >= from && x.t <= to && x.confirmed.length);
    const rawHit = timeline.find((x) => x.t >= from && x.t <= to && x.raw.length);
    return { id: e.id, what: e.what, fromMs: from, hitMs: hit ? hit.t : null, delayH: hit ? (hit.t - from) / 3600_000 : null, rawMs: rawHit ? rawHit.t : null,
      classes: hit ? [...new Set(hit.confirmed.map((b) => `${b.lane}:${b.cls}`))] : [] };
  });
  const healthyChecks = timeline.filter((x) => x.t >= HEALTHY.from && x.t < HEALTHY.to);
  const byClass = (xs, key) => { const m = {}; for (const x of xs) for (const b of x[key]) (m[`${b.lane}:${b.cls}`] ??= []).push(x.t); return m; };
  const falseAlarm = healthyChecks.filter((x) => x.confirmed.length && !inEpisode(x.t));
  const outside = timeline.filter((x) => x.confirmed.length && !inEpisode(x.t) && !(x.t >= HEALTHY.from && x.t < HEALTHY.to));
  return {
    timeline, episodes,
    healthy: { checks: healthyChecks.length, falseAlarms: falseAlarm.length, raw: healthyChecks.filter((x) => x.raw.length).length,
      falseByClass: byClass(falseAlarm, 'confirmed'), rawByClass: byClass(healthyChecks.filter((x) => x.raw.length), 'raw') },
    outside: { checks: outside.length, byClass: byClass(outside, 'confirmed') },
  };
}

function report(r) {
  const out = [];
  out.push('| Episode | Onset (UTC) | First confirmed alarm | Delay | First raw breach | Classes |', '|---|---|---|---|---|---|');
  for (const e of r.episodes) {
    out.push(`| ${e.id} ${e.what} | ${fmt(e.fromMs)} | ${e.hitMs ? fmt(e.hitMs) : 'none'} | ${e.delayH === null ? 'MISSED' : `${e.delayH.toFixed(1)}h`} | ${e.rawMs ? fmt(e.rawMs) : 'none'} | ${e.classes.join(', ')} |`);
  }
  out.push('', `Healthy window ${fmt(HEALTHY.from)} .. ${fmt(HEALTHY.to)} (${r.healthy.checks} hourly checks): confirmed alarms ${r.healthy.falseAlarms}, single-hour raw breaches ${r.healthy.raw}.`);
  for (const [k, ts] of Object.entries(r.healthy.falseByClass)) out.push(`  false-alarm ${k}: ${ts.length} checks, first ${fmt(ts[0])}, last ${fmt(ts[ts.length - 1])}`);
  for (const [k, ts] of Object.entries(r.healthy.rawByClass)) out.push(`  raw ${k}: ${ts.length} checks, first ${fmt(ts[0])}`);
  out.push(`Confirmed alarms outside any listed episode and outside the healthy window: ${r.outside.checks} checks.`);
  for (const [k, ts] of Object.entries(r.outside.byClass)) out.push(`  ${k}: ${ts.length} checks, ${fmt(ts[0])} .. ${fmt(ts[ts.length - 1])}`);
  return out.join('\n');
}

// The committed replay fixture (tests/fixtures/codex-lane-history.json, BRO-6139 stage 3): only the
// lines the parsers read, so a runner/picker/alarm change can be replayed offline before it lands.
const KEEP_LINE = /^(## Codex runner|- (Landed and Done|Landed part, back to Todo with what is left|Runner error mid-card \(back to Todo\)|Stopped early|Why nothing was worked|Claude check): )/;
function compactFixture({ summaries, landed, runs }) {
  const { redactSecrets } = require('./lib/codex-runner.js');
  return {
    note: 'BRO-6139: BRO-4745 runner summaries (parsed lines only), codex-runner.yml runs and Codex landing times, 2026-10-06..10-24. Regenerate: node scripts/backtest-codex-lane-health.js --summaries=... --runs=... --landed=... --write-fixture=tests/fixtures/codex-lane-history.json',
    summaries: summaries.filter((c) => /^## Codex runner/.test(String(c.body || '')))
      .map((c) => ({ createdAt: c.createdAt, body: redactSecrets(String(c.body).split('\n').filter((l) => KEEP_LINE.test(l)).map((l) => l.slice(0, 200)).join('\n'), {}) })),
    runs: runs.map((r) => ({ startMs: r.startMs, endMs: r.endMs, conclusion: r.conclusion, durationMin: Math.round(r.durationMin * 10) / 10 })),
    landedMs: landed.map((e) => e.ms),
  };
}
const fromFixture = (f) => ({ summaries: f.summaries, runs: f.runs, landed: f.landedMs.map((ms) => ({ ms })) });

function main() {
  let inputs;
  if (arg('fixture')) inputs = fromFixture(JSON.parse(fs.readFileSync(arg('fixture'), 'utf8')));
  else {
    inputs = inputsFromDumps({ summaries: JSON.parse(fs.readFileSync(arg('summaries'), 'utf8')), runsRaw: JSON.parse(fs.readFileSync(arg('runs'), 'utf8')), landedTsv: fs.readFileSync(arg('landed'), 'utf8') });
    if (arg('write-fixture')) { fs.writeFileSync(arg('write-fixture'), `${JSON.stringify(compactFixture(inputs))}\n`); console.error(`wrote ${arg('write-fixture')}`); }
  }
  console.log(report(replay(inputs)));
}
if (require.main === module) main();
module.exports = { EPISODES, HEALTHY, replay, report, inputsFromDumps, compactFixture, fromFixture };
