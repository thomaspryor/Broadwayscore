'use strict';
// hooks/lib/strip-git-commit-noise.js — BRO-2639.
//
// gh-poll-block.sh's `is_git_commit` flag used to exempt the ENTIRE command
// string from its Rule 1/3/5/6 danger-pattern checks whenever a git-commit-
// shaped statement appeared ANYWHERE in it — not just that statement. A real
// chained dangerous command after the commit (`git commit -m "x"; gh run
// watch 123`) rode the exemption free. This module removes the two things
// that legitimately need shielding from keyword matching — heredoc BODIES
// (never separately-executed statements, always inert data) and the commit
// MESSAGE TEXT itself — so the caller can scan the STRIPPED string with no
// blanket exemption at all, and a real chained statement gets evaluated on
// its own merits.
//
// Deliberately self-contained: gh-poll-block.sh is a global, every-session,
// every-repo hook (~/.claude/hooks/), so it must not depend on any one
// project repo being cloned/present. stripHeredocBodies() below is a ported
// copy of scripts/lib/infra-review-scope.js's hardened implementation
// (Broadwayscore, task #1557's adversarial-review findings) rather than a
// `require()` of that file — see this ticket's plan-review DESIGN BLOCKER 1.
// Keep the two in sync by hand if either evolves; there is no shared runtime
// link between them.

// Same lookbehind/lookahead shape as the Broadwayscore original: pinned to
// EXACTLY two `<` so a here-STRING (`<<<TAG`, no multi-line body) isn't
// misread as a heredoc opener that swallows every following line as fake
// "body" until (if ever) a line matching the tag turns up — a false NEGATIVE
// that would hide a real subsequent statement from the danger-pattern scan,
// the dangerous direction for this fix to fail in.
const HEREDOC_OPEN_RE = /(?<!<)<<(?!<)(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/g;

function stripHeredocBodies(command) {
  const str = String(command || '');
  if (!str.includes('<<')) return str; // fast path — no heredocs
  const lines = str.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    HEREDOC_OPEN_RE.lastIndex = 0;
    const tags = [];
    let m;
    while ((m = HEREDOC_OPEN_RE.exec(line)) !== null) tags.push({ tag: m[3], dashed: !!m[1] });
    // A line can open more than one heredoc (`cmd <<A <<B`); bash consumes
    // their bodies in the order the redirections appear, so a coincidental
    // line matching B's tag inside A's body must not end the strip early.
    for (const { tag, dashed } of tags) {
      const isTerminator = dashed ? (l) => l.replace(/^\t+/, '') === tag : (l) => l === tag;
      while (i < lines.length && !isTerminator(lines[i])) i++;
      if (i >= lines.length) break; // unterminated — nothing left to strip precisely
      i++; // drop the terminator line, continue with the next tag's body (if any)
    }
  }
  return out.join('\n');
}

// Same wrapper-prefix shape gh-poll-block.sh's own anchors use (BRO-2635):
// timeout/env/nohup/nice/command ahead of the real `git commit`. `m` flag so
// `^` matches at the start of any line — `echo "$command" | grep` in the bash
// caller already treats a multi-line command this way (grep tests each line).
const GIT_COMMIT_RE = /(^|;|&&|\|\|)\s*(?:cd [^;&]+\s*(?:;|&&)\s*)?(?:timeout\s+\S+\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+|nohup\s+|nice\s+(?:-n\s*\S+\s+)?|command\s+)*git commit/m;

function hasGitCommitInvocation(command) {
  return GIT_COMMIT_RE.test(String(command || ''));
}

// A message-setting flag TOKEN: -m, --message, or a short-option cluster
// ENDING in 'm' (git combines short flags, so `-am "msg"` is `-a` + `-m`).
// Anchored to a token boundary (start of string or preceding whitespace) so
// it can't match mid-word. `[a-zA-Z]*` before the trailing 'm' also matches
// unrelated flags that happen to end in 'm' (e.g. a hypothetical `-realm`) —
// a KNOWN, ACCEPTED over-match: this only ever REMOVES text before the
// danger-pattern scan runs, which can reduce false-positive sensitivity
// elsewhere but never conceals an actual dangerous COMMAND (flag values are
// string literals, not executed code). Gated on hasGitCommitInvocation() by
// the caller, so it only fires on commands that contain a real commit at all.
const FLAG_TOKEN_RE = /(^|\s)(--message|-[a-zA-Z]*m)/g;

// The value immediately after a flag token: optional attached '=', optional
// whitespace, then a double-quoted (backslash-escape aware, matching bash's
// real double-quote semantics closely enough for this hook's "well-meaning
// Claude, not adversarial" threat model), single-quoted (bash allows NO
// escaping inside single quotes — stops at the very next `'`), or bare value
// (stops at whitespace or a statement-boundary metacharacter).
const AFTER_FLAG_RE = /^(=?)(\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]*)/;

function stripCommitMessageValues(command) {
  const str = String(command || '');
  let out = '';
  let cursor = 0;
  FLAG_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = FLAG_TOKEN_RE.exec(str)) !== null) {
    if (m.index < cursor) { FLAG_TOKEN_RE.lastIndex = cursor; continue; }
    const flagEnd = m.index + m[0].length;
    const rest = str.slice(flagEnd);
    const vm = AFTER_FLAG_RE.exec(rest);
    if (!vm || !vm[3]) continue; // no value followed this flag — nothing to strip
    out += str.slice(cursor, flagEnd);
    out += vm[1] + vm[2]; // keep the '=' / whitespace separator, drop the value text
    cursor = flagEnd + vm[0].length;
    FLAG_TOKEN_RE.lastIndex = cursor;
  }
  out += str.slice(cursor);
  return out;
}

// The single entry point gh-poll-block.sh calls. Order matters: heredoc
// bodies must be stripped FIRST — a `-m "$(cat <<'EOF' ... EOF)"` heredoc
// body can span many lines and must collapse to nothing before the
// (line-blind) flag/value stripper runs, otherwise a `"` inside the body
// would terminate that regex early or run away across lines. -F/--file
// (message stored in a real FILE on disk) needs no stripping at all — its
// text never appears in the command string — UNLESS the file argument is
// itself a heredoc-backed process substitution (`-F <(cat <<EOF ...)`),
// which the heredoc-body pass already neutralises regardless of the
// surrounding syntax.
function stripForDangerScan(command) {
  const str = String(command || '');
  const noHeredocs = stripHeredocBodies(str);
  if (!hasGitCommitInvocation(noHeredocs)) return noHeredocs;
  return stripCommitMessageValues(noHeredocs);
}

module.exports = {
  stripHeredocBodies,
  hasGitCommitInvocation,
  stripCommitMessageValues,
  stripForDangerScan,
};
