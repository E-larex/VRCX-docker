# VRCX-0 Web

English | [Français](README.fr-FR.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja-JP.md) | [한국어](README.ko-KR.md)

**A Docker web edition based on the original [VRCX-0](https://github.com/Map1en/VRCX-0), with development driven by ChatGPT.**

This fork starts from upstream **v2.32.0** (`9e4e2193b88513882d3b4173e598f48eeb65092b`). It reuses the original Rust business logic, databases, and React interface, keeping changes small to make future upstream updates easier. The development branch is `feat/web-headless`; this is an initial working version.

Run it on a Linux server without a desktop or display, then access it in a browser. The server keeps collecting friend status and other information from VRChat after the browser closes. It is designed for a single user: one active VRChat account shared across multiple browser sessions, with shared settings and data. The website password is separate from your VRChat password.

ChatGPT drives development of this fork; running the core service does not require a ChatGPT account. Optional upstream AI features still require a configured provider.

## Docker Compose setup

Requirements: a Linux host, Docker, and the Docker Compose plugin. From this repository directory:

```sh
cp .env.example .env
```

Edit `.env` with your actual public origin and a separate website password of at least 12 characters:

```dotenv
VRCX_WEB_ORIGIN=https://vrcx.example.com
VRCX_WEB_PASSWORD=replace-with-your-own-strong-password
VRCX_WEB_LAN_MODE=0
VRCX_WEB_LISTEN=127.0.0.1
VRCX_WEB_PORT=8080
TZ=Asia/Shanghai
```

Then build and start:

```sh
docker compose up -d --build
docker compose logs -f web
```

The default bind address is `127.0.0.1:8080`. `VRCX_WEB_ORIGIN` must exactly match the browser's scheme, hostname, and port, without a subpath. Sign in to the website first, then use the original interface to sign in to VRChat and complete two-factor verification. Saved credentials and automatic login continue to use upstream behavior; server startup attempts to restore the saved VRChat session.

### Public access through Nginx and HTTPS

The application serves HTTP; Nginx handles the HTTPS certificate and HTTP-to-HTTPS redirect. Add [the Nginx configuration snippet](deploy/nginx.web.conf) to the HTTPS `server` block for your domain. Disable proxy buffering for the SSE event stream. If Nginx also runs in Docker, attach both services to a shared network and use `web:8080` as the proxy target.

For local testing on the server itself, `VRCX_WEB_ORIGIN=http://localhost:8080` also works when the browser uses exactly that address. HTTPS mode uses a Secure session cookie.

### LAN access over HTTP

A domain, certificate, and Nginx are not required for LAN mode. Keep the website password configured and set:

```dotenv
VRCX_WEB_LAN_MODE=1
VRCX_WEB_LISTEN=0.0.0.0
VRCX_WEB_PORT=8080
```

Run `docker compose up -d --build`, then open `http://192.168.1.10:8080`, replacing the IP with your server's LAN address.

LAN mode ignores `VRCX_WEB_ORIGIN` and checks that the request Origin matches Host. Private IPv4, IPv6 ULA, link-local and loopback IPs, and `localhost` are supported. Ordinary domain names use the fixed-origin mode. Browser clipboard features may be restricted over HTTP.

To return to the default deployment, set `VRCX_WEB_LAN_MODE=0`, `VRCX_WEB_LISTEN=127.0.0.1`, and your actual HTTPS origin.

## Data and backups

Compose stores databases, VRChat sessions, settings, image cache, uploaded/exported files, and backups in **`./data`**. Rebuilding a container preserves this directory. The one-shot `init-data` service initializes its permissions; a successful exit is normal. The web service runs as UID/GID `10001:10001`.

The original credential encryption relies on `./data/.machine-id`; include it when backing up or moving the complete directory. Do not share one data directory between running instances. `.env` and `./data` are excluded from Git, and real credentials/data are excluded from the Docker build context.

Browser upload/download replaces native file dialogs. Manual exports are downloaded and also retained in `./data/web-files`. The per-request upload limit is 256 MiB, matching the Nginx example. Automatic backups can use a new server folder within the persistent data directory; opening such a folder lists downloadable files.

The original migration interface can upload a VRCX directory containing `VRCX.sqlite3` and related databases/settings into `./data/legacy`. Alternatively, place readable source data there before the first startup. Restore VRCX-0 `.vrcx0backup` files through the existing restore interface. If migration or restoration requires a restart, the server exits and Compose starts it again; sign back into the website afterwards.

For a full instance backup, run `docker compose stop web`, copy the entire `./data` directory including hidden files, then run `docker compose start web`. Restore with ownership `10001:10001`. Backups contain account sessions and settings and should be protected like the website password.

## Features and background operation

- Keep upstream server-side features: friend status, social history, favorites, worlds, avatars, groups, invitations, notifications, filters, notes, tags, and statistics.
- Reuse the original interface and services for Webhooks, remote logger integration, translation, and optional AI providers. Third-party integrations require their own configuration. Webhooks are sent by the server while the browser is closed.
- Closing a browser, losing the connection, or choosing “Sign out of website” keeps VRChat and collection running. Explicitly logging out of VRChat ends the VRChat session.
- Local game process monitoring, game log collection, screenshot monitoring, and VR Overlay are disabled. Desktop-specific controls such as the tray, window controls, autostart, desktop notifications, and Discord RPC are hidden.
- No new age-based history deletion is added. Existing maintenance and backup retention settings still follow upstream behavior.
- Original polling defaults are retained: realtime status primarily uses VRChat events; friend/favorite baselines normally refresh hourly and the current user every 5 minutes. **Bio scanning is off by default**. When enabled, it processes one candidate every 3 seconds, with at least 12 hours between scans of the same user. Authentication, upstream scheduling, and rate limits still apply.

Website sessions last up to 7 days and are cleared on server restart; persisted VRChat sessions are separate. To change the website password, edit `.env` and run `docker compose up -d --force-recreate web`. The website password screen follows the system light/dark theme.

## Updating and stopping

After updating this branch's source:

```sh
docker compose up -d --build
```

Use `docker compose down` to stop the deployment. Start again with the command above. Back up `./data` before updates.

## Development and upstream updates

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
docker compose build
```

Automated checks cover website authentication, origin validation, original database commands, desktop capability restrictions, and file access boundaries. Real VRChat account login, two-factor verification, long-running events, and third-party Webhook delivery still require acceptance testing with actual accounts and endpoints.

## Credits and license

Thanks to the authors and contributors of [Map1en/VRCX-0](https://github.com/Map1en/VRCX-0) for the original application, interface, and features. This repository is an independent Docker web derivative with ChatGPT-driven development. Report web-edition issues in this repository.

Licensed under [GNU GPL v3.0](LICENSE). Portions originate from VRCX; see [NOTICE](NOTICE) and [LICENSES/MIT.txt](LICENSES/MIT.txt) for the relevant attribution and MIT license. This project is not endorsed by VRChat Inc.; VRChat and related trademarks belong to their respective owners.
