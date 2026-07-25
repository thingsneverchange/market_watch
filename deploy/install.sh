#!/usr/bin/env bash
# ============================================================
#  market-watch 오버레이 설치 / 갱신  (서버에서 실행)
#
#  최초:  git clone → 이 스크립트
#  갱신:  git pull  → 이 스크립트   (멱등 — 여러 번 돌려도 안전)
#
#  ※ 기존 앱과 완전히 분리:
#     - 디렉터리 /home/market-watch   (themecloset_builder, market-feed 와 별도)
#     - PM2 이름 market-watch-overlay (market-feed / themecloset-* 와 다름)
#     - 포트 6211                     (market-feed 6210 / themecloset 6109·5109 와 다름)
#     - nginx 안 씀 (포트 직결) → IP 허용목록이 유일한 방어선
# ============================================================
set -euo pipefail

APP_DIR="${MARKET_WATCH_DIR:-/home/market-watch}"
APP_NAME="market-watch-overlay"
PORT="${PORT:-6211}"

cd "$APP_DIR"

echo "════════════════════════════════════════════"
echo "  market-watch 오버레이 설치/갱신"
echo "  경로: $APP_DIR   포트: $PORT   PM2: $APP_NAME"
echo "════════════════════════════════════════════"

# ── 1. Node 확인 ──
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "❌ Node 20 이상이 필요합니다 (현재: $(node -v 2>/dev/null || echo 없음))"
  exit 1
fi
echo "✓ Node $(node -v)"

mkdir -p logs

# ── 2. .env 확인 ──
# 오버레이는 시세 키(FINNHUB/FMP)와 피드 읽기키가 필요하다.
# 자동 생성하지 않는다 — 키는 사람이 넣어야 한다.
if [[ ! -f .env ]]; then
  MY_IP="$(echo "${SSH_CLIENT:-}" | awk '{print $1}')"
  cat > .env <<EOF
# ── 시세 API 키 (맥의 market_watch/.env 에서 복사) ──
FINNHUB_API_KEY=
FMP_API_KEY=

# ── market-feed 연결 (같은 서버) ──
MARKET_FEED_URL=http://127.0.0.1:6210
MARKET_READ_KEY=

# ── IP 허용목록 (이 앱엔 nginx 가 없어 유일한 방어선) ──
# 비우면 게이트가 꺼진다 → 서버에서는 반드시 채울 것!
# /control 이 열리면 아무나 방송에 가짜 속보를 띄울 수 있다.
MARKET_WATCH_ALLOWED_IPS=127.0.0.1${MY_IP:+,$MY_IP}
EOF
  chmod 600 .env
  echo ""
  echo "⚠️  .env 를 새로 만들었습니다. 키를 채운 뒤 이 스크립트를 다시 실행하세요:"
  echo "     nano $APP_DIR/.env"
  echo "   (허용 IP 는 ${MY_IP:-현재 SSH IP} 로 미리 넣어 두었습니다)"
  exit 1
fi
chmod 600 .env

# 필수 키 확인 (값은 출력하지 않는다)
missing=""
for k in FINNHUB_API_KEY MARKET_WATCH_ALLOWED_IPS; do
  grep -qE "^$k=.+" .env || missing="$missing $k"
done
if [[ -n "$missing" ]]; then
  echo "❌ .env 에 다음 값이 비어 있습니다:$missing"
  echo "   nano $APP_DIR/.env"
  exit 1
fi
echo "✓ .env 확인 (필수 키 존재)"

# ── 3. 의존성 + 빌드 ──
echo ""
echo "→ 의존성 설치"
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2 || npm install --no-audit --no-fund 2>&1 | tail -2
echo "→ 빌드 (devDependencies 필요)"
npm install --no-audit --no-fund 2>&1 | tail -2
npm run build 2>&1 | tail -3

# ── 4. PM2 등록/재시작 ──
echo ""
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "→ 기존 앱 재시작"
  pm2 restart "$APP_NAME" --update-env
else
  echo "→ 신규 등록"
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save >/dev/null 2>&1 || true

# ── 5. 헬스체크 ──
sleep 3
echo ""
echo "── 헬스체크 ──"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/whoami" || echo 000)"
if [[ "$CODE" == "200" ]]; then
  curl -s "http://127.0.0.1:$PORT/whoami"; echo
  PUBIP="$(curl -s --max-time 5 https://api.ipify.org || echo '<서버IP>')"
  echo ""
  echo "✅ 설치 완료"
  echo ""
  echo "  오버레이 (OBS 브라우저 소스):  http://$PUBIP:$PORT/"
  echo "  컨트롤러 (폰):                 http://$PUBIP:$PORT/control"
  echo "  내 IP 확인:                    http://$PUBIP:$PORT/whoami"
  echo ""
  echo "  ⚠️  허용목록에 없는 IP 는 404 를 받습니다."
  echo "      집 IP 가 바뀌면: nano $APP_DIR/.env → MARKET_WATCH_ALLOWED_IPS 수정 → pm2 restart $APP_NAME --update-env"
else
  echo "❌ 헬스체크 실패 (HTTP $CODE) — 로그: pm2 logs $APP_NAME --lines 40"
  exit 1
fi
