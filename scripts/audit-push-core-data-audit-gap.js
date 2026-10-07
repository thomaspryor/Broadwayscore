#!/usr/bin/env node
/**
 * Advisory guard (task #1460, cousin of #1442): flag workflows that write a
 * data/audit/*.json ledger but rely ONLY on push-core-data to persist it.
 *
 * push-core-data's composite action syncs a FIXED CORE_FILES list (shows.json,
 * reviews.json, grosses.json, ...) read live from
 * .github/actions/push-core-data/action.yml — data/audit/ is never in it. A
 * workflow that writes an audit ledger and calls only push-core-data (no
 * explicit git add/commit/push-with-retry.sh) silently never persists that
 * file: every run starts cold from whatever was last committed by hand,
 * defeating any cross-run state (cooldowns, dedup, escalation counters) the
 * ledger was meant to hold.
 *
 * Live example (task #1456): audit-imageless-scored-shows.yml wrote
 * data/audit/imageless-scored-shows.json entirely inside
 * scripts/audit-imageless-scored-shows.js — the workflow YAML itself never
 * mentioned the path, only "Push core data" appeared as the persistence
 * step. Caught by adversarial code review before merge, not by any CI gate.
 * That shape (the write lives in an invoked script, invisible to a
 * YAML-only reader) is why this check follows `node scripts/X.js`
 * invocations into their source, not just the workflow YAML text.
 *
 * Detection — a workflow is an offender only if ALL of:
 *   (1) It contains a write signal for some data/audit/*.json path, either
 *       inline in a run: step (redirect/tee/writeFileSync referencing the
 *       path directly) or transitively: it invokes `node scripts/X.js` and
 *       X.js's source contains both a data/audit/*.json path literal (or a
 *       path.join('data','audit',...) construction) and a filesystem write
 *       call anywhere in the file.
 *   (2) It calls push-core-data (uses: ./.github/actions/push-core-data)
 *       somewhere in the file.
 *   (3) It has NO alternative persistence mechanism anywhere in the file for
 *       data/audit specifically: no explicit `git add` covering data/audit
 *       (narrow path or a broad `-A`/`.` add) paired with
 *       scripts/lib/push-with-retry.sh, and no push-review-texts step.
 *
 * This is a heuristic, not a parser — like audit-run-budget-coverage.js, it
 * does not chase indirection beyond the directly-invoked script (a script
 * that writes via a required lib helper's write function is a known gap),
 * and a script whose data/audit write is genuinely scratch/ephemeral
 * (deliberately never meant to survive a run) will still be flagged. Always
 * exits 0 — this needs a period of human-reviewed findings before it's
 * trustworthy enough to fail CI, same posture as audit-run-budget-coverage.js.
 *
 * Exemption (add inside the workflow YAML — anywhere in the file):
 *   # hygiene-audit-persist-ok: <reason>
 *
 * No external deps. Parsed with plain regex, consistent with
 * audit-workflow-hygiene.js / audit-run-budget-coverage.js.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const REPO_ROOT = path.join(__dirname, '..');

const AUDIT_JSON_RE = /data\/audit\/[\w.\-/]*\.json/;
const WRITE_CALL_RE = /\bwriteFileSync\s*\(|\.writeFile\s*\(|fsPromises\.writeFile\s*\(/;
const WRITE_FN_NAME = '(?:writeFileSync|\\.writeFile|fsPromises\\.writeFile)';
// A data/audit path expressed either as a quoted literal or a path.join('data','audit',...) call.
const AUDIT_PATH_EXPR = "(?:['\"]data/audit/[^'\"]*\\.json['\"]|path\\.join\\([^)]*['\"]data['\"]\\s*,\\s*['\"]audit['\"][^)]*\\))";

/** Repo-relative `scripts/X.js`/`scripts/X.mjs` paths referenced on non-comment lines. */
function findInvokedScripts(raw) {
  const scripts = new Set();
  for (const line of raw.split('\n')) {
    const stripped = line.trimStart();
    if (stripped.startsWith('#')) continue;
    const re = /\bscripts\/[\w-]+(?:\/[\w-]+)*\.(?:js|mjs)\b/g;
    let m;
    while ((m = re.exec(line))) scripts.add(m[0]);
  }
  return [...scripts];
}

/**
 * True if `scriptRelPath`'s source writes a data/audit/*.json path — the
 * path expression itself must be the argument to a write call, either
 * directly (`writeFileSync('data/audit/x.json', ...)`) or via a variable
 * (`const P = 'data/audit/x.json'; ...; writeFileSync(P, ...)`). Requiring
 * that link — instead of "both patterns appear somewhere in the file" —
 * avoids false-positiving on scripts that merely mention a data/audit path
 * in an unrelated error message while also calling writeFileSync elsewhere
 * for something else entirely (validate-data.js: an error() string names
 * data/audit/same-url-duplicate-baseline.json, and the file separately
 * writes other reports — neither call touches the other).
 */
function scriptWritesAuditJson(scriptRelPath) {
  const abs = path.join(REPO_ROOT, scriptRelPath);
  if (!fs.existsSync(abs)) return false;
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return false;
  }

  const directRe = new RegExp(`${WRITE_FN_NAME}\\s*\\(\\s*${AUDIT_PATH_EXPR}`);
  if (directRe.test(src)) return true;

  // Allows for the common `const X = process.env.OVERRIDE || path.join(...)`
  // idiom (e.g. scripts/check-bd-breaker.js's STATE_PATH) — the audit path
  // expression doesn't have to sit directly after `=`, just somewhere before
  // the statement's terminating `;` (bounded window to avoid runaway
  // backtracking on files with sparse semicolons).
  const varAssignRe = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*[^;]{0,200}?${AUDIT_PATH_EXPR}`, 'g');
  let m;
  while ((m = varAssignRe.exec(src))) {
    const varName = m[1];
    const viaVarRe = new RegExp(`${WRITE_FN_NAME}\\s*\\(\\s*${varName}\\b`);
    if (viaVarRe.test(src)) return true;
  }

  return false;
}

/** Inline run: lines that write a data/audit/*.json path directly (no invoked script). */
function findInlineAuditWrites(raw) {
  const hits = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimStart();
    if (stripped.startsWith('#')) continue;
    const match = line.match(AUDIT_JSON_RE);
    if (!match) continue;
    const isWriteContext =
      new RegExp(`>\\s*['"]?${match[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(line) ||
      (/\btee\b/.test(line) && line.includes(match[0])) ||
      WRITE_CALL_RE.test(line);
    if (isWriteContext) {
      hits.push({ lineNum: i + 1, text: line.trim(), file: match[0] });
    }
  }
  return hits;
}

/**
 * True if the file has some OTHER way to persist data/audit besides
 * push-core-data: an explicit `git add` covering data/audit or a broad
 * `-A`/`.` add, or the shared `stage-data-changes.sh` helper called with no
 * args (stages all of data/ minus its private-path exclusions, which do not
 * include data/audit/) or with an arg list that covers data/ or data/audit
 * specifically — paired with push-with-retry.sh anywhere in the file.
 *
 * push-review-texts is deliberately NOT treated as an exemption here (fixed
 * during ship-check review): its composite action runs entirely inside
 * `working-directory: data/review-texts` — a nested checkout that never
 * touches data/audit/, the same way push-core-data's own /tmp/core-data-
 * checkout never does. Calling it proves nothing about this file's
 * persistence.
 */
function hasAlternativePersistMechanism(raw) {
  if (!/push-with-retry\.sh/.test(raw)) return false;

  // Non-comment lines only: a prose comment mentioning "stage-data-changes.sh"
  // or "git add -A" (explaining what NOT to do, or narrating history) must
  // never satisfy this check — only a real invocation counts. Using the
  // first regex match against the whole raw file, unfiltered, previously
  // matched an EARLIER comment line ahead of the real call and derived
  // "args" from prose text instead (review-refresh.yml false positive,
  // caught in ship-check review: its real `bash scripts/lib/
  // stage-data-changes.sh` call on line 476 was preceded by two comment
  // lines each mentioning "stage-data-changes.sh").
  const codeLines = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));

  for (const line of codeLines) {
    if (/\bgit add\b[^\n]*data\/audit\b/.test(line)) return true;
    if (/\bgit add\s+-A\b/.test(line)) return true;
    if (/\bgit add\s+\.\s*$/.test(line.trimEnd())) return true;

    const stageMatch = line.match(/stage-data-changes\.sh(.*)$/);
    if (stageMatch) {
      // Strip a trailing inline comment before judging "no args".
      const args = stageMatch[1].replace(/\s#.*$/, '').trim();
      // No args = stages all of data/, which includes data/audit/.
      if (args === '') return true;
      if (/\bdata\//.test(args)) return true;
    }
  }
  return false;
}

/** Returns an offender record for `file`, or null if it's clean/exempt/not applicable. */
function checkWorkflow(file, raw) {
  if (raw.includes('hygiene-audit-persist-ok:')) return null;
  if (!raw.includes('uses: ./.github/actions/push-core-data')) return null;

  const inlineHits = findInlineAuditWrites(raw);
  const invokedScripts = findInvokedScripts(raw);
  const writingScripts = invokedScripts.filter(scriptWritesAuditJson);

  if (inlineHits.length === 0 && writingScripts.length === 0) return null;
  if (hasAlternativePersistMechanism(raw)) return null;

  return { file, inlineHits, writingScripts };
}

function main() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  const offenders = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    const result = checkWorkflow(file, raw);
    if (result) offenders.push(result);
  }

  if (offenders.length === 0) {
    console.log(
      `✅ push-core-data audit-persistence check: no offenders found (${files.length} workflows checked, advisory).`,
    );
    return;
  }

  console.log(
    `⚠️  ${offenders.length} workflow(s) write data/audit/*.json but rely only on push-core-data to persist it (advisory).\n`,
  );
  console.log('push-core-data only syncs its fixed CORE_FILES list — data/audit/ is never');
  console.log('in it, so the write silently never reaches the repo. Every run starts cold,');
  console.log('defeating any cross-run state the ledger was meant to hold (task #1456 bug class).\n');
  for (const { file, inlineHits, writingScripts } of offenders) {
    console.log(`  • ${file}`);
    for (const h of inlineHits) console.log(`      line ${h.lineNum} [${h.file}]: ${h.text}`);
    for (const s of writingScripts) console.log(`      invokes ${s} (writes data/audit/*.json internally)`);
  }
  console.log('\nFix: add an explicit commit step in the same file (after the write), e.g.:');
  console.log(`      - name: Commit audit ledger
        if: always()
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/audit/<file>.json 2>/dev/null || true
          if git diff --staged --quiet; then
            echo "No ledger changes"
          else
            git commit -m "data: update audit ledger [skip ci]"
            bash scripts/lib/push-with-retry.sh
          fi`);
  console.log(
    '\nExempt (deliberately ephemeral/scratch, no cross-run state): add  # hygiene-audit-persist-ok: <reason>  anywhere in the file.',
  );
  // Advisory only — never fails the gate. See header comment for why.
}

module.exports = {
  checkWorkflow,
  findInvokedScripts,
  scriptWritesAuditJson,
  findInlineAuditWrites,
  hasAlternativePersistMechanism,
};

if (require.main === module) {
  // Advisory-only means "never fails the gate" — that promise only held on
  // the happy path (an unreadable workflow file or similar would otherwise
  // crash main() with a nonzero exit, silently breaking the guarantee this
  // check exists to keep). Caught here, not per-file, since a scan that hit
  // an unexpected error partway through has an incomplete offender list
  // anyway — better to say so once than print a partial "clean" report.
  try {
    main();
  } catch (err) {
    console.log(`ℹ️  push-core-data audit-persistence check crashed (advisory, not failing CI): ${err.message}`);
  }
}
