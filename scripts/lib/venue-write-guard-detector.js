/**
 * Venue-write-guard detector (card #1923, follow-up to card #994).
 *
 * Card #994's sanitizeVenueForWrite() (scripts/lib/venue-classification.js)
 * fails closed on placeholder/neighbourhood-blob venue strings before they
 * reach shows.json — a real incident (junk venue text tripping the
 * opening-night orchestrator + a live subscriber broadcast) is what it
 * exists to prevent. Three separate discovery rounds (BRO-160, card #1921,
 * card #1922) each found MORE show-entry builders / venue-writing
 * enrichment scripts skipping it, all via the same ad-hoc
 * `grep -rn "venue:" scripts/*.js | grep -v sanitizeVenueForWrite`. This is
 * that grep, automated: scan every object-literal `venue:` key and
 * `.venue =` assignment in scripts/**, and flag any whose right-hand-side
 * expression does not route through sanitizeVenueForWrite(...) (a bare
 * call, or a ternary of one — the pattern card #1921's
 * buildRegionalShowEntry fix uses: `venue: cond ? sanitizeVenueForWrite(x)
 * : null`).
 *
 * Heuristic, not a real parser — same tradeoff as every other audit-*.js in
 * this repo. The RHS is captured by depth-aware bracket scanning from just
 * after the `venue:`/`.venue =` token to the first top-level `,`, unmatched
 * closing bracket, or `;` — enough to see through a ternary (which has its
 * own `:` at depth 0, deliberately not a stop character) without a real AST.
 *
 * Comment/string handling reuses audit-fetch-timeouts.js's acorn-tokenizer
 * approach (two blanked views, same offsets — see its doc comment for the
 * full rationale) rather than a hand-rolled `//`-only check: a first version
 * of this file used isCommentLine() checking only line comments, which
 * misread a JSDoc block comment's `*   venue: <Playbill venue, as
 * parsed...>` line (promote-ob-historical.js:14) as a real, unguarded call
 * site — caught live by /second-opinion review before this ever reached CI.
 * Reimplemented standalone rather than require()'d from audit-fetch-timeouts.js
 * for the same reason that file gives: it runs a --help gate as a
 * MODULE-LOAD side effect, which would hijack this lib's own callers.
 *
 * Pure detection logic lives here so both the CLI (audit-venue-write-guard.js)
 * and its unit test can call scanVenueWrites() directly (CLAUDE.md §15 —
 * never copy logic into a test).
 */

const OBJECT_LITERAL_KEY_RE = /(?<![\w$.])venue\s*:\s*/g;
const ASSIGNMENT_RE = /(?<![\w$])[\w$.]*\.venue\s*=(?!=)\s*/g;
const GUARD_CALL_RE = /sanitizeVenueForWrite\(/;
const FILE_EXEMPTION = 'venue-write-guard-ok';

// A bare hardcoded string literal RHS (`venue: "Studio 54"`) can never carry
// the incident class card #994 guards against — a placeholder/junk value
// scraped from an external source — because a human typed it directly into
// source code. Excluding this shape (common in historical backfill scripts
// that hand-list dozens of known venues) cuts real noise out of the audit
// without weakening the guarantee: only a DYNAMIC/derived RHS can carry
// untrusted data, and those still require sanitizeVenueForWrite(...).
// Template literals only qualify with no `${...}` interpolation — an
// interpolated template can embed unsanitized data just like any other
// expression.
const STRING_LITERAL_RE = /^(['"])(?:\\.|(?!\1)[^\\])*\1$/;
const TEMPLATE_LITERAL_NO_INTERP_RE = /^`(?:\\.|[^`$]|\$(?!\{))*`$/;

function isHardcodedStringRhs(rhs) {
  const trimmed = rhs.trim();
  return STRING_LITERAL_RE.test(trimmed) || TEMPLATE_LITERAL_NO_INTERP_RE.test(trimmed);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function lineText(source, index) {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  let lineEnd = source.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = source.length;
  return source.slice(lineStart, lineEnd).trim();
}

/**
 * Captures the RHS expression starting at `startIdx` (just past the
 * `venue:`/`.venue =` token). Stops at the first top-level `,`, `;`, or
 * unmatched closing bracket — a ternary's own `:` is NOT a stop character,
 * so `cond ? sanitizeVenueForWrite(x) : null` is captured whole.
 */
function scanRhs(source, startIdx) {
  let depth = 0;
  let i = startIdx;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ',' || ch === ';')) break;
  }
  return source.slice(startIdx, i);
}

/**
 * Two blanked views of the same source, both via acorn's tokenizer, both
 * preserving offsets/newlines (space-fill only) — same idiom as
 * audit-fetch-timeouts.js's stripComments/blankStringsAndComments:
 *
 *   blankStringsAndComments(src) — blanks comments (// and /* *\/) AND
 *     string/template content. Used for CALL-SITE matching: the literal
 *     text "venue:" inside a string or a block comment must never read as a
 *     real object key or assignment.
 *
 *   stripComments(src) — blanks comments only, string/template content
 *     stays intact. Used for reading the RHS text (guard-call check,
 *     hardcoded-string-literal check) — those checks need to SEE the actual
 *     string content, just not a comment merely naming the pattern.
 *
 * FAILS OPEN: acorn unavailable, or the file doesn't parse (most .ts files —
 * acorn has no native TS support) → returns source UNCHANGED. Accepted gap
 * for unparseable files, consistent with this repo's audit-*.js stance.
 */
function blanker(src) {
  const out = src.split('');
  return {
    blank(from, to) {
      for (let k = from; k < to && k < out.length; k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
    },
    result: () => out.join(''),
  };
}

function tokenizeAcorn(src, onToken) {
  let acorn;
  try { acorn = require('acorn'); } catch { return false; }
  try {
    const tokenizer = acorn.tokenizer(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      onComment: (block, text, start, end) => onToken({ type: { label: 'comment' }, start, end }),
    });
    for (const tok of tokenizer) onToken(tok);
  } catch {
    return false;
  }
  return true;
}

function stripComments(src) {
  const b = blanker(src);
  const ok = tokenizeAcorn(src, (tok) => {
    if (tok.type.label === 'comment') b.blank(tok.start, tok.end);
  });
  return ok ? b.result() : src;
}

function blankStringsAndComments(src) {
  const b = blanker(src);
  const ok = tokenizeAcorn(src, (tok) => {
    const label = tok.type.label;
    if (label === 'comment') b.blank(tok.start, tok.end);
    else if (label === 'string' || label === 'regexp') b.blank(tok.start + 1, tok.end - 1);
    else if (label === 'template' || label === 'invalidTemplate') b.blank(tok.start, tok.end);
  });
  return ok ? b.result() : src;
}

/**
 * Scan one file's source for `venue:` / `.venue =` write sites.
 * @param {string} source
 * @returns {Array<{line: number, kind: 'literal'|'assignment', snippet: string, guarded: boolean}>}
 */
function scanVenueWrites(source) {
  if (source.includes(FILE_EXEMPTION)) return [];

  // scanSrc: strings+comments blanked — for finding real call sites, so a
  // string/comment merely containing the text "venue:" can't match.
  // scopeSrc: comments blanked only — for reading the RHS's actual content
  // (the guard call, or a hardcoded string literal), same offsets as scanSrc.
  const scanSrc = blankStringsAndComments(source);
  const scopeSrc = stripComments(source);

  const findings = [];

  for (const [re, kind] of [[OBJECT_LITERAL_KEY_RE, 'literal'], [ASSIGNMENT_RE, 'assignment']]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(scanSrc)) !== null) {
      const rhsStart = match.index + match[0].length;
      const rhs = scopeSrc.slice(rhsStart, rhsStart + scanRhs(scanSrc, rhsStart).length);
      findings.push({
        line: lineOf(scanSrc, match.index),
        kind,
        snippet: lineText(source, match.index).slice(0, 160),
        guarded: GUARD_CALL_RE.test(rhs) || isHardcodedStringRhs(rhs),
      });
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

/** Convenience wrapper: unguarded findings only. */
function findUnguardedVenueWrites(source) {
  return scanVenueWrites(source).filter(f => !f.guarded);
}

module.exports = {
  scanVenueWrites,
  findUnguardedVenueWrites,
  scanRhs,
  isHardcodedStringRhs,
  blankStringsAndComments,
  stripComments,
  FILE_EXEMPTION,
};
