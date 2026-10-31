// Shared shell-text helpers for the workflow ledger guards. These are
// deliberately text-based, not a YAML or shell parser. A line starting with
// `#` is treated as a comment even inside a script block's template literal.
const COMMENT_LINE_RE = /^\s*#/;
const DONE_RE = /^\s*done\s*$/;
// Tolerate a trailing comment after `do`, including workflow-line-length-ok.
const FOR_LOOP_INLINE_DO_RE = /^\s*for\s+(\w+)\s+in\s+(.+?);\s*do\s*(?:#.*)?$/;
const FOR_LOOP_HEADER_RE = /^\s*for\s+(\w+)\s+in\s+(.+?)\s*$/;
const BARE_DO_RE = /^\s*do\s*$/;

// Join bash `\`-continued lines before matching commands or for-loop lists.
function joinBackslashContinuations(lines) {
  const result = [];
  let buffer = '';
  let buffering = false;
  for (const line of lines) {
    const continues = /\\\s*$/.test(line);
    const stripped = line.replace(/\\\s*$/, '');
    buffer = buffering ? buffer + ' ' + stripped.trim() : stripped;
    if (continues) {
      buffering = true;
    } else {
      result.push(buffer);
      buffer = '';
      buffering = false;
    }
  }
  if (buffering) result.push(buffer);
  return result;
}

// Return the loop variable, list and first body index for inline `do` or
// `do` on the next line; return null when this line does not start a loop.
function matchForLoopStart(jobLines, i) {
  const line = jobLines[i];
  let m = line.match(FOR_LOOP_INLINE_DO_RE);
  if (m) return { varName: m[1], list: m[2], bodyStart: i + 1 };
  m = line.match(FOR_LOOP_HEADER_RE);
  if (m && jobLines[i + 1] && BARE_DO_RE.test(jobLines[i + 1])) {
    return { varName: m[1], list: m[2], bodyStart: i + 2 };
  }
  return null;
}

module.exports = { joinBackslashContinuations, matchForLoopStart, COMMENT_LINE_RE, DONE_RE };
