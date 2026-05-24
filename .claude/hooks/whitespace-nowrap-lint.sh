#!/usr/bin/env bash
# PostToolUse hook: warn when whitespace-nowrap is paired with a long literal
# text string in a flex/grid child — the FeaturedSpot overflow trap.
#
# The trap: <div className="whitespace-nowrap ...">HISTORICAL ACCURACY</div>
# inside a constrained flex/grid column. whitespace-nowrap forces single-line
# rendering; if the column is narrower than the natural one-line width, the
# text gets clipped (or visually overflows with overflow:hidden parent).
#
# This is a WARNING (exit 0 + stderr), not a block. Like design-system-lint.sh.
# Escape: NOWRAP_LINT_SKIP=1.
#
# Self-skip if user-level master exists.
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi

[ "${NOWRAP_LINT_SKIP:-0}" = "1" ] && exit 0

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)

case "$tool_name" in
  Edit|Write) ;;
  *) exit 0 ;;
esac

file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file_path" ] && exit 0

case "$file_path" in
  *.tsx|*.jsx) ;;
  *) exit 0 ;;
esac

# Skip generated / test files
case "$file_path" in
  */node_modules/*|*.test.tsx|*.test.jsx|*/__tests__/*) exit 0 ;;
esac

if [ "$tool_name" = "Edit" ]; then
  content=$(echo "$input" | jq -r '.tool_input.new_string // empty' 2>/dev/null)
else
  content=$(echo "$input" | jq -r '.tool_input.content // empty' 2>/dev/null)
fi
[ -z "$content" ] && exit 0

# Strategy: find any line in `content` that has BOTH:
#   - className containing "whitespace-nowrap"
#   - either (a) a long literal text node (>= 12 chars of letters/spaces)
#     directly following the opening tag, OR
#   - (b) appears inside a className that also has flex/grid utilities
#     ("flex", "grid", "inline-flex", or fixed-width "w-N") indicating a
#     constrained child where overflow is possible.
#
# This is heuristic. False positives are acceptable (it's a warning); false
# negatives are not (we want to surface the FeaturedSpot pattern reliably).

triggers=""

# Pattern A: whitespace-nowrap on element whose tag opens AND closes on one
# line with a long text run between (e.g. <div className="…whitespace-nowrap…">
# HISTORICAL ACCURACY</div>).
if echo "$content" | grep -qE '"[^"]*whitespace-nowrap[^"]*"[^>]*>[A-Za-z][A-Za-z ]{11,}<'; then
  triggers="${triggers}
  • <… className=\"…whitespace-nowrap…\">LONG TEXT</…> — single-line text in
    a nowrap container is the FeaturedSpot HISTORICAL ACCURA class:
    constrained column + long text + nowrap = clipping at the narrow viewport."
fi

# Pattern B: whitespace-nowrap inside className that ALSO has a fixed-width
# (w-N, max-w-N, or grid-cols-N) utility, suggesting a constrained box.
if echo "$content" | grep -qE '"[^"]*whitespace-nowrap[^"]*\b(w-[0-9]|max-w-[0-9]|min-w-[0-9]|grid-cols-[0-9])[^"]*"'; then
  triggers="${triggers}
  • whitespace-nowrap + fixed-width utility — if the text exceeds the width,
    you get the FeaturedSpot clip. Either drop nowrap, allow wrapping, use
    truncate (text-overflow ellipsis), or widen the container."
fi

# Pattern C: whitespace-nowrap in a flex child without min-w-0 — when a flex
# item has nowrap text wider than its track, flexbox can't shrink it past the
# text's natural width unless min-w-0 is set.
# Match flex-1 in either order with whitespace-nowrap within the same className.
if echo "$content" | grep -qE '"[^"]*(whitespace-nowrap[^"]*\bflex-1|flex-1[^"]*\bwhitespace-nowrap)[^"]*"' && ! echo "$content" | grep -qE 'min-w-0'; then
  triggers="${triggers}
  • whitespace-nowrap + flex-1 without min-w-0 — flex-1 children with nowrap
    text won't shrink below the text's natural width unless you add min-w-0."
fi

[ -z "$triggers" ] && exit 0

printf >&2 '⚠️  whitespace-nowrap lint: potential overflow trap in %s%s\n\nFix the FeaturedSpot incident class. See: memory/feedback_local_preview_before_push.md\nSilence: NOWRAP_LINT_SKIP=1\n' "$(basename "$file_path")" "$triggers"
exit 0
