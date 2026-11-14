'use strict';

/**
 * cron-ordering — the registry of "B must run after A" assumptions between
 * scheduled workflows, checked against the real cron lines (BRO-4801).
 *
 * GitHub starts this repo's schedules hours late, and by a different amount
 * per slot: '15 2' started 08:44-09:08, '30 5' 10:29-12:25, '45 6' 11:34-15:17
 * (2026-09/10). Two crons 15-90 min apart can therefore run in either order.
 * A same-day ordering held only by cron times needs at least MIN_LEAD_HOURS
 * between the two slots; anything tighter must chain with workflow_run.
 *
 * Each entry names the producer's exact cron line, so a producer with several
 * daily slots (llm-ensemble-score) is pinned to the run the consumer means.
 * Checked by scripts/lib/cron-ordering.test.mjs (blocking) and reported by
 * scripts/audit-cron-health-coverage.js.
 */

const fs = require('fs');
const path = require('path');

const MIN_LEAD_HOURS = 4;
// A lead longer than this means the consumer actually runs just BEFORE the
// producer's next slot, i.e. on yesterday's output.
const MAX_LEAD_HOURS = 20;

const ORDERING = [
  {
    before: 'rebuild-reviews.yml', beforeCron: '0 4 * * *',
    after: 'check-review-count-drift.yml',
    why: 'drift compares the freshly rebuilt reviews.json against review-texts',
  },
  {
    before: 'rebuild-reviews.yml', beforeCron: '0 4 * * *',
    after: 'check-corpus-drift.yml',
    why: 'corpus audits should see the freshly rebuilt corpus',
  },
  {
    before: 'llm-ensemble-score.yml', beforeCron: '30 4 * * *',
    after: 'adjudicate-review-queue.yml',
    why: 'adjudication resolves the disagreements the morning scoring run flagged',
  },
  {
    before: 'audit-provisional-venues.yml', beforeCron: '25 20 * * *',
    after: 'data-health-check.yml',
    why: 'the morning digest and promote-ob-historical.js read the same-day venue-date mismatch report',
  },
  {
    before: 'update-show-status.yml', beforeCron: '0 8 * * *',
    after: 'audit-closing-dates.yml',
    why: 'closing-date audit reads the status update and one enrich cycle',
  },
];

function cronsOf(yamlText) {
  return [...String(yamlText).matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1].trim());
}

function workflowName(yamlText) {
  const m = String(yamlText).match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
  return m ? m[1] : null;
}

// True when the consumer has a workflow_run trigger on the producer's name
// (flow list `workflows: [a, b]` or block list `workflows:\n  - a`).
function chainsOn(consumerYaml, producerName) {
  if (!producerName) return false;
  const m = String(consumerYaml).match(/^\s+workflow_run:\s*\n\s+workflows:[ \t]*(\[[^\]]*\]|\n(?:[ \t]+-[^\n]*\n?)+)/m);
  if (!m) return false;
  const names = m[1].startsWith('[')
    ? m[1].slice(1, -1).split(',')
    : m[1].split('\n').filter((l) => /^\s+-/.test(l)).map((l) => l.replace(/^\s+-\s*/, ''));
  return names.map((s) => s.trim().replace(/^['"]|['"]$/g, '')).includes(producerName);
}

// Minute-of-day for a cron with single minute and hour fields, else null.
function minuteOfDay(expr) {
  const [min, hour] = String(expr).trim().split(/\s+/);
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
  return Number(hour) * 60 + Number(min);
}

/**
 * @returns {Array<{entry, problem: string}>} empty when every assumption holds
 */
function checkOrdering(readWorkflow, entries = ORDERING) {
  const problems = [];
  for (const e of entries) {
    const prod = readWorkflow(e.before);
    const cons = readWorkflow(e.after);
    if (prod == null || cons == null) { problems.push({ entry: e, problem: `workflow file missing (${prod == null ? e.before : e.after})` }); continue; }
    if (!cronsOf(prod).includes(e.beforeCron)) { problems.push({ entry: e, problem: `${e.before} no longer has cron '${e.beforeCron}'; update the registry` }); continue; }
    if (chainsOn(cons, workflowName(prod))) continue;
    const p = minuteOfDay(e.beforeCron);
    const consCrons = cronsOf(cons);
    if (!consCrons.length) { problems.push({ entry: e, problem: `${e.after} has no cron and no workflow_run on ${e.before}` }); continue; }
    for (const c of consCrons) {
      const m = minuteOfDay(c);
      if (m == null || p == null) { problems.push({ entry: e, problem: `cron '${c}' is not a single daily time; chain with workflow_run instead` }); continue; }
      const lead = (((m - p) % 1440) + 1440) % 1440 / 60;
      if (lead < MIN_LEAD_HOURS || lead > MAX_LEAD_HOURS) {
        problems.push({ entry: e, problem: `${e.after} '${c}' is ${lead.toFixed(2)}h after ${e.before} '${e.beforeCron}'; needs ${MIN_LEAD_HOURS}-${MAX_LEAD_HOURS}h (GitHub schedule lag) or a workflow_run chain` });
      }
    }
  }
  return problems;
}

function fileReader(workflowsDir) {
  return (file) => {
    const p = path.join(workflowsDir, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
}

module.exports = { ORDERING, MIN_LEAD_HOURS, MAX_LEAD_HOURS, checkOrdering, fileReader, chainsOn, minuteOfDay, cronsOf };
