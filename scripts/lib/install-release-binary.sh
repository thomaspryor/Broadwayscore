#!/usr/bin/env bash
# install-release-binary.sh — install one binary from a GitHub release tarball
# in CI, robustly.
#
# Usage: bash scripts/lib/install-release-binary.sh OWNER/REPO TAG ASSET BINARY [DEST_DIR]
#   e.g. bash scripts/lib/install-release-binary.sh rhysd/actionlint v1.7.7 actionlint_1.7.7_linux_amd64.tar.gz actionlint
#
# Why (2026-11-09): every land.yml run failed at "Install actionlint" with
# "gzip: stdin: not in gzip format". The inline `curl -sL <asset> | tar xz`
# was unauthenticated, had no -f and no retry, so an error body from GitHub's
# release CDN went straight into tar. Here: authenticated `gh release download`
# first (GH_TOKEN), then `curl -f` with retries, then `gzip -t` before
# extracting. Exit non-zero only when every path fails.
# Guarded by scripts/lib/actionlint-install-guard.test.mjs.
set -euo pipefail

REPO="${1:?OWNER/REPO}"; TAG="${2:?TAG}"; ASSET="${3:?ASSET}"; BIN="${4:?BINARY}"; DEST="${5:-/usr/local/bin}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/asset.tgz"

ok=0
if command -v gh >/dev/null 2>&1 && [ -n "${GH_TOKEN:-}" ]; then
  for i in 1 2 3; do
    rm -f "$OUT"
    if gh release download "$TAG" -R "$REPO" -p "$ASSET" -O "$OUT" 2>"$WORK/gh.err" && gzip -t "$OUT" 2>/dev/null; then ok=1; break; fi
    echo "::warning::gh release download $REPO $TAG $ASSET attempt $i failed: $(head -c 300 "$WORK/gh.err" 2>/dev/null)"
    sleep $((i * 5))
  done
fi
if [ "$ok" -ne 1 ]; then
  rm -f "$OUT"
  if curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$OUT" "https://github.com/${REPO}/releases/download/${TAG}/${ASSET}" && gzip -t "$OUT" 2>/dev/null; then
    ok=1
  fi
fi
if [ "$ok" -ne 1 ]; then
  echo "::error::could not download a valid $ASSET from $REPO $TAG (gh and curl both failed)"
  exit 1
fi
tar -xzf "$OUT" -C "$WORK" "$BIN"
if [ -w "$DEST" ]; then mv "$WORK/$BIN" "$DEST/$BIN"; else sudo mv "$WORK/$BIN" "$DEST/$BIN"; fi
chmod +x "$DEST/$BIN"
echo "installed $BIN from $REPO $TAG to $DEST"
