'use strict';
/**
 * BRO-2805 (BRO-2795 cousins): a workflow job whose commit step is the
 * BLANKET `bash scripts/lib/stage-data-changes.sh` (no args = `git add data/`)
 * stages every data/audit/*.json an EARLIER step in that job wrote. If one of
 * those paths is neither MANAGED, apiFallbackSafe nor apiFallbackMerge in
 * core-data-merge-registry.js, push-with-retry.sh's Git Data API fallback
 * disqualifier ("unaudited data/audit/ path") vetoes the fallback for the
 * WHOLE commit — invisible until the push loses its race. BRO-2795 was the
 * commercial-rss-poll.yml instance; this finds the rest statically.
 *
 * Pure text scan, no spawn/exec. Per-path classification delegates to
 * classifyPushFallbackSafety() (the real disqualifier module), so the verdict
 * cannot drift from push-with-retry.sh.
 *
 * Exempt a path deliberately (gitignored, or removed before the sweep):
 * a `# blanket-sweep-audit-ok: data/audit/x.json <reason>` line in the step.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { parseWorkflow, classifyPushFallbackSafety } = require('./audit-push-retry-budgets.js');
const { findInvokedScripts } = require('../audit-push-core-data-audit-gap.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BLANKET_RE = /^\s*bash\s+scripts\/lib\/stage-data-changes\.sh\s*$/m;
const AUDIT_FILE_RE = /^[\w.-]+\.jsonl?$/;
const WRITE_FN = '(?:writeFileSync|appendFileSync|writeFile|appendFile)';
// path.join(...) with data/audit spelled as a literal or as ('data','audit') parts.
const AUDIT_DIR_EXPR = "(?:['\"][./]*(?:data/audit|audit)['\"]|path\\.join\\([^)]*['\"]data['\"]\\s*,\\s*['\"]audit['\"][^)]*\\)|path\\.join\\([^)]*['\"][./]*data/audit['\"][^)]*\\))";

/** Basenames a script writes under data/audit/ (top-level files only). */
function auditFilesWrittenBy(src) {
  const out = new Set();
  const add = (name) => { if (AUDIT_FILE_RE.test(name)) out.add(`data/audit/${name}`); };
  // 1. direct literal: write*('data/audit/x.json' ...)
  let m;
  const direct = new RegExp(`${WRITE_FN}\\s*\\(\\s*['"\`][./]*data/audit/([\\w.-]+)['"\`]`, 'g');
  while ((m = direct.exec(src))) add(m[1]);
  // 2. variables holding the audit dir, or a full audit file path
  const dirVars = new Set();
  const fileVars = new Map();
  const assign = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*([^;]{0,240})`, 'g');
  while ((m = assign.exec(src))) {
    const [, v, rhs] = m;
    const lit = rhs.match(/['"`][./]*data\/audit\/([\w.-]+\.jsonl?)['"`]/);
    const parts = rhs.match(/['"]data['"]\s*,\s*['"]audit['"]\s*,\s*['"]([\w.-]+\.jsonl?)['"]/);
    if (lit) fileVars.set(v, lit[1]);
    else if (parts) fileVars.set(v, parts[1]);
    else if (new RegExp(`^\\s*${AUDIT_DIR_EXPR}\\s*$`).test(rhs.replace(/\)\s*$/, ')'))
      || (/^\s*path\.join\(/.test(rhs) && /['"]data['"]\s*,\s*['"]audit['"]\s*\)?\s*$/.test(rhs.trim()))
      || /['"][./]*data\/audit\/?['"]\s*\)?\s*$/.test(rhs.trim())) dirVars.add(v);
  }
  // 3. a write whose first arg is one of those vars / path.join(dirVar, 'x.json') / path.join('data','audit','x.json')
  const wr = new RegExp(`${WRITE_FN}\\s*\\(\\s*`, 'g');
  while ((m = wr.exec(src))) {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 260);
    const v = rest.match(/^(\w+)\s*[,)]/);
    if (v && fileVars.has(v[1])) add(fileVars.get(v[1]));
    const pj = rest.match(/^path\.join\(([^)]*)\)/);
    if (pj) {
      const args = pj[1].split(',').map((s) => s.trim());
      const last = (args[args.length - 1] || '').match(/^['"`]([\w.-]+\.jsonl?)['"`]$/);
      if (!last) continue;
      const head = args.slice(0, -1);
      const isDirVar = head.length === 1 && dirVars.has(head[0]);
      const isLiteral = head.join(',').replace(/\s/g, '').match(/['"]data['"],['"]audit['"]$/)
        || (head.length >= 1 && /['"`][./]*data\/audit\/?['"`]$/.test(head[head.length - 1]));
      if (isDirVar || isLiteral) add(last[1]);
    }
  }
  return [...out];
}

function readScript(rel) {
  try { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); } catch { return null; }
}

/** Inline `> data/audit/x.json` / tee style writes in a run: block. */
function inlineAuditFiles(runText) {
  const out = new Set();
  for (const line of runText.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/(?:>>?|\btee(?:\s+-a)?)\s*['"]?(data\/audit\/[\w.-]+\.jsonl?)\b/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * Known, accepted findings (shrink-only, like safe-form-allowlist's
 * TRANSITIVE_SCAN_BASELINE): review-refresh.yml's rebuild/recover/cleanup
 * scripts write these reports, but the same scripts also run from other
 * workflows (rebuild-reviews.yml, rebuild-fast.yml, recover-explicit-ratings.yml),
 * so the registry's single-writer apiFallbackSafe claim cannot honestly be made
 * (see the "grow one entry at a time, each independently verified" rule in
 * core-data-merge-registry.js). Impact is bounded: reviews.json/shows.json
 * (NEVER_FALLBACK) ride the same commit on most runs, so the fallback is
 * already unavailable there. Register an entry (then delete it here) or
 * split the step to burn one down. A NEW unregistered write is NOT allowed.
 */
const BASELINE = new Set([
  'review-refresh.yml|data/audit/recover-ratings-state.json',
  'review-refresh.yml|data/audit/recover-ratings-report.json',
  'review-refresh.yml|data/audit/phantom-outlets-report.json',
  'review-refresh.yml|data/audit/rebuild-regression.json',
  'review-refresh.yml|data/audit/rebuild-show-drift.json',
  'review-refresh.yml|data/audit/cross-show-fingerprint-collisions.json',
  'review-refresh.yml|data/audit/skipped-alias-collisions.json',
]);

function gitIgnored(p) {
  try {
    execFileSync('git', ['check-ignore', '-q', p], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function auditBlanketSweeps(text, file, { readSrc = readScript, isIgnored = gitIgnored } = {}) {
  const { jobs } = parseWorkflow(text);
  const findings = [];
  for (const job of jobs) {
    const sweepIdx = job.steps.findIndex((s) => BLANKET_RE.test((s.runText || '').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')));
    if (sweepIdx < 0) continue;
    for (const step of job.steps.slice(0, sweepIdx + 1)) {
      const run = step.runText || '';
      const exempt = new Set([...run.matchAll(/#\s*blanket-sweep-audit-ok:\s*(data\/audit\/[\w.-]+)/g)].map((x) => x[1]));
      const sources = new Map(); // path -> origin
      for (const p of inlineAuditFiles(run)) sources.set(p, 'inline');
      for (const sc of findInvokedScripts(run)) {
        const src = readSrc(sc);
        if (src == null) continue;
        for (const p of auditFilesWrittenBy(src)) if (!sources.has(p)) sources.set(p, sc);
      }
      for (const [p, origin] of sources) {
        if (exempt.has(p)) continue;
        if (!classifyPushFallbackSafety(p).disqualifiesFallback) continue;
        if (isIgnored(p)) continue; // never staged by `git add data/`
        findings.push({ file, job: job.key, step: step.name, path: p, origin, continueOnError: !!step.continueOnError });
      }
    }
  }
  return findings;
}

function auditAllWorkflows(dir = path.join(REPO_ROOT, '.github', 'workflows')) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    out.push(...auditBlanketSweeps(fs.readFileSync(path.join(dir, f), 'utf8'), f));
  }
  return out;
}

module.exports = { BASELINE, auditFilesWrittenBy, inlineAuditFiles, auditBlanketSweeps, auditAllWorkflows };
