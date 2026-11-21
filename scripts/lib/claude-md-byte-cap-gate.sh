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
# The byteLimit config is ALSO read from <git_ref>, not the working tree
# (Codex adversarial-review finding, BRO-124): CI checks out and validates
# the pushed commit, so an uncommitted local bump to claude-md-anchors.json's
# byteLimit would otherwise let an oversized committed CLAUDE.md pass this
# local gate and still fail in CI — the two checks must read the SAME
# snapshot to agree. Falls back to the working-tree copy only if the config
# genuinely isn't resolvable at the ref (shouldn't happen once this file is
# committed — the config predates this gate — but fails open on that infra
# hiccup rather than blocking on it).
#
# Exit codes: 0 = within cap, OR nothing to check (CLAUDE.md absent at ref,
# node missing, decision script missing, config unresolvable at the ref AND
# absent from the working tree — all fail open, same philosophy as the rest
# of scripts/hooks/pre-push's audits). 1 = over cap; message on stdout/stderr
# either way.
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
TMP_ANCHORS="$(mktemp)"
trap 'rm -f "$TMP_MD" "$TMP_ANCHORS"' EXIT

git -C "$REPO_ROOT" show "$REF:CLAUDE.md" >"$TMP_MD" 2>/dev/null || exit 0

if ! git -C "$REPO_ROOT" show "$REF:scripts/lib/claude-md-anchors.json" >"$TMP_ANCHORS" 2>/dev/null; then
  cp "$REPO_ROOT/scripts/lib/claude-md-anchors.json" "$TMP_ANCHORS" 2>/dev/null || exit 0
fi

node "$REPO_ROOT/scripts/lib/check-claude-md-byte-cap.js" "$TMP_ANCHORS" <"$TMP_MD"
