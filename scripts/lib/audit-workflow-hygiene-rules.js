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

/**
 * Split a workflow's raw YAML into { jobKey: lines[] } using findJobBoundaries.
 * Returns an empty object when the file has no top-level `jobs:` key.
 */
function readWorkflowJobBlocks(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return {};
  const jobStarts = findJobBoundaries(lines, jobsIdx);
  const blocks = {};
  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    blocks[lines[start].trim().replace(/:\s*$/, '')] = lines.slice(start, jobStarts[j + 1]);
  }
  return blocks;
}

/**
 * Job-level `timeout-minutes` of a job block (header line first), or null when
 * the job declares none. Only matches at header indent + 2, so step-level
 * timeouts inside the job are ignored.
 */
function jobTimeoutMinutes(jobLines) {
  const headerIndent = indentOf(jobLines[0]);
  const line = jobLines.find(
    (l) => indentOf(l) === headerIndent + 2 && /^\s*timeout-minutes\s*:\s*\d+/.test(l),
  );
  return line ? parseInt(line.trim().split(':')[1].trim(), 10) : null;
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
function extractRunBlocks(raw, { includeInline = false } = {}) {
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
        if (includeInline) blocks.push({ lines: [{ lineNum: i + 1, text: content }] });
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
 * Rule (e), widened by BRO-4480: a captured exit code (`VAR=$?`, `local
 * VAR=$?`, or `echo $?`) that is unreachable because GHA runs every `run:`
 * block under `bash -e` (`bash -eo pipefail` with `shell: bash`). When the
 * command on the previous logical line fails, `-e` aborts the step before the
 * capture runs, so whatever was meant to report the failure never runs.
 * BRO-4480: setup-playwright's `timeout 480 cmd` + `status=$?` hid an 8-minute
 * install hang with zero diagnostics. The old rule only looked at `echo $?`
 * in blocks that spelled out `pipefail`, and never at composite actions.
 *
 * Reachable (not flagged): the previous logical line contains `||` or `&&`
 * (a failing left side of a list does not trip -e), starts with `!`, is a
 * control-flow line (if/while/until/elif/then/else/do/fi/done/esac/;;/}/)),
 * or errexit is off at that point (`set +e`, re-enabled by `set -e`).
 * Function bodies ARE scanned: whether -e is live inside depends on the
 * caller (`fn || x` suspends it), which this rule cannot see — exempt such a
 * line with `# hygiene-exitcode-ok: <reason>` on the capture line or the
 * command line before it (a per-line exemption; the file-wide
 * `# hygiene-echo-exitcode-ok:` is still honoured by the caller).
 * `\` continuations are joined, so the previous LOGICAL line is checked.
 */
const CAPTURE_RE = /^(?:(?:local|export|declare(?:\s+-\w+)*)\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"\$\?"|\$\{\?\}|"\$\{\?\}"|\$\?)(?:\s*(?:[;#].*)?)$|^echo\s+(?:"\$\?"|\$\?|\$\{\?\}|"\$\{\?\}")(?:\s|$)/;
const REACHABLE_PREV_RE = /\|\||&&|^!|^(?:if|elif|while|until|then|else|do|fi|done|esac|;;|\}|\))\b|^(?:\}|\))|(?:\bthen|\bdo|;;|\{)\s*$/;

function logicalLines(block) {
  const out = [];
  let cur = null;
  for (const l of block.lines) {
    const text = l.text.trim();
    if (!cur && (text === '' || text.startsWith('#'))) continue;
    if (cur) {
      cur.text = `${cur.text.replace(/\\$/, '')} ${text}`;
      cur.raw += `\n${l.text}`;
    } else {
      cur = { lineNum: l.lineNum, text, raw: l.text };
    }
    if (!/\\$/.test(text)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

function findPipefailDeadExitCodeEcho(raw) {
  const violations = [];
  for (const block of extractRunBlocks(raw)) {
    let errexit = true;
    let prev = null;
    for (const line of logicalLines(block)) {
      const { text } = line;
      if (CAPTURE_RE.test(text) && errexit && prev && !REACHABLE_PREV_RE.test(prev.text)) {
        const exempt = /hygiene-exitcode-ok:/.test(line.raw) || /hygiene-exitcode-ok:/.test(prev.raw);
        if (!exempt) violations.push({ lineNum: line.lineNum, text, prev: prev.text });
      }
      if (/\bset\s+\+[a-z]*e|\bset\s+\+o\s+errexit/.test(text)) errexit = false;
      else if (/\bset\s+-[a-z]*e[a-z]*\b|\bset\s+-o\s+errexit/.test(text)) errexit = true;
      prev = line;
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

/**
 * BRO-4047: detect a double-quoted eval argument escaping into bare shell
 * text. JS comments offer no protection from bash's quote processing.
 *
 * Walk shell quote state, not YAML text matches: # comments, quoted shell
 * documentation, heredocs and github-script source are not eval commands.
 * Inside an eval, backslash pairs are consumed before quote transitions.
 * A closing quote followed by bare text is suspicious; adjacent quoted
 * segments and parameter expansions are valid shell word concatenation.
 * For multiline evals with a standalone closing delimiter, an earlier
 * quote followed by whitespace is also premature (even if the truncated
 * JS happens to be syntactically valid). Report once per eval, recovering
 * at that delimiter so one bad comment cannot hide the next command.
 *
 * This is a literal-argument guard, not a complete bash or JS validator.
 * It does not evaluate shell expansions or dynamically generated source.
 */
function findUnescapedDoubleQuotesInDoubleQuotedEval(raw) {
  const hits = [];
  for (const block of extractRunBlocks(raw.replace(/\r\n?/g, '\n'), { includeInline: true })) {
    const source = block.lines.map(l => l.text).join('\n');
    let quote = null;
    const substitutions = [];
    const heredocs = [];
    const lineAt = pos => block.lines[(source.slice(0, pos).match(/\n/g) || []).length];

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (ch === '\\' && (!quote || /[\n$`"\\]/.test(source[i + 1] || ''))) { i++; continue; }
      // $(...) has its own quoting context even inside "...".
      if (ch === '$' && source[i + 1] === '(') {
        substitutions.push({ quote, depth: 1 });
        quote = null;
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (substitutions.length && (ch === '(' || ch === ')')) {
        const sub = substitutions[substitutions.length - 1];
        sub.depth += ch === '(' ? 1 : -1;
        if (sub.depth === 0) { quote = sub.quote; substitutions.pop(); }
        continue;
      }
      if (ch === '#' && (i === 0 || /[\s;|&()]/.test(source[i - 1]))) {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end - 1;
        continue;
      }
      if (ch === '<' && source[i - 1] !== '<' && source[i + 1] === '<' && source[i + 2] !== '<') {
        const doc = source.slice(i).match(/^<<-?\s*(['"]?)([\w-]+)\1/);
        if (doc) { heredocs.push(doc[2]); i += doc[0].length - 1; continue; }
      }
      if (ch === '\n' && heredocs.length) {
        for (const delimiter of heredocs.splice(0)) {
          let end = i + 1;
          while (end < source.length) {
            const next = source.indexOf('\n', end);
            const stop = next === -1 ? source.length : next;
            if (source.slice(end, stop).trim() === delimiter) { i = stop; break; }
            end = stop + 1;
          }
          if (end >= source.length) i = source.length;
        }
        continue;
      }
      if (ch !== '"' || !EVAL_OPENER_TAIL_RE.test(source.slice(0, i))) {
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        continue;
      }

      const startLine = lineAt(i).lineNum;
      // Only an opener whose body starts on the next line has a separate
      // closing-delimiter convention. Inline commands can have later evals.
      const rest = source.slice(i + 1);
      const closing = /^[ \t]*\n/.test(rest) ? /^[ \t]*"(?=[\s);|&<>]|$)/m.exec(rest) : null;
      const closeAt = closing ? i + 1 + closing.index + closing[0].length - 1 : -1;
      let state = '"';
      let badQuote = -1;
      let lastClose = -1;
      let pos = i + 1;
      for (; pos < source.length; pos++) {
        const c = source[pos];
        if (state === "'") {
          if (c === "'") state = null;
          continue;
        }
        if (c === '\\' && (!state || /[\n$`"\\]/.test(source[pos + 1] || ''))) { pos++; continue; }
        if (c === '"') {
          if (state === '"') {
            state = null;
            lastClose = pos;
            if (pos < closeAt && SHELL_WORD_BREAK_RE.test(source[pos + 1] || '')) badQuote = pos;
          } else state = '"';
          continue;
        }
        if (state) continue;
        if (SHELL_WORD_BREAK_RE.test(c)) break;
        if (c === "'") { state = "'"; continue; }
        // Legitimate "source"$VAR"source" concatenation must not be
        // mistaken for an unescaped JS comment or string literal.
        const parameter = c === '$' && source.slice(pos).match(/^\$(?:[A-Za-z_]\w*|\d+|\{[^}]*\})/);
        if (parameter) { pos += parameter[0].length - 1; continue; }
        badQuote = lastClose;
        break;
      }
      if (badQuote !== -1) {
        const line = lineAt(badQuote);
        hits.push({ startLine, lineNum: line.lineNum, text: line.text.trim(), message: 'Unescaped double quote ends the eval string before its source is complete; escape it as \\".' });
        // Recover only within this run block, never into another YAML step.
        if (closeAt > badQuote) pos = closeAt;
        else {
          const end = source.indexOf('\n', badQuote);
          pos = end === -1 ? source.length : end;
        }
      }
      i = pos;
    }
  }
  return hits;
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

/**
 * Rule (o) (BRO-4231): an actions/checkout step whose `with:` block sets
 * `fetch-depth: 0` without `filter: blob:none` — a FULL-BLOB full-history
 * clone of this repo (~545 MB pack, ~24 min per checkout, measured on
 * llm-ensemble-score.yml run 36523767401 and collect-review-texts.yml run
 * 36550916420) where a blobless partial clone (~30 s, runs 36672742657 /
 * 36672749242) keeps the full commit graph that `fetch-depth: 0` exists for
 * (merge-base for push-with-retry.sh, the #209 parentless-root incident) and
 * fetches blobs lazily. Nearly every job here reads only the working tree
 * and pushes through push-with-retry.sh, which handles partial clones since
 * BRO-4219.
 *
 * ADVISORY ONLY (rule (f)/(n) posture): the sweep that introduced this rule
 * converted every safe workflow, but a genuine full-blob need exists
 * (purge-archives-history.yml runs git filter-repo over every historical
 * blob) and is exempted with `# hygiene-full-blobs-ok: <reason>` on the same
 * step (anywhere between the step's first line and its `fetch-depth: 0`,
 * or in the `with:` block).
 *
 * Comment-aware: a `fetch-depth: 0` that appears only in a `#` comment
 * (guard-no-orphan-commit.yml, update-show-status.yml's rationale block) is
 * not a key. Workflow files only — composite actions expose `fetch-depth`
 * as an INPUT (checkout-review-texts/action.yml), so the caller passes a
 * different file list. Returns [{ lineNum, text }] for each offending
 * `fetch-depth: 0` line.
 */
// `fetch-depth: 0`, optionally quoted, optionally followed by a `# comment`.
const FETCH_DEPTH_ZERO_RE = /^\s*fetch-depth\s*:\s*(['"]?)0\1\s*(?:#.*)?$/;
const BLOB_NONE_FILTER_RE = /^\s*filter\s*:\s*(['"]?)blob:none\1\s*(?:#.*)?$/;
const FULL_BLOBS_OK_RE = /hygiene-full-blobs-ok:/;

function findFullBlobFullHistoryCheckouts(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('#')) continue;
    if (!FETCH_DEPTH_ZERO_RE.test(line)) continue;
    const ind = indentOf(line);
    const stepIndent = ind - 4; // `- uses:` sits two keys shallower than a `with:` value
    let filtered = false;
    let exempt = false;
    // Upward: the rest of this `with:` block and the step's other keys, up to
    // the step's `- ` line, then the contiguous comment block that introduces
    // the step (that is where a reviewer writes "why this step is special").
    for (let j = i - 1; j >= 0; j--) {
      const l = lines[j];
      if (l.trim() === '') continue;
      const jInd = indentOf(l);
      if (jInd < stepIndent) break; // above the step
      if (FULL_BLOBS_OK_RE.test(l)) exempt = true;
      if (jInd >= ind && !l.trimStart().startsWith('#') && BLOB_NONE_FILTER_RE.test(l)) filtered = true;
      if (jInd === stepIndent && l.trimStart().startsWith('- ')) {
        for (let k = j - 1; k >= 0 && indentOf(lines[k]) === stepIndent && lines[k].trimStart().startsWith('#'); k--) {
          if (FULL_BLOBS_OK_RE.test(lines[k])) exempt = true;
        }
        break;
      }
    }
    // Downward: the rest of the `with:` block (blank lines allowed inside).
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (indentOf(l) < ind) break; // left the with: block
      if (FULL_BLOBS_OK_RE.test(l)) exempt = true;
      if (!l.trimStart().startsWith('#') && BLOB_NONE_FILTER_RE.test(l)) filtered = true;
    }
    if (!filtered && !exempt) hits.push({ lineNum: i + 1, text: line });
  }
  return hits;
}

/**
 * Rule (q) (BRO-5033): `git diff` / `git status` / `git show` on a path git
 * ignores. Core data (data/shows.json, reviews.json, grosses*.json, ...) is
 * gitignored here and synced through checkout-core-data/push-core-data, so
 * `git diff --quiet data/shows.json` always says "no change" and every step
 * it gates is dead code. weekly-grosses.yml skipped validate/build/commit/
 * deploy on every run this way. Use scripts/lib/core-data-changed.js, which
 * compares against the checkout-core-data snapshot.
 *
 * Scans run-block lines (comments skipped). For each git diff/status/show
 * command on the line, the literal arguments up to the next `|`, `;`, `&&`,
 * `||` or `)` are path candidates when they contain `/` or end in `.json`
 * and hold no `$` (expansions can't be resolved statically). For `git show
 * REF:path` the part after the colon is the path. `isIgnored(path)` decides;
 * the CLI passes a `git check-ignore` probe, so a tracked file that happens
 * to match an ignore pattern is (correctly) not flagged.
 *
 * ADVISORY at introduction (CLAUDE.md §19): the CLI prints these and does
 * not count them toward its blocking total. Exempt one line with
 * `# hygiene-ignored-diff-ok: <reason>` on that line.
 *
 * Returns [{ lineNum, text, path }].
 */
// Allows git's global options before the subcommand (`git --no-pager diff`,
// `git -C dir diff`, `git -c k=v diff`).
const GIT_INSPECT_SRC = String.raw`\bgit(?:\s+(?:--no-pager|-[Cc]\s+\S+))*\s+(?:diff|status|show)\b`;
const GIT_INSPECT_RE = new RegExp(GIT_INSPECT_SRC, 'g');
function findGitDiffOnIgnoredPaths(raw, isIgnored) {
  const hits = [];
  const lines = raw.split('\n');
  for (const { lineNum, text: first } of runLineMatches(raw, new RegExp(GIT_INSPECT_SRC))) {
    if (first.includes('hygiene-ignored-diff-ok:')) continue;
    // Join backslash continuations so `git diff --quiet \` + next-line path is seen.
    let text = first;
    for (let j = lineNum; text.endsWith('\\') && j < lines.length; j++) {
      text = text.slice(0, -1) + ' ' + lines[j].trim();
    }
    const seen = new Set();
    GIT_INSPECT_RE.lastIndex = 0;
    let m;
    while ((m = GIT_INSPECT_RE.exec(text))) {
      const rest = text.slice(m.index + m[0].length).split(/\|\||&&|[|;)#]/)[0];
      for (let tok of rest.trim().split(/\s+/)) {
        tok = tok.replace(/^["']+|["']+$/g, '');
        if (!tok || tok.startsWith('-') || tok.includes('$')) continue;
        if (tok.includes(':')) tok = tok.slice(tok.indexOf(':') + 1);
        if (!tok || !(tok.includes('/') || tok.endsWith('.json'))) continue;
        if (seen.has(tok)) continue;
        seen.add(tok);
        if (isIgnored(tok)) hits.push({ lineNum, text, path: tok });
      }
    }
  }
  return hits;
}

/**
 * Rule (r) (BRO-4266): a job that runs checkout-core-data (or checks out the
 * broadway-scorecard-data repo directly with actions/checkout) under a job-level
 * `timeout-minutes` below CORE_DATA_JOB_MIN_TIMEOUT. The repo checkout plus the
 * core-data clone alone can take 3-5 min on a slow runner, so update-show-
 * status.yml's 3- and 5-minute jobs were CANCELLED before their own step ran
 * (check-opening-night-readiness 09-28/10-01, catchup-zero-review-shows
 * 08-06/10-05). A job with no job-level timeout inherits GitHub's 360 min and
 * is not flagged.
 *
 * ADVISORY at introduction (CLAUDE.md §19). Exempt a job with
 * `# hygiene-short-timeout-ok: <reason>` anywhere in its block.
 *
 * Returns [{ job, lineNum, timeoutMin }].
 */
const CORE_DATA_JOB_MIN_TIMEOUT = 8;
function findShortCoreDataJobTimeouts(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return [];
  const starts = findJobBoundaries(lines, jobsIdx);
  const hits = [];
  for (let j = 0; j < starts.length - 1; j++) {
    const block = lines.slice(starts[j], starts[j + 1]);
    const code = block.filter((l) => !l.trimStart().startsWith('#'));
    // The composite action, or a direct actions/checkout of the same private repo.
    if (!code.some((l) => /uses:\s*\.\/\.github\/actions\/checkout-core-data\b/.test(l)
      || /repository:\s*['"]?thomaspryor\/broadway-scorecard-data\b/.test(l))) continue;
    if (block.some((l) => /hygiene-short-timeout-ok:/.test(l))) continue;
    const timeoutMin = jobTimeoutMinutes(block);
    if (timeoutMin === null || timeoutMin >= CORE_DATA_JOB_MIN_TIMEOUT) continue;
    hits.push({ job: block[0].trim().replace(/:\s*$/, ''), lineNum: starts[j] + 1, timeoutMin });
  }
  return hits;
}

// ── Rules (s)/(t)/(u): step-scoped shell-safety rules (BRO-5046/4730/4621) ──────

/**
 * Split a workflow's raw YAML into its job steps (list items at indent 6).
 * Returns [{ name, startLine (0-based), endLine (exclusive), lines }]. A step
 * ends at the next step start or at the first non-blank line indented <= 4.
 */
function splitWorkflowSteps(raw) {
  const lines = raw.split('\n');
  const steps = [];
  let cur = null;
  const close = (end) => {
    if (!cur) return;
    cur.endLine = end;
    cur.lines = lines.slice(cur.startLine, end);
    const m = cur.lines.join('\n').match(/^\s*(?:- )?name:\s*(.+?)\s*$/m);
    cur.name = m ? m[1].replace(/^['"]|['"]$/g, '') : '(unnamed)';
    steps.push(cur);
    cur = null;
  };
  let inSteps = false; // only list items under a job's `steps:` key (indent 4) are steps
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = indentOf(l);
    if (ind <= 4 && !l.trimStart().startsWith('#')) {
      close(i);
      inSteps = ind === 4 && /^ {4}steps\s*:\s*$/.test(l);
      continue;
    }
    if (inSteps && /^ {6}- /.test(l)) { close(i); cur = { startLine: i }; }
  }
  close(lines.length);
  return steps;
}

const stripComments = (lines) => lines.filter((l) => !l.trimStart().startsWith('#'));

/**
 * Rule (s) (BRO-5046): `node … | tee` in a step whose shell has no pipefail.
 * A `run:` with no `shell:` executes as `bash -e {0}` (NO pipefail), so the
 * pipeline's status is tee's and a failing node script exits 0. Explicit
 * `shell: bash` runs `-eo pipefail`. Exempt: the step (or the workflow's
 * defaults) sets shell: bash, the block mentions pipefail, or it reads
 * PIPESTATUS. Fix: add `shell: bash` to the step.
 */
const NODE_TEE_RE = /\b(?:node|npx|tsx)\b[^\n|]*\|\s*tee\b/;
function findNodeTeeWithoutPipefail(raw) {
  if (/^\s*defaults:\s*\n\s*run:\s*\n\s*shell:\s*bash\b/m.test(raw)) return [];
  const out = [];
  for (const step of splitWorkflowSteps(raw)) {
    const body = stripComments(step.lines);
    // Join `\` continuations so `node a.js \ --x | tee` is one logical line.
    const text = body.join('\n').replace(/\\\n\s*/g, ' ');
    if (!NODE_TEE_RE.test(text)) continue;
    if (/pipefail|PIPESTATUS/.test(text)) continue;
    if (body.some((l) => /^\s*(?:- )?shell:\s*bash\b/.test(l))) continue;
    const idx = body.findIndex((l) => /\|\s*tee\b/.test(l));
    out.push({ name: step.name, lineNum: step.startLine + 1 + step.lines.indexOf(body[Math.max(idx, 0)]) });
  }
  return out;
}

/**
 * Rule (t) (BRO-4730, BRO-3342 cousins): push-with-retry.sh followed by a
 * `|| echo …` / `|| true` / `|| :` handler swallows a terminal push failure.
 * Re-raising (`|| { …; exit 1; }`) is fine; a deliberately non-blocking push
 * uses step-level `continue-on-error: true` instead. Logical lines are joined
 * across `\` continuations.
 */
function maskedPushHandler(line) {
  const m = line.match(/push-with-retry\.sh(?:\s+[^|\s]\S*)*\s*(?:\|\|\s*(.*))?$/);
  if (!m || line.trim().startsWith('#') || !m[1]) return null;
  const handler = m[1].trim();
  return /\bexit\s+[1-9]/.test(handler) || /\breturn\s+[1-9]/.test(handler) ? null : handler;
}
function findMaskedPushFailures(raw) {
  const out = [];
  for (const step of splitWorkflowSteps(raw)) {
    for (let i = 0; i < step.lines.length; i++) {
      let logical = step.lines[i];
      if (!/push-with-retry\.sh/.test(logical)) continue;
      let j = i;
      while (/\\\s*$/.test(logical) && j + 1 < step.lines.length) logical = logical.replace(/\\\s*$/, ' ') + step.lines[++j].trim();
      const h = maskedPushHandler(logical);
      if (h) out.push({ name: step.name, lineNum: step.startLine + i + 1, handler: h });
    }
  }
  return out;
}

/**
 * Rule (z) (BRO-3341): a step that opts into the Git Data API REST ref-update
 * fallback (`PUSH_API_REST_REF_UPDATE` set to anything but 0/false) stages
 * files the fallback has not been proven safe for. "Proven" means the path is
 * in core-data-merge-registry (apiFallbackSafe or apiFallbackMerge) or is a
 * branch-ruleset RESTRICTED_FILE_PATHS glob (the fallback's own admission
 * check handles those). Anything else may race the contents API and clobber a
 * concurrent writer. Warn-only: the CLI lists hits without failing.
 */
function findRestFallbackUnprovenPaths(raw) {
  if (raw.includes('hygiene-rest-fallback-ok:')) return []; // file-level exemption
  const { extractStagedPaths, classifyPushFallbackSafety } = require('./audit-push-retry-budgets.js');
  const { matchesRestrictedPath } = require('./branch-ruleset-paths.js');
  // push-via-git-api.sh engages only on exactly "1".
  const OPT_IN = /(?:^|\s)(?:export\s+)?PUSH_API_REST_REF_UPDATE\s*[:=]\s*['"]?1['"]?(?=\s|#|$)/m;
  // Literal git-add args extractStagedPaths drops (non-data/ files, and
  // adds it cannot resolve statically: `.`, `-A`, bare directories).
  const extraTokens = (text) => {
    const toks = [];
    for (const m of text.matchAll(/(?<![\w.-])git\s+add\b([^\n]*)/g)) {
      let rest = m[1];
      const stop = rest.match(/\|\||&&|;|(?:^|\s)#/);
      if (stop) rest = rest.slice(0, stop.index);
      for (const raw of rest.trim().split(/\s+/)) {
        const t = raw.replace(/^['"]|['"]$/g, '');
        if (!t || t.includes('$') || /[<>|]/.test(t)) continue;
        if (t === '.' || t === '-A' || t === '--all' || t === '-a' || t.endsWith('/')) toks.push(t);
        else if (!t.startsWith('-') && !t.startsWith('data/')) toks.push(t);
      }
    }
    return toks;
  };
  const out = [];
  const steps = splitWorkflowSteps(raw);
  // Workflow- or job-level `env:` (outside every step) opts in all push steps.
  const inStep = new Set();
  for (const st of steps) for (let i = st.startLine; i < st.endLine; i++) inStep.add(i);
  const outside = raw.split('\n').filter((_, i) => !inStep.has(i));
  const globalOptIn = OPT_IN.test(stripComments(outside).join('\n'));
  for (const step of steps) {
    const text = stripComments(step.lines).join('\n');
    if (!globalOptIn && !OPT_IN.test(text)) continue;
    if (globalOptIn && !/push-with-retry\.sh/.test(text)) continue;
    const unproven = [...new Set([...extractStagedPaths(text), ...extraTokens(text)])].filter((p) => {
      const c = classifyPushFallbackSafety(p);
      return !c.isApiFallbackSafe && !c.isApiFallbackMerge && !matchesRestrictedPath(p);
    });
    if (unproven.length > 0) out.push({ name: step.name, lineNum: step.startLine + 1, paths: unproven });
  }
  return out;
}

/**
 * Rule (u) (BRO-4621): a STRING workflow_dispatch/workflow_call input
 * interpolated straight into a `run:` script (`${{ inputs.x }}`) is a shell
 * injection sink: the value is pasted into the script before bash parses it.
 * boolean/choice/number inputs cannot carry shell metacharacters and are
 * ignored. Fix: pass it through the step's `env:` and use "$VAR".
 */
function declaredInputTypes(raw) {
  const types = {};
  const lines = raw.split('\n');
  const onIdx = lines.findIndex((l) => /^(?:on|'on'|"on")\s*:/.test(l));
  if (onIdx === -1) return types;
  let inInputs = false;
  let inputsIndent = -1;
  let cur = null;
  for (let i = onIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
    if (indentOf(l) === 0) break;
    const ind = indentOf(l);
    if (/^\s*inputs\s*:\s*$/.test(l)) { inInputs = true; inputsIndent = ind; cur = null; continue; }
    if (inInputs && ind <= inputsIndent) inInputs = false;
    if (!inInputs) continue;
    const k = l.match(/^(\s*)([\w-]+)\s*:\s*$/);
    if (k && ind === inputsIndent + 2) { cur = k[2]; types[cur] = 'string'; continue; }
    const t = l.match(/^\s*type\s*:\s*['"]?(\w+)['"]?/);
    if (t && cur && ind === inputsIndent + 4) types[cur] = t[1];
  }
  return types;
}
// Any ${{ ... }} that mentions inputs.<name>, narrowed in stringInputOf() below.
const INPUT_EXPR_RE = /\$\{\{([^}]*(?<![\w.])(?:github\.event\.)?inputs\.([\w-]+)[^}]*)\}\}/g;
// A bare comparison (`inputs.x == 'y'`) yields a boolean, never attacker text.
const COMPARISON_ONLY_RE = /^\s*(?:github\.event\.)?inputs\.[\w-]+\s*[!=]=\s*(?:'[^']*'|"[^"]*"|true|false|\d+)\s*$/;
function findStringInputInterpolation(raw) {
  const types = declaredInputTypes(raw);
  const out = [];
  for (const step of splitWorkflowSteps(raw)) {
    const lines = step.lines;
    const runIdx = lines.findIndex((l) => RUN_LINE_RE.test(l.trim()));
    if (runIdx === -1) continue;
    const runIndent = indentOf(lines[runIdx]) + (/^\s*-\s/.test(lines[runIdx]) ? 2 : 0);
    for (let i = runIdx; i < lines.length; i++) {
      const l = lines[i];
      if (i > runIdx && l.trim() !== '' && indentOf(l) <= runIndent && /^\s*[\w-]+\s*:/.test(l)) break;
      if (l.trimStart().startsWith('#')) continue;
      let m;
      INPUT_EXPR_RE.lastIndex = 0;
      while ((m = INPUT_EXPR_RE.exec(l))) {
        if (!COMPARISON_ONLY_RE.test(m[1]) && (types[m[2]] || 'string') === 'string') out.push({ name: step.name, lineNum: step.startLine + i + 1, input: m[2] });
      }
    }
  }
  return out;
}

/**
 * Rules (t)/(u) for a composite action.yml (steps sit at indent 4, `inputs.*`
 * are strings unless typed): masked push-with-retry.sh lines, and
 * `${{ inputs.x }}` inside a `run:` / `script:` (github-script) block.
 */
function findCompositeShellHazards(raw) {
  const lines = raw.split('\n');
  const out = [];
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (blockIndent >= 0) {
      if (l.trim() !== '' && indentOf(l) <= blockIndent) blockIndent = -1;
      else if (!l.trimStart().startsWith('#')) {
        const h = maskedPushHandler(l);
        if (h) out.push({ kind: 'masked-push', lineNum: i + 1, detail: `|| ${h}` });
        INPUT_EXPR_RE.lastIndex = 0;
        let m;
        while ((m = INPUT_EXPR_RE.exec(l))) if (!COMPARISON_ONLY_RE.test(m[1])) out.push({ kind: 'string-input', lineNum: i + 1, detail: `inputs.${m[2]}` });
        continue;
      }
    }
    if (/^\s*(?:-\s+)?(?:run|script)\s*:\s*[|>][+-]?\d*\s*$/.test(l)) blockIndent = indentOf(l) + (/^\s*-\s/.test(l) ? 2 : 0);
  }
  return out;
}

/**
 * Rule (v): a root-repo push in a job whose declared permissions lack
 * `contents: write` (BRO-5302).
 *
 * `push-with-retry.sh` pushes the ROOT checkout as github-actions[bot] with the
 * actions/checkout GITHUB_TOKEN. Under `permissions: contents: read` (or a
 * block that omits contents) every attempt 403s ("Permission to ... denied to
 * github-actions[bot]"), and the Git Data API fallback 403s too. Short runs hide
 * it (no diff, no push); a ledger commit step marked continue-on-error hides it
 * forever; a long run that does reach the push fails the job and pages. The
 * opening-night orchestrator hit it on 2026-10-13 after a 5h poll.
 *
 * Effective permissions: a job-level `permissions:` block wins over the
 * workflow-level one. A workflow with NO block at either level inherits the repo
 * default token, which is treated as write (about 60 workflows push this way and
 * land commits), so it is skipped. If the repo default is ever flipped to read,
 * this rule stays silent while they all break at once.
 *
 * Counts a push as: a real `bash|sh ... push-with-retry.sh` call (an echo that
 * merely names the script does not match) or `uses:` of a composite that runs
 * push-with-retry.sh on the root checkout. Composites that push OTHER repos
 * (checkout-core-data, push-core-data) are NESTED_PUSH_COMPOSITES and ignored;
 * the unit test pins every action.yml that mentions push-with-retry.sh to one of
 * the two lists so a new composite cannot slip past unclassified.
 */
const ROOT_PUSH_COMPOSITES = ['commit-scraper-spend-ledger', 'commit-stage-latency'];
const NESTED_PUSH_COMPOSITES = ['checkout-core-data', 'push-core-data'];

function readPermissionsGrant(lines, idx, scope) {
  const indent = indentOf(lines[idx]);
  const re = new RegExp(`^\\s*${scope}\\s*:\\s*['"]?write\\b`);
  const inline = lines[idx].replace(/^[^:]*:/, '').replace(/#.*$/, '').trim();
  if (inline) return inline === 'write-all' || new RegExp(`\\b${scope}\\s*:\\s*['"]?write\\b`).test(inline); // flow map: { contents: write }
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (indentOf(l) <= indent) break;
    if (re.test(l)) return true;
  }
  return false;
}
const readPermissionsGrantsContentsWrite = (lines, idx) => readPermissionsGrant(lines, idx, 'contents');

function findPushWithoutWritePermission(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return [];
  const topIdx = lines.findIndex((l) => /^permissions\s*:/.test(l));
  const top = topIdx === -1 ? null : readPermissionsGrantsContentsWrite(lines, topIdx);
  const composite = new RegExp(
    `^\\s*-?\\s*uses:\\s*\\./\\.github/actions/(${ROOT_PUSH_COMPOSITES.join('|')})\\s*(#.*)?$`,
  );
  // `bash [-x] path`, `sh path`, `source path`, `. path`, or a bare `./path` at the start of a command.
  const direct = /(?:\b(?:bash|sh|source)\s+(?:-\S+\s+)*|(?:^|[\s;&|])\.\s+|^\s*(?:-\s+)?(?:run:\s*[|>]?\s*)?\.\/)\S*push-with-retry\.sh/;
  const starts = findJobBoundaries(lines, jobsIdx);
  const hits = [];
  for (let j = 0; j < starts.length - 1; j++) {
    const jobKey = lines[starts[j]].trim().replace(/:\s*$/, '');
    const body = lines.slice(starts[j], starts[j + 1]);
    const jobPermOffset = body.findIndex(
      (l) => indentOf(l) === 4 && /^\s*permissions\s*:/.test(l),
    );
    const grants =
      jobPermOffset !== -1 ? readPermissionsGrantsContentsWrite(body, jobPermOffset) : top;
    if (grants === null || grants === true) continue; // undeclared (repo default) or write
    for (let k = 0; k < body.length; k++) {
      const l = body[k];
      if (l.trim().startsWith('#')) continue;
      if (direct.test(l) || composite.test(l)) {
        hits.push({ job: jobKey, lineNum: starts[j] + k + 1, text: l.trim() });
      }
    }
  }
  return hits;
}

/**
 * Rule (w): `gh workflow run` / `gh run cancel|rerun` / a `/dispatches` API call
 * in a step that authenticates with the workflow token (no secrets-backed
 * GH_TOKEN/GITHUB_TOKEN in the step env), inside a job whose declared permissions
 * lack `actions: write` (BRO-5302 cousin; the 13-workflow silent-403 fix recorded
 * in memory/roadmap.md was the first instance). Same effective-permissions
 * semantics as rule (v): job-level wins, no block anywhere = repo default, skipped.
 */
// `gh api .../actions/workflows/<id>/dispatches` only: repository_dispatch (`repos/o/r/dispatches`) needs
// contents: write, not actions: write.
const DISPATCH_RE = /\bgh\s+(?:workflow\s+run|run\s+(?:cancel|rerun))\b|\bgh\s+api\b[^\n]*\/workflows\/[^/\s]+\/dispatches\b/;
// Composites that run `gh workflow run` with the workflow token (their action.yml sets
// GH_TOKEN: ${{ github.token }}). `uses:` of one counts as a dispatch in the calling job.
// Pinned by the unit test against every .github/actions/*/action.yml.
const DISPATCH_COMPOSITES = ['dispatch-deploy'];
// A PAT, not the workflow token: GH_TOKEN/GITHUB_TOKEN from a secret other than secrets.GITHUB_TOKEN.
const PAT_ENV_RE = /\b(?:GH_TOKEN|GITHUB_TOKEN)\s*:\s*\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/;
function findDispatchWithoutActionsWrite(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return [];
  const topIdx = lines.findIndex((l) => /^permissions\s*:/.test(l));
  const top = topIdx === -1 ? null : readPermissionsGrant(lines, topIdx, 'actions');
  const workflowEnvPat = PAT_ENV_RE.test(lines.slice(0, jobsIdx).join('\n'));
  const compositeUse = new RegExp(
    `^\\s*-?\\s*uses:\\s*\\./\\.github/actions/(${DISPATCH_COMPOSITES.join('|')})\\s*(#.*)?$`,
  );
  const starts = findJobBoundaries(lines, jobsIdx);
  const steps = splitWorkflowSteps(raw);
  const hits = [];
  for (let j = 0; j < starts.length - 1; j++) {
    const jobKey = lines[starts[j]].trim().replace(/:\s*$/, '');
    const body = lines.slice(starts[j], starts[j + 1]);
    const permOffset = body.findIndex((l) => indentOf(l) === 4 && /^\s*permissions\s*:/.test(l));
    const grants = permOffset !== -1 ? readPermissionsGrant(body, permOffset, 'actions') : top;
    if (grants === null || grants === true) continue;
    const stepsAt = body.findIndex((l) => /^ {4}steps\s*:/.test(l));
    const jobEnvPat = PAT_ENV_RE.test(body.slice(0, stepsAt === -1 ? 0 : stepsAt).join('\n'));
    for (const step of steps.filter((s) => s.startLine > starts[j] && s.startLine < starts[j + 1])) {
      if (workflowEnvPat || jobEnvPat || PAT_ENV_RE.test(step.lines.join('\n'))) continue;
      step.lines.forEach((l, k) => {
        if (!l.trim().startsWith('#') && (DISPATCH_RE.test(l) || compositeUse.test(l))) {
          hits.push({ job: jobKey, lineNum: step.startLine + k + 1, text: l.trim() });
        }
      });
    }
  }
  return hits;
}

/**
 * Rule (x): a step that runs a script whose self-heal dispatches workflows with
 * `process.env.GITHUB_TOKEN || REVIEW_TEXTS_TOKEN` (scripts/lib/dispatch-*.js,
 * opening-night-remediation.js) but has no GITHUB_TOKEN/GH_TOKEN/REVIEW_TEXTS_TOKEN
 * in its step, job or workflow env. Every dispatch then fails `no-token` and the
 * failure is only an annotation (BRO-2872: considered=7 dispatched=0 on 2026-09-05
 * and 2026-10-01). Add a script to TOKEN_REQUIRED_SCRIPTS when its dispatcher
 * reads the token from the environment.
 */
const TOKEN_REQUIRED_SCRIPTS = ['opening-night-checklist.js'];
const TOKEN_ENV_RE = /\b(?:GITHUB_TOKEN|GH_TOKEN|REVIEW_TEXTS_TOKEN)\s*:/;
function findScriptWithoutDispatchToken(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return [];
  const workflowEnv = TOKEN_ENV_RE.test(lines.slice(0, jobsIdx).join('\n'));
  const scriptRe = new RegExp(`\\bnode\\s+scripts/(?:${TOKEN_REQUIRED_SCRIPTS.map((s) => s.replace(/\./g, '\\.')).join('|')})\\b`);
  const starts = findJobBoundaries(lines, jobsIdx);
  const steps = splitWorkflowSteps(raw);
  const hits = [];
  for (let j = 0; j < starts.length - 1; j++) {
    const jobKey = lines[starts[j]].trim().replace(/:\s*$/, '');
    const body = lines.slice(starts[j], starts[j + 1]);
    const stepsAt = body.findIndex((l) => /^ {4}steps\s*:/.test(l));
    const jobEnv = TOKEN_ENV_RE.test(body.slice(0, stepsAt === -1 ? 0 : stepsAt).join('\n'));
    for (const step of steps.filter((s) => s.startLine > starts[j] && s.startLine < starts[j + 1])) {
      if (workflowEnv || jobEnv || TOKEN_ENV_RE.test(step.lines.join('\n'))) continue;
      step.lines.forEach((l, k) => {
        if (!l.trim().startsWith('#') && scriptRe.test(l)) {
          hits.push({ job: jobKey, lineNum: step.startLine + k + 1, text: l.trim() });
        }
      });
    }
  }
  return hits;
}

/**
 * Rule (z) (BRO-5972, BRO-6029): a git network command with no wall-clock cap.
 * A stalled transfer never returns, so the step waits for the job timeout (or
 * GitHub's 6h default when the job sets none) instead of failing in minutes.
 * Wrap it as `git_net <secs> clone|fetch|pull|push ...` (scripts/lib/git-net-timeout.sh,
 * BRO-4966) or under `timeout`. Scans run-block lines (comments skipped).
 *
 * Not flagged: `--mirror`/`--bare` clones (the r2/gitlab archive jobs, whose
 * size varies too much for one cap and whose job timeout bounds them), lines
 * that start with `echo`/`printf` (messages that mention a clone), and lines
 * bounded by `git_net` or `timeout`/`gtimeout`. Each command is checked separately
 * so a bounded fetch cannot hide an unbounded push on the same line. A command split
 * across a `\` continuation is judged by its first line only.
 *
 * ADVISORY at introduction (CLAUDE.md §19). Exempt one command with
 * `# hygiene-unbounded-clone-ok: <reason>` on its line or the line above.
 *
 * Returns [{ lineNum, text }].
 */
// git's global options may sit before the subcommand; their values may be quoted.
const GIT_GLOBAL_OPTIONS = String.raw`(?:\s+(?:--no-pager|--bare|-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)))*`;
const GIT_CLONE_RE = new RegExp(String.raw`\bgit${GIT_GLOBAL_OPTIONS}\s+(clone)\b`, 'g');
const GIT_NETWORK_RE = new RegExp(String.raw`\bgit${GIT_GLOBAL_OPTIONS}\s+(clone|fetch|pull|push)\b`, 'g');
const UNBOUNDED_CLONE_OK_RE = /hygiene-unbounded-clone-ok:/;
function findUnboundedGitCommands(raw, pattern) {
  const lines = raw.split('\n');
  // runLineMatches expects a stateless regex; matchAll below needs the global one.
  return runLineMatches(raw, new RegExp(pattern.source)).filter(({ lineNum, text }) => {
    // A trailing `# ...` comment is dropped so its words (e.g. "timeout")
    // cannot vouch for the command.
    const body = text.replace(/^\s*(?:-\s+)?run:\s*/, '').replace(/\s+#.*$/, '').trim();
    // Quoted message text can contain shell separators without executing them.
    // Command substitutions inside messages still execute and need a cap.
    // A redirect may name one file; shell operators after it must still be scanned.
    if (!/\$\(|(?<!\\)`/.test(body) && (
      /^(?:echo|printf)\b[^;&|]*$/.test(body) ||
      /^(?:echo|printf)\s+(?:"(?:\\.|[^"\\])*"|'[^']*')(?:\s+(?:"(?:\\.|[^"\\])*"|'[^']*'))*(?:\s*>>?\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"';&|<>]+))?\s*$/.test(body)
    )) return false;
    if (UNBOUNDED_CLONE_OK_RE.test(text) || UNBOUNDED_CLONE_OK_RE.test(lines[lineNum - 2] || '')) return false;
    return [...body.matchAll(pattern)].some((match) => {
      const before = body.slice(0, match.index);
      // Escaped backticks in heredoc prose do not execute a command.
      if (before.endsWith('\\`')) return false;
      const command = body.slice(match.index).split(/[;&|]/)[0];
      if (match[1] === 'clone' && /--mirror\b|--bare\b/.test(command)) return false;
      // Quoted arguments (e.g. env NOTE="timeout 60") cannot supply a
      // timeout wrapper. Keep a placeholder so quoted duration arguments
      // still count, without treating their contents as shell commands.
      const unquotedBefore = before.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
      if (/(?:^|[^\w./-])(?:timeout|gtimeout)\s+[^;&|()]*$/.test(unquotedBefore)) return false;
      return true;
    });
  });
}

// Keep the clone-only API for the existing clone migration check.
function findUnboundedGitClones(raw) {
  return findUnboundedGitCommands(raw, GIT_CLONE_RE);
}

function findUnboundedGitNetworkCommands(raw) {
  return findUnboundedGitCommands(raw, GIT_NETWORK_RE);
}

/**
 * Rule (z2): a `git_net` call before the run block defines it (BRO-6029).
 * git_net is a shell function each run block must source
 * (scripts/lib/git-net-timeout.sh, with the fail-open `git_net() { ... }`
 * fallback). A block that sources it only further down, or an inline
 * `run: git_net ...` that cannot source it, dies with "git_net: command not
 * found" (exit 127). BRO-6029's first rewrite did exactly this in three blocks
 * whose BRO-5972 source line sat below the new fetch.
 */
const GIT_NET_SOURCE_RE = /^\s*(?:\.|source)\s+\S*git-net-timeout\.sh\b|\bgit_net\s*\(\)\s*\{/;
const GIT_NET_CALL_RE = /(?:^|[\s;&|({!`]|\$\()git_net\s+(?:\d|["'$])/;
function findGitNetUsedBeforeSource(raw) {
  const hits = [];
  for (const block of extractRunBlocks(raw, { includeInline: true })) {
    let defined = false;
    for (const { lineNum, text } of block.lines) {
      const t = text.trim();
      if (t.startsWith('#')) continue;
      if (GIT_NET_SOURCE_RE.test(t)) { defined = true; continue; }
      if (!defined && GIT_NET_CALL_RE.test(t.replace(/\s#.*$/, ''))) hits.push({ lineNum, text: t });
    }
  }
  return hits;
}

/**
 * Rule (aa): every workflow declares a top-level `permissions:` block
 * (BRO-6398). With no block anywhere the job runs on the repository default,
 * which is write-all here, so a planted or prompt-injected step can push,
 * open issues and dispatch workflows with the GITHUB_TOKEN. A job-level block
 * alone is not enough: jobs without one still inherit the default.
 */
function findMissingTopLevelPermissions(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return [];
  if (lines.some((l) => /^permissions\s*:/.test(l))) return [];
  return [{ lineNum: jobsIdx + 1, text: 'no top-level permissions: block (jobs without their own inherit the repo default, write-all)' }];
}

/**
 * Rule (ab): an external action (`owner/repo[/path]@ref`) is pinned to a full
 * 40-hex commit SHA, never a tag or branch (BRO-6398). Tags move: the Trivy,
 * Checkmarx KICS and Mini Shai-Hulud incidents all re-pointed release tags at
 * malicious commits, so a tag pin runs whatever the tag points at today. Local
 * composites (`./.github/actions/...`) have no `@ref` and are not actions
 * this rule sees. Dependabot's github-actions group keeps the SHAs current.
 */
const EXTERNAL_USES_RE = /^\s*-?\s*uses:\s*['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s#'"]+)/;
// A container step is the same exposure: `docker://image:tag` re-resolves on
// every run; only `docker://image@sha256:<digest>` is a fixed artifact.
const DOCKER_USES_RE = /^\s*-?\s*uses:\s*['"]?docker:\/\/([^\s#'"]+)/;
function findUnpinnedActionUses(raw) {
  const hits = [];
  raw.split('\n').forEach((l, i) => {
    if (l.trim().startsWith('#')) return;
    const m = EXTERNAL_USES_RE.exec(l);
    if (m && !/^[0-9a-f]{40}$/.test(m[2])) hits.push({ lineNum: i + 1, text: l.trim(), action: m[1], ref: m[2] });
    const d = DOCKER_USES_RE.exec(l);
    if (d && !/@sha256:[0-9a-f]{64}$/.test(d[1])) hits.push({ lineNum: i + 1, text: l.trim(), action: 'docker://' + d[1].split('@')[0].split(':')[0], ref: d[1].includes('@') ? d[1].split('@')[1] : d[1].split(':')[1] || 'latest' });
  });
  return hits;
}

/**
 * Rule (ac): no `node-version:` at or below Node 20 (BRO-6398). Node 20
 * reached end of life in April 2026 and did not receive the 21 October 2026
 * security release (Brotli decoder RCE, TLS hostname bypass), while the
 * scrapers on these runners read untrusted web pages. Raise NODE_MIN_MAJOR
 * when the next line goes EOL.
 */
const NODE_MIN_MAJOR = 22;
function findEolNodeVersions(raw) {
  const hits = [];
  raw.split('\n').forEach((l, i) => {
    if (l.trim().startsWith('#')) return;
    const m = /^\s*-?\s*node-version:\s*['"]?v?(\d+)(?:\.(?:\d+|x))*['"]?\s*(?:#.*)?$/.exec(l);
    if (m && Number(m[1]) < NODE_MIN_MAJOR) hits.push({ lineNum: i + 1, text: l.trim(), major: Number(m[1]) });
  });
  return hits;
}

module.exports = {
  findMissingTopLevelPermissions,
  findUnpinnedActionUses,
  findEolNodeVersions,
  NODE_MIN_MAJOR,
  findUnboundedGitNetworkCommands,
  findGitNetUsedBeforeSource,
  findUnboundedGitClones,
  findDispatchWithoutActionsWrite,
  findScriptWithoutDispatchToken,
  TOKEN_REQUIRED_SCRIPTS,
  DISPATCH_COMPOSITES,
  findCompositeShellHazards,
  splitWorkflowSteps,
  findNodeTeeWithoutPipefail,
  maskedPushHandler,
  findMaskedPushFailures,
  findRestFallbackUnprovenPaths,
  declaredInputTypes,
  findStringInputInterpolation,
  CORE_DATA_JOB_MIN_TIMEOUT,
  findShortCoreDataJobTimeouts,
  findGitDiffOnIgnoredPaths,
  indentOf,
  RUN_LINE_RE,
  findFullBlobFullHistoryCheckouts,
  findJobBoundaries,
  readWorkflowJobBlocks,
  jobTimeoutMinutes,
  runLineMatches,
  findMissingGitIdentityCommits,
  findCoreFileWritesWithoutPush,
  findDeadCommitSteps,
  extractRunBlocks,
  findPipefailDeadExitCodeEcho,
  extractSingleQuotedEvalBodies,
  findUnescapedDoubleQuotesInDoubleQuotedEval,
  findBareAuditDirectoryGlobs,
  findPushWithoutWritePermission,
  ROOT_PUSH_COMPOSITES,
  NESTED_PUSH_COMPOSITES,
};
