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

# DETERMINISM, scoped to what determinism can actually mean here.
#
# A whole-file `diff` between two runs cannot pass. The source is a LIVE board
# that the fleet writes to continuously: across the real pair of runs, 4 pages
# were created and 21 edited in the ~2 hours between them. A criterion that can
# only ever fail is worse than none, because the next reader learns to skip it.
#
# The determinism claim that IS testable and IS what matters: a page that did
# not change between the two runs must produce a byte-identical record. Any
# difference there is a genuine non-determinism bug in the exporter — which is
# exactly how the pre-signed-S3-URL defect was found (5 unchanged pages
# diverged because Notion re-signs image URLs on every fetch, so the archive
# was storing links that die within the hour).
echo "── double-run determinism (records for pages UNCHANGED between the two runs) ──"
node -e '
const fs = require("fs");
const load = (p) => {
  const m = new Map();
  for (const l of fs.readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    m.set(r.id, { raw: l, editedAt: r.lastEditedTime });
  }
  return m;
};
const A = load(process.argv[1]), B = load(process.argv[2]);
let identical = 0, diverged = 0, edited = 0, createdInB = 0, deleted = 0;
const offenders = [];
for (const [id, a] of A) {
  const b = B.get(id);
  if (!b) { deleted++; continue; }
  if (a.editedAt !== b.editedAt) { edited++; continue; }
  if (a.raw === b.raw) identical++;
  else { diverged++; if (offenders.length < 10) offenders.push(id); }
}
for (const id of B.keys()) if (!A.has(id)) createdInB++;
console.log(`  pages in A / B                      ${A.size} / ${B.size}`);
console.log(`  created between the runs            ${createdInB}`);
console.log(`  deleted between the runs            ${deleted}`);
console.log(`  edited between the runs             ${edited}`);
console.log(`  UNCHANGED and byte-identical        ${identical}`);
console.log(`  UNCHANGED but DIVERGED              ${diverged}`);
if (diverged) {
  console.log("  ❌ non-determinism: " + offenders.join(", "));
  process.exit(1);
}
if (identical === 0) { console.log("  ❌ nothing was comparable — the two runs share no unchanged page"); process.exit(1); }
console.log("  ✅ every page unchanged between the runs produced an identical record");
' "$A/corpus.ndjson" "$B/corpus.ndjson" || die "the export is not deterministic — investigate before publishing"

mkdir -p "$DEST" || die "could not create $DEST"

# Every copy is checked. This script runs with `set -uo pipefail` and NOT -e
# (deliberately — the diff step needs to inspect a non-zero diff), so an
# unchecked `cp` that fails leaves the PREVIOUS run's corpus.ndjson sitting in
# $DEST, and the shasum step below then mints a perfectly valid SHA256SUMS over
# the stale file. `shasum -c` passes, the script prints "published", and the
# archive is silently the wrong one — with a hash manifest vouching for it.
cp "$A/corpus.ndjson" "$DEST/corpus.ndjson" || die "failed to copy corpus.ndjson into $DEST"
cp "$A/manifest.json" "$DEST/manifest.json" || die "failed to copy manifest.json into $DEST"
cp "$A/errors.json" "$DEST/errors.json" 2>/dev/null || true   # optional, absent on older runs
if [ -f "$RUNS_DIR/corpus-baseline.json" ]; then
  cp "$RUNS_DIR/corpus-baseline.json" "$DEST/corpus-baseline.json" || die "failed to copy corpus-baseline.json"
fi

# Prove the published file is the one we just diffed, not a leftover.
cmp -s "$A/corpus.ndjson" "$DEST/corpus.ndjson" || die "published corpus.ndjson differs from $A — refusing to hash it"

( cd "$DEST" && shasum -a 256 corpus.ndjson manifest.json > SHA256SUMS ) || die "failed to write SHA256SUMS"
echo "── hash manifest ──"
cat "$DEST/SHA256SUMS"
( cd "$DEST" && shasum -c SHA256SUMS ) || die "shasum -c failed immediately after writing it"

echo ""
echo "✅ published to $DEST"
echo "   Next: commit it in the data repo, then re-run 'shasum -c SHA256SUMS' from a FRESH clone —"
echo "   verifying in place only proves the file did not change in the last second."
