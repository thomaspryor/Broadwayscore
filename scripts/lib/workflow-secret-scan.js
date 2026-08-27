/**
 * Pure parsing/analysis functions for scripts/audit-workflow-secret-gaps.js
 * (task #1855). Split out so tests/unit/*.test.mjs can require() the real
 * logic instead of re-deriving it (CLAUDE.md rule 15).
 *
 * ## Workflow YAML parsing
 * GitHub Actions workflow YAML in this repo is plain block-style (no flow
 * collections, no anchors, consistent indentation) — a full YAML parser is
 * overkill and this repo's other audit-*.js scripts deliberately avoid
 * adding a js-yaml dependency (see scripts/audit-workflow-concurrency.js
 * header). `groupByMinIndent` instead exploits one structural invariant of
 * valid block YAML: within any contiguous line range, a key's DIRECT
 * children always sit at the range's minimum indentation (nested values are
 * always indented deeper than their own key line). Recursing on that one
 * rule handles arbitrary nesting depth for both mappings (`key: value`) and
 * sequences (`- item`) without needing to know which one it is in advance.
 *
 * ## Require-chain tracing
 * Unlike scripts/audit-test-yml-lib-deps.js (deliberately ONE hop), this
 * walks the FULL transitive closure of local require()s, bounded by
 * maxFiles. The motivating bug (task #1855, BRO-67) needed 3 hops:
 * opening-night-checklist.js -> lib/opening-night-checks/index.js ->
 * (dynamic per-file require) -> lib/opening-night-checks/*.check.js ->
 * lib/llm-extractor.js, which reads ANTHROPIC_API_KEY. One hop would have
 * missed it entirely.
 *
 * `index.js`'s loader is itself dynamic — it lists the directory with
 * fs.readdirSync, then require()s each matching filename by joining it back
 * onto that same directory — which a static require() regex can't see.
 * `DYNAMIC_DIR_GLOB_RE` special-cases that exact shape (readdirSync of a
 * variable, then require(path.join(sameVariable, ...)) nearby) and pulls in
 * every sibling .js file in that directory as an additional edge. This is a
 * narrow heuristic for one real pattern, not a general dynamic-require
 * solver — other dynamic-require shapes will still be missed (false
 * negative, acceptable for an advisory check).
 *
 * Over-approximation is the accepted tradeoff of full transitive closure:
 * a deep call graph can pull in a lib that reads a secret behind a branch
 * this particular workflow's script never actually reaches, producing a
 * false-positive gap. Suppress a specific one with a
 * `# audit-secret-gap-ok: SECRET_NAME` comment anywhere in the workflow file.
 *
 * Known false-negative (second-opinion review, task #1855): `extractEnvReads`
 * only matches string-literal keys (dot access, bracket access with a quoted
 * literal, or destructuring). A COMPUTED key — `process.env[someVar]`,
 * e.g. `scripts/collect-review-texts.js`'s per-outlet credential lookup
 * (`process.env[creds.emailVar]`) — is invisible to this scan. That is
 * exactly the shape most likely to recur as a BRO-67-class silent no-op
 * (a missing login secret degrading gracefully), so a workflow relying only
 * on a clean report from this audit for a script using computed env keys is
 * not actually covered. Left unresolved rather than guessed at: reliably
 * resolving an arbitrary computed key back to its possible string values
 * needs real static analysis, not a regex.
 *
 * Second known false-negative (ship-check review, task #1855): a step that
 * invokes a script indirectly via `npm run <script-name>` (resolved through
 * package.json's `scripts` map) is invisible to `extractScriptInvocations`,
 * which only matches literal `node`/`npx tsx`/`npx ts-node` invocations. No
 * current workflow calls a secret-reading script this way (checked at
 * introduction), but it is an undocumented blind spot in exactly the shape
 * of script this tool exists to cover — worth resolving `npm run` through
 * package.json if a workflow ever adopts that style for one of these.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RESOLVE_CANDIDATES = ['', '.js', '.mjs', '.cjs', '.ts', '.json', '/index.js', '/index.ts'];
const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
// `fs\.` is a deliberately load-bearing prefix, not cosmetic: without it this
// pattern is a quine — it textually matches ITS OWN definition line below
// (the regex source text contains "readdirSync\s*\(\s*(...)" immediately
// followed by "require\(\s*path\.join\(\s*\1\s*,", which is exactly what the
// bare pattern looks for). That made collectTransitiveSource treat this
// file's own directory (scripts/lib/, ~300 files) as a dependency of ITSELF
// on every run, silently defeating buildRequirerCounts' shared-module
// filter for any script requiring this file (ship-check finding, task
// #1855 — confirmed live: scripts/audit-workflow-secret-gaps.js was
// wrongly flagged as reading IMPACT_*/POSTHOG_*/PARTNERIZE_* secrets it has
// no relation to, pulled in purely via this false self-match). Requiring
// the `fs.` call-site prefix matches how every real loader in this repo
// actually writes it (`fs.readdirSync(CHECKS_DIR)` in
// opening-night-checks/index.js) while no longer matching the regex
// literal's own un-prefixed source text.
const DYNAMIC_DIR_GLOB_RE = /fs\.readdirSync\s*\(\s*([A-Za-z_$][\w$]*)\s*\)[\s\S]{0,400}?require\(\s*path\.join\(\s*\1\s*,/;
const ENV_DOT_RE = /process\.env\.([A-Z][A-Z0-9_]*)\b/g;
const ENV_BRACKET_RE = /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;
const ENV_DESTRUCTURE_RE = /const\s*\{([^}]+)\}\s*=\s*process\.env/g;
const SCRIPT_INVOKE_RE = /(?:^|[\s;&|])(?:node|npx\s+ts-node|npx\s+tsx)\s+((?:-[\w-]+(?:[= ]\S+)?\s+)*)([\w./-]+\.(?:js|mjs|cjs|ts))\b/g;
const SECRET_REF_RE = /\$\{\{\s*secrets(?:\.([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])\s*\}\}/g;
const EXEMPT_RE = /#\s*audit-secret-gap-ok:\s*([A-Z0-9_]+)/g;

// --- Line/indent utilities -------------------------------------------------

function toLines(raw) {
  return raw.split('\n').map((text) => {
    const indent = text.match(/^(\s*)/)[1].length;
    return { raw: text, indent, trimmed: text.trim() };
  });
}

function isContent(l) {
  return l.trimmed !== '' && !l.trimmed.startsWith('#');
}

/** Groups a line range into direct children by minimum indentation. */
function groupByMinIndent(blockLines) {
  const contentIdx = [];
  for (let i = 0; i < blockLines.length; i++) {
    if (isContent(blockLines[i])) contentIdx.push(i);
  }
  if (contentIdx.length === 0) return [];
  const minIndent = Math.min(...contentIdx.map((i) => blockLines[i].indent));
  const siblingIdx = contentIdx.filter((i) => blockLines[i].indent === minIndent);
  const children = [];
  for (let s = 0; s < siblingIdx.length; s++) {
    const start = siblingIdx[s];
    const end = s + 1 < siblingIdx.length ? siblingIdx[s + 1] : blockLines.length;
    children.push({ keyLine: blockLines[start], bodyLines: blockLines.slice(start + 1, end) });
  }
  return children;
}

function asMapping(child) {
  const m = child.keyLine.trimmed.match(/^([^\s:#][^:]*):\s*(.*)$/);
  if (!m) return null;
  return { key: m[1].trim(), inline: m[2].trim(), bodyLines: child.bodyLines };
}

/** Interprets a `- ...` sequence item as a mapping of its own fields. */
function asSequenceItemFields(child) {
  const m = child.keyLine.raw.match(/^(\s*)-(\s+)(.*)$/);
  if (!m) return [];
  const [, dashIndentStr, gap, inline] = m;
  const dashIndent = dashIndentStr.length;
  const combined = [];
  if (inline.trim() !== '') {
    combined.push({
      raw: ' '.repeat(dashIndent + 1 + gap.length) + inline,
      indent: dashIndent + 1 + gap.length,
      trimmed: inline.trim(),
    });
  }
  combined.push(...child.bodyLines);
  return groupByMinIndent(combined).map(asMapping).filter(Boolean);
}

function findMappingChild(fields, keyName) {
  return fields.find((f) => f.key === keyName) || null;
}

function collectEnvKeys(envField) {
  if (!envField) return new Set();
  const children = groupByMinIndent(envField.bodyLines).map(asMapping).filter(Boolean);
  return new Set(children.map((c) => c.key));
}

function collectRunText(runField) {
  if (!runField) return '';
  const inline = runField.inline;
  if (inline && !inline.startsWith('|') && !inline.startsWith('>')) return inline;
  return runField.bodyLines.map((l) => l.raw).join('\n');
}

/**
 * Parses one workflow YAML file into { workflowEnv, jobs }, where each job
 * is { name, env, steps }, and each step is { name, run, env }.
 */
function parseWorkflowFile(raw) {
  const lines = toLines(raw);
  const rootFields = groupByMinIndent(lines).map(asMapping).filter(Boolean);
  const workflowEnv = collectEnvKeys(findMappingChild(rootFields, 'env'));

  const jobsField = findMappingChild(rootFields, 'jobs');
  const jobs = [];
  if (jobsField) {
    const jobChildren = groupByMinIndent(jobsField.bodyLines).map(asMapping).filter(Boolean);
    for (const jobEntry of jobChildren) {
      const jobFields = groupByMinIndent(jobEntry.bodyLines).map(asMapping).filter(Boolean);
      const jobEnv = collectEnvKeys(findMappingChild(jobFields, 'env'));
      const stepsField = findMappingChild(jobFields, 'steps');
      const steps = [];
      if (stepsField) {
        for (const stepChild of groupByMinIndent(stepsField.bodyLines)) {
          const stepFields = asSequenceItemFields(stepChild);
          const nameField = findMappingChild(stepFields, 'name');
          steps.push({
            name: nameField ? nameField.inline : '(unnamed step)',
            run: collectRunText(findMappingChild(stepFields, 'run')),
            env: collectEnvKeys(findMappingChild(stepFields, 'env')),
          });
        }
      }
      jobs.push({ name: jobEntry.key, env: jobEnv, steps });
    }
  }
  return { workflowEnv, jobs };
}

// --- Script invocation + require-chain tracing -----------------------------

/** Extracts `node scripts/x.js`-style invocations from a run: block's text. */
function extractScriptInvocations(runText) {
  const scripts = new Set();
  let m;
  const re = new RegExp(SCRIPT_INVOKE_RE);
  while ((m = re.exec(runText))) scripts.add(m[2]);
  return [...scripts];
}

function resolveModulePath(fromDir, relOrRootedPath) {
  const base = path.isAbsolute(relOrRootedPath)
    ? path.normalize(relOrRootedPath)
    : path.normalize(path.join(fromDir, relOrRootedPath));
  for (const suffix of RESOLVE_CANDIDATES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Local (non-package) require()/import specifiers, plus the dynamic
 * same-directory glob-require heuristic described in the file header. */
function extractLocalDeps(source, fileAbsPath) {
  const fileDir = path.dirname(fileAbsPath);
  const specs = new Set();
  let m;
  const reReq = new RegExp(REQUIRE_RE);
  while ((m = reReq.exec(source))) specs.add(m[1]);
  const reImp = new RegExp(IMPORT_RE);
  while ((m = reImp.exec(source))) specs.add(m[1]);

  const resolved = new Set();
  for (const spec of specs) {
    const abs = resolveModulePath(fileDir, spec);
    if (abs) resolved.add(abs);
  }

  if (DYNAMIC_DIR_GLOB_RE.test(source)) {
    try {
      for (const f of fs.readdirSync(fileDir)) {
        if (!/\.(js|mjs|cjs|ts)$/.test(f)) continue;
        const abs = path.join(fileDir, f);
        if (abs !== fileAbsPath) resolved.add(abs);
      }
    } catch {
      // directory not readable — skip the heuristic, static requires still counted
    }
  }
  return [...resolved];
}

/**
 * Counts, for every local .js/.ts/.mjs/.cjs file under `rootDir`, how many
 * DISTINCT other files require() it — a reverse-dependency index used to
 * detect "shared infra" modules (scraper.js's fetchPage() fallback chain,
 * llm-score-extractor.js's model fallback, discord-notify.js, etc.).
 *
 * Why this matters: this codebase's documented architecture leans heavily
 * on graceful multi-provider degradation (memory/feedback_scraper_architecture.md's
 * fetchPage() chain, the LLM ensemble's "3->2->1 model fallback" in
 * llm-ensemble-score.yml's own docs, owner-alert-router for Discord/email).
 * A script pulling in one of these for a single helper function does NOT
 * need every provider secret simultaneously — that's the intended, working
 * behavior, not the BRO-67 bug class (a hard, no-fallback dependency that
 * silently no-ops with nothing to fall back to). Confirmed empirically:
 * before this exclusion, tracing scripts/validate-data.js alone produced
 * ~150 false-positive gap lines, entirely from scraper.js's provider
 * secrets reached 2 hops down through an unrelated helper import.
 *
 * Rather than hand-maintain a list of which specific files are "shared
 * infra" (brittle, silently stale as the codebase grows), this counts real
 * reuse: a file required by many independent call sites is registering
 * itself as ambient infrastructure, and its own secret reads cannot be
 * meaningfully attributed to any ONE workflow's specific responsibility.
 * scripts/lib/llm-extractor.js (the actual BRO-67 culprit) is required by
 * only 4 files — well under SHARED_MODULE_THRESHOLD — so it is correctly
 * traced through, not treated as shared infra.
 */
function buildRequirerCounts(rootDir) {
  const counts = new Map(); // depAbsPath -> Set<requirerAbsPath>
  const stack = [rootDir];
  const files = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(js|mjs|cjs|ts)$/.test(entry.name) && !entry.name.includes('.test.')) files.push(full);
    }
  }
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const dep of extractLocalDeps(src, f)) {
      if (!counts.has(dep)) counts.set(dep, new Set());
      counts.get(dep).add(f);
    }
  }
  return counts;
}

const SHARED_MODULE_THRESHOLD = 5;

/** BFS over the local require graph, bounded by maxFiles, returns combined
 * source text of every file visited (entry file included). A dependency
 * (never the entry file itself) required by more than SHARED_MODULE_THRESHOLD
 * distinct files repo-wide is treated as shared infra — excluded entirely,
 * its own deps not followed — per buildRequirerCounts's doc comment above. */
function collectTransitiveSource(entryAbsPath, { maxFiles = 60, requirerCounts = null } = {}) {
  const visited = new Set();
  const queue = [entryAbsPath];
  const chunks = [];
  while (queue.length && visited.size < maxFiles) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (requirerCounts && cur !== entryAbsPath) {
      const requirers = requirerCounts.get(cur);
      if (requirers && requirers.size > SHARED_MODULE_THRESHOLD) continue;
    }
    let src;
    try {
      src = fs.readFileSync(cur, 'utf8');
    } catch {
      continue;
    }
    chunks.push(src);
    for (const dep of extractLocalDeps(src, cur)) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return chunks.join('\n');
}

/** Dot access, quoted bracket access, and destructured `process.env` reads. */
function extractEnvReads(source) {
  const reads = new Set();
  let m;
  const reDot = new RegExp(ENV_DOT_RE);
  while ((m = reDot.exec(source))) reads.add(m[1]);
  const reBracket = new RegExp(ENV_BRACKET_RE);
  while ((m = reBracket.exec(source))) reads.add(m[1]);
  const reDestructure = new RegExp(ENV_DESTRUCTURE_RE);
  while ((m = reDestructure.exec(source))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':')[0].trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) reads.add(name);
    }
  }
  return reads;
}

/** Every secret name referenced anywhere via the secrets context (dot or
 * quoted-bracket form) across the given workflow file contents — the
 * universe of things this repo treats as "a secret" worth flagging when a
 * script reads it but a step never provides it. Restricting to this set
 * (rather than flagging any missing env var) avoids noise on ambient/
 * non-secret vars (CI, HOME, repo `vars.*`, etc.). */
function collectKnownSecrets(workflowRawContents) {
  const known = new Set();
  for (const raw of workflowRawContents) {
    let m;
    const re = new RegExp(SECRET_REF_RE);
    while ((m = re.exec(raw))) known.add(m[1] || m[2]);
  }
  return known;
}

/** `# audit-secret-gap-ok: SECRET_NAME` anywhere in a workflow file
 * suppresses that secret for the whole file (matches this repo's
 * `# hygiene-*-ok:` exemption convention). */
function collectExemptions(raw) {
  const exempt = new Set();
  let m;
  const re = new RegExp(EXEMPT_RE);
  while ((m = re.exec(raw))) exempt.add(m[1]);
  return exempt;
}

module.exports = {
  parseWorkflowFile,
  groupByMinIndent,
  asMapping,
  asSequenceItemFields,
  extractScriptInvocations,
  resolveModulePath,
  extractLocalDeps,
  buildRequirerCounts,
  collectTransitiveSource,
  extractEnvReads,
  collectKnownSecrets,
  collectExemptions,
};
