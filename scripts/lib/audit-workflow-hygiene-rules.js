/**
 * Pure `run:` step-line parsing helpers and rule-matching predicates shared
 * by scripts/audit-workflow-hygiene.js's rules (b/c), (d), (g), (e), and (h).
 *
 * Extracted from audit-workflow-hygiene.js (task #1481) so the anchor fix
 * that previously had to be applied in 5 near-identical copies (task #1461
 * fixed only rule (h)'s copy; #1474 unified the rest) is tested directly via
 * require() rather than by eyeballing the regex (CLAUDE.md rule 15 — extract
 * pure decision functions to scripts/lib/ and require() them in tests).
 *
 * No fs/https/process access — every export here is a pure string-in,
 * data-out function so it can run in tests without a real workflow file.
 */
'use strict';

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

// Matches a `run:` step line, accepting both the common indented `run: |`/
// `run: <cmd>` style and the inline `- run: <cmd>` list-item shorthand (used
// elsewhere in this repo, e.g. .github/workflows/overnight-collect.yml:48).
// Anchored on the line START (after left-trim) — a `run:` that appears mid-
// line, e.g. embedded in a step name or a quoted string value
// (`- name: "then run: build"`), is deliberately NOT matched: this anchor
// answers "is this THE run: key for this step", not "does run: appear
// anywhere in this text".
const RUN_LINE_RE = /^(?:-\s+)?run\s*:\s*(.*?)\s*$/;

/**
 * Find job block boundaries under a top-level `jobs:` map (indent-2 keys
 * directly under `jobs:`). Returns start-line indices with `lines.length`
 * appended as the final boundary; callers iterate [jobStarts[j], jobStarts[j+1])
 * as each job's line range.
 */
function findJobBoundaries(lines, jobsIdx) {
  const jobStarts = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line) === 0) break;
    if (indentOf(line) === 2 && /^ {2}[A-Za-z0-9_.-]+\s*:\s*$/.test(line)) {
      jobStarts.push(i);
    }
  }
  jobStarts.push(lines.length);
  return jobStarts;
}

/** Return lines in `run:` blocks that contain `pattern` (non-comment). Rules (b)/(c). */
function runLineMatches(raw, pattern) {
  const lines = raw.split('\n');
  const hits = [];
  let inRunBlock = false;
  let runIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimStart();

    // Detect start of a `run:` block.
    // `run: |` and `run: >` are block scalars — NOT an inline command.
    // `run: echo foo` is an inline command on the same line.
    const runMatch = stripped.match(RUN_LINE_RE);
    if (runMatch) {
      const content = runMatch[1];
      const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';

      if (isBlockScalar) {
        // Block scalar — subsequent indented lines are the command body
        inRunBlock = true;
        runIndent = indentOf(line);
        continue;
      } else {
        // Inline run: content is on the same line after the colon
        inRunBlock = false;
        if (!content.trimStart().startsWith('#') && pattern.test(content)) {
          hits.push({ lineNum: i + 1, text: line.trimEnd() });
        }
        continue;
      }
    }

    if (inRunBlock) {
      // End of block: a line at <= runIndent indent (excluding blank lines)
      if (stripped !== '' && indentOf(line) <= runIndent) {
        inRunBlock = false;
        // Still check this line — it might be a new `run:` on the next iteration
        i--;
        continue;
      }
      if (stripped.startsWith('#')) continue; // comment inside run block
      if (pattern.test(line)) {
        hits.push({ lineNum: i + 1, text: line.trimEnd() });
      }
    }
  }

  return hits;
}

/**
 * Return job-scoped violations: an inline `git commit -m` in a `run:` block
 * with no git identity configured earlier in the same job. Rule (d).
 */
function findMissingGitIdentityCommits(raw) {
  const lines = raw.split('\n');
  const violations = [];

  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return violations;

  const jobStarts = findJobBoundaries(lines, jobsIdx);

  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    const end = jobStarts[j + 1];
    const jobName = lines[start].trim().replace(/:\s*$/, '');

    let identityConfigured = false;
    let inRunBlock = false;
    let runIndent = -1;

    for (let i = start; i < end; i++) {
      const line = lines[i];
      const stripped = line.trimStart();
      if (stripped.startsWith('#')) continue;

      // The shared setup-node composite action configures git on the ROOT
      // checkout (not a nested one) when called with configure-git: 'true'.
      if (/uses:\s*\.\/\.github\/actions\/setup-node\b/.test(line)) {
        const lookahead = lines.slice(i, i + 6).join('\n');
        if (/configure-git:\s*['"]?true['"]?/.test(lookahead)) {
          identityConfigured = true;
        }
      }

      let textToCheck = null;
      const runMatch = stripped.match(RUN_LINE_RE);
      if (runMatch) {
        const content = runMatch[1];
        const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';
        if (isBlockScalar) {
          inRunBlock = true;
          runIndent = indentOf(line);
          continue;
        }
        inRunBlock = false;
        textToCheck = content;
      } else if (inRunBlock) {
        if (stripped !== '' && indentOf(line) <= runIndent) {
          inRunBlock = false;
        } else {
          textToCheck = line;
        }
      }

      if (textToCheck !== null) {
        if (/git config\s+(--local\s+|--global\s+)?user\.(name|email)/.test(textToCheck)) {
          identityConfigured = true;
        }
        if (/\bgit commit\s+-m\b/.test(textToCheck) && !identityConfigured) {
          violations.push({ job: jobName, lineNum: i + 1, text: line.trim() });
        }
      }
    }
  }

  return violations;
}

/**
 * Return job-scoped violations of rule (g): an explicit `git add data/<file>`
 * for one of `coreFiles`, with no `uses: ./.github/actions/push-core-data`
 * step anywhere in the same job (push-core-data's snapshot diff only sees
 * writes from its own job's checkout-core-data snapshot).
 */
function findCoreFileWritesWithoutPush(raw, coreFiles) {
  const violations = [];
  const escaped = coreFiles.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const coreFileRe = new RegExp(`\\bdata/(${escaped.join('|')})\\b`);

  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return violations;

  const jobStarts = findJobBoundaries(lines, jobsIdx);

  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    const end = jobStarts[j + 1];
    const jobName = lines[start].trim().replace(/:\s*$/, '');

    let hasPushCoreData = false;
    const writes = [];
    let inRunBlock = false;
    let runIndent = -1;

    for (let i = start; i < end; i++) {
      const line = lines[i];
      const stripped = line.trimStart();
      if (stripped.startsWith('#')) continue;

      if (/uses:\s*\.\/\.github\/actions\/push-core-data\b/.test(line)) {
        hasPushCoreData = true;
      }

      let textToCheck = null;
      const runMatch = stripped.match(RUN_LINE_RE);
      if (runMatch) {
        const content = runMatch[1];
        const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';
        if (isBlockScalar) {
          inRunBlock = true;
          runIndent = indentOf(line);
          continue;
        }
        inRunBlock = false;
        textToCheck = content;
      } else if (inRunBlock) {
        if (stripped !== '' && indentOf(line) <= runIndent) {
          inRunBlock = false;
        } else {
          textToCheck = line;
        }
      }

      if (textToCheck !== null && !textToCheck.trimStart().startsWith('#')) {
        const match = textToCheck.match(coreFileRe);
        if (match && /\bgit\s+add\b/.test(textToCheck)) {
          writes.push({ lineNum: i + 1, text: line.trim(), coreFile: match[1] });
        }
      }
    }

    if (writes.length > 0 && !hasPushCoreData) {
      for (const w of writes) {
        violations.push({ job: jobName, lineNum: w.lineNum, text: w.text, coreFile: w.coreFile });
      }
    }
  }

  return violations;
}

// Shared helper scripts that perform `git add` internally — a job that
// invokes one of these has staged files even though the literal text
// "git add" never appears in the job's own YAML lines (see rule (h)).
// Matched against the full `scripts/lib/<name>` path (not the bare filename)
// inside actual run content only — a bare filename can appear incidentally in
// a commit message or step name ("Fixed per stage-data-changes.sh notes"),
// and matching that would silently defeat the exact dead-commit bug class
// this rule exists to catch (ship-check finding, task #1461).
const GIT_ADD_SATISFYING_SCRIPTS = [
  'stage-data-changes.sh',
  'git-add-existing.sh',
  'safe-sync-review-texts.sh',
  'sync-audit-checkout.sh',
];
const GIT_ADD_SATISFYING_SCRIPT_RE = new RegExp(
  `scripts/lib/(?:${GIT_ADD_SATISFYING_SCRIPTS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
);

/**
 * Return job-scoped violations of rule (h): a job with an inline `git
 * commit` on the root checkout and a push step (bare `git push` or
 * `push-with-retry.sh`), but zero `git add` anywhere in the job.
 */
function findDeadCommitSteps(raw) {
  const violations = [];
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return violations;

  const jobStarts = findJobBoundaries(lines, jobsIdx);

  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    const end = jobStarts[j + 1];
    const jobName = lines[start].trim().replace(/:\s*$/, '');

    let hasGitAdd = false;
    let hasPush = false;
    const commitLines = [];
    let inRunBlock = false;
    let runIndent = -1;

    for (let i = start; i < end; i++) {
      const line = lines[i];
      const stripped = line.trimStart();
      if (stripped.startsWith('#')) continue;

      let textToCheck = null;
      const runMatch = stripped.match(RUN_LINE_RE);
      if (runMatch) {
        const content = runMatch[1];
        const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';
        if (isBlockScalar) {
          inRunBlock = true;
          runIndent = indentOf(line);
          continue;
        }
        inRunBlock = false;
        textToCheck = content;
      } else if (inRunBlock) {
        if (stripped !== '' && indentOf(line) <= runIndent) {
          inRunBlock = false;
        } else {
          textToCheck = line;
        }
      }

      if (textToCheck !== null && !textToCheck.trimStart().startsWith('#')) {
        if (/\bgit\s+add\b/.test(textToCheck)) {
          hasGitAdd = true;
        }
        if (GIT_ADD_SATISFYING_SCRIPT_RE.test(textToCheck)) {
          hasGitAdd = true;
        }
        if (/\bgit push\b/.test(textToCheck) || /push-with-retry\.sh/.test(textToCheck)) {
          hasPush = true;
        }
        if (/\bgit commit\b/.test(textToCheck)) {
          commitLines.push({ lineNum: i + 1, text: line.trim() });
        }
      }
    }

    if (commitLines.length > 0 && hasPush && !hasGitAdd) {
      for (const c of commitLines) {
        violations.push({ job: jobName, lineNum: c.lineNum, text: c.text });
      }
    }
  }

  return violations;
}

/**
 * Split a workflow file into its `run:` block-scalar bodies (one entry per
 * step's `run: |`/`run: >` block). Inline `run: <cmd>` steps are single
 * commands and can never contain a `set -o pipefail` + later-line `echo $?`
 * pair, so they're not tracked here.
 */
function extractRunBlocks(raw) {
  const lines = raw.split('\n');
  const blocks = [];
  let inRunBlock = false;
  let runIndent = -1;
  let current = null;

  const closeCurrent = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimStart();
    const runMatch = stripped.match(RUN_LINE_RE);

    if (runMatch) {
      const content = runMatch[1];
      // Tolerates chomp/indent indicators in either order (|2, |2-, >+) and a
      // trailing comment (rules a-d's isBlockScalar checks don't need this).
      const isBlockScalar = /^[|>][0-9]?[-+]?(\s+#.*)?$/.test(content) || content === '';
      closeCurrent();
      if (isBlockScalar) {
        inRunBlock = true;
        runIndent = indentOf(line);
        current = { lines: [] };
      } else {
        inRunBlock = false;
      }
      continue;
    }

    if (inRunBlock) {
      if (stripped !== '' && indentOf(line) <= runIndent) {
        inRunBlock = false;
        closeCurrent();
        i--;
        continue;
      }
      current.lines.push({ lineNum: i + 1, text: line });
    }
  }
  closeCurrent();

  return blocks;
}

/**
 * Return violations of rule (e): a `run:` block that sets `pipefail` and
 * also contains a bare `echo $?` (dead code under bash -e). Exempt: `echo
 * $?` immediately preceded by `|| ` on the same line, since that construct
 * is reachable under `bash -e` (the `||` protects it).
 */
function findPipefailDeadExitCodeEcho(raw) {
  const violations = [];

  for (const block of extractRunBlocks(raw)) {
    const hasPipefail = block.lines.some(
      (l) => !l.text.trimStart().startsWith('#') && /\bpipefail\b/.test(l.text),
    );
    if (!hasPipefail) continue;

    for (const l of block.lines) {
      const stripped = l.text.trimStart();
      if (stripped.startsWith('#')) continue;
      if (!/echo\s+"?\$\?"?/.test(l.text)) continue;
      // Guarded on the same line — covers `cmd || echo $?`, brace groups
      // (`cmd || { echo $?; }`), and subshells (`cmd || (echo $?)`).
      if (/\|\|.*echo\s+"?\$\?"?/.test(l.text)) continue;
      violations.push({ lineNum: l.lineNum, text: l.text.trim() });
    }
  }

  return violations;
}

// Matches the tail of the shell text immediately preceding a `'` that opens
// an inline eval argument — `node -e '`, `node --input-type=module -e '`,
// `npx tsx -e '`, `python3 -e '`/`python -e '`, `... -p '`. Deliberately
// narrow (verified against every current `-e '`/`-p '` opener in
// .github/workflows/*.yml, 2026-08-26) rather than matching any `-e '`, since
// generic single-char flags (`sed -e`, `grep -e`) take a PATTERN argument,
// not embedded source, and bash's own quote-parity rule doesn't apply to
// them the same way (their bodies are never multi-line JS with prose
// comments, the actual risk surface this rule targets).
//
// Deliberately excludes `python3 -c '...'` (this repo's only current
// single-quoted-eval Python idiom is double-quoted, so no live workflow is
// affected either way): the validator this feeds
// (findUnescapedApostrophesInSingleQuotedEval) always runs `node --check`
// on the reconstructed body — matching a Python opener would hand Python
// source to a JS syntax checker and manufacture a guaranteed false
// positive, not close a gap. Widening this needs a language-aware
// validator alongside it, not just a wider regex.
const EVAL_OPENER_TAIL_RE = /\b(?:node(?:\s+--\S+)*|npx\s+tsx|python3?)\s+-[ep]\s*$/;

// Characters (besides whitespace) that end an unquoted shell word/simple
// command in POSIX word-splitting — `)` is the one that actually shows up
// after these blocks (closing a `$(...)` command substitution).
const SHELL_WORD_BREAK_RE = /[\s)(;&|<>]/;

/**
 * Return the literal source bodies of inline `-e '...'`/`-p '...'` eval
 * arguments EXACTLY as bash would parse them.
 *
 * Bash single-quoted strings have no escape mechanism, so a `'` inside one
 * always closes it — but a closed quote does NOT necessarily end the shell
 * WORD: `'foo'bar'baz'` with zero whitespace between segments is ONE
 * concatenated word ("foobarbaz"), because bash only splits words on
 * whitespace/metacharacters, never on a bare quote transition. This matters
 * here because a comment containing a well-formed quoted-and-closed aside —
 * `// result.action==='digest' means...` — round-trips back into the SAME
 * shell word by accident (no whitespace ever sits at any quote boundary),
 * while a stray possessive apostrophe — `sit out the previous incident's` —
 * is immediately followed by end-of-line whitespace, which DOES end the
 * word right there, truncating everything after it (the exact BRO-450 bug:
 * `SyntaxError: Unexpected end of input`, run 32253007200).
 *
 * Algorithm: walk the block character-by-character from the opener,
 * toggling in/out of quotes on each `'`. Whenever a quote closes, keep
 * consuming the following unquoted text into the same accumulated body
 * UNLESS/UNTIL hitting whitespace or a shell metacharacter (`)(;&|<>`) —
 * that's the true end of the word. Hitting another `'` first just re-enters
 * quoted mode and the accumulation continues (this is what correctly
 * reconstructs the "digest"/"human" case above, and also why `SHOWS=$(node
 * -e '...')`'s trailing `)` and `... ' "$VAR")`'s argv-passing tail are
 * correctly EXCLUDED from the returned body).
 */
function extractSingleQuotedEvalBodies(raw) {
  const results = [];

  for (const block of extractRunBlocks(raw)) {
    if (block.lines.length === 0) continue;
    const blockText = block.lines.map((l) => l.text).join('\n');

    let searchFrom = 0;
    while (true) {
      const openIdx = blockText.indexOf("'", searchFrom);
      if (openIdx === -1) break;

      const before = blockText.slice(0, openIdx);
      if (!EVAL_OPENER_TAIL_RE.test(before)) {
        searchFrom = openIdx + 1;
        continue;
      }

      let pos = openIdx + 1;
      let inQuote = true;
      let segStart = pos;
      let body = '';

      while (pos <= blockText.length) {
        if (inQuote) {
          const closeIdx = blockText.indexOf("'", pos);
          if (closeIdx === -1) {
            body += blockText.slice(segStart);
            pos = blockText.length + 1;
            break;
          }
          body += blockText.slice(segStart, closeIdx);
          inQuote = false;
          segStart = closeIdx + 1;
          pos = segStart;
        } else {
          let k = pos;
          while (k < blockText.length && blockText[k] !== "'" && !SHELL_WORD_BREAK_RE.test(blockText[k])) {
            k++;
          }
          if (k >= blockText.length || blockText[k] !== "'") {
            body += blockText.slice(segStart, k);
            pos = k + 1; // word ends here (whitespace/metachar/EOF)
            break;
          }
          // Hit another quote — the literal text up to it continues the
          // same word, and we're back inside a quoted span.
          body += blockText.slice(segStart, k);
          inQuote = true;
          segStart = k + 1;
          pos = segStart;
        }
      }

      const startLine = block.lines[0].lineNum + (before.match(/\n/g) || []).length;
      const esm = /--input-type=module/.test(before);
      results.push({ startLine, body, esm });
      searchFrom = pos;
    }
  }

  return results;
}

// Every `data/audit/...` token on a `git add`/`git-add-existing.sh` line,
// delimited by whitespace or a trailing quote char. \S* (not \S+) lets the
// bare `data/audit/` case match with zero trailing characters.
const AUDIT_PATH_TOKEN_RE = /\bdata\/audit\/\S*/g;
const AUDIT_PREFIX_LEN = 'data/audit/'.length;

/**
 * Classify one extracted `data/audit/...` token: does it name a concrete
 * file `findWritingWorkflows()` in api-fallback-writer-drift.js could match
 * on, or one of the two shapes that scanner's literal-basename regex can
 * never see?
 *   - 'directory'         — no basename at all: `data/audit/`,
 *                            `data/audit/pipeline-health/` (ends in `/`,
 *                            after stripping a trailing quote char)
 *   - 'wildcard-basename'  — the last path segment contains `*`:
 *                            `data/audit/*.json`,
 *                            `data/audit/opening-night-latency-*.json`. The
 *                            scanner's regex is a literal substring match
 *                            against a specific REGISTERED basename — a `*`
 *                            in the staged pathspec can never literally equal
 *                            that registered basename string, so this is
 *                            invisible via a different mechanism than the
 *                            no-basename case but with the identical result.
 *   - null                 — a concrete basename (`data/audit/foo.json`) —
 *                            fine, visible to the scanner.
 */
function classifyAuditToken(token) {
  const stripped = token.replace(/["'`]+$/, '');
  const basename = stripped.slice(AUDIT_PREFIX_LEN);
  if (basename === '' || basename.endsWith('/')) return 'directory';
  const lastSegment = basename.split('/').pop();
  if (lastSegment.includes('*')) return 'wildcard-basename';
  return null;
}

/**
 * Rule (n) (BRO-3990): a `git add`/`git-add-existing.sh` line staging a
 * `data/audit/` pathspec with no fixed basename — either a bare directory
 * (no basename at all) or a wildcard basename (`*.json`) — rather than an
 * explicit file list.
 *
 * WHY THIS MATTERS: scripts/lib/api-fallback-writer-drift.js's
 * findWritingWorkflows() — the static scanner that verifies every
 * `apiFallbackSafe` registry claim still matches a real single writer —
 * matches on the LITERAL basename string appearing after `git add`/
 * `git-add-existing.sh` on the same command. Neither a directory pathspec
 * nor a `*`-glob ever contains that literal string, so any NEW single-writer
 * `data/audit/*.json` file swept up by one of these is invisible to the
 * scanner in BOTH directions: it can't be flagged as an unregistered writer
 * (nothing to match against), and if a human forgets to register it in
 * core-data-merge-registry.js, nothing catches the gap. That silent gap is
 * exactly what BRO-2722 found in llm-ensemble-score.yml
 * (data/audit/progress-watch-state.json staged via a bare `data/audit/`
 * directory glob, never registered, poisoning push-with-retry.sh's Git Data
 * API fallback on every scheduled run) — this rule generalizes that one fix
 * into a standing lint (both shapes — a second-opinion review of the
 * directory-only first draft found the `*.json` extension-glob shape has the
 * identical blind spot via a different mechanism, 16 live occurrences at
 * introduction) so the NEXT script that writes a new data/audit/*.json file
 * under one of these workflows doesn't silently repeat it.
 *
 * ADVISORY ONLY (like rule (f)'s never-run coverage) — NOT counted toward
 * the CLI's blocking `total`. Both idioms are already used intentionally
 * across ~30 workflows combined (many multi-file, several genuinely
 * disposable audit output), so retroactively failing all of them would
 * require an exemption comment on every one just to keep CI green, for a
 * risk that is real but not urgent on any SINGLE existing file. Surfacing it
 * as a printed warning — reviewed the next time someone touches one of these
 * workflows or adds a new data/audit/ writer — is the useful middle ground;
 * flip to blocking later if repeat incidents show the warning gets ignored.
 *
 * Known gap (mirrors rule (g)'s own line-continuation note above): this scans
 * one physical `run:` line at a time (via runLineMatches). A pathspec staged
 * on its OWN backslash-continuation line — `git add \` on one line, `\n
 * data/audit/` on the next — never contains the `git add`/`git-add-
 * existing.sh` trigger text itself, so it's never treated as a candidate
 * line. No live workflow hits this today (checked at introduction, BRO-3990)
 * — the one continuation-style `git add \` in this repo
 * (weekly-video-reviews.yml) lists concrete basenames only — but a future
 * bare-directory add written this way would slip past this rule silently.
 *
 * Pure and exported so tests/unit can assert against the real matcher.
 * Returns [{ lineNum, text, paths: [{ path, kind }] }].
 */
function findBareAuditDirectoryGlobs(raw) {
  const candidateLines = runLineMatches(raw, /\b(?:git add|git-add-existing\.sh)\b/);
  const violations = [];
  for (const { lineNum, text } of candidateLines) {
    const paths = [];
    AUDIT_PATH_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = AUDIT_PATH_TOKEN_RE.exec(text))) {
      const kind = classifyAuditToken(m[0]);
      if (kind) paths.push({ path: m[0].replace(/["'`]+$/, ''), kind });
    }
    if (paths.length > 0) violations.push({ lineNum, text, paths });
  }
  return violations;
}

module.exports = {
  indentOf,
  RUN_LINE_RE,
  findJobBoundaries,
  runLineMatches,
  findMissingGitIdentityCommits,
  findCoreFileWritesWithoutPush,
  findDeadCommitSteps,
  extractRunBlocks,
  findPipefailDeadExitCodeEcho,
  extractSingleQuotedEvalBodies,
  findBareAuditDirectoryGlobs,
};
