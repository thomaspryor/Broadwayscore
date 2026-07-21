/**
 * weekly-monitor-runner.js — shared boilerplate for the weekly gate-monitor
 * CLIs (monitor-gate-ab.js, monitor-email-gate-funnel.js,
 * monitor-gate-cold-start.js): state I/O, analyzer subprocess invocation,
 * the alert-send loop (dry-run / log-only / delivery-retry revert), and the
 * final state write. Each monitor supplies its own data-loading (fixture
 * seam + analyzer args) and pure decision function — those stay untouched.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sendAlert } = require('./discord-notify');

function loadState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; }
}

function runAnalyzerJson(scriptPath, args) {
  const raw = execFileSync('node', [scriptPath, '--json', ...args], {
    encoding: 'utf8', timeout: 120000,
  }).trim();
  // --json prints exactly one JSON line last; tolerate stray warnings above it.
  const jsonLine = raw.split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (!jsonLine) throw new Error(`${path.basename(scriptPath)} --json produced no JSON (got: ${raw.slice(0, 200)})`);
  return JSON.parse(jsonLine);
}

// Shared RECENT/CUMULATIVE two-window loader for monitors whose decide fn
// takes { recent, cumulative }: fixtureDir (if set) reads recent.json +
// cumulative.json instead of shelling out to the live analyzer.
function loadWindows({ fixtureDir, analyzerPath, recentDays, cumulativeDays }) {
  if (fixtureDir) {
    return {
      recent: JSON.parse(fs.readFileSync(path.join(fixtureDir, 'recent.json'), 'utf8')),
      cumulative: JSON.parse(fs.readFileSync(path.join(fixtureDir, 'cumulative.json'), 'utf8')),
    };
  }
  return {
    recent: runAnalyzerJson(analyzerPath, [`--days=${recentDays}`]),
    cumulative: runAnalyzerJson(analyzerPath, [`--days=${cumulativeDays}`]),
  };
}

async function runWeeklyMonitor({ loadData, decideFn, statePath, dryRun, logData }) {
  const state = loadState(statePath);
  const data = await loadData();
  const { alerts, state: nextState } = decideFn(data, state, Date.now());
  nextState.lastRunAt = new Date().toISOString();
  nextState.lastSummary = data;

  logData(data);
  console.log(`Decisions: ${alerts.map(a => a.kind).join(', ') || 'none'}`);

  for (const a of alerts) {
    if (dryRun) { console.log(`[dry-run] would send ${a.kind}: ${a.title}`); continue; }
    if (a.logOnly) { console.log(`[log-only] ${a.kind}: ${a.description}`); continue; }
    const delivered = await sendAlert({ title: a.title, description: a.description, severity: a.severity, email: a.email });
    if (a.email && !delivered && a.stampKey) {
      // Delivery failed (Resend down / env missing): revert the sent-stamp so
      // this alert RETRIES next week instead of being silently lost.
      delete nextState[a.stampKey];
      console.log(`delivery FAILED for ${a.kind} — stamp ${a.stampKey} reverted, will retry next run`);
    } else {
      console.log(`sent ${a.kind} (${a.severity}${a.email ? ', email' : ''})`);
    }
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + '\n');
    console.log(`State saved: ${statePath}`);
  }
}

module.exports = { runWeeklyMonitor, runAnalyzerJson, loadWindows, loadState };
