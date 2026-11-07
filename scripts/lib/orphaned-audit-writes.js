/**
 * Pure helpers for scripts/audit-orphaned-audit-writes.js (BRO-2420).
 *
 * Finds scripts that write data/audit/<file> but whose invoking workflow never
 * `git add`s that file, so the write is silently discarded at job end (the
 * BRO-182 failure: update-show-status.yml never staged ob-venue-candidates.json).
 */
'use strict';

const WRITE_CALL = /\b(writeFileSync|appendFileSync|writeFile|appendFile|writeJsonSync|writeJson|atomicWrite\w*|writeAtomic\w*)\s*\(/;
const AUDIT_LITERAL = /data\/audit\/([A-Za-z0-9_.-]+\.(?:jsonl?|txt|md|csv))/g;
const AUDIT_JOIN = /['"]data['"]\s*,\s*['"]audit['"]\s*,\s*['"]([A-Za-z0-9_.-]+\.(?:jsonl?|txt|md|csv))['"]/g;
const AUDIT_JOIN_SHORT = /['"]audit['"]\s*,\s*['"]([A-Za-z0-9_.-]+\.(?:jsonl?|txt|md|csv))['"]/g;

// Gate workflows run hundreds of scripts read-only (a 7000-line job file cannot be
// matched per job), so their basename mentions are not "this workflow persists it".
const GATE_WORKFLOWS = ['test.yml', 'check-corpus-drift.yml'];

const AUDIT_DIR_JOIN = /\b\w*AUDIT_?DIR\w*\s*,\s*['"]([A-Za-z0-9_.-]+\.(?:jsonl?|txt|md|csv))['"]/gi;

/** Audit files a script source writes (file-level heuristic: needs a write call + a literal path). */
function extractAuditWrites(source) {
  if (!WRITE_CALL.test(source)) return [];
  // Drop line comments so documentation mentions do not count.
  const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
  const found = new Set();
  for (const re of [AUDIT_LITERAL, AUDIT_JOIN, AUDIT_JOIN_SHORT, AUDIT_DIR_JOIN]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) found.add(`data/audit/${m[1]}`);
  }
  return [...found].sort();
}

/**
 * Every pathspec a workflow stages: `git add` args plus the repo's staging
 * helpers (continuations joined, flags dropped). git-add-existing.sh <paths>
 * stages its args; stage-data-changes.sh stages its args, or all of data/
 * when called bare (BRO-5261 retro-review: 24 of 131 baseline rows were
 * files staged through git-add-existing.sh).
 */
function extractGitAddSpecs(yaml) {
  const text = yaml.replace(/\\\r?\n\s*/g, ' ');
  const specs = [];
  const re = /(?:git\s+add|scripts\/lib\/(git-add-existing|stage-data-changes)\.sh)([^\n;&|]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const cmd = [];
    let catchAll = false;
    for (const raw of m[2].split(/\s+/)) {
      const tok = raw.replace(/^['"]|['"]$/g, '');
      if (!tok) continue;
      if (tok.startsWith('2>') || tok.startsWith('>') || tok.startsWith('||')) break;
      if (tok === '-A' || tok === '--all') { catchAll = true; continue; }
      if (tok.startsWith('-') || tok.startsWith(':!') || tok.startsWith(':(exclude)')) continue;
      cmd.push(tok);
    }
    // `git add -A <pathspec>` stages only the pathspec; bare -A stages everything.
    if (!cmd.length && catchAll) specs.push('-A');
    else if (!cmd.length && m[1] === 'stage-data-changes') specs.push('data/');
    else specs.push(...cmd);
  }
  return specs;
}

function stripComments(yaml) {
  return yaml.replace(/^\s*#.*$/gm, '').replace(/\s#\s[^"'\n]*$/gm, '');
}

/** A real `git commit` command at line start (not an echo or --amend hint). */
function commitsDirectly(yaml) {
  return /(?:^|\|\||&&|;|\bif\b|\bthen\b|run:)\s*(?:-\s+)?(?:[\w./-]+=\S*\s+)*git\s+(?:-c\s+\S+\s+)*commit\b(?![^\n]*--amend)/m.test(yaml);
}

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}

/** True when one git-add pathspec stages `file`. */
function specCovers(spec, file) {
  if (spec === '-A' || spec === '.' || spec === 'data' || spec === ':/') return true;
  const s = spec.replace(/^\.\//, '');
  if (s === file) return true;
  if (s.endsWith('/')) return file.startsWith(s);
  if (/[*?]/.test(s)) return globToRegex(s).test(file);
  return file.startsWith(`${s}/`);
}

function workflowStages(yaml, file) {
  return extractGitAddSpecs(yaml).some((s) => specCovers(s, file));
}

function workflowInvokes(yaml, scriptRel) {
  const base = scriptRel.replace(/^scripts\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A bare basename must not be preceded by '/': scripts/tests/foo.js is not scripts/foo.js.
  return new RegExp(`(^|[^\\w./-])(?:\\./)?(?:\\S*scripts/)?${base}(?![\\w.-])`, 'm').test(yaml);
}

/**
 * scripts: {rel: source}; workflows: {name: yaml}; exempt: {"script|file": reason}.
 * Returns orphaned writes: invoked by >=1 workflow, staged by none of them.
 */
function findOrphanedWrites(scripts, workflows, exempt = {}, gateWorkflows = GATE_WORKFLOWS) {
  const out = [];
  // Only workflows that commit can lose a write by not staging it. Parsed once.
  const committing = Object.entries(workflows)
    .filter(([n]) => !gateWorkflows.some((g) => n.endsWith(`/${g}`) || n === g))
    .map(([n, y]) => [n, stripComments(y)])
    .filter(([, y]) => commitsDirectly(y))
    .map(([n, y]) => ({ name: n, yaml: y, specs: extractGitAddSpecs(y) }));
  for (const [rel, source] of Object.entries(scripts)) {
    const files = extractAuditWrites(source);
    if (!files.length) continue;
    const invokers = committing.filter((w) => workflowInvokes(w.yaml, rel));
    if (!invokers.length) continue;
    for (const file of files) {
      if (exempt[`${rel}|${file}`]) continue;
      if (invokers.some((w) => w.specs.some((sp) => specCovers(sp, file)))) continue;
      out.push({ script: rel, file, workflows: invokers.map((w) => w.name).sort() });
    }
  }
  return out.sort((a, b) => (a.script + a.file).localeCompare(b.script + b.file));
}

module.exports = { extractAuditWrites, extractGitAddSpecs, specCovers, workflowStages, workflowInvokes, stripComments, findOrphanedWrites };
