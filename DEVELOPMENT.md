# Web development and upstream updates

For contributors working on the Web edition. See [README.md](README.md) for deployment and [RELEASING.md](RELEASING.md) for the maintainer release process.

Most new code lives in `crates/web-server` and `src/platform/web`:

1. Vite's `web` mode replaces Tauri calls, events, file operations, and window APIs with HTTP/SSE/browser adapters. Original UI components and generated bindings remain shared.
2. The web server selects desktop-independent modules from `src-tauri/src/commands` at build time and generates HTTP dispatch, reusing original command implementations, error types, and `AppState`.
3. `runtime-host-desktop` supplies the existing business services. Its `web-host` feature disables local game and overlay services without creating a Tauri application, window, or display server. The original headless CLI remains separate.

Use the Node.js/npm versions required by [package.json](package.json), a compatible Rust toolchain, and Linux fontconfig development libraries:

```sh
npm ci
npm run build:web
cargo build --locked -p vrcx-0-web
VRCX_WEB_ORIGIN=http://localhost:8080 \
  VRCX_WEB_PASSWORD_FILE=/path/to/website-password \
  VRCX_LEGACY_DATA_DIR=./data/legacy \
  target/debug/vrcx-0-web --data-dir ./data
```

For frontend hot reload, run `npm run dev:web` on port 9000. API requests are proxied to `127.0.0.1:8080`; set the backend origin to `http://localhost:9000`. A standalone binary needs a process manager or manual restart after restore/migration exits.

When merging an upstream tag, check the command selection in `crates/web-server/build.rs`, newly added desktop UI entries, and `web-host` guards. Build desktop and web packages separately to prevent Cargo feature unification from enabling `web-host` on the desktop build.

```sh
npm run typecheck
npm run lint
npm run build:web
cargo test --locked -p vrcx-0-web
docker compose -f compose.example.yaml -f compose.build.yaml build
```

Automated checks cover website authentication, origin validation, original database commands, desktop capability restrictions, and file access boundaries. Real VRChat account login, two-factor verification, long-running events, and third-party Webhook delivery still require acceptance testing with actual accounts and endpoints.

After building the Web frontend and debug server, run `node scripts/check-web-folders.mjs` to check folder naming, uploads, selection, and persistence across a server restart in Chromium. The script starts isolated local services with temporary storage and synthetic website credentials, then removes its test data. Playwright and Chromium must be installed; `VRCX_TEST_PLAYWRIGHT_MODULE` can specify an external Playwright module and `VRCX_TEST_CHROMIUM` can specify the browser executable.

## Continuous integration

[CI](.github/workflows/ci.yml) runs on pushes and pull requests to `master`, and can also be started manually. Frontend formatting, lint, type checking, and tests run on Linux. Changes affecting the Web application, build inputs, deployment, or CI also run Web Rust formatting, Clippy, and tests, then build the `linux/amd64` Docker image and check its startup with isolated data. Documentation-only changes skip Rust and Docker jobs; manual runs execute all checks. CI builds do not publish images; publication follows [RELEASING.md](RELEASING.md).
