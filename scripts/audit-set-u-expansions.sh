#!/usr/bin/env bash
# audit-set-u-expansions.sh — report `set -u` shell scripts whose array
# expansions crash on macOS bash 3.2 when the array is empty (BRO-2555).
# Logic and rules: scripts/lib/audit-set-u-expansions.js. Report-only unless
# --strict. Usage: bash scripts/audit-set-u-expansions.sh [--strict] [--json] [files...]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/lib/audit-set-u-expansions.js" "$@"
