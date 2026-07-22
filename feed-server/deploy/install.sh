#!/usr/bin/env bash
# ============================================================
#  market-feed 서버 설치 / 갱신  (서버에서 실행)
#
#  최초 설치:  git clone → 이 스크립트 실행
#  이후 갱신:  git pull  → 이 스크립트 실행 (멱등, 몇 번 돌려도 안전)
#
#  ※ themecloset_builder 와 완전히 분리되어 있습니다.
#     - 별도 디렉터리 /home/market-feed
#     - 별도 PM2 앱 이름 market-feed
#     - 별도 포트 6210 (themecloset 은 6109/5109)
#     - 별도 DB (SQLite 파일, MySQL 안 씀)
#     - nginx 안 씀 (직접 포트 접속)
# ============================================================
set -euo pipefail

APP_DIR="${MARKET_FEED_DIR:-/home/market-feed}"
APP_NAME="market-feed"
PORT="${PORT:-6210}"

cd "$APP_DIR"

echo "════════════════════════════════════════════"
echo "  market-feed 설치/갱신"
echo "  경로: $APP_DIR"
echo "════════════════════════════════════════════"

# ── 1. Node 버전 확인 (node:sqlite 는 22.5+ 필요) ──
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "❌ Node 22 이상이 필요합니다 (현재: $(node -v 2>/dev/null || echo 없음))"
  exit 1
fi
echo "✓ Node $(node -v)"

# ── 2. 디렉터리 준비 ──
mkdir -p data logs
chmod 700 data

# ── 3. .env 확인 (없으면 생성하고 멈춤) ──
if [[ ! -f .env ]]; then
  echo ""
  echo "⚠️  .env 가 없습니다. 새로 만듭니다 — 키는 자동 생성됩니다."
  MY_IP="$(echo "${SSH_CLIENT:-}" | awk '{print $1}')"
  cat > .env <<EOF
PORT=$PORT
HOST=0.0.0.0
MARKET_DB_FILE=$APP_DIR/data/feed.db

# 쓰기: 맥의 cron 만 가진다
MARKET_WRITE_SECRET=$(openssl rand -hex 32)
# 읽기: market_watch 오버레이가 가진다
MARKET_READ_KEY=$(openssl rand -hex 32)

# 이 서버엔 방화벽이 없다 — 이 목록이 유일한 차단 지점이다.
# 집 IP 가 바뀌면:  ./deploy/allow-ip.sh auto
MARKET_ALLOWED_IPS=127.0.0.1${MY_IP:+,$MY_IP}
EOF
  chmod 600 .env
  echo "✓ .env 생성 완료 (허용 IP: 127.0.0.1${MY_IP:+, $MY_IP})"
  echo ""
  echo "  아래 키를 맥에 옮겨 적으세요:"
  echo "  ─────────────────────────────────────────"
  grep -E '^MARKET_(WRITE_SECRET|READ_KEY)=' .env | sed 's/^/    /'
  echo "  ─────────────────────────────────────────"
  echo ""
else
  echo "✓ 기존 .env 유지 (키를 덮어쓰지 않습니다)"
  chmod 600 .env
fi

# ── 4. 자체 점검 ──
echo ""
echo "── 자체 점검 ──"
node scripts/ipallow.test.mjs 2>&1 | tail -3

# ── 5. PM2 등록/재시작 ──
echo ""
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "→ 기존 앱 재시작"
  pm2 restart "$APP_NAME" --update-env
else
  echo "→ 신규 등록"
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save >/dev/null 2>&1 || true

# ── 6. 헬스체크 ──
sleep 2
echo ""
echo "── 헬스체크 ──"
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  curl -s "http://127.0.0.1:$PORT/health" | head -c 500; echo
  echo ""
  echo "✅ 설치 완료"
  echo ""
  PUBIP="$(curl -s --max-time 5 https://api.ipify.org || echo '<서버IP>')"
  echo "  접속 주소:  http://$PUBIP:$PORT/health"
  echo "  내 IP 확인: http://$PUBIP:$PORT/whoami   (허용목록과 무관하게 항상 응답)"
  echo ""
  echo "  ⚠️  이 서버엔 방화벽이 없어 포트가 인터넷에 열려 있습니다."
  echo "      허용목록에 없는 IP 는 404 를 받습니다 (앱에서 차단)."
else
  echo "❌ 헬스체크 실패 — 로그 확인:  pm2 logs $APP_NAME --lines 40"
  exit 1
fi
