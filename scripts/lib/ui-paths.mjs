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
//      |src/app/.*\.(?:tsx|jsx|ts|js)$
//      |styles/.*\.(?:css|scss)$)

// JS regex matches paths with OR without a leading slash so callers using
// either relative paths (git diff output) or absolute (Edit tool inputs) work.
export const UI_PATH_RE = new RegExp(
  '(?:^|/)(?:' +
    'src/.*\\.(?:tsx|jsx|css|scss)$' +
    '|tailwind\\.config\\.(?:js|ts|cjs|mjs)$' +
    '|postcss\\.config\\.(?:js|ts|cjs|mjs)$' +
    '|src/app/.*\\.(?:tsx|jsx|ts|js)$' +
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
