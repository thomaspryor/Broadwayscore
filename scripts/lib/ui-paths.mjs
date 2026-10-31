// scripts/lib/ui-paths.mjs — single source of truth for the "what counts as a
// UI file" decision. Imported by the visual-qa hooks, the ledger walker, and
// the transcript-scan module so the four call sites can't drift apart.
//
// /ship-check (Claude reviewer P0-3, 2026-05-26) found four divergent regex
// copies — `module.css` listed twice, `tailwind.config.` matching prefix-only,
// some sites including `src/app/**/*.ts` and others not. Drift here is silent:
// the ledger says "UI commit needs approval" while the push hook says "no UI
// files changed" → wrong gate decision either way.
//
// Equivalent bash regex (anchored to start-of-path, case-sensitive) — used by
// pre-push-visual-gate.sh and verify-edits.sh. Keep in sync with UI_PATH_RE:
//   ^(?:src/.*\.(?:tsx|jsx|css|scss)$
//      |tailwind\.config\.(?:js|ts|cjs|mjs)$
//      |postcss\.config\.(?:js|ts|cjs|mjs)$
//      |styles/.*\.(?:css|scss)$)

// JS regex matches paths with OR without a leading slash so callers using
// either relative paths (git diff output) or absolute (Edit tool inputs) work.
export const UI_PATH_RE = new RegExp(
  '(?:^|/)(?:' +
    'src/.*\\.(?:tsx|jsx|css|scss)$' +
    '|tailwind\\.config\\.(?:js|ts|cjs|mjs)$' +
    '|postcss\\.config\\.(?:js|ts|cjs|mjs)$' +
    '|styles/.*\\.(?:css|scss)$' +
  ')'
);

// Paths where ANY edit must be treated as visual regardless of diff content.
// Reason: editing a CSS custom property value (`--brand: #ff0` → `--brand: #00f`)
// has no className/style/JSX/HTML keyword, so VISUAL_DIFF_HINT_RE misses it.
// Same for tailwind.config additions (`colors: { brand: '#ff0' }` → no JSX).
// These paths exist solely to affect rendering, so don't bother diff-inspecting.
export const VISUAL_BY_PATH_RE = new RegExp(
  '(?:^|/)(?:' +
    '.*\\.(?:css|scss|module\\.css|module\\.scss)$' +
    '|tailwind\\.config\\.(?:js|ts|cjs|mjs)$' +
    '|postcss\\.config\\.(?:js|ts|cjs|mjs)$' +
  ')'
);

export function isUiPath(p) {
  return typeof p === 'string' && UI_PATH_RE.test(p);
}

export function isVisualByPath(p) {
  return typeof p === 'string' && VISUAL_BY_PATH_RE.test(p);
}

// ── Diff-aware visual check (BRO-5844) ───────────────────────────────────────
// JS mirror of VISUAL_DIFF_HINT_RE / _strip_string_literals in
// .claude/hooks/verify-edits.sh (the Stop hook). Parity is asserted by
// scripts/tests/visual-diff-hint.test.mjs, which parses the Python source.
export const VISUAL_DIFF_HINT_RE = new RegExp(
  '(?:' +
    '\\bclassName\\s*=|\\bclassname\\s*=|\\bclass\\s*=|' +
    '\\bstyle\\s*=|\\bsx\\s*=|' +
    '<[A-Z][A-Za-z0-9]*\\b|</[A-Z][A-Za-z0-9]*>|' +
    '<(?:div|span|p|h[1-6]|button|a|img|svg|input|form|section|article|nav|header|footer|main|aside|ul|ol|li)\\b|' +
    'background(?:-color)?\\s*:|color\\s*:|font-(?:size|weight|family)\\s*:|' +
    '(?:^|\\s)(?:padding|margin|border|width|height|gap|grid|flex|display|position|top|left|right|bottom|z-index|opacity|transform|transition)\\s*:|' +
    '@media\\b|@keyframes\\b' +
  ')',
  'im'
);

// Context lines can carry a class list on another line (`className={[` then
// `'px-3 py-1.5',` on its own line), so a changed string literal next to one of
// these is a possible Tailwind edit even though the changed line itself strips
// to blank.
const CLASS_CONTEXT_RE = /\b(?:className|classname|class|style|sx|clsx|classNames|twMerge|cn|cx|cva|tv|variants|slotProps|classes)\b\s*[=({:]/i;

const STRING_LITERAL_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

export function stripStringLiterals(text) {
  return text.replace(STRING_LITERAL_RE, ' ');
}

// Lines that remove or add whole sections of the page without any hint token.
const RENDER_LOGIC_RE = /\breturn\b|&&|\|\||\?(?![.?])|\.(?:map|filter|slice)\(|\bif\s*\(|\belse\b|=>|\bnull\b|\bundefined\b|\bhidden\b/;

// A string (or bare line) that reads like a Tailwind class list: every token
// is lowercase class charset, and at least one token has a class-ish
// separator or is a bare utility word.
const CLASS_TOKEN_RE = /^[a-z0-9!:[\]/.\-_%#()@]+$/;
const BARE_UTILITIES = new Set(['flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute', 'fixed', 'sticky', 'static', 'contents', 'truncate', 'underline', 'italic', 'uppercase', 'lowercase', 'capitalize', 'border', 'rounded', 'shadow', 'container', 'sr-only']);
function looksLikeClassList(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every(t => CLASS_TOKEN_RE.test(t))) return false;
  return tokens.some(t => /[-:[\]/]/.test(t) || BARE_UTILITIES.has(t));
}

// Is this ONE changed line (leading +/- already removed) free of visual surface?
function lineIsNonVisual(line) {
  const trimmed = line.trim();
  if (trimmed === '' || /^(?:\/\/|\/\*|\*)/.test(trimmed)) return true;
  // Strip PER LINE: joining lines let apostrophes in JSX text ("can't ... It's")
  // pair across lines and erase real components between them.
  const literals = line.match(STRING_LITERAL_RE) || [];
  const stripped = stripStringLiterals(line);
  if (/['"`]/.test(stripped)) return false; // unbalanced quote: cannot tell
  if (VISUAL_DIFF_HINT_RE.test(stripped)) return false;
  if (RENDER_LOGIC_RE.test(stripped)) return false;
  if (literals.some(l => looksLikeClassList(l.slice(1, -1)))) return false;
  if (literals.length === 0 && looksLikeClassList(stripped)) return false; // bare line inside a multi-line template
  return true;
}

// True when a unified-diff patch for ONE file touches visual surface, or when
// that cannot be ruled out. Fail-safe: an empty patch (mode-only, binary,
// rename), a new or deleted file, or any non-string input is visual.
//
// Deliberate policy (owner decision 2026-10-21, BRO-5844): plain copy edits
// (metadata strings, JSX text with no tags/classes/logic) do NOT need an
// approved screenshot. Everything else the Stop hook's regex catches, plus the
// gaps a review found in it (cross-line apostrophes, multi-line template
// literals, class strings in helper consts, render-logic edits), stays gated.
export function patchTouchesVisualSurface(patch) {
  if (typeof patch !== 'string' || !/^@@ /m.test(patch)) return true;
  if (/^(?:new|deleted) file mode /m.test(patch)) return true;
  const hunkLines = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) { inHunk = true; continue; }
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    hunkLines.push(line);
  }
  const changed = hunkLines.filter(l => l[0] === '+' || l[0] === '-');
  if (changed.length === 0) return true;
  // Template-literal tracking: an odd backtick total means the hunk cuts a
  // template literal; an odd running count before a changed line means that
  // line sits inside one. Either way the line may be class text.
  const ticks = l => (l.match(/(?<!\\)`/g) || []).length;
  let open = 0;
  let total = 0;
  for (const l of hunkLines) {
    const t = ticks(l);
    if ((l[0] === '+' || l[0] === '-') && open % 2 === 1) return true;
    open += t;
    total += t;
  }
  if (total % 2 === 1) return true;
  for (const l of changed) if (!lineIsNonVisual(l.slice(1))) return true;
  // A changed string next to a class-bearing call in the hunk context.
  const context = hunkLines.filter(l => l[0] === ' ').map(l => l.slice(1)).join('\n');
  return changed.some(l => /['"`]/.test(l)) && CLASS_CONTEXT_RE.test(context);
}
