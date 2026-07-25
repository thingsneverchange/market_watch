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

if [[ "$(decide "$DOW" "$HM")" == "yes" ]]; then
  exec "$HERE/update-feed.sh" market_brief
fi
exit 0
