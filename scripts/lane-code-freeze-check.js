#!/usr/bin/env node
'use strict';
// BRO-6650: advisory pre-press-night lane code freeze check (land.yml). Always exits 0; prints status=... and, with
// --github, a ::warning and a GITHUB_OUTPUT line. See scripts/lib/lane-code-freeze.js.
//   node scripts/lane-code-freeze-check.js --base <ref> --head <ref> [--now ISO] [--shows data/shows.json] [--github]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateFreeze } = require('./lib/lane-code-freeze');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d = '') => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

function main() {
  const base = arg('base', 'origin/main');
  const head = arg('head', 'HEAD');
  const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
  const changedFiles = [];
  const deletedFiles = [];
  let commitMessages = [];
  try {
    // --no-renames: a rename is a delete plus an add, so the old path is seen.
    for (const line of git(['diff', '--no-renames', '--name-status', `${base}...${head}`]).split('\n').filter(Boolean)) {
      const [st, ...rest] = line.split('\t');
      (st === 'D' ? deletedFiles : changedFiles).push(rest.join('\t'));
    }
    commitMessages = git(['log', '--format=%B%x00', `${base}..${head}`]).split('\0');
  } catch (e) {
    return finish({ status: 'unknown', reason: `git diff failed: ${String(e.message).split('\n')[0]}`, files: [], nights: [], skipped: [] });
  }
  let laneFiles = [];
  try {
    laneFiles = require('./lib/opening-night-lane/rehearsal').laneCodeFiles().map((f) => path.relative(ROOT, f));
  } catch (e) {
    return finish({ status: 'unknown', reason: `laneCodeFiles failed: ${String(e.message).split('\n')[0]}`, files: [], nights: [], skipped: [] });
  }
  let shows = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(ROOT, arg('shows', 'data/shows.json')), 'utf8'));
    shows = Array.isArray(raw) ? raw : raw.shows;
  } catch { shows = null; }
  const { defaultEmbargoAt } = require('./lib/press-night-record');
  return finish(evaluateFreeze({ changedFiles, deletedFiles, laneFiles, shows, nowMs, commitMessages, disabled: ['1', 'true'].includes(String(process.env.LANE_FREEZE_DISABLED || '').toLowerCase()), embargoAtFn: defaultEmbargoAt }));
}

function finish(r) {
  const gh = process.argv.includes('--github');
  console.log(JSON.stringify({ status: r.status, reason: r.reason, files: r.files.length, nights: r.nights, skipped: r.skipped }));
  if (r.status === 'flagged') {
    const n = r.nights.map((x) => `${x.show} (embargo ${x.embargoAt}, ${x.hoursToEmbargo}h away)`).join(', ');
    const msg = `Lane code freeze: this land changes ${r.files.length} opening-night lane file(s) (${r.files.slice(0, 5).join(', ')}) near a Broadway press night: ${n}. It changes the lane code hash and disarms the lane until lane-rehearsal-recorded.yml re-passes (about 20 min after landing). To proceed on purpose, add a "LANE-FREEZE-BYPASS: <reason, 15+ chars>" line to a commit message.`;
    console.log(gh ? `::warning::${msg}` : msg);
  } else if (r.status === 'overridden') console.log(`Lane code freeze overridden: ${r.override}`);
  else if (r.status === 'unknown') console.log(gh ? `::warning::Lane code freeze could not be checked: ${r.reason}` : `could not check: ${r.reason}`);
  if (gh && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${r.status}\n`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
