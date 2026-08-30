#!/usr/bin/env bash
#
# Pull-based deploy. Runs ON THE SERVER, from a systemd timer or by hand.
#
#   ./scripts/deploy.sh              # deploy whatever :latest now points at
#   ./scripts/deploy.sh sha-abc123   # deploy one specific commit
#   ./scripts/deploy.sh --rollback   # go back to the previously deployed tag
#
# Pull, not push: the server sits behind NAT, so GitHub cannot open a
# connection to it. Having the server ask "is there anything new?" needs no
# inbound port, no deploy key on the runner, and no tunnel — the smaller
# attack surface is the point, the simplicity is a bonus.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile apps)
STATE="$ROOT/.deploy-state"
LOCK=/tmp/performance-lab-deploy.lock

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# A timer firing while a deploy is still running would interleave two `up -d`
# calls on the same project. flock makes the second one leave immediately.
exec 9>"$LOCK"
flock -n 9 || { log "another deploy is running; leaving"; exit 0; }

[ -f "$ROOT/.env" ] || die "no .env in $ROOT — copy .env.example and fill it in"
set -a; . "$ROOT/.env"; set +a

PREVIOUS=$(cat "$STATE" 2>/dev/null || echo latest)

case "${1:-}" in
  --rollback)
    TARGET=$(cat "$STATE.previous" 2>/dev/null) \
      || die "no previous deploy recorded"
    [ -n "$TARGET" ] || die "no previous deploy recorded"
    log "rolling back to $TARGET"
    ;;
  "") TARGET=latest ;;
  *)  TARGET=$1 ;;
esac

export IMAGE_TAG=$TARGET
log "target: $TARGET (currently deployed: $PREVIOUS)"

# --- pull ---------------------------------------------------------------
# Record what is running first, so "did anything change?" is answerable even
# when the tag string is identical — :latest moves, the digest is the truth.
before=$("${COMPOSE[@]}" images --format json 2>/dev/null | tr -d '\n')

log "pulling images"
"${COMPOSE[@]}" pull --quiet || die "pull failed — is the tag published?"

after=$("${COMPOSE[@]}" images --format json 2>/dev/null | tr -d '\n')

if [ "$before" = "$after" ] && [ "$TARGET" = "$PREVIOUS" ] && [ "${FORCE:-}" != "1" ]; then
  log "already up to date; nothing to do"
  exit 0
fi

# --- migrate ------------------------------------------------------------
# Before restarting anything: a migration that fails should leave the old
# version serving, not a half-swapped stack. Runs in the new api image, which
# carries packages/db and its migration files.
log "applying migrations"
if ! "${COMPOSE[@]}" run --rm --no-deps api npx tsx packages/db/src/migrate.ts; then
  die "migration failed — nothing was restarted, the old version is still serving"
fi

# --- swap ---------------------------------------------------------------
log "starting new containers"
"${COMPOSE[@]}" up -d --remove-orphans || die "up failed"

# --- verify -------------------------------------------------------------
# `up -d` returning 0 only means the containers were created. The API has a
# healthcheck; wait for it to actually pass before calling this a success.
log "waiting for api to report healthy"
healthy=""
for _ in $(seq 1 60); do
  state=$(docker inspect --format '{{.State.Health.Status}}' \
    "$("${COMPOSE[@]}" ps -q api)" 2>/dev/null || echo unknown)
  case "$state" in
    healthy) healthy=1; break ;;
    unhealthy) break ;;
  esac
  sleep 2
done

if [ -z "$healthy" ]; then
  log "api did not become healthy; rolling back to $PREVIOUS"
  "${COMPOSE[@]}" logs --tail 40 api || true
  IMAGE_TAG=$PREVIOUS "${COMPOSE[@]}" up -d
  die "deploy failed and was rolled back to $PREVIOUS"
fi

# --- record -------------------------------------------------------------
[ "$TARGET" != "$PREVIOUS" ] && printf '%s\n' "$PREVIOUS" > "$STATE.previous"
printf '%s\n' "$TARGET" > "$STATE"

log "deployed $TARGET"
# Old image layers accumulate fast on a box with one disk. Images still
# referenced by a container are never touched by this.
docker image prune -f --filter 'until=168h' >/dev/null 2>&1 || true
