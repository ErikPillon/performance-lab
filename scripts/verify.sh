#!/usr/bin/env bash
#
# Everything CI runs, run locally.
#
# The point is that a green run here means a green pipeline: same checks, same
# order, no "works on my machine" gap. Nothing here needs Docker or a database
# — the suites that do are integration tests and are skipped without their
# fixtures, exactly as they are in CI.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=()
run() {
  local name=$1; shift
  printf '\n\033[1m▸ %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m  ok\033[0m\n'
  else
    printf '\033[31m  FAILED\033[0m\n'
    FAILED+=("$name")
  fi
}

# Type errors are the cheapest class of bug to catch, so they go first.
for ws in packages/db packages/jobs services/api services/ingest-worker apps/web; do
  run "typecheck $ws" bash -c "cd $ws && npx tsc --noEmit"
done

for ws in packages/db services/api services/ingest-worker apps/web; do
  run "test $ws" npm test --silent --workspace "$ws"
done

# pytest must run from the service directory: `app` is resolved relative to
# rootdir, so invoking it from the repo root fails collection on every module.
# The venv is created on demand; CI builds its own from pyproject.toml.
if [ -x services/analytics/.venv/bin/python ]; then
  run "test services/analytics" bash -c \
    "cd services/analytics && .venv/bin/python -m pytest -q -p no:warnings"
else
  printf '\n\033[33m▸ services/analytics skipped — no venv.\033[0m\n'
  printf '  python3 -m venv services/analytics/.venv && services/analytics/.venv/bin/pip install -e "services/analytics[dev]"\n'
fi

run "build apps/web" npm run build --silent --workspace @lab/web

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32m✓ everything passed\033[0m\n'
  exit 0
fi
printf '\033[31m✗ %d failed:\033[0m\n' "${#FAILED[@]}"
printf '   %s\n' "${FAILED[@]}"
exit 1
