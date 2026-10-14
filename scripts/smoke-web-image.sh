#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash scripts/smoke-web-image.sh IMAGE}"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
smoke_dir="$(mktemp -d)"
project="vrcx-release-smoke-$$"

# A named volume and no published ports keep the check separate from real data
# and any running deployment. No .env file or VRChat credentials are loaded.
cat > "$smoke_dir/compose.smoke.yaml" <<'YAML'
services:
    init-data:
        pull_policy: never
        volumes:
            - smoke-data:/data
    web:
        pull_policy: never
        restart: 'no'
        ports: !reset []
        volumes:
            - smoke-data:/data
volumes:
    smoke-data:
YAML

export VRCX_WEB_IMAGE="$image"
export VRCX_WEB_PASSWORD="release-smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export VRCX_WEB_ORIGIN=http://localhost:8080
export VRCX_WEB_LAN_MODE=0
export VRCX_WEB_LISTEN=127.0.0.1
export VRCX_WEB_PORT=8080
export TZ=UTC

compose=(docker compose --env-file /dev/null --project-directory "$smoke_dir"
    -p "$project" -f "$repo_dir/compose.example.yaml" -f "$smoke_dir/compose.smoke.yaml")

cleanup() {
    status=$?
    trap - EXIT
    if (( status != 0 )); then
        "${compose[@]}" logs --no-color || true
    fi
    "${compose[@]}" down --volumes --remove-orphans || true
    rm -rf "$smoke_dir"
    exit "$status"
}
trap cleanup EXIT

"${compose[@]}" up -d --no-build --wait --wait-timeout 180
"${compose[@]}" exec -T web sh -ec '
    test "$(id -u)" = 10001
    test -s /data/.machine-id
    test -s /app/dist/index.html
    test "$(curl --fail --silent http://127.0.0.1:8080/health)" = ok
    curl --fail --silent http://127.0.0.1:8080/ > /dev/null
'
