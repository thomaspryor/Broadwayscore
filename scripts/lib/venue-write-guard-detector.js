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
 * that grep, automated and widened past what a literal grep would catch:
 * scans every `venue:` / `'venue':` / `"venue":` object-literal key and
 * every `.venue =` / `['venue'] =` / `["venue"] =` assignment (including
 * `||=`/`??=` compound forms) in scripts/**, and flags any whose
 * right-hand-side expression does not route through
 * sanitizeVenueForWrite(...) — a bare call, a ternary of one (card #1921's
 * buildRegionalShowEntry fix: `venue: cond ? sanitizeVenueForWrite(x) :
 * null`), but NOT one whose non-null fallback defeats it
 * (`sanitizeVenueForWrite(x) || x` restores exactly what the call just
 * rejected — this is a real gap an adversarial review caught live, same
 * bug class as discover-new-shows.js's fixed `|| 'TBA'` history).
 *
 * Heuristic, not a real parser — same tradeoff as every other audit-*.js in
 * this repo, and known gaps remain (shorthand `{ venue }`, a computed key
 * `{ [k]: raw }`, `Object.defineProperty` — all silent misses, not
 * misclassifications; found by adversarial review, judged low-value to chase
 * further for a regex-level heuristic). The RHS is captured by depth-aware
 * bracket scanning from just after the key/assignment token to the first
 * top-level `,`, unmatched closing bracket, or `;` — enough to see through a
 * ternary (which has its own `:` at depth 0, deliberately not a stop
 * character) without a real AST.
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
 * MODULE-LOAD side effect, which would hijack this lib's own callers. One
 * deliberate exception to the string-blanking: a string token whose content
 * is EXACTLY "venue" is left intact (see blankStringsAndComments below) — a
 * quoted key/bracket write would otherwise be invisible to its own regex.
 *
 * A hardcoded string-literal RHS (`venue: "Studio 54"`) is treated as safe —
 * a human typed it, it can't carry scraped junk — EXCEPT a literal that is
 * itself a known placeholder marker (`venue: "TBA"`), which is exactly the
 * value class sanitizeVenueForWrite() exists to reject (also caught live by
 * adversarial review — the original version trusted ANY string literal).
 *
 * Pure detection logic lives here so both the CLI (audit-venue-write-guard.js)
 * and its unit test can call scanVenueWrites() directly (CLAUDE.md §15 —
 * never copy logic into a test).
 */

// Object-literal key: bare `venue:` or a quoted `'venue':`/`"venue":` (the
// quoted form is a real gap found live by adversarial review — a caller can
// defeat the bare-identifier match by quoting the key with identical runtime
// meaning).
const OBJECT_LITERAL_KEY_RE = /(?<![\w$.])(?:venue|'venue'|"venue")\s*:\s*/g;
// Assignment: `.venue =` / `.venue ||=` / `.venue ??=`, or bracket-notation
// `['venue'] =` / `["venue"] =` — also found live: a caller can defeat the
// dot-notation-only match with either shape while writing the exact same
// field.
const ASSIGNMENT_RE = /(?<![\w$])[\w$.]*(?:\.venue|\[\s*(?:'venue'|"venue")\s*\])\s*(?:\|\||\?\?)?=(?!=)\s*/g;
const GUARD_CALL_RE = /sanitizeVenueForWrite\(/;
const FILE_EXEMPTION = 'venue-write-guard-ok';

// A `sanitizeVenueForWrite(x) || fallback` RHS is NOT guarded if `fallback`
// is anything but a null/undefined-ish literal — sanitizeVenueForWrite()
// returns null on rejection specifically so a placeholder/junk value never
// reaches the write; `|| x`/`|| rawVenue`/`|| 'TBA'` restores exactly what
// it just rejected, the same fallback-defeats-the-guard shape already fixed
// once in discover-new-shows.js's `|| 'TBA'` history. Found live by
// adversarial review — a substring check for "sanitizeVenueForWrite(" alone
// can't see this. Matched on the ORIGINAL (non-blanked) rhs text so string
// fallbacks like 'TBA' are visible.
const SAFE_FALLBACK_RE = /^(?:null|undefined)$/i;

function isGuardCallDefeatedByFallback(rhs) {
  const idx = rhs.search(GUARD_CALL_RE);
  if (idx === -1) return false;

  // Reversed form: `raw || sanitizeVenueForWrite(raw)` — the guard call is
  // ITSELF the fallback of an earlier `||`/`??`. JS short-circuits, so a
  // truthy `raw` writes unsanitized and the guard call never even runs —
  // found live by a second adversarial-review pass, after the tail-fallback
  // check below was already fixed for the forward form. Checked by looking
  // at what immediately precedes the call (ignoring whitespace): if it's
  // `||`/`??`, the call is a fallback, not the primary expression.
  const before = rhs.slice(0, idx);
  if (/(?:\|\||\?\?)\s*$/.test(before)) return true;

  const afterCallStart = rhs.indexOf('(', idx);
  const closeIdx = findMatchingParen(rhs, afterCallStart);
  if (closeIdx === -1) return false;
  const tail = rhs.slice(closeIdx + 1).trim();
  if (!tail) return false; // nothing after the call — not defeated
  const fallbackMatch = /^\|\|\s*([\s\S]*)$/.exec(tail) || /^\?\?\s*([\s\S]*)$/.exec(tail);
  if (!fallbackMatch) return false; // some other trailing expression (e.g. `?.trim()`) — not a fallback defeat we can reason about; don't flag
  return !SAFE_FALLBACK_RE.test(fallbackMatch[1].trim());
}

function findMatchingParen(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

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
//
// EXCEPT a hardcoded value that IS itself a known placeholder marker
// (`venue: "TBA"`) — found live by adversarial review: sanitizeVenueForWrite()
// exists specifically to reject these (isPlaceholderVenue's UNKNOWN_MARKERS,
// scripts/audit-placeholder-venues.js), so a hand-typed 'TBA' is exactly the
// value class this guard exists to keep out of the venue field, not a
// counterexample to it.
const STRING_LITERAL_RE = /^(['"])(?:\\.|(?!\1)[^\\])*\1$/;
const TEMPLATE_LITERAL_NO_INTERP_RE = /^`(?:\\.|[^`$]|\$(?!\{))*`$/;
const UNKNOWN_MARKERS = new Set(['tba', 'tbd', 'n/a', 'na', 'unknown', '', '-']);

function isHardcodedStringRhs(rhs) {
  const trimmed = rhs.trim();
  if (!STRING_LITERAL_RE.test(trimmed) && !TEMPLATE_LITERAL_NO_INTERP_RE.test(trimmed)) return false;
  const inner = trimmed.slice(1, -1).trim().toLowerCase();
  return !UNKNOWN_MARKERS.has(inner);
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
    else if (label === 'string' || label === 'regexp') {
      // Exception: a string token whose content is EXACTLY "venue" is left
      // intact — blanking it would blind the quoted-key ('venue': x) and
      // bracket-assignment (['venue'] =) call-site regexes to a real write,
      // the same false-negative caught live by adversarial review for the
      // bare-identifier-only version of this detector. The residual risk is
      // a string literal reading exactly "venue" used as a VALUE (not a key)
      // immediately followed by `:` or wrapped in `[...] =` — grepped the
      // current corpus (`grep -rn "['\"]venue['\"]"`) and found none; the
      // real instances (`field: 'venue'`, `checks.push('venue')`) are all
      // followed by `,`/`)`, which the key/assignment regexes below don't
      // match on.
      if (label === 'string' && src.slice(tok.start + 1, tok.end - 1) === 'venue') return;
      b.blank(tok.start + 1, tok.end - 1);
    }
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
        guarded: (GUARD_CALL_RE.test(rhs) && !isGuardCallDefeatedByFallback(rhs)) || isHardcodedStringRhs(rhs),
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
  isGuardCallDefeatedByFallback,
  blankStringsAndComments,
  stripComments,
  FILE_EXEMPTION,
};
