'use strict';
/**
 * Drift detector for scripts/lib/core-data-merge-registry.js's
 * `apiFallbackSafe` entries (task: data-health-check.yml push-race
 * hardening, session 2026-08-22, plan-reviewed).
 *
 * WHAT THIS CHECKS
 * -----------------
 * push-with-retry.sh's Git Data API fallback disqualifier grants a live
 * "ours wins outright" bypass to any `data/audit/*` path registered with
 * `apiFallbackSafe: true`. That grant is only safe if the entry's claim —
 * "exactly one workflow writes this file, and its own concurrency group
 * prevents that workflow from racing itself" — stays true over time. This
 * module re-derives the claim from the real workflow files and flags drift:
 * a second writer appearing (e.g. a new cron copy-pasting an existing `git
 * add` line) is exactly the failure class a plan-review pre-mortem and the
 * structure reviewer both flagged (task's own plan-review record).
 *
 * HINT ONLY, NEVER AUTHORITATIVE (Codex/gpt-5.4-mini + Gemini plan-review
 * finding). Static regex matching over workflow YAML text has real blind
 * spots — a writer reached only through a shared helper script whose
 * invocation doesn't literally contain the target path string, or a
 * dynamically-constructed path, is invisible here. A PASS from this module
 * does NOT certify a NEW entry as safe to add — only a human, grepping and
 * reading the actual workflow logic (the same bar `verifiedBy` documents),
 * does that. A FAIL/gap from this module on an EXISTING entry is the
 * actionable signal: it means the registry's claim needs re-verification
 * before the next push relies on it — remove `apiFallbackSafe: true` from
 * the entry (or fix `concurrencyGroup`) once confirmed, matching how
 * `deferredReason` documents a `'deferred'` status is a deliberate parked
 * decision, not a silent gap.
 *
 * Pure functions only (project rule §15) — no fs reads here. The colocated
 * test (api-fallback-writer-drift.test.mjs) supplies both synthetic
 * fixtures (proving the concurrencyGroup escape hatch doesn't false-positive
 * the way a naive "2+ writers = gap" rule would on the grosses.json shape)
 * and a live-repo assertion (reading the real workflow files) that the
 * actual registered entries still hold.
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `for f in data/audit/a.json data/audit/b.json; do ... git add "$f" ...;
// done` — the loop-staged idiom used across ~9 real workflows (BRO-3071:
// same blind spot scripts/lib/audit-push-retry-budgets.js's own
// extractLoopStagedPaths already closed for its sibling tool — e.g.
// audit-aggregator-gap.yml, audit-critic-coverage.yml, monitor-gate-ab.yml,
// coverage-adversarial-probe.yml, check-arm-yield.yml, send-follow-
// notifications.yml, check-cron-health.yml). Without this, findWritingWorkflows
// only ever sees the loop VARIABLE on the `git add "$f"` line itself (which
// pathTokensFrom-style matching can't resolve to a literal path), so every
// apiFallbackSafe entry staged this way false-negatived the live-repo
// regression test in api-fallback-writer-drift.test.mjs even though it was a
// real, hand-verified single writer. Gated on the loop body actually
// referencing `git add ... $VAR` for the SAME loop variable so an unrelated
// for-loop's arguments are never misattributed as staged paths. Does not
// handle nested loops (finds the first `done` after the loop body starts) —
// no such shape exists in this repo's push-staging loops today.
function loopStagesBasename(text, basename) {
  const forRe = /for\s+(\w+)\s+in\s+([\s\S]*?);\s*do\b/g;
  let m;
  while ((m = forRe.exec(text))) {
    const varName = m[1];
    const listText = m[2].replace(/\\\s*\n/g, ' ');
    const bodyStart = forRe.lastIndex;
    const doneIdx = text.indexOf('\ndone', bodyStart);
    const body = text.slice(bodyStart, doneIdx === -1 ? text.length : doneIdx);
    const addsVar = new RegExp(`git\\s+add\\b[^\\n]*\\$\\{?${escapeRegExp(varName)}\\}?\\b`).test(body);
    if (!addsVar) continue;
    const pathRe = new RegExp(`(?:^|[\\s"'])data/${escapeRegExp(basename)}(?:[\\s"']|$)`);
    if (pathRe.test(listText)) return true;
  }
  return false;
}

/**
 * Workflow files (by name) whose text contains a `git add`/`git-add-
 * existing.sh` reference to `data/<basename>`. Matches the three real
 * staging shapes seen across this repo's workflows: an inline `git add
 * data/audit/foo.json`, the shared `bash scripts/lib/git-add-existing.sh
 * ... data/audit/foo.json ...` helper, and the loop-staged `for f in
 * data/audit/foo.json ...; do git add "$f"; done` idiom (see
 * loopStagesBasename above).
 *
 * @param {string} dataPath repo-relative path, e.g. 'data/audit/foo.json'
 * @param {Record<string,string>} workflowTexts {filename: raw yaml text}
 * @returns {string[]} workflow filenames that write this path, in
 *   Object.entries iteration order (insertion order of workflowTexts)
 */
function findWritingWorkflows(dataPath, workflowTexts) {
  const basename = dataPath.replace(/^data\//, '');
  // `(?:[^\n]|\\\n)*` — the command may continue across backslash-newline
  // line continuations (`git-add-existing.sh \` + one pathspec per line), the
  // shape check-opening-night-drift.yml adopted in BRO-3455 (2026-09-15); the
  // single-line scan then reported its drift-state.json writer as missing
  // and reddened main on this very guard.
  if (basename.endsWith('/*.json')) return findDirPatternWriters(basename.slice(0, -'*.json'.length), workflowTexts);
  const re = new RegExp(`(?:git add|git-add-existing\\.sh)(?:[^\\n]|\\\\\\n)*\\bdata/${escapeRegExp(basename)}\\b`);
  const writers = [];
  for (const [wfFile, text] of Object.entries(workflowTexts || {})) {
    if (re.test(text) || loopStagesBasename(text, basename)) writers.push(wfFile);
  }
  return writers;
}

/**
 * Writers of a `dir/*.json` registry entry (BRO-6615, audit/press-night/*.json).
 * Such files are staged through a variable built from the directory
 * (`F="data/audit/press-night/${SHOW_ID}-${NIGHT}.json"; git add "$F"`), so a
 * workflow counts as a writer when a `git add` names the directory directly,
 * or a variable assigned a value under it is later passed to `git add`.
 */
function findDirPatternWriters(dir, workflowTexts) {
  const dirRe = escapeRegExp(`data/${dir}`);
  const direct = new RegExp(`(?:git add|git-add-existing\\.sh)(?:[^\\n]|\\\\\\n)*${dirRe}`);
  const assignRe = new RegExp(`\\b(\\w+)=["']?${dirRe}`, 'g');
  const writers = [];
  for (const [wfFile, text] of Object.entries(workflowTexts || {})) {
    let hit = direct.test(text);
    for (const m of hit ? [] : String(text).matchAll(assignRe)) {
      if (new RegExp(`git\\s+add\\b[^\\n]*\\$\\{?${escapeRegExp(m[1])}\\}?\\b`).test(text)) { hit = true; break; }
    }
    if (hit) writers.push(wfFile);
  }
  return writers;
}

/**
 * A workflow's own top-level `concurrency.group:` value, or null if absent
 * or effectively non-serializing.
 *
 * A group templated on `github.run_id` (or similar per-run tokens) is
 * unique to every single invocation — it can never actually serialize two
 * runs of the same workflow against each other, so it does not count as
 * real protection even though the YAML key is present.
 *
 * @param {string} yamlText raw workflow file contents
 * @returns {string|null}
 */
function extractConcurrencyGroup(yamlText) {
  const m = /^concurrency:[^\S\n]*\n[^\S\n]*group:[^\S\n]*([^\n#]+)/m.exec(String(yamlText || ''));
  if (!m) return null;
  const group = m[1].trim();
  if (!group) return null;
  if (/run_id/.test(group)) return null;
  return group;
}

/**
 * Check one apiFallbackSafe registry entry against real workflow text.
 *
 * @param {{file:string, concurrencyGroup?:string}} entry a
 *   CORE_DATA_MERGE_REGISTRY entry with `apiFallbackSafe: true`; `file` is
 *   the bare (no `data/` prefix) path as stored in the registry
 * @param {Record<string,string>} workflowTexts {filename: raw yaml text}
 * @returns {{ok:boolean, writers:string[], reason?:string, groups?:(string|null)[]}}
 */
function checkEntry(entry, workflowTexts) {
  const dataPath = `data/${entry.file}`;
  const writers = findWritingWorkflows(dataPath, workflowTexts);

  if (writers.length === 0) {
    return {
      ok: false,
      writers,
      reason: 'no writer found via static git-add scan — path may have moved, or is written only through a dynamic/helper call this check cannot see (re-verify by hand, do not assume safe)',
    };
  }
  if (writers.length === 1) return { ok: true, writers };

  // 2+ writers is only a non-gap when EVERY writer declares the SAME
  // concurrency group as the entry's own claim — the grosses.json shape
  // (two writers, mutually exclusive via a shared group), not a true
  // single writer. This is the escape hatch a naive "2+ writers = gap"
  // rule would miss, and the plan-review design reviewer's finding this
  // module exists to not repeat.
  const groups = writers.map((w) => extractConcurrencyGroup(workflowTexts[w]));
  const allMatchClaimed = entry.concurrencyGroup && groups.every((g) => g === entry.concurrencyGroup);
  if (allMatchClaimed) return { ok: true, writers, groups };

  return {
    ok: false,
    writers,
    groups,
    reason: `${writers.length} writers found; not all share the claimed concurrencyGroup '${entry.concurrencyGroup}' (found: ${groups.map((g) => g || '(none)').join(', ')})`,
  };
}

// ── BRO-3514: private-core-data writers ────────────────────────────────────
// findWritingWorkflows() above finds PUBLIC-repo writers by their `git add`.
// A private-core-data file never gets a `git add`: a workflow writes it with
// some script and the push-core-data action syncs every CORE_FILES entry that
// changed. So a writer here is a workflow that (a) uses
// ./.github/actions/push-core-data and (b) runs a scripts/ .js/.ts file whose source,
// or a ./lib module it requires (2 levels), calls a write function on a line
// naming the file, or on a line using a const bound to a path naming it.
// Same posture as above: a HINT. It misses writes through helpers that build
// the path elsewhere (registry entries say so with writersUnverifiable) and
// is reported by an advisory audit, never a blocking gate.
const WRITE_CALL = /\b(?:writeFileSync|writeJsonAtomic|atomicWrite\w*|writeJson\w*|safeWrite\w*|renameSync)\s*\(/;
const USES_PUSH_CORE_DATA = /uses:\s*\.\/\.github\/actions\/push-core-data\b/;

function sourceWritesBasename(file, basename, readFile, seen = new Set(), depth = 0) {
  if (seen.has(file) || depth > 2) return false;
  seen.add(file);
  const src = readFile(file);
  if (!src) return false;
  const lit = new RegExp(`['"\`/]${escapeRegExp(basename)}['"\`]`);
  const lines = src.split('\n');
  const bound = new Set();
  for (const line of lines) {
    // Only a PATH binding (`= path.join(...)`, `= path.resolve(...)` or a
    // string literal), never `= JSON.parse(readFileSync('...x.json'))`, which
    // binds the file's CONTENT and would make every later write a "writer".
    const m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.(?:join|resolve)\(|['"`])/.exec(line);
    if (m && lit.test(line)) bound.add(m[1]);
  }
  for (const line of lines) {
    if (!WRITE_CALL.test(line)) continue;
    if (lit.test(line)) return true;
    for (const name of bound) if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line)) return true;
  }
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    let rel = normalizePath(`${dir}/${m[1]}`);
    if (!/\.(?:(?:c|m)?js|ts)$/.test(rel)) rel += '.js';
    if (sourceWritesBasename(rel, basename, readFile, seen, depth + 1)) return true;
  }
  return false;
}

function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

/**
 * Workflows that write a private-core-data file (see above).
 * @param {string} basename registry `file`, e.g. 'critic-consensus.json'
 * @param {Record<string,string>} workflowTexts {filename: raw yaml text}
 * @param {(repoRelPath:string)=>string|null} readFile source reader (null if absent)
 * @returns {Record<string,string[]>} workflow -> the scripts that write it
 */
function findCoreDataWriters(basename, workflowTexts, readFile) {
  const out = {};
  for (const [wf, text] of Object.entries(workflowTexts || {})) {
    if (!USES_PUSH_CORE_DATA.test(text)) continue;
    const scripts = [...new Set([...String(text).matchAll(/\bscripts\/[\w./-]+\.(?:(?:c|m)?js|ts)\b/g)].map((m) => m[0]))];
    const hits = scripts.filter((sp) => sourceWritesBasename(sp, basename, readFile));
    if (hits.length) out[wf] = hits;
  }
  return out;
}

/**
 * Compare derived writers to a private-core-data single-writer entry's claim.
 * @returns {{status:'ok'|'drift'|'unverifiable'|'undeclared', derived:string[], undeclared:string[], reason?:string}}
 */
function checkCoreDataEntry(entry, derivedWriters, workflowTexts) {
  const derived = Object.keys(derivedWriters).sort();
  if (!Array.isArray(entry.writers)) {
    return { status: 'undeclared', derived, undeclared: derived, reason: 'entry has no `writers: [...]` list to check against' };
  }
  const undeclared = derived.filter((w) => !entry.writers.includes(w));
  if (undeclared.length) {
    return { status: 'drift', derived, undeclared, reason: `writes found in ${undeclared.join(', ')}, not in the entry's writers list` };
  }
  const groups = entry.writers.map((w) => extractConcurrencyGroup((workflowTexts || {})[w] || ''));
  const serialized = entry.writers.length === 1 ? groups[0] !== null : groups.every((g) => g && g === groups[0]);
  if (!serialized && !entry.multiWriterMitigation) {
    return { status: 'drift', derived, undeclared, reason: 'writers can run concurrently (no shared serializing concurrency group) and the entry documents no multiWriterMitigation' };
  }
  if (derived.length === 0 && entry.writers.length > 0) {
    return { status: 'unverifiable', derived, undeclared, reason: entry.writersUnverifiable || 'scan found none of the declared writers' };
  }
  return { status: 'ok', derived, undeclared };
}

module.exports = { findWritingWorkflows, extractConcurrencyGroup, checkEntry, findCoreDataWriters, checkCoreDataEntry };
