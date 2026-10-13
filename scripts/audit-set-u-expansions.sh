#!/usr/bin/env bash
# Audit: unguarded empty-array expansions in `set -u` shell scripts (BRO-2555).
#
# macOS ships bash 3.2, where "${arr[@]}" / ${arr[*]} on a ZERO-element array
# aborts with "unbound variable" under `set -u` (fixed upstream in 4.4, never
# backported). Seen live: BRO-2186 (gc-merged-worktrees.sh), BRO-2554
# (push-with-retry.sh), and rebuild-fast-redo.sh / merge-worktree-to-main.sh.
#
# Safe forms:   ${arr[@]+"${arr[@]}"}      ${arr[*]:-}      ${#arr[@]}
# Opt-out:      append `# set-u-safe: <reason>` to the line (array provably
#               non-empty, e.g. a non-empty literal or guarded by a count check).
#
# Usage: scripts/audit-set-u-expansions.sh [dir-or-file ...]   (default: scripts)
# Exit 0 = clean, 1 = unguarded sites found (listed as file:line: text).
set -uo pipefail

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(scripts)

found=0
while IFS= read -r f; do
  # Only scripts that enable nounset: set -u, set -eu, set -euo pipefail, ...
  grep -qE '^[[:space:]]*set[[:space:]]+-[a-zA-Z]*u' "$f" || continue
  out=$(awk '
    /^[[:space:]]*#/ { next }
    /# set-u-safe:/ { next }
    {
      line = $0
      # drop every guarded form, then see whether a bare expansion remains
      gsub(/\\?\$\{[A-Za-z_][A-Za-z_0-9]*\[[@*]\]\+[^}]*\}/, "", line)
      gsub(/\\?\$\{[A-Za-z_][A-Za-z_0-9]*\[[@*]\]:?-[^}]*\}/, "", line)
      if (line ~ /\\?\$\{[A-Za-z_][A-Za-z_0-9]*\[[@*]\]\}/) printf "%s:%d: %s\n", FILENAME, FNR, $0
    }' "$f")
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    found=1
  fi
done < <(find ${targets[@]+"${targets[@]}"} -type f -name '*.sh' | sort)

if [ "$found" -ne 0 ]; then
  echo "FAIL: unguarded array expansions under set -u (bash 3.2 crashes on empty arrays)." >&2
  echo "Fix: \${arr[@]+\"\${arr[@]}\"}, or add '# set-u-safe: <reason>' to the line." >&2
  exit 1
fi
echo "OK: no unguarded array expansions in set -u scripts"
