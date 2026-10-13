# VRCX-0 Web

[English](README.md) | [Français](README.fr-FR.md) | 简体中文 | [繁體中文](README.zh-Hant.md) | [日本語](README.ja-JP.md) | [한국어](README.ko-KR.md)

**基于原版 [VRCX-0](https://github.com/Map1en/VRCX-0)、由 ChatGPT 驱动开发的 Docker 网页版本。**

本项目从原版 **v2.32.0**（`9e4e2193b88513882d3b4173e598f48eeb65092b`）衍生，网页版开发由 ChatGPT 驱动，尽可能复用原项目的 Rust 业务逻辑、数据库和 React 界面，以减少改动并方便同步上游功能。当前开发分支为 `feat/web-headless`，处于初步可用阶段。

在无桌面环境的 Linux 上通过 Docker Compose 运行，通过浏览器访问。服务器持续记录从 VRChat 获取的好友状态等信息，关闭浏览器后仍然运行。面向单用户使用：一个活动 VRChat 账号，多个浏览器共享账号、设置和数据库。网站密码与 VRChat 密码相互独立。

ChatGPT 用于本分支的开发；基础服务运行无需 ChatGPT 账号。原版可选 AI 功能仍需自行配置服务。

## 使用 Docker Compose

需要 Linux 主机、Docker 和 Docker Compose 插件。在本项目目录执行：

```sh
cp .env.example .env
# 编辑 .env：填写实际域名和独立的网站管理密码（至少 12 个字符）
docker compose up -d --build
docker compose logs -f web
```

服务默认仅绑定宿主机 `127.0.0.1:8080`。`VRCX_WEB_ORIGIN` 必须与浏览器地址的协议、域名、端口完全一致，例如 `https://vrcx.example.com`，不带子路径。Compose 会在项目目录创建 `./data`，并让以 UID/GID `10001:10001` 运行的服务拥有该目录。`init-data` 是一次性的目录权限初始化任务，成功退出属于正常行为。

数据库、VRChat 会话、设置、图片缓存、导入导出文件和备份均保存在 `./data`；重建容器不会删除它们。用于原版凭据加密的机器标识保存在 `./data/.machine-id`，整目录备份和迁移时也必须保留该文件。不要将不同实例同时指向同一数据目录。目录已从 Git 和 Docker 构建上下文中排除。

把 [Nginx 配置片段](deploy/nginx.web.conf) 放进该域名现有的 HTTPS `server` 配置中。Nginx 负责证书和 HTTP 到 HTTPS 跳转，应用自身仍使用 HTTP。SSE 事件流需要关闭代理缓冲。若 Nginx 也运行在容器中，应将两者接入同一 Docker 网络，并将代理目标改为 `web:8080`。

首次访问先登录网站，再在原版界面登录 VRChat、完成二步验证。原来的保存密码和自动登录选项继续使用；服务器启动会尝试恢复已保存的 VRChat 会话，遇到需要验证码等情况再通过网页处理。

仅在本机测试时，可把 `VRCX_WEB_ORIGIN` 改为 `http://localhost:8080`，通过完全相同的地址访问。公网使用配置好的 HTTPS 域名；HTTPS 模式的会话 Cookie 带有 Secure 标记。

### 局域网 HTTP 模式

无需域名、证书或 Nginx。在 `.env` 中设置：

```dotenv
VRCX_WEB_LAN_MODE=1
VRCX_WEB_LISTEN=0.0.0.0
VRCX_WEB_PORT=8080
```

然后运行 `docker compose up -d --build`，通过 `http://服务器的局域网IP:8080` 访问，例如 `http://192.168.1.10:8080`。该模式忽略 `VRCX_WEB_ORIGIN`，仍然要求网站管理密码，并校验请求 Origin 与 Host 一致；支持私有 IPv4、IPv6 ULA、链路本地及回环 IP，也支持 `localhost`。普通域名访问仍使用原来的固定 Origin 模式。

`VRCX_WEB_LAN_MODE` 默认 `0`，HTTPS 域名及 Nginx 部署方式保持不变。切换回原模式时设为 `0`，恢复 `VRCX_WEB_LISTEN=127.0.0.1` 和实际 `VRCX_WEB_ORIGIN`。HTTP 局域网模式下，浏览器可能限制剪贴板等需要安全上下文的功能。

## 后台运行和功能范围

- 关闭浏览器、网络断开、点击右上角“退出网页”均不会注销 VRChat 或停止记录。原版账号菜单中的 VRChat 注销仍会终止 VRChat 会话。
- 好友状态、社交记录、收藏、世界、头像、群组、邀请、通知、筛选、备注、标签、统计等继续调用上游的业务服务和数据库。界面仍来自同一套源码。
- 原有 Webhook、远程记录器、翻译和 AI 等服务器端集成继续使用原设置。Webhook 由服务器发送，无需保持浏览器打开。依赖第三方服务的功能仍需配置相应服务。
- 不启动本机游戏进程监测、游戏日志采集、截图监测或 VR Overlay；网页隐藏相关入口以及托盘、窗口、自启动、桌面通知、Discord RPC 等桌面设置。
- 不新增历史记录过期清理。已有数据维护、备份保留数量等独立设置仍遵循原版逻辑。
- 采集频率保持原版：实时状态以 VRChat 事件流为主，好友/收藏基线通常每小时刷新，当前用户信息每 5 分钟刷新。**资料简介扫描默认关闭**；开启后每 3 秒处理一个候选用户，同一用户至少间隔 12 小时。实际请求仍受登录状态、原版调度和限流策略约束。

网站会话最长 7 天，服务重启后需要重新登录网站；这不会删除 VRChat 的持久会话。网站密码可修改 `.env` 后通过 `docker compose up -d --force-recreate web` 生效。

## 导入、导出和备份

原版文件选择框在网页中替换为浏览器上传/下载。手动导出完成后触发下载；服务器副本保留在 `./data/web-files`。上传单次请求上限为 256 MiB，Nginx 示例与服务保持一致。

自动备份的文件夹选择支持“新建服务器文件夹”，生成的目录位于持久化数据目录内；“上传文件夹”用于导入、背景图片等操作。打开已选服务器备份文件夹时，网页显示可下载的文件列表。

迁移原版 VRCX 数据时，在原界面的迁移入口选择包含 `VRCX.sqlite3` 的原始数据目录，相关数据库及配置文件会上传到 `./data/legacy`，之后仍走原版确认与迁移流程。也可以在首次启动前将原始数据放到该目录（确保容器用户可读）。VRCX-0 的 `.vrcx0backup` 备份继续通过原版恢复入口上传与校验。恢复或迁移需要重启时，服务正常退出，由 Compose 自动拉起，然后重新登录网页。

额外备份整个实例时，先执行 `docker compose stop web`，复制完整 `./data`，再执行 `docker compose start web`。恢复整目录时保持 UID/GID `10001:10001`。目录包含账号会话和用户配置，应与网站管理密码同样妥善保管。

## 开发与上游同步

新增模块主要是 `crates/web-server` 和 `src/platform/web`：

1. Vite 的 `web` 模式把 Tauri 的调用、事件、文件和窗口接口替换成 HTTP/SSE/浏览器适配器；原版组件和生成的类型绑定继续复用。
2. Web 服务在编译时从 `src-tauri/src/commands` 中选取不依赖桌面客户端的命令，生成 HTTP 调度层，直接复用原有命令实现、错误类型和 `AppState`。新增上游业务命令会随所选模块进入构建，不需要手工复制一遍。
3. 为保留完整的现有功能，服务复用 `runtime-host-desktop` 的业务组装，开启 `web-host` 特性禁止本机游戏及 Overlay 服务；不会创建 Tauri 应用、窗口或显示服务器。原有简化的 headless CLI 保持独立。

本地构建需要项目要求的 Node.js/Rust 版本和 Linux fontconfig 开发库：

```sh
npm ci
npm run build:web
cargo build --locked -p vrcx-0-web
VRCX_WEB_ORIGIN=http://localhost:8080 \
  VRCX_WEB_PASSWORD_FILE=/path/to/website-password \
  VRCX_LEGACY_DATA_DIR=./data/legacy \
  target/debug/vrcx-0-web --data-dir ./data
```

前端热更新使用 `npm run dev:web`，默认端口 9000，API 代理到 `127.0.0.1:8080`；此时服务的 `VRCX_WEB_ORIGIN` 应为 `http://localhost:9000`。独立运行二进制时，迁移/恢复触发退出后需由进程管理器或开发者重新启动。

同步上游时先合并对应标签，再检查 `crates/web-server/build.rs` 的命令模块选择、新增桌面能力入口和 `web-host` 守卫，并分别构建桌面版与网页版。网页包和桌面包建议分开构建，避免 Cargo 的特性合并让桌面包也开启 `web-host`。

验证命令：

```sh
npm run typecheck
npm run lint
npm run build:web
cargo test --locked -p vrcx-0-web
docker compose build
```

目前自动化验证覆盖网站鉴权、跨站请求拒绝、原有数据库命令、客户端能力屏蔽和文件访问边界。真实 VRChat 账号、二步验证、持续在线事件及第三方 Webhook 投递仍需用实际账号和接收端验收。

## 更新与停止

更新本分支源码后重建并启动：

```sh
docker compose up -d --build
```

停止服务使用 `docker compose down`；再次运行上述启动命令即可恢复。持久化数据位于 `./data`，更新前建议按前述步骤备份完整目录。

## 来源与许可证

感谢 [Map1en/VRCX-0](https://github.com/Map1en/VRCX-0) 的作者及贡献者提供原版核心、界面和功能。本仓库是独立衍生的 Docker 网页版本，网页适配问题请在本仓库反馈。

沿用 [GNU GPL v3.0](LICENSE)。部分代码来自 VRCX，相关版权和 MIT 许可见 [NOTICE](NOTICE) 及 [LICENSES/MIT.txt](LICENSES/MIT.txt)。本项目不受 VRChat Inc. 官方认可，VRChat 及相关商标归其各自权利人所有。
