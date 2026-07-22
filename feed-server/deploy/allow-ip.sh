#!/usr/bin/env bash
# ============================================================
#  허용 IP 추가/교체  (서버에서 실행)
#
#  집 인터넷 IP 는 바뀝니다. 접속이 안 되면 이걸 실행하세요:
#
#    ssh root@165.232.146.7 '/home/market-feed/deploy/allow-ip.sh auto'
#
#  auto  = SSH 로 접속한 당신의 현재 IP 를 자동으로 넣습니다 (가장 편함)
#  <IP>  = 특정 IP/CIDR 을 추가합니다
#  --replace 를 붙이면 기존 목록을 지우고 새로 씁니다
# ============================================================
set -euo pipefail

APP_DIR="${MARKET_FEED_DIR:-/home/market-feed}"
ENV_FILE="$APP_DIR/.env"
KEY="MARKET_ALLOWED_IPS"

[[ -f "$ENV_FILE" ]] || { echo "❌ $ENV_FILE 이 없습니다"; exit 1; }

TARGET="${1:-auto}"
REPLACE=0
[[ "${2:-}" == "--replace" || "${1:-}" == "--replace" ]] && REPLACE=1

if [[ "$TARGET" == "auto" || "$TARGET" == "--replace" ]]; then
  # SSH_CLIENT 의 첫 필드가 접속해 온 IP
  TARGET="$(echo "${SSH_CLIENT:-}" | awk '{print $1}')"
  [[ -n "$TARGET" ]] || { echo "❌ SSH 접속 IP 를 알 수 없습니다. IP 를 직접 지정하세요."; exit 1; }
  echo "→ SSH 접속 IP 를 사용합니다: $TARGET"
fi

# 형식 검증 (앱과 동일한 규칙 — 앞자리 0 패딩 거부)
if ! echo "$TARGET" | grep -qE '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}(/[0-9]{1,2})?$'; then
  echo "❌ IP 형식이 아닙니다: $TARGET"; exit 1
fi

CURRENT="$(grep -E "^${KEY}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"

if [[ $REPLACE -eq 1 || -z "$CURRENT" ]]; then
  NEW="127.0.0.1,$TARGET"
else
  if echo ",$CURRENT," | grep -q ",$TARGET,"; then
    echo "✓ 이미 허용목록에 있습니다: $TARGET"
    echo "  현재 목록: $CURRENT"
    exit 0
  fi
  NEW="$CURRENT,$TARGET"
fi

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
if grep -qE "^${KEY}=" "$ENV_FILE"; then
  sed -i "s|^${KEY}=.*|${KEY}=${NEW}|" "$ENV_FILE"
else
  echo "${KEY}=${NEW}" >> "$ENV_FILE"
fi

echo "✓ 허용목록 갱신: $NEW"
pm2 restart market-feed --update-env >/dev/null 2>&1 && echo "✓ market-feed 재시작됨" || echo "⚠️ PM2 재시작 실패 — 수동으로: pm2 restart market-feed --update-env"
sleep 1
curl -s "http://127.0.0.1:$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || echo 6210)/health" | head -c 300; echo
