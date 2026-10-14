# VRCX-0 Web

English | [Français](README.fr-FR.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja-JP.md) | [한국어](README.ko-KR.md)

**A Docker web edition based on the original [VRCX-0](https://github.com/Map1en/VRCX-0), with development driven by ChatGPT.**

This fork starts from upstream **v2.32.0** (`9e4e2193b88513882d3b4173e598f48eeb65092b`). It reuses the original Rust business logic, databases, and React interface, keeping changes small to make future upstream updates easier. This is an initial working version.

Run it on a Linux server without a desktop or display, then access it in a browser. The server keeps collecting friend status and other information from VRChat after the browser closes. It is designed for a single user: one active VRChat account shared across multiple browser sessions, with shared settings and data. The website password is separate from your VRChat password.

ChatGPT drives development of this fork; running the core service does not require a ChatGPT account. Optional upstream AI features still require a configured provider.

## Docker Compose setup

Requirements: an amd64 (Intel/AMD x86-64) Linux host, Docker, and the Docker Compose plugin. The default deployment pulls the public `ghcr.io/e-larex/vrcx-docker:latest` image; no GitHub login or server-side compilation is needed. From this repository directory:

```sh
cp compose.example.yaml compose.yaml
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

Then pull and start:

```sh
docker compose pull
docker compose up -d
docker compose logs -f web
```

The default bind address is `127.0.0.1:8080`. `VRCX_WEB_ORIGIN` must exactly match the browser's scheme, hostname, and port, without a subpath. Sign in to the website first, then use the original interface to sign in to VRChat and complete two-factor verification. Saved credentials and automatic login continue to use upstream behavior; server startup attempts to restore the saved VRChat session.

### Public access through Nginx and HTTPS

The application serves HTTP; Nginx handles the HTTPS certificate and HTTP-to-HTTPS redirect. Add [the Nginx configuration snippet](deploy/nginx.web.conf) to the HTTPS `server` block for your domain. Disable proxy buffering for the SSE event stream. If Nginx also runs in Docker, attach both services to a shared network and use `web:8080` as the proxy target.

For local testing on the server itself, `VRCX_WEB_ORIGIN=http://localhost:8080` also works when the browser uses exactly that address. HTTPS mode uses a Secure session cookie.

### LAN access over HTTP

A domain, certificate, and Nginx are not required for LAN mode. Set:

```dotenv
VRCX_WEB_LAN_MODE=1
VRCX_WEB_LISTEN=0.0.0.0
VRCX_WEB_PORT=8080
```

Run `docker compose pull` and `docker compose up -d`, then open `http://192.168.1.10:8080`, replacing the IP with your server's LAN address.

To allow direct access without website login, leave `VRCX_WEB_PASSWORD` empty or unset. This is permitted only when `VRCX_WEB_LAN_MODE=1`; a configured password still requires login and must contain at least 12 characters. Anyone who can reach the supported LAN address can use the shared application in passwordless mode. VRChat account login remains separate. For standalone servers, `VRCX_WEB_PASSWORD_FILE` takes precedence over the password environment variable.

LAN mode ignores `VRCX_WEB_ORIGIN` and checks that the request Origin matches Host. Private IPv4, IPv6 ULA, link-local and loopback IPs, and `localhost` are supported. Ordinary domain names use the fixed-origin mode. Browser clipboard features may be restricted over HTTP.

To return to the default deployment, configure a website password, set `VRCX_WEB_LAN_MODE=0`, `VRCX_WEB_LISTEN=127.0.0.1`, and your actual HTTPS origin.

## Data and backups

Compose stores databases, VRChat sessions, settings, image cache, uploaded/exported files, and backups in **`./data`**. Rebuilding a container preserves this directory. The one-shot `init-data` service initializes its permissions; a successful exit is normal. The web service runs as UID/GID `10001:10001`.

The original credential encryption relies on `./data/.machine-id`; include it when backing up or moving the complete directory. Do not share one data directory between running instances. `.env` and `./data` are excluded from Git, and real credentials/data are excluded from the Docker build context.

Browser upload/download replaces native file dialogs. Manual exports are downloaded and also retained in `./data/web-files`. The per-request upload limit is 256 MiB, matching the Nginx example. The folder picker browses subfolders within `./data/web-files`. Select an existing folder, create a named folder, or upload a local folder with an editable destination name. New folders are created directly under the currently displayed directory; existing names are rejected without overwriting or merging. Uploads preserve file structure but are copies, with no ongoing synchronization to the local folder. Empty local folders cannot be uploaded. Automatic backups write to the selected server folder; opening it lists downloadable files.

The original migration interface can upload a VRCX directory containing `VRCX.sqlite3` and related databases/settings into `./data/legacy`. Alternatively, place readable source data there before the first startup. Restore VRCX-0 `.vrcx0backup` files through the existing restore interface. If migration or restoration requires a restart, the server exits and Compose starts it again; sign back into the website afterwards.

For a full instance backup, run `docker compose stop web`, copy the entire `./data` directory including hidden files, then run `docker compose start web`. Restore with ownership `10001:10001`. Backups contain account sessions and settings and should be protected like the website password.

## Features and background operation

- Keep upstream server-side features: friend status, social history, favorites, worlds, avatars, groups, invitations, notifications, filters, notes, tags, and statistics.
- Reuse the original interface and services for Webhooks, remote logger integration, translation, and optional AI providers. Third-party integrations require their own configuration. Webhooks are sent by the server while the browser is closed.
- Closing a browser, losing the connection, or choosing “Quit VRCX-0” in the top-left menu keeps VRChat and collection running. Explicitly logging out of VRChat ends the VRChat session.
- Local game process monitoring, game log collection, screenshot monitoring, and VR Overlay are disabled. Desktop-specific controls such as the tray, window controls, autostart, desktop notifications, and Discord RPC are hidden.
- No new age-based history deletion is added. Existing maintenance and backup retention settings still follow upstream behavior.
- Original polling defaults are retained: realtime status primarily uses VRChat events; friend/favorite baselines normally refresh hourly and the current user every 5 minutes. **Bio scanning is off by default**. When enabled, it processes one candidate every 3 seconds, with at least 12 hours between scans of the same user. Authentication, upstream scheduling, and rate limits still apply.

With a website password configured, website sessions last up to 7 days and are cleared on server restart; persisted VRChat sessions are separate. To change the website password, edit `.env` and run `docker compose up -d --force-recreate web`. The website password screen follows the system light/dark theme. The top-left “Quit VRCX-0” item signs out only the current website session; it is hidden in passwordless mode. There is no separate website logout button in the title bar.

## Updating and stopping

Pull the new image and recreate the containers:

```sh
docker compose pull
docker compose up -d
```

To pin a release or roll back, set `VRCX_WEB_IMAGE=ghcr.io/e-larex/vrcx-docker:2.32.0-web.1` in `.env`, then run the pull and start commands above. Both services use the same image. Rolling back an image does not roll back the database; restore the complete pre-update backup if a migration is incompatible with the older version.

Use `docker compose down` to stop the deployment. Start again with the command above. Back up `./data` before updates.

## Building from source

For a local Docker build, first copy the configuration files as shown above and configure `.env`, then use the explicit build override:

```sh
docker compose -f compose.yaml -f compose.build.yaml build web
docker compose -f compose.yaml -f compose.build.yaml up -d
```

Both services then use `vrcx-0-web:local` without pulling from GHCR. Use the same two `-f` options for subsequent logs, stop, and other Compose commands.

## Credits and license

Thanks to the authors and contributors of [Map1en/VRCX-0](https://github.com/Map1en/VRCX-0) for the original application, interface, and features. This repository is an independent Docker web derivative with ChatGPT-driven development. Report web-edition issues in this repository.

Licensed under [GNU GPL v3.0](LICENSE). Portions originate from VRCX; see [NOTICE](NOTICE) and [LICENSES/MIT.txt](LICENSES/MIT.txt) for the relevant attribution and MIT license. This project is not endorsed by VRChat Inc.; VRChat and related trademarks belong to their respective owners.
