'use strict';

/**
 * Main-red guard for workflows that do not block landing (BRO-7486).
 *
 * check-performance.yml (Bundle Size Check) and test-ugc.yml (UGC visual
 * baselines) run on push to main, after land.yml has already fast-forwarded.
 * Both sat red for two weeks because no session was ever told. land.yml now
 * asks, per landing, whether the latest finished run of each watched workflow
 * on main failed, and prints a warning if so. Advisory first (CLAUDE.md §19).
 */

const WATCHED_WORKFLOWS = [
  { file: 'check-performance.yml', name: 'Bundle Size Check', fix: 'cut the first-load JS or HTML that grew (lazy-load / dynamic import); do not raise the cap without evidence' },
  { file: 'test-ugc.yml', name: 'UGC visual tests', fix: 'confirm each screenshot diff is an intended UI change, then regenerate baselines (workflow_dispatch update_snapshots); fix the UI if it is a regression' },
];

/** Conclusions that mean "this workflow is red". Cancelled/skipped runs say nothing. */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const GREEN_CONCLUSIONS = new Set(['success']);

/**
 * @param {Array<{file:string,name?:string,fix?:string,runs:Array<{id:number,conclusion:string|null,created_at:string,html_url?:string}>}>} workflows
 *   runs newest first, completed runs on main only.
 * @returns {{red: Array<{file:string,name:string,fix:string,runId:number,url:string,since:string|null,consecutive:number}>, unknown: string[]}}
 */
function evaluateMainRed(workflows) {
  const red = [];
  const unknown = [];
  for (const wf of workflows) {
    const runs = (wf.runs || []).filter((r) => r && r.conclusion && (RED_CONCLUSIONS.has(r.conclusion) || GREEN_CONCLUSIONS.has(r.conclusion)));
    if (!runs.length) { unknown.push(wf.file); continue; }
    if (!RED_CONCLUSIONS.has(runs[0].conclusion)) continue;
    let consecutive = 0;
    while (consecutive < runs.length && RED_CONCLUSIONS.has(runs[consecutive].conclusion)) consecutive++;
    const oldestRed = runs[consecutive - 1];
    red.push({
      file: wf.file,
      name: wf.name || wf.file,
      fix: wf.fix || '',
      runId: runs[0].id,
      url: runs[0].html_url || '',
      since: oldestRed.created_at || null,
      consecutive,
    });
  }
  return { red, unknown };
}

/** The `::warning::` lines land.yml prints, one per red workflow. */
function formatWarnings({ red }) {
  return red.map((r) => `::warning title=main is red: ${r.name}::${r.file} has failed ${r.consecutive}+ run(s) on main in a row${r.since ? ` (red since at least ${r.since.slice(0, 10)})` : ''}${r.url ? `, latest ${r.url}` : ''}. Fix: ${r.fix}.`);
}

module.exports = { WATCHED_WORKFLOWS, RED_CONCLUSIONS, evaluateMainRed, formatWarnings };
