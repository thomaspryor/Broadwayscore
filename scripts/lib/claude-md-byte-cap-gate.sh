#!/bin/bash
# scripts/lib/claude-md-byte-cap-gate.sh <repo_root> <git_ref>
#
# Git-plumbing wrapper for BRO-124's byte-cap check: gets CLAUDE.md's
# COMMITTED content at <git_ref> into scripts/lib/check-claude-md-byte-cap.js
# (which owns the actual byte-count decision) via a temp file rather than a
# pipe. A pipe (`git show ... | node ...`) breaks under scripts/hooks/
# pre-push's `set -o pipefail`: if CLAUDE.md doesn't exist at <git_ref> (e.g.
# this push DELETES it), `git show` exits non-zero and pipefail reports that
# exit code even though node — fed empty stdin — exits 0, falsely blocking a
# deletion. Writing to a temp file first and checking `git show`'s own exit
# status avoids the pipe entirely (second-opinion review finding, BRO-124).
#
# Exit codes: 0 = within cap, OR nothing to check (CLAUDE.md absent at ref,
# node missing, decision script missing — all fail open, same philosophy as
# the rest of scripts/hooks/pre-push's audits). 1 = over cap; message on
# stdout/stderr either way.
#
# Extracted so scripts/pre-push.test.mjs can exercise this exact wrapper
# (including the deletion case) without invoking the full pre-push hook —
# CLAUDE.md rule 15 (require/call the real logic, don't restate it in tests).
set -u

REPO_ROOT="$1"
REF="$2"

command -v node >/dev/null 2>&1 || exit 0
[ -f "$REPO_ROOT/scripts/lib/check-claude-md-byte-cap.js" ] || exit 0

TMP_MD="$(mktemp)"
trap 'rm -f "$TMP_MD"' EXIT

git show "$REF:CLAUDE.md" >"$TMP_MD" 2>/dev/null || exit 0

node "$REPO_ROOT/scripts/lib/check-claude-md-byte-cap.js" "$REPO_ROOT/scripts/lib/claude-md-anchors.json" <"$TMP_MD"
