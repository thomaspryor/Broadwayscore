#!/usr/bin/env bash
# PostToolUse hook: JSX/Tailwind UI lint — warns on recurring mobile CSS traps
# in edited tsx/jsx. Two trap classes:
#
# Patterns A-C (whitespace-nowrap): <div className="whitespace-nowrap ...">
# HISTORICAL ACCURACY</div> inside a constrained flex/grid column — the
# FeaturedSpot clip. Escape: NOWRAP_LINT_SKIP=1.
#
# Pattern D (iOS input zoom): <input|textarea|select> whose className sets a
# BASE font size under 16px (text-xs, text-sm, text-[<16px] with no breakpoint
# prefix) — iOS Safari auto-zooms on focus and the zoom sticks after blur.
# Fixed one-off across 4 components in PR #448; this guards the class of bug.
# Remedy idiom: text-base sm:text-sm. Escape: IOS_ZOOM_LINT_SKIP=1.
# Known false negatives (acceptable for a warning hook — do NOT harden into a
# block): className={clsx(...)}/template-literal values, style={{fontSize}},
# rem arbitrary values (text-[0.875rem]), Edit new_strings that omit the tag.
#
# This is a WARNING (exit 0 + stderr), not a block. Like design-system-lint.sh.
# Escape: NOWRAP_LINT_SKIP=1 disables the whole hook.
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
#
# /ship-check round 2 P1-3: extended from ASCII-only [A-Za-z] to Unicode-aware
# matching via Python (which handles \w as Unicode by default for str regexes).
# macOS grep doesn't reliably support \p{L} portably.
if printf '%s' "$content" | python3 -c "
import sys, re
text = sys.stdin.read()
pattern = re.compile(r'\"[^\"]*whitespace-nowrap[^\"]*\"[^>]*>(\w[\w ]{11,})<')
sys.exit(0 if pattern.search(text) else 1)
"; then
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

# Pattern D: form control (<input|textarea|select>) whose className string sets
# a base (un-prefixed) font size under 16px — iOS Safari zooms on focus and the
# zoom sticks. Token-based: `sm:text-sm` is fine (mobile base stays 16px), and
# `text-base sm:text-sm` — the PR #448 remedy — must never be flagged.
# Attr scan tolerates one nesting level of braces so `onChange={e => ...}`
# (the `>` in `=>`) doesn't truncate the tag match.
zoom_hits=""
if [ "${IOS_ZOOM_LINT_SKIP:-0}" != "1" ]; then
  zoom_hits=$(printf '%s' "$content" | python3 -c "
import sys, re
text = sys.stdin.read()
# Blank out balanced {...} spans (JSX expression containers) so a '>' inside
# a handler ('=>' at any brace depth) can't truncate the tag scan. className
# string attributes are quoted, not braced, so they survive; className={...}
# is a documented false negative either way.
out, depth = [], 0
for ch in text:
    if ch == '{':
        depth += 1
    elif ch == '}' and depth > 0:
        depth -= 1
    elif depth == 0:
        out.append(ch)
    else:
        out.append(' ' if ch not in '\n' else ch)
text = ''.join(out)
tag_re = re.compile(
    r'<(input|textarea|select)\b'
    r'((?:\"[^\"]*\"|\'[^\']*\'|[^<>\"\'])*?)'
    r'/?>', re.S)
cls_re = re.compile(r'className\s*=\s*\"([^\"]*)\"')
bad = []
for m in tag_re.finditer(text):
    cm = cls_re.search(m.group(2))
    if not cm:
        continue
    for tok in cm.group(1).split():
        if ':' in tok:
            continue  # breakpoint/state-prefixed sizes keep the 16px mobile base
        if tok in ('text-xs', 'text-sm'):
            bad.append('<%s … %s>' % (m.group(1), tok)); break
        am = re.fullmatch(r'text-\[(\d+(?:\.\d+)?)px\]', tok)
        if am:
            try:
                if float(am.group(1)) < 16:
                    bad.append('<%s … %s>' % (m.group(1), tok)); break
            except ValueError:
                pass  # unparseable size: fail open
for b in bad[:5]:
    print(b)
" 2>/dev/null)
fi

if [ -n "$zoom_hits" ]; then
  printf >&2 '⚠️  iOS input-zoom lint: form control with base font under 16px in %s\n%s\n  Sub-16px <input>/<textarea>/<select> makes iOS Safari zoom on focus, and the\n  zoom sticks after blur (PR #448 bug class). Use the mobile-first idiom:\n  text-base sm:text-sm (16px on phones, original size on sm+).\n  Silence this pattern: IOS_ZOOM_LINT_SKIP=1\n' "$(basename "$file_path")" "$zoom_hits"
fi

[ -z "$triggers" ] && exit 0

printf >&2 '⚠️  whitespace-nowrap lint: potential overflow trap in %s%s\n\nFix the FeaturedSpot incident class. See: memory/feedback_local_preview_before_push.md\nSilence: NOWRAP_LINT_SKIP=1\n' "$(basename "$file_path")" "$triggers"
exit 0
