#!/usr/bin/env bash
# Prints NODE_OPTIONS for a full-repo `tsc --noEmit` (BRO-6004).
# Node's default ~2GB old-space cap OOMs project-wide tsc in cloud containers.
# Floor, not override: keeps the caller's heap size when it is already >= MIN_MB,
# otherwise appends the floor (Node honors the last --max-old-space-size).
MIN_MB=6144
cur="${NODE_OPTIONS:-}"
# Node also accepts --max_old_space_size; normalize only for parsing.
have=$(printf '%s' "$cur" | tr '_' '-' | sed -n 's/.*--max-old-space-size[= ]\([0-9][0-9]*\).*/\1/p' | tail -n1)
if [ -n "$have" ] && [ "$have" -ge "$MIN_MB" ]; then
  printf '%s\n' "$cur"
else
  printf '%s\n' "${cur:+$cur }--max-old-space-size=$MIN_MB"
fi
