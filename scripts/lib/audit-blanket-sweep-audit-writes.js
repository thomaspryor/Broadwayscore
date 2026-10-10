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
// Blanket = no args, or an arg list containing the whole `data` dir (`data`, `data/`).
function isBlanketSweepLine(line) {
  const m = line.replace(/\s+#.*$/, '').match(/^\s*bash\s+scripts\/lib\/stage-data-changes\.sh((?:\s+[^\s;&|]+)*)\s*(?:(?:&&|\|\||;).*)?$/);
  if (!m) return false;
  const args = m[1].trim().split(/\s+/).filter(Boolean).map((a) => a.replace(/^['"]|['"]$/g, ''));
  return args.length === 0 || args.some((a) => a === 'data' || a === 'data/');
}
const AUDIT_FILE_RE = /^[\w.-]+\.jsonl?$/;

/**
 * data/audit top-level filenames a script (or a lib it require()s) can write.
 * Deliberately generous: a script that contains ANY write primitive (fs write/
 * append, writeAuditArtifact, rename) and names a data/audit file — as a
 * literal path, or as a bare 'x.json' joined onto an audit dir (literal,
 * 'audit' segment, or a variable assigned one) — is assumed to write it. False
 * positives are cheap (exempt comment); false negatives recreate BRO-2795.
 */
const WRITE_PRIM_RE = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|writeAuditArtifact|renameSync|createWriteStream)\s*\(/;
function auditFilesWrittenBy(src) {
  if (!WRITE_PRIM_RE.test(src)) return [];
  const out = new Set();
  const add = (name) => { if (AUDIT_FILE_RE.test(name)) out.add(`data/audit/${name}`); };
  let m;
  const lit = /[`'"][^`'"\n]*?data\/audit\/([\w.-]+\.jsonl?)[`'"]/g;
  while ((m = lit.exec(src))) add(m[1]);
  // audit-dir variables: `X = ... 'audit'` / `X = ... data/audit` (any depth of path.join/resolve)
  const dirVars = new Set();
  const assign = /(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]{0,200})/g;
  while ((m = assign.exec(src))) {
    const rhs = m[2].trim();
    if (/['"`]audit['"`]\s*\)?\s*$/.test(rhs) || /data\/audit\/?['"`]\s*\)?\s*$/.test(rhs) || /\$\{\w+\}\/audit\/?`$/.test(rhs)) dirVars.add(m[1]);
  }
  const joins = /path\.(?:join|resolve)\(([^)]*)\)/g;
  while ((m = joins.exec(src))) {
    const args = m[1].split(',').map((x) => x.trim());
    const last = (args[args.length - 1] || '').match(/^['"`]([\w.-]+\.jsonl?)['"`]$/);
    if (!last) continue;
    const head = args.slice(0, -1);
    if (head.some((a) => /^['"`]audit['"`]$/.test(a) || dirVars.has(a) || /data\/audit\/?['"`]$/.test(a))) add(last[1]);
  }
  // template strings: `${AUDIT_DIR}/x.json`
  const tpl = /`\$\{(\w+)\}\/([\w.-]+\.jsonl?)`/g;
  while ((m = tpl.exec(src))) if (dirVars.has(m[1])) add(m[2]);
  return [...out];
}

/** The script plus the relative lib modules it require()s (one level). */
function auditFilesWrittenByWithLibs(scriptRel, readSrc) {
  const src = readSrc(scriptRel);
  if (src == null) return [];
  const out = new Set(auditFilesWrittenBy(src));
  const req = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = req.exec(src))) {
    const base = path.posix.join(path.posix.dirname(scriptRel), m[1]);
    for (const cand of [base, `${base}.js`, `${base}/index.js`]) {
      const lsrc = readSrc(cand);
      if (lsrc != null) { for (const p of auditFilesWrittenBy(lsrc)) out.add(p); break; }
    }
  }
  return [...out];
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

function readScript(rel) {
  try { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); } catch { return null; }
}


/**
 * Known, accepted findings (shrink-only, like safe-form-allowlist's
 * TRANSITIVE_SCAN_BASELINE). The extractor is deliberately generous (a script
 * with a write primitive that names the path counts), so some entries are
 * conditional writes (e.g. url-mismatch-suspects.json only when suspects
 * exist). Writer scripts are shared across workflows (rebuild-reviews.yml,
 * rebuild-fast.yml, ...),
 * so the registry's single-writer apiFallbackSafe claim cannot honestly be made
 * (see the "grow one entry at a time, each independently verified" rule in
 * core-data-merge-registry.js). Impact is bounded: reviews.json/shows.json
 * (NEVER_FALLBACK) ride the same commit on most runs, so the fallback is
 * already unavailable there. Register an entry (then delete it here) or
 * split the step to burn one down. A NEW unregistered write is NOT allowed.
 */
const BASELINE = new Set([
  'check-show-freshness.yml|data/audit/london-only-nyc-accumulation.json',
  'check-show-freshness.yml|data/audit/same-url-duplicate-baseline.json',
  'check-show-freshness.yml|data/audit/tony-coverage-gaps.json',
  'check-show-freshness.yml|data/audit/url-mismatch-suspects.json',
  'check-show-freshness.yml|data/audit/validation-baseline.json',
  'commercial-friday.yml|data/audit/url-mismatch-suspects.json',
  'commercial-rss-poll.yml|data/audit/url-mismatch-suspects.json',
  'commercial-weekly.yml|data/audit/url-mismatch-suspects.json',
  'fetch-all-image-formats.yml|data/audit/existing-image-audit.json',
  'fetch-all-image-formats.yml|data/audit/image-search-attempts.json',
  'fetch-all-image-formats.yml|data/audit/suspect-duplicate-images.json',
  'fetch-all-image-formats.yml|data/audit/url-mismatch-suspects.json',
  'review-refresh.yml|data/audit/cross-show-fingerprint-collisions.json',
  'review-refresh.yml|data/audit/market-misroutes.json',
  'review-refresh.yml|data/audit/phantom-outlets-report.json',
  'review-refresh.yml|data/audit/rebuild-regression.json',
  'review-refresh.yml|data/audit/rebuild-show-drift.json',
  'review-refresh.yml|data/audit/recover-ratings-report.json',
  'review-refresh.yml|data/audit/recover-ratings-state.json',
  'review-refresh.yml|data/audit/skipped-alias-collisions.json',
  'review-refresh.yml|data/audit/stage-latency.jsonl',
  'review-refresh.yml|data/audit/url-mismatch-suspects.json',
  'scrape-aggregators.yml|data/audit/market-misroutes.json',
  'scrape-westendtheatre.yml|data/audit/url-mismatch-suspects.json',
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
    const hasSweep = (s) => (s.runText || '').split('\n').some((l) => !l.trimStart().startsWith('#') && isBlanketSweepLine(l));
    let sweepIdx = -1;
    job.steps.forEach((s, i) => { if (hasSweep(s)) sweepIdx = i; }); // LAST sweep: covers every earlier step
    if (sweepIdx < 0) continue;
    for (const step of job.steps.slice(0, sweepIdx + 1)) {
      const run = step.runText || '';
      const exempt = new Set([...run.matchAll(/#\s*blanket-sweep-audit-ok:\s*(data\/audit\/[\w.-]+)/g)].map((x) => x[1]));
      const sources = new Map(); // path -> origin
      for (const p of inlineAuditFiles(run)) sources.set(p, 'inline');
      for (const sc of findInvokedScripts(run)) {
        for (const p of auditFilesWrittenByWithLibs(sc, readSrc)) if (!sources.has(p)) sources.set(p, sc);
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

module.exports = { BASELINE, auditFilesWrittenBy, auditFilesWrittenByWithLibs, inlineAuditFiles, auditBlanketSweeps, auditAllWorkflows };
