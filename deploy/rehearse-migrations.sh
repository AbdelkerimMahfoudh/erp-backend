#!/usr/bin/env bash
# The D227 migration rehearsal (0116 onward) on a disposable MySQL, never on a live one.
#
#   MYSQL_BIN=/path/to/mysql/bin ROOT_URL=mysql://root@127.0.0.1:3399 \
#   [PROD_SCHEMA=prod-schema.sql] [PROD_DATA=prod-sanitised.sql] deploy/rehearse-migrations.sh
#
# 1. The base: production's own schema when PROD_SCHEMA is given (mysqldump --no-data --routines --triggers of the
#    live database), optionally its sanitised data (PROD_DATA); otherwise the repository's migrations up to BASE
#    (default 0115_platform_admin_invitation, production's head) — the dry run.
# 2. A full dump of the base, then every pending migration applied with `prisma migrate deploy`; a second deploy
#    must apply nothing.
# 3. A fresh database built from every migration; the two schemas must be identical (tables, columns, indexes,
#    foreign keys, triggers), AUTO_INCREMENT counters aside.
# 4. The restore proof: the base dump restored into a new database gives back the base's row counts and CHECKSUMs.
# The databases are dropped at the end unless KEEP=1. Every step is printed, so the run is the record (docs/113).
set -euo pipefail
: "${MYSQL_BIN:?set MYSQL_BIN to the folder holding mysql and mysqldump}"
: "${ROOT_URL:?set ROOT_URL, e.g. mysql://root@127.0.0.1:3399}"
BASE=${BASE:-0115_platform_admin_invitation}
HERE=$(cd "$(dirname "$0")/.." && pwd)
HOSTPORT=${ROOT_URL#mysql://*@}
HOST=${HOSTPORT%:*}
PORT=${HOSTPORT##*:}
USERPART=${ROOT_URL#mysql://}
USERPART=${USERPART%@*}
DBUSER=${USERPART%%:*}
if [ "$USERPART" != "$DBUSER" ]; then export MYSQL_PWD=${USERPART#*:}; fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
UP="rh_up_$STAMP" FRESH="rh_fresh_$STAMP" BACK="rh_back_$STAMP"
WORK=$(mktemp -d)
M=("$MYSQL_BIN/mysql" -h "$HOST" -P "$PORT" --protocol=TCP -u "$DBUSER")
D=("$MYSQL_BIN/mysqldump" -h "$HOST" -P "$PORT" --protocol=TCP -u "$DBUSER")
q() { "${M[@]}" -N -B -e "$1" | tr -d '\r'; }
url() { echo "${ROOT_URL%/}/$1"; }
# Always run from this checkout's own install; the schema file (and the migrations beside it) may be a copy elsewhere.
deploy() { (cd "$HERE" && DATABASE_URL=$(url "$1") npx prisma migrate deploy --schema "$2/prisma/schema.prisma" 2>&1) | tr -d '\r'; }
cleanup() {
  [ "${KEEP:-0}" = 1 ] || for db in "$UP" "$FRESH" "$BACK"; do q "DROP DATABASE IF EXISTS \`$db\`" || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

create() { q "CREATE DATABASE \`$1\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"; }
counts() { q "SELECT table_name FROM information_schema.tables WHERE table_schema='$1' AND table_type='BASE TABLE' ORDER BY table_name" | while read -r t; do
  echo "$t $(q "SELECT COUNT(*) FROM \`$1\`.\`$t\`") $(q "CHECKSUM TABLE \`$1\`.\`$t\`" | awk '{print $2}')"; done; }
schema() { "${D[@]}" --no-data --skip-comments --routines --triggers --skip-dump-date "$1" 2>/dev/null | tr -d '\r' \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//; s/DEFINER=`[^`]+`@`[^`]+` //; s/`'"$1"'`\.//g'; }

echo "=== rehearsal $STAMP on $HOST:$PORT, base $([ -n "${PROD_SCHEMA:-}" ] && echo "production schema $PROD_SCHEMA" || echo "repository at $BASE")"
create "$UP"
if [ -n "${PROD_SCHEMA:-}" ]; then
  sed -E 's/DEFINER=`[^`]+`@`[^`]+` //' "$PROD_SCHEMA" | "${M[@]}" "$UP"
  [ -z "${PROD_DATA:-}" ] || "${M[@]}" "$UP" < "$PROD_DATA"
else
  mkdir -p "$WORK/base/prisma/migrations"
  cp "$HERE/prisma/schema.prisma" "$WORK/base/prisma/"
  cp "$HERE/prisma/migrations/migration_lock.toml" "$WORK/base/prisma/migrations/"
  for m in "$HERE"/prisma/migrations/[0-9]*/; do
    n=$(basename "$m"); [[ "$n" > "$BASE" ]] && break; cp -r "$m" "$WORK/base/prisma/migrations/"
  done
  deploy "$UP" "$WORK/base" | tail -1
fi
echo "base at: $(q "SELECT migration_name FROM \`$UP\`._prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1")"

echo "=== base dump and its counts"
"${D[@]}" --single-transaction --routines --triggers --skip-dump-date "$UP" 2>/dev/null | sed -E 's/DEFINER=`[^`]+`@`[^`]+` //' > "$WORK/base.sql"
counts "$UP" > "$WORK/base.counts"
echo "tables: $(wc -l < "$WORK/base.counts"), dump bytes: $(wc -c < "$WORK/base.sql")"

echo "=== upgrade"
deploy "$UP" "$HERE" | grep -E "migration|applied|pending" | tail -20
echo "=== again: nothing may be applied"
AGAIN=$(deploy "$UP" "$HERE")
echo "$AGAIN" | tail -1
echo "$AGAIN" | grep -q "No pending migrations" || { echo "FAIL: a second deploy applied something"; exit 1; }

echo "=== fresh install and schema comparison"
create "$FRESH"
deploy "$FRESH" "$HERE" | tail -1
schema "$UP" > "$WORK/up.schema"; schema "$FRESH" > "$WORK/fresh.schema"
if diff -u "$WORK/fresh.schema" "$WORK/up.schema" > "$WORK/schema.diff"; then echo "schemas identical ($(grep -c '^CREATE TABLE' "$WORK/up.schema") tables)"; else
  echo "FAIL: upgraded schema differs from a fresh install"; head -80 "$WORK/schema.diff"; exit 1; fi

echo "=== restore proof"
create "$BACK"
"${M[@]}" "$BACK" < "$WORK/base.sql"
counts "$BACK" > "$WORK/back.counts"
if diff -q "$WORK/base.counts" "$WORK/back.counts" >/dev/null; then echo "restored: row counts and CHECKSUMs identical on every table"; else
  echo "FAIL: the restore differs"; diff "$WORK/base.counts" "$WORK/back.counts" | head -40; exit 1; fi
echo "=== rehearsal $STAMP: PASS"
