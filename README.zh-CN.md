# VRCX-0 Web

[English](README.md) | [Français](README.fr-FR.md) | 简体中文 | [繁體中文](README.zh-Hant.md) | [日本語](README.ja-JP.md) | [한국어](README.ko-KR.md)

**基于原版 [VRCX-0](https://github.com/Map1en/VRCX-0)、由 ChatGPT 驱动开发的 Docker 网页版本。**

本项目从原版 **v2.32.0**（`9e4e2193b88513882d3b4173e598f48eeb65092b`）衍生，网页版开发由 ChatGPT 驱动，尽可能复用原项目的 Rust 业务逻辑、数据库和 React 界面，以减少改动并方便同步上游功能。当前处于初步可用阶段。

在无桌面环境的 Linux 上通过 Docker Compose 运行，通过浏览器访问。服务器持续记录从 VRChat 获取的好友状态等信息，关闭浏览器后仍然运行。面向单用户使用：一个活动 VRChat 账号，多个浏览器共享账号、设置和数据库。网站密码与 VRChat 密码相互独立。

ChatGPT 用于本分支的开发；基础服务运行无需 ChatGPT 账号。原版可选 AI 功能仍需自行配置服务。

## 使用 Docker Compose

需要 amd64（Intel/AMD x86-64）Linux 主机、Docker 和 Docker Compose 插件。默认拉取公开镜像 `ghcr.io/e-larex/vrcx-docker:latest`，无需登录 GitHub，也无需在服务器编译。在本项目目录执行：

```sh
cp compose.example.yaml compose.yaml
cp .env.example .env
# 编辑 .env：填写实际域名和独立的网站管理密码（至少 12 个字符）
docker compose pull
docker compose up -d
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

然后运行 `docker compose pull` 和 `docker compose up -d`，通过 `http://服务器的局域网IP:8080` 访问，例如 `http://192.168.1.10:8080`。该模式忽略 `VRCX_WEB_ORIGIN`，校验请求 Origin 与 Host 一致；支持私有 IPv4、IPv6 ULA、链路本地及回环 IP，也支持 `localhost`。普通域名访问仍使用原来的固定 Origin 模式。

如需免网站登录，将 `VRCX_WEB_PASSWORD` 留空或不设置。只有 `VRCX_WEB_LAN_MODE=1` 允许无密码启动；设置了密码仍需登录，且密码至少 12 个字符。免密码模式下，能够访问受支持局域网地址的用户可直接使用共享应用；VRChat 账号登录仍独立进行。独立运行服务器时，`VRCX_WEB_PASSWORD_FILE` 的内容优先于密码环境变量。

`VRCX_WEB_LAN_MODE` 默认 `0`，HTTPS 域名及 Nginx 部署方式保持不变。切换回原模式时需设置网站密码，将 LAN 模式设为 `0`，恢复 `VRCX_WEB_LISTEN=127.0.0.1` 和实际 `VRCX_WEB_ORIGIN`。HTTP 局域网模式下，浏览器可能限制剪贴板等需要安全上下文的功能。

## 后台运行和功能范围

- 关闭浏览器、网络断开、点击左上角菜单中的“退出 VRCX-0”均不会注销 VRChat 或停止记录。原版账号菜单中的 VRChat 注销仍会终止 VRChat 会话。
- 好友状态、社交记录、收藏、世界、头像、群组、邀请、通知、筛选、备注、标签、统计等继续调用上游的业务服务和数据库。界面仍来自同一套源码。
- 原有 Webhook、远程记录器、翻译和 AI 等服务器端集成继续使用原设置。Webhook 由服务器发送，无需保持浏览器打开。依赖第三方服务的功能仍需配置相应服务。
- 不启动本机游戏进程监测、游戏日志采集、截图监测或 VR Overlay；网页隐藏相关入口以及托盘、窗口、自启动、桌面通知、Discord RPC 等桌面设置。
- 不新增历史记录过期清理。已有数据维护、备份保留数量等独立设置仍遵循原版逻辑。
- 采集频率保持原版：实时状态以 VRChat 事件流为主，好友/收藏基线通常每小时刷新，当前用户信息每 5 分钟刷新。**资料简介扫描默认关闭**；开启后每 3 秒处理一个候选用户，同一用户至少间隔 12 小时。实际请求仍受登录状态、原版调度和限流策略约束。

设置网站密码时，网站会话最长 7 天，服务重启后需要重新登录网站；这不会删除 VRChat 的持久会话。网站密码可修改 `.env` 后通过 `docker compose up -d --force-recreate web` 生效。左上角“退出 VRCX-0”仅退出当前网站会话，免密码模式下隐藏；右上角不再单独显示退出按钮。

## 导入、导出和备份

原版文件选择框在网页中替换为浏览器上传/下载。手动导出完成后触发下载；服务器副本保留在 `./data/web-files`。上传单次请求上限为 256 MiB，Nginx 示例与服务保持一致。

文件夹选择器可浏览 `./data/web-files` 内的子目录，支持选择已有文件夹、新建时输入名称，以及上传本地文件夹时修改目标名称。新文件夹直接创建在当前浏览的目录下；同名时提示换名，不覆盖或合并已有内容。上传保留内部文件结构，但仅保存副本，不会持续同步本地修改；空本地文件夹无法上传。自动备份写入所选服务器目录，打开该目录可查看并下载文件。

迁移原版 VRCX 数据时，在原界面的迁移入口选择包含 `VRCX.sqlite3` 的原始数据目录，相关数据库及配置文件会上传到 `./data/legacy`，之后仍走原版确认与迁移流程。也可以在首次启动前将原始数据放到该目录（确保容器用户可读）。VRCX-0 的 `.vrcx0backup` 备份继续通过原版恢复入口上传与校验。恢复或迁移需要重启时，服务正常退出，由 Compose 自动拉起，然后重新登录网页。

额外备份整个实例时，先执行 `docker compose stop web`，复制完整 `./data`，再执行 `docker compose start web`。恢复整目录时保持 UID/GID `10001:10001`。目录包含账号会话和用户配置，应与网站管理密码同样妥善保管。

## 从源码部署

从本地源码构建 Docker 镜像时，先按上文复制配置文件并填写 `.env`，再使用显式构建配置：

```sh
docker compose -f compose.yaml -f compose.build.yaml build web
docker compose -f compose.yaml -f compose.build.yaml up -d
```

该配置让两个服务使用本地 `vrcx-0-web:local` 镜像，不拉取 GHCR。后续日志、停止等命令也使用同样的两个 `-f` 参数。

## 更新与停止

拉取新镜像并重建容器：

```sh
docker compose pull
docker compose up -d
```

默认使用 `latest`。要固定版本或回滚，在 `.env` 中设置：

```dotenv
VRCX_WEB_IMAGE=ghcr.io/e-larex/vrcx-docker:2.32.0-web.1
```

再执行上述拉取和启动命令。`init-data` 和 `web` 始终使用同一镜像。镜像回滚不会回滚数据库；若更新涉及不兼容的数据迁移，应同时恢复更新前的完整数据备份。

停止服务使用 `docker compose down`；再次运行上述启动命令即可恢复。持久化数据位于 `./data`，更新前建议按前述步骤备份完整目录。

## 来源与许可证

感谢 [Map1en/VRCX-0](https://github.com/Map1en/VRCX-0) 的作者及贡献者提供原版核心、界面和功能。本仓库是独立衍生的 Docker 网页版本，网页适配问题请在本仓库反馈。

沿用 [GNU GPL v3.0](LICENSE)。部分代码来自 VRCX，相关版权和 MIT 许可见 [NOTICE](NOTICE) 及 [LICENSES/MIT.txt](LICENSES/MIT.txt)。本项目不受 VRChat Inc. 官方认可，VRChat 及相关商标归其各自权利人所有。
