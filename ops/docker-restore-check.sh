#!/bin/sh
# Restore check for a Docker install (DV-22; A11 7.2): the same as ops/restore-check.sh, but the scratch
# database lives in the installation's own db container (no host port, no PostgreSQL tools on the host),
# and the migrations and the integrity check run in the app container against it. The live database is
# never touched. Run it periodically (CP-03) and record the result.
# Usage: COMPOSE="docker compose -p deviations -f /opt/deviations/ops/docker-compose.yml -f /opt/deviations/ops/docker-compose.override.yml" \
#        ops/docker-restore-check.sh /backups/deviations-....dump
set -eu
: "${COMPOSE:?COMPOSE is required (the docker compose command of the installation)}"
dump="${1:?path to a .dump file}"
[ -f "$dump.sha256" ] || { echo "no checksum file for $dump: refusing an unverified backup" >&2; exit 1; }
(cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256")
scratch="deviations_restore_check_$(date -u +%Y%m%d%H%M%S)"
# shellcheck disable=SC2086 # COMPOSE is a command line with arguments
db() { $COMPOSE exec -T db sh -c "$1"; }
app() { $COMPOSE exec -T app sh -c "$1"; }
db "createdb -U \"\$POSTGRES_USER\" $scratch"
cleanup() { db "dropdb -U \"\$POSTGRES_USER\" --force --if-exists $scratch" || true; }
trap cleanup EXIT
trap 'exit 1' INT TERM
# The dump goes in on stdin, so nothing is copied into the container.
db "pg_restore --no-owner --exit-on-error -U \"\$POSTGRES_USER\" -d $scratch" < "$dump"
# DATABASE_URL in the app container names the live database: point the same login at the scratch one.
app "MIGRATION_DATABASE_URL=\"\${DATABASE_URL%/*}/$scratch\" node dist/db/migrate.js"
app "DATABASE_URL=\"\${DATABASE_URL%/*}/$scratch\" DB_APP_ROLE= node dist/db/integrity.js"
echo "note: after a real restore into a new database, run: REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC; GRANT TEMPORARY ON DATABASE <db> TO dev_app;"
echo "restore check passed: $dump"
