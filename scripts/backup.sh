#!/usr/bin/env bash
#
# Snapshot the two things that cannot be recomputed.
#
#   ./scripts/backup.sh
#
# Everything else in this system is derived. Delete the analytics tables and a
# recompute rebuilds them; delete the raw FIT objects and the numbers are gone
# for good. So this backs up exactly two things:
#
#   * the Postgres database  — activities, streams, thresholds, accounts, grants
#   * the MinIO object store — the original uploaded FIT files
#
# BACKUP_REMOTE in .env (user@host:/path) additionally rsyncs the snapshot to
# another machine. A backup that lives on the disk it is protecting is not a
# backup; it only survives fat-fingers, not a dead SSD.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile apps)
STAMP=$(date -u '+%Y-%m-%dT%H-%M-%SZ')
DEST=${BACKUP_DIR:-$ROOT/backups}/$STAMP
KEEP=${BACKUP_KEEP:-14}

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ -f "$ROOT/.env" ] || die "no .env in $ROOT"
set -a; . "$ROOT/.env"; set +a

mkdir -p "$DEST" || die "cannot create $DEST"
log "backing up to $DEST"

# --- Postgres -----------------------------------------------------------
# -Fc is the custom format: compressed, and pg_restore can pull a single table
# out of it, which a plain SQL dump cannot.
log "dumping postgres"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-lab}" -d "${POSTGRES_DB:-performance_lab}" -Fc \
  > "$DEST/postgres.dump" || die "pg_dump failed"

# A dump that silently produced nothing is the failure mode that goes unnoticed
# for months, so check it before claiming success.
size=$(wc -c < "$DEST/postgres.dump")
[ "$size" -gt 1000 ] || die "postgres dump is only ${size}B — treating as failed"
log "  postgres.dump  $(du -h "$DEST/postgres.dump" | cut -f1)"

# --- MinIO --------------------------------------------------------------
# Tarring the volume rather than mirroring through `mc`: it captures the store
# byte for byte with no credentials and no second network hop.
log "archiving object store"
docker run --rm \
  -v performance-lab_miniodata:/data:ro \
  -v "$DEST:/backup" \
  alpine tar czf /backup/minio.tar.gz -C /data . || die "minio archive failed"
log "  minio.tar.gz   $(du -h "$DEST/minio.tar.gz" | cut -f1)"

# --- manifest -----------------------------------------------------------
# What was running when this was taken. Restoring a dump into the wrong schema
# version is how a "successful" restore produces a broken app.
cat > "$DEST/manifest.txt" <<MANIFEST
taken:      $STAMP
host:       $(hostname)
image_tag:  $(cat "$ROOT/.deploy-state" 2>/dev/null || echo unknown)
git_commit: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
migration:  $("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-lab}" \
              -d "${POSTGRES_DB:-performance_lab}" -tAc \
              'select hash from drizzle.__drizzle_migrations order by created_at desc limit 1' \
              2>/dev/null || echo unknown)
MANIFEST
log "  manifest.txt"

# --- retention ----------------------------------------------------------
cd "${BACKUP_DIR:-$ROOT/backups}"
count=$(ls -1d 20*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -gt "$KEEP" ]; then
  ls -1d 20*/ | head -n -"$KEEP" | while read -r old; do
    log "pruning $old"; rm -rf "$old"
  done
fi

# --- offsite ------------------------------------------------------------
if [ -n "${BACKUP_REMOTE:-}" ]; then
  log "replicating to $BACKUP_REMOTE"
  if rsync -az --delete-after "${BACKUP_DIR:-$ROOT/backups}/" "$BACKUP_REMOTE/"; then
    log "  replicated"
  else
    # Local snapshot is good; the copy failed. Worth an alert, not a failure.
    log "  WARNING: replication failed — the local snapshot is still valid"
  fi
fi

log "done: $DEST"
