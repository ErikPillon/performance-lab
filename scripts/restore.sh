#!/usr/bin/env bash
#
# Restore from a snapshot taken by backup.sh.
#
#   ./scripts/restore.sh backups/2026-08-30T21-00-00Z
#   ./scripts/restore.sh --verify backups/2026-08-30T21-00-00Z   # rehearsal
#
# --verify restores into a throwaway database and container, counts what came
# back, and destroys them. It touches nothing live. Run it monthly: an untested
# backup is a guess, and the moment you need a real restore is the worst
# possible time to discover the dumps have been empty since March.
#
# Without --verify this OVERWRITES the live database and object store, and it
# asks first.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile apps)

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

VERIFY=""
[ "${1:-}" = "--verify" ] && { VERIFY=1; shift; }
SRC=${1:-}
[ -n "$SRC" ] || die "usage: $0 [--verify] <snapshot-dir>"
SRC=$(cd "$SRC" 2>/dev/null && pwd) || die "no such snapshot: ${1}"
[ -f "$SRC/postgres.dump" ] || die "$SRC has no postgres.dump"

[ -f "$ROOT/.env" ] || die "no .env in $ROOT"
set -a; . "$ROOT/.env"; set +a

echo; sed 's/^/  /' "$SRC/manifest.txt" 2>/dev/null; echo

# --- rehearsal ----------------------------------------------------------
if [ -n "$VERIFY" ]; then
  log "rehearsing into a scratch database (nothing live is touched)"
  scratch=lab-restore-check-$$
  docker run -d --name "$scratch" \
    -e POSTGRES_USER=check -e POSTGRES_PASSWORD=check -e POSTGRES_DB=check \
    postgres:16-alpine >/dev/null || die "could not start scratch postgres"
  # shellcheck disable=SC2064
  trap "docker rm -f $scratch >/dev/null 2>&1" EXIT

  for _ in $(seq 1 30); do
    docker exec "$scratch" pg_isready -U check >/dev/null 2>&1 && break
    sleep 1
  done

  docker exec -i "$scratch" pg_restore -U check -d check --no-owner \
    < "$SRC/postgres.dump" >/dev/null 2>&1
  # pg_restore warns about missing roles on a fresh cluster and still succeeds;
  # what matters is whether the rows arrived, so measure that instead.

  log "row counts restored:"
  docker exec "$scratch" psql -U check -d check -tAc "
    select table_name from information_schema.tables
    where table_schema='public' order by table_name" 2>/dev/null \
  | while read -r t; do
      [ -n "$t" ] || continue
      n=$(docker exec "$scratch" psql -U check -d check -tAc \
            "select count(*) from \"$t\"" 2>/dev/null || echo '?')
      printf '    %-28s %s\n' "$t" "$n"
    done

  acts=$(docker exec "$scratch" psql -U check -d check -tAc \
          'select count(*) from activities' 2>/dev/null || echo 0)
  echo
  [ "${acts:-0}" -gt 0 ] \
    && log "rehearsal PASSED — $acts activities restored" \
    || die "rehearsal FAILED — no activities in the restored dump"
  exit 0
fi

# --- real restore -------------------------------------------------------
log "This OVERWRITES the live database and object store."
printf '  Type the snapshot name to confirm (%s): ' "$(basename "$SRC")"
read -r reply
[ "$reply" = "$(basename "$SRC")" ] || die "not confirmed"

log "stopping application services (infra stays up)"
"${COMPOSE[@]}" stop api ingest-worker analytics web || true

log "restoring postgres"
"${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-lab}" -d postgres -c \
  "drop database if exists \"${POSTGRES_DB:-performance_lab}\" with (force)" >/dev/null \
  || die "could not drop the existing database"
"${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-lab}" -d postgres -c \
  "create database \"${POSTGRES_DB:-performance_lab}\"" >/dev/null
"${COMPOSE[@]}" exec -T postgres pg_restore -U "${POSTGRES_USER:-lab}" \
  -d "${POSTGRES_DB:-performance_lab}" --no-owner < "$SRC/postgres.dump" \
  || log "  pg_restore reported warnings (usually harmless role/ownership notices)"

if [ -f "$SRC/minio.tar.gz" ]; then
  log "restoring object store"
  "${COMPOSE[@]}" stop minio || true
  docker run --rm -v performance-lab_miniodata:/data -v "$SRC:/backup:ro" \
    alpine sh -c 'rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/minio.tar.gz -C /data' \
    || die "object store restore failed"
  "${COMPOSE[@]}" start minio
fi

log "starting application services"
"${COMPOSE[@]}" up -d

log "restored from $SRC"
