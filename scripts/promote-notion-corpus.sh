#!/usr/bin/env bash
#
# promote-notion-corpus.sh — S2-T6 of sprint-plan-notion-linear-cutover.md.
#
# Takes two INDEPENDENT full export runs, proves they agree byte-for-byte,
# then publishes one of them into the private data repo with a hash manifest.
#
# WHY TWO RUNS. Everything else in Sprint 2 checks the export against itself:
# the manifest counts what the exporter thinks it did, and the verifier checks
# volume against a baseline the exporter produced. A second independent run is
# the only check that catches a NON-DETERMINISTIC defect — a pagination race, a
# dropped cursor page, a block list that silently truncates on one run and not
# the next. Those are exactly the defects that would survive every other gate
# here and only surface after Notion is deleted.
#
# The comparison is scoped to corpus.ndjson on purpose. manifest.json carries
# generatedAt and durationSec BY DESIGN — that is where run metadata lives
# precisely so that no timestamp ends up inside a record. Diffing it would
# always fail, which would train the next reader to ignore the diff.
#
# The data repo, not ~/Documents/claude-outputs: iCloud evicts to dataless
# placeholders, and a placeholder is indistinguishable from a file until you
# read it.
#
# Usage: scripts/promote-notion-corpus.sh [runA] [runB] [dest]
set -uo pipefail

RUNS_DIR="${RUNS_DIR:-/Users/tompryor/broadway-scorecard-data/.notion-corpus-runs}"
A="${1:-$RUNS_DIR/run-a}"
B="${2:-$RUNS_DIR/run-b}"
DEST="${3:-/Users/tompryor/broadway-scorecard-data/notion-corpus}"

die() { echo "❌ $*" >&2; exit 1; }

for d in "$A" "$B"; do
  [ -f "$d/corpus.ndjson" ] || die "no corpus.ndjson in $d"
  [ -f "$d/manifest.json" ] || die "no manifest.json in $d"
done

# Both runs must have been clean and complete. A partial run diffing clean
# against another partial run proves nothing at all.
for d in "$A" "$B"; do
  node -e '
    const m = require(process.argv[1] + "/manifest.json");
    if (m.partial) { console.error(`❌ ${process.argv[1]} is a PARTIAL run (--limit was set)`); process.exit(1); }
    if (m.errorCount) { console.error(`❌ ${process.argv[1]} has ${m.errorCount} error(s)`); process.exit(1); }
    console.log(`  ${process.argv[1]}: ${m.pagesExported} pages, ${m.errorCount} errors, ${m.durationSec}s`);
  ' "$d" || die "manifest check failed for $d"
done

echo "── double-run diff (corpus.ndjson only; manifest.json carries run metadata by design) ──"
if diff -q "$A/corpus.ndjson" "$B/corpus.ndjson" >/dev/null; then
  echo "  ✅ byte-identical across two independent runs"
else
  echo "  ❌ the two runs DISAGREE — the export is not deterministic. Investigate before publishing:"
  diff <(cut -c1-60 "$A/corpus.ndjson") <(cut -c1-60 "$B/corpus.ndjson") | head -20
  # Cards genuinely edited between the two runs show up here too, and that is a
  # real signal, not noise: it means the corpus is a moving target and the two
  # runs must be taken closer together (or the board frozen) before publishing.
  exit 1
fi

mkdir -p "$DEST"
cp "$A/corpus.ndjson" "$DEST/corpus.ndjson"
cp "$A/manifest.json" "$DEST/manifest.json"
cp "$A/errors.json" "$DEST/errors.json" 2>/dev/null || true
[ -f "$RUNS_DIR/corpus-baseline.json" ] && cp "$RUNS_DIR/corpus-baseline.json" "$DEST/corpus-baseline.json"

( cd "$DEST" && shasum -a 256 corpus.ndjson manifest.json > SHA256SUMS )
echo "── hash manifest ──"
cat "$DEST/SHA256SUMS"
( cd "$DEST" && shasum -c SHA256SUMS ) || die "shasum -c failed immediately after writing it"

echo ""
echo "✅ published to $DEST"
echo "   Next: commit it in the data repo, then re-run 'shasum -c SHA256SUMS' from a FRESH clone —"
echo "   verifying in place only proves the file did not change in the last second."
