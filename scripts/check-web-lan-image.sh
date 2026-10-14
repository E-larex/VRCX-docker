#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash scripts/check-web-lan-image.sh IMAGE}"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
project="vrcx-lan-check-$$"

cat > "$test_dir/compose.test.yaml" <<'YAML'
services:
    init-data:
        pull_policy: never
        volumes:
            - test-data:/data
    web:
        pull_policy: never
        restart: 'no'
        ports: !reset []
        volumes:
            - test-data:/data
volumes:
    test-data:
YAML

touch "$test_dir/test.env"
export VRCX_WEB_IMAGE="$image"
export VRCX_WEB_PASSWORD=
export VRCX_WEB_ORIGIN=
export VRCX_WEB_LAN_MODE=1
export VRCX_WEB_LISTEN=127.0.0.1
export VRCX_WEB_PORT=8080
export TZ=UTC
compose=(docker compose --env-file "$test_dir/test.env" --project-directory "$test_dir"
    -p "$project" -f "$repo_dir/compose.example.yaml" -f "$test_dir/compose.test.yaml")
cleanup() {
    status=$?
    trap - EXIT
    if (( status != 0 )); then "${compose[@]}" logs --no-color || true; fi
    "${compose[@]}" down --volumes --remove-orphans || true
    rm -rf "$test_dir"
    exit "$status"
}
trap cleanup EXIT

"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --wait --wait-timeout 180
"${compose[@]}" exec -T web sh -ec '
    test "$(curl --fail --silent http://localhost:8080/api/session)" = "{\"authenticated\":true,\"passwordRequired\":false}"
    test "$(curl --silent -o /dev/null -w "%{http_code}" -H "Host: attacker.example" http://localhost:8080/api/files/folders?path=)" = 403
    test "$(curl --silent -o /dev/null -w "%{http_code}" -H "Origin: http://localhost:9000" http://localhost:8080/api/session)" = 403
    curl --fail --silent -H "Origin: http://localhost:8080" -H "X-VRCX-Web: 1" -H "Content-Type: application/json" -d "{}" http://localhost:8080/api/invoke/storage__get_all > /dev/null
    printf "synthetic persistence check" > /data/.lan-persistence-check
    sha256sum /data/.machine-id > /data/.lan-machine-id-check
'
"${compose[@]}" up -d --no-build --force-recreate --wait --wait-timeout 180
"${compose[@]}" exec -T web sh -ec '
    test "$(curl --fail --silent http://localhost:8080/api/session)" = "{\"authenticated\":true,\"passwordRequired\":false}"
    test "$(cat /data/.lan-persistence-check)" = "synthetic persistence check"
    sha256sum --status -c /data/.lan-machine-id-check
'
export VRCX_WEB_PASSWORD=synthetic-container-test-password
"${compose[@]}" up -d --no-build --wait --wait-timeout 180
"${compose[@]}" exec -T web sh -ec '
    test "$(curl --fail --silent http://localhost:8080/api/session)" = "{\"authenticated\":false,\"passwordRequired\":true}"
    test "$(curl --silent -o /dev/null -w "%{http_code}" http://localhost:8080/api/events)" = 401
'
# Exercise the exact single-quoted .env format documented for users.
password_hash="$(cat "$repo_dir/crates/web-server/tests/fixtures/password.argon2")"
printf "VRCX_WEB_PASSWORD='%s'\n" "$password_hash" > "$test_dir/test.env"
unset VRCX_WEB_PASSWORD
export VRCX_WEB_ORIGIN=http://localhost:8080
for lan_mode in 1 0; do
    export VRCX_WEB_LAN_MODE="$lan_mode"
    "${compose[@]}" config --quiet
    "${compose[@]}" up -d --no-build --force-recreate --wait --wait-timeout 180
    "${compose[@]}" exec -T -e EXPECTED_TEST_HASH="$password_hash" web sh -ec '
        test "$VRCX_WEB_PASSWORD" = "$EXPECTED_TEST_HASH"
        test "$(curl --fail --silent http://localhost:8080/api/session)" = "{\"authenticated\":false,\"passwordRequired\":true}"
        test "$(curl --silent -o /dev/null -w "%{http_code}" -H "Origin: http://attacker.example" -H "X-VRCX-Web: 1" -H "Content-Type: application/json" -d "{\"password\":\"synthetic-browser-auth-password\"}" http://localhost:8080/api/login)" = 403
        test "$(curl --silent -o /dev/null -w "%{http_code}" -H "Origin: http://localhost:8080" -H "X-VRCX-Web: 1" -H "Content-Type: application/json" -d "{\"password\":\"wrong-password\"}" http://localhost:8080/api/login)" = 401
        sleep 2
        curl --fail --silent -c /tmp/test-cookies -H "Origin: http://localhost:8080" -H "X-VRCX-Web: 1" -H "Content-Type: application/json" -d "{\"password\":\"synthetic-browser-auth-password\"}" http://localhost:8080/api/login > /dev/null
        test "$(curl --fail --silent -b /tmp/test-cookies http://localhost:8080/api/session)" = "{\"authenticated\":true,\"passwordRequired\":true}"
        curl --fail --silent -b /tmp/test-cookies -H "Origin: http://localhost:8080" -H "X-VRCX-Web: 1" -H "Content-Type: application/json" -d "{}" http://localhost:8080/api/logout > /dev/null
        test "$(curl --silent -o /dev/null -w "%{http_code}" -b /tmp/test-cookies http://localhost:8080/api/events)" = 401
        test "$(cat /data/.lan-persistence-check)" = "synthetic persistence check"
        sha256sum --status -c /data/.lan-machine-id-check
    '
done
"${compose[@]}" stop web
export VRCX_WEB_PASSWORD=
export VRCX_WEB_LAN_MODE=0
export VRCX_WEB_ORIGIN=http://localhost:8080
status=0
timeout 30s "${compose[@]}" run --rm --no-deps web > "$test_dir/rejected-startup.log" 2>&1 || status=$?
test "$status" = 1
printf 'PASS: LAN passwordless startup, origin checks, persistence after recreation, password-protected LAN, Argon2id .env preservation and login/logout in both modes, and fixed-origin empty-password rejection.\n'
