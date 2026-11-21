#!/usr/bin/env node
'use strict';
// BRO-6263: evaluate the Codex trust ladder (scripts/lib/codex-trust-ladder.js) from the same outside
// signals the lane-health alarm uses: the BRO-4745 runner summaries (rejection rate), origin/main
// history (reverts and forward fixes of Codex landings), and the alarm's confirmed breaches.
// Shadow by default: it prints the report and writes nothing unless the committed state says
// mode "live" AND --apply is given. Kill switches: owner file killSwitch, env
// CODEX_TRUST_LADDER_DISABLED=1, repo var CODEX_LADDER_DISABLED=true (workflow).
//
//   node scripts/codex-trust-ladder.js [--apply] [--alert] [--health=FILE] [--out=FILE]
//        [--summaries=FILE] [--git-log=FILE] [--now=ISO]
// Exit: 0 ran | 1 state or owner file corrupt | 2 no source readable | 3 --alert and a card could not be filed.
if (require.main === module && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  console.log('Usage: node scripts/codex-trust-ladder.js [--apply] [--alert] [--health=FILE] [--out=FILE] [--summaries=FILE] [--git-log=FILE] [--now=ISO]\nCodex trust ladder (BRO-6263). Shadow unless the state file says mode "live" and --apply is given.');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lib/codex-trust-ladder.js');
// The protected parser itself, never a re-export from a file Codex may edit (BRO-6303).
const { runnerSummaryFacts } = require('./lib/codex-runner-grading.js');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const flag = (n) => process.argv.includes(`--${n}`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function readGitLog() {
  const f = arg('git-log');
  if (f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }
  try {
    // A shallow checkout sees a handful of commits, which would read as "no regressions" on every run.
    if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') return null;
    return execFileSync('git', ['log', 'origin/main', '--since=14 days ago', `--format=${L.GIT_LOG_FORMAT}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch { return null; }
}

async function readSummaries() {
  const f = arg('summaries');
  if (f) return readJson(f);
  return require('./codex-lane-alarm.js').readSummaries(L.POLICY.windowDays + 1);
}

// The alarm's confirmed breaches. A missing file, or one where a source was unreadable, is unknown, not clean.
function readBreaches() {
  const f = arg('health');
  const h = f && readJson(f);
  if (!h || (h.unknown && h.unknown.length)) return null;
  return h.confirmed || [];
}

const mdLine = (r) => `- ${r.rung}: ${r.regression.why}`;

async function main() {
  const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
  const files = L.loadFiles(process.cwd());
  if (files.corrupt) { console.error('codex-trust-ladder: a ladder file does not parse; access fails closed (narrowest) until it is fixed'); return 1; }
  if (!files.state) { console.log('Codex trust ladder: not set up (no state file). Runner access is the pre-ladder baseline.'); return 0; }
  const owner = files.owner || L.seedOwner();

  const raw = readGitLog();
  const summaries = await readSummaries();
  if (raw === null && !summaries && readBreaches() === null) { console.error('codex-trust-ladder: no source readable'); return 2; }
  const record = {
    stats: summaries ? L.rejectionStats(summaries, nowMs, L.POLICY.windowDays, runnerSummaryFacts) : null,
    regressions: L.gitRegressions(raw),
    breaches: readBreaches(),
  };
  const { state, events, report } = L.evaluate({ state: files.state, owner, record, nowMs });

  const st = report.stats || {};
  const lines = [
    `Codex trust ladder: ${report.status}${state.mode === 'live' ? '' : ' (shadow: no access changed)'}${files.state.promoteEnabled ? '' : ' (promotion off)'}`,
    ...Object.entries(report.rungs).map(([k, v]) => `- ${k}: ${v}`),
    `record (7d): ${st.attempts ?? '?'} attempts, rejected ${st.rate === null || st.rate === undefined ? '?' : `${(st.rate * 100).toFixed(0)}%`}, clean ${report.cleanDays === undefined ? '?' : report.cleanDays.toFixed(1)} day(s)`,
  ];
  if (report.missing && report.missing.length) lines.push(`next rung (${report.nextRung || 'none'}) needs: ${report.missing.join('; ')}`);
  for (const h of report.holds || []) lines.push(`hold: ${h}`);
  for (const r of report.relocked || []) lines.push(`RELOCKED ${mdLine(r)}`);
  if (report.promoted) lines.push(`PROMOTED ${report.promoted}`);
  console.log(lines.join('\n'));
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify({ at: new Date(nowMs).toISOString(), mode: state.mode, report, events }, null, 2) + '\n');

  const live = state.mode === 'live' && L.access({ state, owner, env: process.env }).source !== 'killed';
  let alertFailed = false;
  if (live && flag('alert') && events.some((e) => e.type === 'relock' || e.type === 'promote')) {
    const { routeAlert } = require('./lib/owner-alert-router');
    for (const e of events.filter((x) => x.type === 'relock' || x.type === 'promote')) {
      const relock = e.type === 'relock';
      try {
        // digest + decision: lands in the owner's morning digest and is never auto-dispatched, so no
        // worker can "fix" a relock by editing the state back.
        const r = await routeAlert({
          conditionKey: `codex-ladder:${e.type}:${relock ? e.why.split(':')[0] : `${e.rung}:${e.at.slice(0, 10)}`}`,
          title: relock ? `Codex lost access to ${e.rung} after a problem with its work` : `Codex earned more access: ${e.rung}`,
          description: `${e.why}. ${relock ? 'The trust ladder took back one rung of Codex access automatically; it comes back after 7 clean days.' : 'The record held for 7 days with under 40% of cards rejected.'}\n\nTechnical: scripts/codex-trust-ladder.js (BRO-6263), state data/audit/codex-trust-ladder.json. Do not re-unlock by editing the state file; fix the cause, or set killSwitch in data/audit/codex-trust-ladder-owner.json to return to the old behaviour.`,
          severity: relock ? 'warning' : 'info', disposition: 'digest', decision: true,
          decisionPrompt: relock ? 'Nothing needed unless you want Codex to keep this access: say so and a session will set the kill switch.' : 'Nothing needed. Say if you want it taken back.',
        });
        console.log(`   [alert] ${e.type} ${e.rung} -> ${r.action}`);
      } catch (err) { alertFailed = true; console.error(`[alert] routeAlert threw for ${e.type} ${e.rung}: ${err.message}`); }
    }
  }

  if (flag('apply') && live) {
    const strip = (s) => JSON.stringify({ ...s, clock: { ...s.clock, lastEvalAt: null } });
    const sixHours = 6 * 3600_000;
    const stale = !files.state.clock.lastEvalAt || nowMs - Date.parse(files.state.clock.lastEvalAt) > sixHours;
    if (strip(state) !== strip(files.state) || stale) {
      fs.writeFileSync(path.join(process.cwd(), L.STATE_FILE), JSON.stringify(state, null, 2) + '\n');
      console.log(`wrote ${L.STATE_FILE}`);
    } else console.log('state unchanged, nothing to write');
  }
  return alertFailed ? 3 : 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(2); });
module.exports = { main };
