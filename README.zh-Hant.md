# VRCX-0 Web

[English](README.md) | [Français](README.fr-FR.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [日本語](README.ja-JP.md) | [한국어](README.ko-KR.md)

**基於原版 [VRCX-0](https://github.com/Map1en/VRCX-0)、由 ChatGPT 驅動開發的 Docker 網頁版本。**

本分支以 **v2.32.0** 為基礎，盡可能共用原版 Rust 業務邏輯、資料庫與 React 介面，減少修改以方便同步上游。開發分支為 `feat/web-headless`，目前處於初步可用階段。

在沒有桌面或顯示器的 Linux 伺服器上執行，透過瀏覽器操作。適用於單一使用者：一個使用中的 VRChat 帳號，多個瀏覽器共用設定與資料。ChatGPT 用於開發，基本服務執行不需要 ChatGPT 帳號；選用 AI 功能仍需自行設定服務。

## Docker Compose 部署

需要 Linux、Docker 與 Docker Compose 外掛。在本專案目錄執行 `cp .env.example .env`，編輯 `.env`，填入實際網域及至少 12 個字元的獨立網站密碼：

```dotenv
VRCX_WEB_ORIGIN=https://vrcx.example.com
VRCX_WEB_PASSWORD=replace-with-your-own-strong-password
VRCX_WEB_LAN_MODE=0
VRCX_WEB_LISTEN=127.0.0.1
VRCX_WEB_PORT=8080
TZ=Asia/Shanghai
```

建置並啟動：

```sh
docker compose up -d --build
docker compose logs -f web
```

預設只監聽 `127.0.0.1:8080`。`VRCX_WEB_ORIGIN` 必須與瀏覽器網址的協定、網域及連接埠完全一致，不包含子路徑。將 [Nginx 設定片段](deploy/nginx.web.conf) 放入該網域的 HTTPS `server` 區塊；Nginx 負責憑證及 HTTPS 轉址，應用程式使用 HTTP，SSE 事件串流須關閉代理緩衝。若 Nginx 也在容器中，使用共用 Docker 網路及 `web:8080` 作為代理目標。

首次開啟網頁時先輸入網站密碼，再於原版介面登入 VRChat 並完成兩步驟驗證。網站密碼與 VRChat 密碼彼此獨立。

## 區域網路 HTTP 模式

不需要網域、憑證或 Nginx。保留網站密碼，修改 `.env`：

```dotenv
VRCX_WEB_LAN_MODE=1
VRCX_WEB_LISTEN=0.0.0.0
VRCX_WEB_PORT=8080
```

再次執行 `docker compose up -d --build`，使用 `http://伺服器的區域網路IP:8080` 存取。此模式忽略 `VRCX_WEB_ORIGIN`，驗證 Origin 與 Host 相符，支援私有 IPv4、IPv6 ULA、鏈路本地、回環 IP 及 `localhost`。一般網域使用固定 Origin 模式。HTTP 下瀏覽器可能限制剪貼簿功能。回復 HTTPS 部署時，將 LAN 模式設為 `0`，還原監聽位址及實際 HTTPS Origin。

## 功能與背景執行

- 保留好友狀態、社交紀錄、收藏、世界、虛擬形象、群組、邀請、通知、備註、標籤、統計與原版介面。
- 保留 Webhook、遠端記錄器、翻譯與選用 AI 整合；第三方服務需另行設定。Webhook 由伺服器發送。
- 關閉瀏覽器或登出網站後仍持續記錄。原版選單中的 VRChat 登出會結束 VRChat 工作階段。
- 停用本機遊戲程序、遊戲日誌、螢幕擷取監測及 VR Overlay，隱藏系統匣、視窗、自動啟動、桌面通知及 Discord RPC 等桌面功能。
- 不新增歷史紀錄到期清理；既有維護與備份保留設定沿用原版。
- 好友／收藏通常每小時更新，目前使用者每 5 分鐘更新。簡介掃描預設關閉；啟用後每 3 秒處理一位候選使用者，同一人至少間隔 12 小時，仍受原版排程與限流影響。

## 資料、備份與更新

資料庫、帳號工作階段、設定、快取和備份儲存在 **`./data`**，重建容器會保留資料。`init-data` 成功執行後退出屬正常行為，服務使用 UID/GID `10001:10001`。整目錄備份及搬移時，務必保留 `./data/.machine-id`；請勿讓多個執行中的實例共用資料目錄。

原版匯入／匯出改用瀏覽器上傳／下載，單次上傳上限為 256 MiB。手動匯出副本位於 `./data/web-files`；VRCX 遷移資料位於 `./data/legacy`，也可透過原介面還原 `.vrcx0backup`。

完整備份前執行 `docker compose stop web`，複製完整 `./data`（含隱藏檔），再執行 `docker compose start web`。還原時維持 `10001:10001` 擁有權。備份含帳號工作階段，請妥善保管。

更新本分支原始碼後執行 `docker compose up -d --build`。停止服務使用 `docker compose down`。網站登入最長維持 7 天，伺服器重啟後需重新登入；已儲存的 VRChat 工作階段獨立保留。修改網站密碼後執行 `docker compose up -d --force-recreate web`。

## 開發與詳細說明

完整架構、原始碼建置、遷移與上游同步步驟見 [English README](README.md) 或 [简体中文说明](README.zh-CN.md)。網頁適配集中於 `crates/web-server` 與 `src/platform/web`。目前自動化驗證涵蓋網站鑑權與檔案邊界等；實際 VRChat 登入、兩步驟驗證、長時間事件及 Webhook 投遞仍需使用真實帳號與接收端驗收。

## 來源與授權

感謝 [Map1en/VRCX-0](https://github.com/Map1en/VRCX-0) 的作者與貢獻者。本倉庫是獨立衍生的 Docker 網頁版本，網頁版問題請在本倉庫回報。沿用 [GNU GPL v3.0](LICENSE)；來自 VRCX 的部分程式碼之著作權與 MIT 授權見 [NOTICE](NOTICE) 及 [LICENSES/MIT.txt](LICENSES/MIT.txt)。本專案不受 VRChat Inc. 官方認可，相關商標歸各權利人所有。
