# VRCX-0 Web

[English](README.md) | [Français](README.fr-FR.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja-JP.md) | 한국어

**원본 [VRCX-0](https://github.com/Map1en/VRCX-0)를 기반으로 ChatGPT 주도로 개발한 Docker 웹 버전입니다.**

원본 **v2.32.0**에서 시작하여 Rust 비즈니스 로직, 데이터베이스, React 인터페이스를 최대한 재사용합니다. 변경을 최소화하여 향후 업스트림 기능을 가져오기 쉽게 유지합니다. 개발 브랜치는 `feat/web-headless`이며 현재 초기 동작 단계입니다.

데스크톱이나 디스플레이가 없는 Linux 서버에서 실행하고 브라우저로 접속합니다. 단일 사용자용으로, 하나의 활성 VRChat 계정과 설정 및 데이터를 여러 브라우저에서 공유합니다. ChatGPT는 개발에 사용되며 기본 서비스를 실행하는 데 ChatGPT 계정이 필요하지 않습니다. 선택 사항인 AI 기능은 별도의 서비스 설정이 필요합니다.

## Docker Compose로 시작하기

Linux, Docker, Docker Compose 플러그인이 필요합니다. 이 저장소 디렉터리에서 `cp .env.example .env`를 실행하고 `.env`에 실제 도메인과 12자 이상의 별도 웹사이트 비밀번호를 설정합니다.

```dotenv
VRCX_WEB_ORIGIN=https://vrcx.example.com
VRCX_WEB_PASSWORD=replace-with-your-own-strong-password
VRCX_WEB_LAN_MODE=0
VRCX_WEB_LISTEN=127.0.0.1
VRCX_WEB_PORT=8080
TZ=Asia/Shanghai
```

이미지를 내려받고 실행합니다.

```sh
cp compose.example.yaml compose.yaml
docker compose pull
docker compose up -d
docker compose logs -f web
```

기본 주소는 `127.0.0.1:8080`입니다. `VRCX_WEB_ORIGIN`은 브라우저 주소의 프로토콜, 호스트, 포트와 정확히 일치해야 하며 하위 경로를 포함하면 안 됩니다. [Nginx 설정 예시](deploy/nginx.web.conf)를 HTTPS `server` 블록에 추가하세요. Nginx가 인증서와 HTTPS 리디렉션을 처리하고 앱은 HTTP로 실행됩니다. SSE 이벤트 스트림을 위해 프록시 버퍼링을 꺼야 합니다. Nginx도 컨테이너에서 실행한다면 같은 Docker 네트워크에 연결하고 프록시 대상을 `web:8080`으로 설정합니다.

먼저 웹사이트 비밀번호로 로그인한 뒤 원본 인터페이스에서 VRChat 로그인과 2단계 인증을 완료합니다. 웹사이트 비밀번호와 VRChat 비밀번호는 별개입니다.

### 웹사이트 비밀번호 설정

`VRCX_WEB_PASSWORD`는 평문 비밀번호 또는 완전한 Argon2id v19 PHC 해시를 받습니다. 외부 도구에서 임의의 솔트와 12자 이상의 원래 비밀번호로 해시를 생성하세요. 서버는 해시에서 원래 길이를 확인할 수 없습니다. `.env`에서 `$`가 유지되도록 전체 해시를 작은따옴표로 감싸고, 로그인할 때는 원래 비밀번호를 입력하세요. `$argon2` 접두사는 해시 전용이며 잘못된 해시는 시작 오류가 됩니다. `VRCX_WEB_PASSWORD_FILE`은 제거되었습니다. 빈 값이라도 해당 변수와 불필요한 마운트를 삭제하고 `VRCX_WEB_PASSWORD`를 설정한 뒤 이미지를 업데이트하고 Web 컨테이너를 다시 생성하세요. [자세한 설정 안내](README.md#website-password-configuration)를 참고하세요.

## LAN HTTP 모드

도메인, 인증서, Nginx 없이 사용할 수 있습니다. `.env`를 변경합니다.

```dotenv
VRCX_WEB_LAN_MODE=1
VRCX_WEB_LISTEN=0.0.0.0
VRCX_WEB_PORT=8080
```

LAN 모드에서만 `VRCX_WEB_PASSWORD`가 비어 있거나 설정되지 않은 경우 웹사이트 로그인 없이 사용할 수 있습니다. 비밀번호가 설정되어 있으면 여전히 로그인이 필요하며, 비밀번호는 12자 이상이어야 합니다. VRChat 로그인은 별도로 유지됩니다. 고정 Origin 모드로 돌아가기 전에 웹사이트 비밀번호를 설정하세요.

`docker compose pull && docker compose up -d`를 실행하고 `http://서버의LAN_IP:8080`으로 접속합니다. 이 모드는 `VRCX_WEB_ORIGIN`을 무시하고 Origin과 Host의 일치를 확인합니다. 사설 IPv4, IPv6 ULA, 링크 로컬 및 루프백 IP, `localhost`를 지원합니다. 일반 도메인은 고정 Origin 모드를 사용하세요. HTTP에서는 클립보드 기능이 제한될 수 있습니다. HTTPS로 돌아가려면 LAN 모드를 `0`으로 설정하고 바인딩 주소와 실제 HTTPS Origin을 복원합니다.

## 기능과 백그라운드 실행

- 원본 화면과 친구 상태, 소셜 기록, 즐겨찾기, 월드, 아바타, 그룹, 초대, 알림, 메모, 태그, 통계를 유지합니다.
- Webhook, 원격 로거 연동, 번역, 선택 사항인 AI 연동을 유지합니다. 외부 서비스는 별도 설정이 필요하며 Webhook은 서버에서 전송합니다.
- 브라우저를 닫거나 웹사이트에서 로그아웃해도 수집을 계속합니다. VRChat에서 직접 로그아웃하면 VRChat 세션이 종료됩니다.
- 로컬 게임 프로세스, 게임 로그, 스크린샷 감시, VR Overlay를 비활성화합니다. 트레이, 창 제어, 자동 시작, 데스크톱 알림, Discord RPC 등의 항목은 숨깁니다.
- 기록 보관 기간에 따른 자동 삭제를 추가하지 않습니다. 기존 유지 관리와 백업 보관 설정은 원본을 따릅니다.
- 친구/즐겨찾기는 보통 매시간, 현재 사용자 정보는 5분마다 갱신합니다. 소개문 스캔은 기본적으로 꺼져 있습니다. 켜면 3초마다 후보 한 명을 처리하고 같은 사용자는 최소 12시간 간격을 둡니다. 원본 스케줄과 요청 제한이 적용됩니다.

## 데이터, 백업 및 업데이트

데이터베이스, 계정 세션, 설정, 캐시, 백업은 **`./data`**에 저장되므로 컨테이너를 다시 만들어도 유지됩니다. `init-data`가 성공한 뒤 종료되는 것은 정상입니다. 서비스의 UID/GID는 `10001:10001`입니다. 전체 디렉터리를 백업하거나 옮길 때 `./data/.machine-id`를 반드시 포함하세요. 실행 중인 여러 인스턴스가 하나의 데이터 디렉터리를 공유하면 안 됩니다.

파일 작업은 브라우저 업로드/다운로드로 대체됩니다. 요청당 업로드 한도는 256 MiB입니다. 수동 내보내기 사본은 `./data/web-files`, VRCX 마이그레이션 데이터는 `./data/legacy`에 저장됩니다. 기존 복원 화면에서 `.vrcx0backup`을 사용할 수 있습니다.

전체 백업은 `docker compose stop web` 실행 후 숨김 파일을 포함한 `./data` 전체를 복사하고 `docker compose start web`으로 다시 시작합니다. 복원 시 소유권은 `10001:10001`로 유지하세요. 백업에는 계정 세션이 포함됩니다.

이미지를 업데이트하려면 `docker compose pull && docker compose up -d`를 실행합니다. 중지는 `docker compose down`입니다. 웹사이트 세션은 최대 7일이며 서버 재시작 후 다시 로그인해야 합니다. 저장된 VRChat 세션은 별도로 유지됩니다. 웹사이트 비밀번호를 변경한 뒤에는 `docker compose up -d --force-recreate web`을 실행합니다.

## 개발 및 상세 안내

구조, 소스 빌드, 마이그레이션, 업스트림 동기화는 [English README](README.md)를 참고하세요. 웹 어댑터는 주로 `crates/web-server`와 `src/platform/web`에 있습니다. 자동 검증은 웹 인증과 파일 접근 경계 등을 다룹니다. 실제 VRChat 로그인, 2단계 인증, 장시간 이벤트 수신, Webhook 전송은 실제 계정과 수신 대상으로 확인해야 합니다.

## 출처와 라이선스

[Map1en/VRCX-0](https://github.com/Map1en/VRCX-0)의 제작자와 기여자에게 감사드립니다. 이 저장소는 독립적인 Docker 웹 파생 버전이며 웹 버전 문제는 이 저장소에 제보하세요. [GNU GPL v3.0](LICENSE)을 따릅니다. VRCX에서 유래한 코드의 저작권 및 MIT 라이선스는 [NOTICE](NOTICE)와 [LICENSES/MIT.txt](LICENSES/MIT.txt)를 참고하세요. 본 프로젝트는 VRChat Inc.의 공식 승인을 받지 않았으며 관련 상표는 각 권리자에게 귀속됩니다.
