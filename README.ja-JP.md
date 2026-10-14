# VRCX-0 Web

[English](README.md) | [Français](README.fr-FR.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-Hant.md) | 日本語 | [한국어](README.ko-KR.md)

**オリジナルの [VRCX-0](https://github.com/Map1en/VRCX-0) をベースに、ChatGPT 主導で開発した Docker 向け Web 版です。**

上流の **v2.32.0** を基に、Rust の業務ロジック、データベース、React の画面をできるだけ再利用しています。変更を小さく保ち、上流の機能を取り込みやすくする方針です。開発ブランチは `feat/web-headless` で、現在は初期の動作可能な段階です。

デスクトップやディスプレイのない Linux サーバーで動作し、ブラウザーから利用できます。単一ユーザー向けで、1 つのアクティブな VRChat アカウント、設定、データを複数のブラウザーで共有します。ChatGPT は開発に使用しており、基本機能の実行に ChatGPT アカウントは不要です。任意の AI 機能には別途プロバイダーの設定が必要です。

## Docker Compose での起動

Linux、Docker、Docker Compose プラグインが必要です。このリポジトリのディレクトリで `cp .env.example .env` を実行し、`.env` に実際のドメインと 12 文字以上の専用 Web パスワードを設定します。

```dotenv
VRCX_WEB_ORIGIN=https://vrcx.example.com
VRCX_WEB_PASSWORD=replace-with-your-own-strong-password
VRCX_WEB_LAN_MODE=0
VRCX_WEB_LISTEN=127.0.0.1
VRCX_WEB_PORT=8080
TZ=Asia/Shanghai
```

イメージを取得して起動します。

```sh
cp compose.example.yaml compose.yaml
docker compose pull
docker compose up -d
docker compose logs -f web
```

初期設定では `127.0.0.1:8080` のみで待ち受けます。`VRCX_WEB_ORIGIN` はブラウザーの URL のスキーム、ホスト名、ポートと完全に一致させ、サブパスを含めないでください。[Nginx 設定例](deploy/nginx.web.conf) を HTTPS の `server` ブロックに追加します。証明書と HTTPS リダイレクトは Nginx が担当し、アプリは HTTP で動作します。SSE 用のプロキシバッファリングは無効にしてください。Nginx もコンテナーの場合は同じ Docker ネットワークに接続し、転送先を `web:8080` にします。

最初に Web パスワードでログインし、その後、元の画面から VRChat にログインして二要素認証を完了します。Web パスワードと VRChat のパスワードは別々です。

## LAN 内で HTTP を使う

ドメイン、証明書、Nginx なしでも利用できます。`.env` を変更します。

```dotenv
VRCX_WEB_LAN_MODE=1
VRCX_WEB_LISTEN=0.0.0.0
VRCX_WEB_PORT=8080
```

LAN モードに限り、`VRCX_WEB_PASSWORD` が空または未設定なら Web ログインなしで利用できます。パスワードを設定した場合はログインが必要で、12 文字以上でなければなりません。VRChat のログインは別です。固定 Origin モードに戻す前に Web パスワードを設定してください。

`docker compose pull && docker compose up -d` を実行し、`http://サーバーのLAN内IP:8080` にアクセスします。このモードは `VRCX_WEB_ORIGIN` を無視し、Origin と Host の一致を確認します。プライベート IPv4、IPv6 ULA、リンクローカル、ループバック IP、`localhost` に対応します。通常のドメイン名では固定 Origin モードを使用します。HTTP ではクリップボード機能が制限される場合があります。HTTPS に戻す場合は LAN モードを `0` にし、待ち受けアドレスと実際の HTTPS Origin を戻してください。

## 機能とバックグラウンド動作

- 元の画面と、フレンドの状態、交流履歴、お気に入り、ワールド、アバター、グループ、招待、通知、メモ、タグ、統計を再利用します。
- Webhook、リモートロガー連携、翻訳、任意の AI 連携を維持します。外部サービスの設定は別途必要です。Webhook はサーバーから送信します。
- ブラウザーを閉じたり Web サイトからログアウトしても記録を継続します。VRChat 自体からログアウトすると VRChat セッションは終了します。
- ローカルのゲームプロセス、ゲームログ、スクリーンショット監視、VR Overlay は無効です。トレイ、ウィンドウ操作、自動起動、デスクトップ通知、Discord RPC などの項目は非表示です。
- 履歴の期限による自動削除は追加しません。既存の保守処理とバックアップ保持設定は元の仕様に従います。
- フレンド／お気に入りは通常 1 時間ごと、現在のユーザーは 5 分ごとに更新します。プロフィール文のスキャンは初期状態では無効です。有効にすると 3 秒ごとに候補 1 人を処理し、同じユーザーは最低 12 時間空けます。元のスケジュールとレート制限が適用されます。

## データ、バックアップ、更新

データベース、セッション、設定、キャッシュ、バックアップは **`./data`** に保存され、コンテナーを再作成しても維持されます。`init-data` が正常終了して停止するのは通常の動作です。サービスの UID/GID は `10001:10001` です。ディレクトリ全体をバックアップ・移行するときは `./data/.machine-id` も必ず含めてください。稼働中の複数インスタンスで同じデータディレクトリを共有しないでください。

ファイル操作はブラウザーのアップロード／ダウンロードに置き換えられ、1 リクエストのアップロード上限は 256 MiB です。手動エクスポートのコピーは `./data/web-files`、VRCX 移行データは `./data/legacy` に保存します。既存の画面から `.vrcx0backup` を復元できます。

全体バックアップは `docker compose stop web` の後、隠しファイルを含む `./data` 全体をコピーし、`docker compose start web` で再開します。復元時の所有者は `10001:10001` にしてください。バックアップにはアカウントセッションが含まれます。

イメージを更新するには `docker compose pull && docker compose up -d` を実行します。停止は `docker compose down` です。Web セッションは最長 7 日で、サーバー再起動後は再ログインが必要です。永続化された VRChat セッションは別に保持されます。Web パスワード変更後は `docker compose up -d --force-recreate web` を実行します。

## 開発と詳細な手順

構成、ソースからのビルド、移行、上流との同期については [English README](README.md) を参照してください。Web 向けの変更は主に `crates/web-server` と `src/platform/web` にあります。自動検証は Web 認証やファイルアクセス境界などを対象とします。実際の VRChat ログイン、二要素認証、長時間のイベント受信、Webhook 配信は実アカウントと受信先での確認が必要です。

## クレジットとライセンス

[Map1en/VRCX-0](https://github.com/Map1en/VRCX-0) の作者と貢献者に感謝します。本リポジトリは独立した Docker Web 派生版です。Web 版の問題は本リポジトリに報告してください。[GNU GPL v3.0](LICENSE) を継承します。VRCX 由来のコードの帰属と MIT ライセンスは [NOTICE](NOTICE) および [LICENSES/MIT.txt](LICENSES/MIT.txt) を参照してください。本プロジェクトは VRChat Inc. の公式な承認を受けていません。商標は各権利者に帰属します。
