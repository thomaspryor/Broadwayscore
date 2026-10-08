/**
 * Pure parser for the three-repo workflow dependency graph (BRO-934).
 * Feeds scripts/generate-workflow-dependencies.js (writes
 * .github/workflows/DEPENDENCIES.md) and scripts/validate-workflow-dependencies.test.mjs.
 *
 * Regex/indent based on purpose: the lint-workflows CI job has no `npm ci`, so
 * js-yaml is unavailable (same constraint as ci-cancellation-guard.js, whose
 * indent helpers and top-level readConcurrency are reused here).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { indentOf, stripComment, readConcurrency } = require('./ci-cancellation-guard.js');

// Composite action -> repo it reads (R) or pushes to (W). Other two repos' own workflows
// live in their repos; only their inbound edges from this repo are knowable here.
const REPO_ACTIONS = {
  'push-core-data': { repo: 'broadway-scorecard-data', mode: 'push' },
  'checkout-core-data': { repo: 'broadway-scorecard-data', mode: 'read' },
  'push-review-texts': { repo: 'broadway-review-texts', mode: 'push' },
  'checkout-review-texts': { repo: 'broadway-review-texts', mode: 'read' },
  'push-aggregator-archive': { repo: 'broadway-review-texts', mode: 'push' },
  'checkout-aggregator-archive': { repo: 'broadway-review-texts', mode: 'read' },
};

// Class -> filename matcher. First match wins. Documented in DEPENDENCIES.md.
// Class is a documentation/audit label; the enforced serialization is the concurrency
// group each workflow already carries (a single shared group per class would hit
// GitHub's pending-queue depth of 1 and cancel queued runs: see rebuild-fast.yml).
const CLASS_RULES = [
  ['deploy', /^(vercel-|dispatch-deploy|update-deploy-watermark)/],
  ['rebuild', /^(rebuild-|enrich-reviews)/],
  ['scoring', /^(llm-|scoring-|snapshot-(audience|award)|score-)/],
  ['scraping', /(scrape|aggregator|collect-|gather-|poller|fetch-|backfill-|enrich-)/],
];

function classify(file) {
  for (const [cls, re] of CLASS_RULES) if (re.test(file)) return cls;
  return 'other';
}

function workflowName(raw, file) {
  const m = raw.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : file;
}

function triggersOf(raw) {
  const lines = raw.split('\n');
  const onIdx = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l) && indentOf(l) === 0);
  const out = { schedule: false, dispatch: false, push: false, pullRequest: false, workflowRun: [] };
  if (onIdx === -1) return out;
  const block = [];
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '' || lines[i].trim().startsWith('#')) continue;
    if (indentOf(lines[i]) === 0) break;
    block.push(lines[i]);
  }
  const text = block.join('\n');
  // Only direct children of `on:` count (a dispatch input named `schedule` must not).
  const childIndent = Math.min(...block.map(indentOf));
  const direct = block.filter((l) => indentOf(l) === childIndent).join('\n');
  out.schedule = /^\s*schedule\s*:/m.test(direct);
  out.dispatch = /^\s*workflow_dispatch\s*:/m.test(direct);
  out.push = /^\s*push\s*:/m.test(direct);
  out.pullRequest = /^\s*pull_request(_target)?\s*:/m.test(direct);
  const wr = block.findIndex((l) => /^\s*workflow_run\s*:/.test(l));
  if (wr !== -1) {
    const wrIndent = indentOf(block[wr]);
    const kids = [];
    for (let i = wr + 1; i < block.length && indentOf(block[i]) > wrIndent; i++) kids.push(block[i]);
    const kt = kids.join('\n');
    const inline = kt.match(/^\s*workflows\s*:\s*\[(.*)\]/m);
    if (inline) {
      out.workflowRun = inline[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      const w = kids.findIndex((l) => /^\s*workflows\s*:\s*$/.test(l));
      if (w !== -1) {
        for (let i = w + 1; i < kids.length && indentOf(kids[i]) > indentOf(kids[w]); i++) {
          const it = stripComment(kids[i]).match(/^-\s*['"]?(.+?)['"]?$/);
          if (it) out.workflowRun.push(it[1]);
        }
      }
    }
  }
  return out;
}

// Job-level concurrency blocks (indent 4 under `jobs:`). Top-level is handled by readConcurrency.
function jobConcurrency(raw) {
  const res = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^    concurrency\s*:/.test(lines[i])) continue;
    let group = '';
    let cancelRaw = null;
    const inline = stripComment(lines[i]).match(/concurrency\s*:\s*(\S.*)$/);
    if (inline) group = inline[1];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '' || lines[j].trim().startsWith('#')) continue;
      if (indentOf(lines[j]) <= 4) break;
      const g = stripComment(lines[j]).match(/^\s*group\s*:\s*(.+)$/);
      if (g) group = g[1].trim();
      const c = stripComment(lines[j]).match(/^\s*cancel-in-progress\s*:\s*(.+)$/);
      if (c) cancelRaw = c[1].trim();
    }
    res.push({ group, cancelRaw, level: 'job' });
  }
  return res;
}

function concurrencyOf(raw) {
  const top = readConcurrency(raw);
  const list = [];
  if (top) list.push({ group: top.group, cancelRaw: top.cancelRaw, level: 'workflow' });
  list.push(...jobConcurrency(raw));
  return list;
}

function parseWorkflow(file, raw) {
  const repoEdges = [];
  for (const [action, meta] of Object.entries(REPO_ACTIONS)) {
    if (new RegExp(`\\.github/actions/${action}\\b`).test(raw)) repoEdges.push({ action, ...meta });
  }
  // Direct pushes without the composite action (git push to this repo is not cross-repo).
  const dispatches = new Set();
  for (const m of raw.matchAll(/workflow_id\s*:\s*['"]([\w.-]+\.ya?ml)['"]/g)) dispatches.add(m[1]);
  const external = [];
  for (const m of raw.matchAll(/gh workflow run\s+['"]?([\w.-]+\.ya?ml)['"]?((?:[^\n]*\\\n)*[^\n]*)/g)) {
    const repo = m[2].match(/--repo\s+['"]?(?:thomaspryor\/)?([\w.-]+)/);
    if (repo && repo[1].toLowerCase() !== 'broadwayscore') external.push({ repo: repo[1], file: m[1] });
    else dispatches.add(m[1]);
  }
  if (/\.github\/actions\/dispatch-deploy\b/.test(raw)) dispatches.add('vercel-deploy.yml');
  dispatches.delete(file);
  const secrets = [...new Set([...raw.matchAll(/secrets\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  return {
    file,
    name: workflowName(raw, file),
    class: classify(file),
    triggers: triggersOf(raw),
    repoEdges,
    pushesCrossRepo: repoEdges.some((e) => e.mode === 'push'),
    dispatches: [...dispatches].sort(),
    externalDispatches: external,
    secrets,
    concurrency: concurrencyOf(raw),
  };
}

function loadWorkflows(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => parseWorkflow(f, fs.readFileSync(path.join(dir, f), 'utf8')));
}

// workflow_run edges: [{ from: triggerName, to: file }]. Unresolved names are reported separately.
function buildGraph(workflows) {
  const byName = new Map(workflows.map((w) => [w.name, w]));
  const edges = [];
  const unresolved = [];
  for (const w of workflows) {
    for (const n of w.triggers.workflowRun) {
      const src = byName.get(n);
      if (src) edges.push({ from: src.file, to: w.file, via: 'workflow_run' });
      else unresolved.push({ file: w.file, name: n });
    }
    for (const d of w.dispatches) edges.push({ from: w.file, to: d, via: 'dispatch' });
  }
  return { edges, unresolved };
}

// Writers that can race: push to the private data/text repos with no concurrency of any level.
function writersWithoutConcurrency(workflows) {
  return workflows.filter((w) => w.pushesCrossRepo && w.concurrency.length === 0).map((w) => w.file);
}

// BRO-4859: a dispatch target whose top-level group is a static string with
// cancel-in-progress: false keeps ONE pending run, so a dispatch arriving while a run
// is busy evicts the previous pending one ('cancelled', never started, no alert).
// gather-reviews.yml lost 43 of 225 dispatches that way in two weeks. Fine for a
// debounce (a full rebuild), wrong when each dispatch carries its own work list.
// Opt out with `# concurrency-queue-ok: <reason>` inside the concurrency block.
const QUEUE_OK_ANNOTATION = 'concurrency-queue-ok';

// Workflows a script or workflow text dispatches: gh CLI (string or argv-array form,
// flags before the target, by file or by display name), REST path, octokit. Display
// names come back as `name:<Name>` for queueEvictionRisks to resolve. A dispatch with
// --repo/-R naming another repo is skipped.
function dispatchTargetsIn(text) {
  const out = new Set();
  const otherRepo = (args) => {
    const repo = args.match(/(?:--repo|-R)['",\s=]+(?:thomaspryor\/)?([\w.-]+)/);
    return Boolean(repo && repo[1].toLowerCase() !== 'broadwayscore');
  };
  const addTarget = (args) => {
    const file = args.match(/([\w.-]+\.ya?ml)\b/);
    if (file) return out.add(file[1]);
    const name = args.match(/^[\s,]*['"]([A-Z][^'"\n]*)['"]/);
    if (name) out.add(`name:${name[1]}`);
  };
  for (const m of text.matchAll(/gh workflow run\b([^\n]*)/g)) if (!otherRepo(m[1])) addTarget(m[1].replace(/(?:^|\s)--?[\w-]+(?:[ =](?!['"][A-Z])\S+)?/g, ' '));
  for (const m of text.matchAll(/['"]workflow['"]\s*,\s*['"]run['"]\s*,([^\]\n]*)/g)) if (!otherRepo(m[1])) addTarget(m[1]);
  for (const m of text.matchAll(/workflow_id\s*:\s*['"]([\w.-]+\.ya?ml)['"]/g)) out.add(m[1]);
  for (const m of text.matchAll(/actions\/workflows\/([\w.-]+\.ya?ml)\/dispatches/g)) out.add(m[1]);
  return out;
}

// workflows: loadWorkflows() output. rawByFile: file -> YAML text. scriptTexts: texts of
// non-workflow dispatchers (scripts/). Returns [{ file, group, dispatchers }].
function queueEvictionRisks(workflows, rawByFile, scriptTexts = []) {
  const dispatchers = new Map();
  const add = (to, from) => {
    if (!dispatchers.has(to)) dispatchers.set(to, new Set());
    dispatchers.get(to).add(from);
  };
  const byName = new Map(workflows.map((w) => [w.name, w.file]));
  const resolve = (d) => (d.startsWith('name:') ? byName.get(d.slice(5)) : d);
  for (const w of workflows) {
    for (const d of w.dispatches) add(d, w.file);
    for (const d of dispatchTargetsIn(rawByFile[w.file] || '')) if (resolve(d) && resolve(d) !== w.file) add(resolve(d), w.file);
  }
  for (const { file, text } of scriptTexts) for (const d of dispatchTargetsIn(text)) if (resolve(d)) add(resolve(d), file);
  const risks = [];
  for (const w of workflows) {
    if (!dispatchers.has(w.file) || !w.triggers.dispatch) continue;
    const c = readConcurrency(rawByFile[w.file] || '');
    if (!c || c.cancelRaw !== 'false') continue;
    if (!c.group || c.group.includes('${{')) continue; // per-run or partitioned key
    if (c.blockText.includes(QUEUE_OK_ANNOTATION)) continue;
    risks.push({ file: w.file, group: c.group, dispatchers: [...dispatchers.get(w.file)].sort() });
  }
  return risks;
}

// Known offenders when the check landed (BRO-4859); triage tracked on Linear. The
// check fails only on workflows NOT listed here, so the set can only shrink.
const QUEUE_EVICTION_BASELINE = [
  'apply-migration.yml',
  'audit-aggregator-gap.yml',
  'audit-census-recall.yml',
  'audit-reverse-discovery.yml',
  'autonomous-merge.yml',
  'backfill-cast.yml',
  'coverage-adversarial-probe.yml',
  'deep-research-commercial.yml',
  'extract-pull-quotes.yml',
  'fetch-aggregator-pages.yml',
  'newsletter-draft.yml',
  'opening-digest.yml',
  'opening-night-broadcast.yml',
  'outlet-listing-poller.yml',
  'rebuild-reviews.yml',
  'review-refresh.yml',
  'scrape-dtli-show-score.yml',
  'sweep-we-aggregators.yml',
  'update-critic-consensus.yml',
  'update-ltd.yml',
  'update-theatr.yml',
  'weekly-grosses.yml',
];

module.exports = {
  QUEUE_OK_ANNOTATION,
  QUEUE_EVICTION_BASELINE,
  dispatchTargetsIn,
  queueEvictionRisks,
  REPO_ACTIONS,
  CLASS_RULES,
  classify,
  parseWorkflow,
  loadWorkflows,
  buildGraph,
  writersWithoutConcurrency,
};
