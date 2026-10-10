#!/usr/bin/env bash
# Run a Supabase migration + its SQL tests against a throwaway local Postgres.
#
# Why: migrations here are applied to production by apply-migration.yml and the
# only other check is the live round-trip in CI, so every SQL bug used to cost a
# land -> apply -> wait loop. This starts a private Postgres cluster in a temp
# dir, loads tests/fixtures/supabase-stub.sql (anon/authenticated roles,
# auth.uid(), Supabase's default grants), applies the migration, then runs the
# test file with ON_ERROR_STOP so the first failed t.ok()/t.fails() exits 1.
#
# Usage:
#   bash scripts/test-plan-shares-sql.sh <migration.sql> [<later-migration.sql> ...] <test.sql>
#   (migrations apply in the order given; the LAST argument is the test file)
#   bash scripts/test-plan-shares-sql.sh --self-test        # harness sanity check
#   bash scripts/test-plan-shares-sql.sh --self-test-fail   # must exit 1
#
# Needs PostgreSQL server binaries (initdb/pg_ctl). The test file can read the
# shared parity fixture via the psql variable :'parity_fixture' (raw JSON text),
# and re-apply the last migration with `\i :last_migration` (a copy the
# postgres user can read), e.g. to exercise a first-apply-only backfill.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STUB="$ROOT/tests/fixtures/supabase-stub.sql"
PARITY="$ROOT/tests/fixtures/shared-plans-parity.json"

PG_BIN="${PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  if command -v initdb >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v initdb)")"
  else
    PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  fi
fi
if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ]; then
  echo "test-plan-shares-sql: no PostgreSQL server binaries found (set PG_BIN)" >&2
  exit 2
fi

MODE="run"
case "${1:-}" in
  --self-test) MODE="self-test" ;;
  --self-test-fail) MODE="self-test-fail" ;;
  ""|-h|--help) sed -n '2,20p' "$0"; exit 2 ;;
esac
if [ "$MODE" = "run" ]; then
  [ $# -ge 2 ] || { echo "usage: $0 <migration.sql> [...] <test.sql>" >&2; exit 2; }
  MIGRATIONS=()
  for f in "${@:1:$#-1}"; do
    [ -f "$f" ] || { echo "missing $f" >&2; exit 2; }
    MIGRATIONS+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")")
  done
  TESTS="${!#}"
  [ -f "$TESTS" ] || { echo "missing $TESTS" >&2; exit 2; }
  TESTS="$(cd "$(dirname "$TESTS")" && pwd)/$(basename "$TESTS")"
fi

# initdb refuses to run as root; drop to the postgres user when we are root.
RUN=()
if [ "$(id -u)" = "0" ]; then
  id postgres >/dev/null 2>&1 || { echo "running as root and no postgres user" >&2; exit 2; }
  RUN=(runuser -u postgres --)
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/plan-shares-pg.XXXXXX")"
chmod 755 "$WORK"
[ ${#RUN[@]} -gt 0 ] && chown postgres "$WORK"
PORT=$(( 20000 + RANDOM % 20000 ))

cleanup() {
  "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUN[@]}" "$PG_BIN/initdb" -D "$WORK/data" -A trust -U postgres >/dev/null
"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" \
  -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN[@]}" "$PG_BIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres
      -v ON_ERROR_STOP=1 -X -q)

# Files are read by the postgres user, so hand psql the contents on stdin.
run_sql() { "${PSQL[@]}" "$@"; }

run_sql < "$STUB"

if [ "$MODE" = "self-test" ]; then
  echo "SELECT t.ok(1 + 1 = 2, 'harness can assert');" | run_sql -o /dev/null
  echo "test-plan-shares-sql: self-test passed"
  exit 0
fi
if [ "$MODE" = "self-test-fail" ]; then
  echo "SELECT t.ok(false, 'deliberately false');" | run_sql
  exit 0  # unreachable when the harness works: ON_ERROR_STOP exits 3 above
fi

for m in "${MIGRATIONS[@]}"; do
  echo "-- applying $(basename "$m")"
  run_sql < "$m"
done
# Migrations must be re-runnable (apply-migration.yml may be dispatched twice).
for m in "${MIGRATIONS[@]}"; do
  echo "-- re-applying $(basename "$m") (idempotency)"
  run_sql < "$m"
done

PARITY_JSON="{}"
[ -f "$PARITY" ] && PARITY_JSON="$(cat "$PARITY")"
LAST_MIGRATION="$WORK/last-migration.sql"
cp "${MIGRATIONS[${#MIGRATIONS[@]}-1]}" "$LAST_MIGRATION"
chmod 644 "$LAST_MIGRATION"
echo "-- running $(basename "$TESTS")"
set +e
run_sql -v parity_fixture="$PARITY_JSON" -v last_migration="$LAST_MIGRATION" < "$TESTS" > "$WORK/out.log" 2>&1
status=$?
set -e
grep -E 'ok - |ASSERTION|ERROR' "$WORK/out.log" | sed 's/^.*NOTICE:  //'
if [ "$status" -ne 0 ]; then
  echo "test-plan-shares-sql: FAILED" >&2
  exit 1
fi
echo "test-plan-shares-sql: all assertions passed"
