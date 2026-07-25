#!/usr/bin/env bash
# ============================================================
#  market_brief 적응형 캐던스 게이트
#
#  crontab 은 이 스크립트를 **10분마다** 호출하고, 실제 실행 여부는 여기서
#  ET 세션 기준으로 결정한다 (DST 는 TZ=America/New_York 이 알아서 처리 — 하드코딩 없음):
#
#    · 정규장   (월–금 09:30–16:00 ET) : 매 10분   ← 장중엔 브리핑이 빨리 낡는다
#    · 프리/애프터 (04:00–09:30, 16:00–20:00) : 30분마다
#    · 밤·주말  (그 외 전부)            : 2시간마다
#
#  조기폐장일 오후에도 그냥 10분 주기로 돈다 — 캐던스가 촘촘한 건 무해하다(내용이 "장 마감" 관점으로 갱신될 뿐).
#
#  crontab 예시:
#    */10 * * * *  /home/market-feed/cron/brief-cadence.sh
# ============================================================
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

decide() { # decide DOW HHMM  →  yes|no
  local dow=$1 hm=$((10#$2)) m=$((10#${2:2:2})) h=$((10#${2:0:2}))
  if (( dow >= 6 )); then                       # 주말
    (( m == 0 && h % 2 == 0 )) && { echo yes; return; }
  elif (( hm >= 930 && hm < 1600 )); then       # 정규장
    echo yes; return
  elif (( (hm >= 400 && hm < 930) || (hm >= 1600 && hm < 2000) )); then  # 프리/애프터
    (( m == 0 || m == 30 )) && { echo yes; return; }
  else                                          # 평일 밤
    (( m == 0 && h % 2 == 0 )) && { echo yes; return; }
  fi
  echo no
}

# 테스트 모드: brief-cadence.sh --test DOW HHMM
if [[ "${1:-}" == "--test" ]]; then
  decide "$2" "$3"
  exit 0
fi

DOW="$(TZ=America/New_York date +%u)"   # 1=월 … 7=일
HM="$(TZ=America/New_York date +%H%M)"
MIN=$((10#${HM:2:2}))
HOUR=$((10#${HM:0:2}))

# ── /control 오버라이드 확인 ─────────────────────────
# 지정학 이슈처럼 "주말에도 계속 봐야 하는" 상황을 위해 사람이 주기를 강제할 수 있다.
# auto = 위 세션 규칙, off = 완전 정지. 서버가 안 뜨면 조용히 auto 로 동작한다.
CONF="${MARKET_FEED_ENV:-$ROOT/.env}"
RK=""; URL="http://127.0.0.1:6210"
if [[ -f "$CONF" ]]; then
  RK="$(grep -m1 '^MARKET_READ_KEY=' "$CONF" | cut -d= -f2-)"
  _u="$(grep -m1 '^MARKET_FEED_URL=' "$CONF" | cut -d= -f2-)"; [[ -n "$_u" ]] && URL="$_u"
fi
MODE="auto"
if [[ -n "$RK" ]]; then
  _r="$(curl -s --max-time 4 -H "authorization: Bearer $RK" "$URL/api/settings" 2>/dev/null)"
  case "$_r" in
    *'"briefCadence":"10m"'*) MODE="10m" ;;
    *'"briefCadence":"30m"'*) MODE="30m" ;;
    *'"briefCadence":"2h"'*)  MODE="2h"  ;;
    *'"briefCadence":"off"'*) MODE="off" ;;
  esac
fi

case "$MODE" in
  off) exit 0 ;;
  10m) RUN="yes" ;;                                              # 10분마다 (crontab 주기 그대로)
  30m) [[ $MIN -eq 0 || $MIN -eq 30 ]] && RUN="yes" || RUN="no" ;;
  2h)  [[ $MIN -eq 0 && $((HOUR % 2)) -eq 0 ]] && RUN="yes" || RUN="no" ;;
  *)   RUN="$(decide "$DOW" "$HM")" ;;                            # auto = 세션 기반
esac

if [[ "$RUN" == "yes" ]]; then
  exec "$HERE/update-feed.sh" market_brief
fi
exit 0
