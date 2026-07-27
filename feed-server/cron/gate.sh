#!/usr/bin/env bash
# ============================================================
#  LLM 호출 게이트 — "하루 N회" 를 **실제로 지키게** 만드는 장치
#
#  왜 필요했나 (실측):
#    기존 crontab 은 세션을 전혀 보지 않고 24시간 내내 돌았다.
#      top_story     */30  → 48회/일
#      earnings_recap */20 → 72회/일
#      live_videos   */15  → 96회/일
#      key_event     6h    →  4회/일
#      market_brief  적응형 → 약 62회/일
#      ─────────────────────────────
#      합계 ≈ **282회/일**  (목표 20회의 14배)
#    새벽 3시와 주말에도 실적 리캡을 20분마다 다시 생성하고 있었다. 바뀔 게 없는데.
#
#  이 게이트가 하는 일 두 가지:
#   1) **세션 기준 최소 간격** — 정규장엔 자주, 장 밖엔 드물게, 주말엔 거의 안 함
#   2) **하루 총량 하드캡** — 간격 계산이 틀려도 예산을 넘지 못한다.
#      스케줄 실수로 요금이 새는 걸 막는 마지막 방어선이다.
#
#  사용법:  gate.sh <kind>   → 종료코드 0 = 실행해도 됨 / 1 = 건너뜀
#  테스트:  gate.sh --test <kind> <DOW> <HHMM>
# ============================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
STATE="${MARKET_FEED_LOG_DIR:-$ROOT/logs}"
mkdir -p "$STATE" 2>/dev/null || true

# .env 에서 예산만 읽는다 (update-feed.sh 와 같은 방식, source 금지)
BUDGET_DEFAULT=20
if [[ -f "${MARKET_FEED_ENV:-$ROOT/.env}" ]]; then
  _b="$(grep -E '^DAILY_LLM_BUDGET=' "${MARKET_FEED_ENV:-$ROOT/.env}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  [[ "$_b" =~ ^[0-9]+$ ]] && BUDGET_DEFAULT="$_b"
fi
BUDGET="${DAILY_LLM_BUDGET:-$BUDGET_DEFAULT}"

# ── 세션별 최소 간격 (분) ──────────────────────────────
#  0 = 그 구간엔 아예 돌리지 않는다.
#  REG = 정규장 / EXT = 프리·애프터 / OFF = 밤·주말
#
#  배분 근거 (평일 기준 합계 ≈ 20):
#    top_story 8 + market_focus 5 + market_brief 3 + earnings_recap 1 + live_videos 1
#    + key_event 1 + macro_recap 1  = 20
#  ※ market_focus 를 넣으면서 brief·recap·videos 에서 4회를 빼 왔다.
#    "지금 시장이 무엇에 꽂혀 있나"가 이 방송에서 가장 자주 바뀌는 정보다.
interval_for() { # interval_for KIND SLOT → 분 (0 = 안 함)
  case "$1:$2" in
    top_story:REG)      echo 110 ;;   # 장중 4회
    top_story:EXT)      echo 200 ;;   # 프리·애프터 3회
    top_story:OFF)      echo 360 ;;   # 밤 1회
    # ★ 지금 시장이 무엇에 꽂혀 있나 — 규칙으로는 메가캡 목록밖에 안 나온다.
    #   "메모리 사이클이 끝나는가" 같은 **논쟁**은 판단이라 LLM 이 해야 한다.
    #   장중에 자주 본다 — 화두는 장중에 바뀐다.
    market_focus:REG)   echo 120 ;;   # 장중 4회
    market_focus:EXT)   echo 480 ;;   # 프리·애프터 1회
    market_focus:OFF)   echo 0   ;;
    market_brief:REG)   echo 200 ;;   # 장중 2회 (market_focus 에 자리를 내줬다)
    market_brief:EXT)   echo 400 ;;   # 1회
    market_brief:OFF)   echo 0   ;;
    # 실적은 발표가 몰리는 프리마켓·애프터마켓에만 의미가 있다.
    # 새벽 3시에 20분마다 다시 만들 이유가 없었다.
    earnings_recap:REG) echo 0   ;;
    #  반응률 검증이 디스크에 남게 되면서(verifylog) 자주 만들 이유가 줄었다
    earnings_recap:EXT) echo 480 ;;   # 1회
    earnings_recap:OFF) echo 0   ;;
    live_videos:REG)    echo 390 ;;   # 장중 1회 (라이브 스트림은 장중에만 열린다)
    live_videos:EXT)    echo 0   ;;
    live_videos:OFF)    echo 0   ;;
    key_event:REG)      echo 0   ;;
    key_event:EXT)      echo 0   ;;
    key_event:OFF)      echo 1440;;   # 하루 1회
    # 거시 이벤트 결과 정리 — 장 마감 뒤 하루 1회면 충분하다
    macro_recap:REG)    echo 0   ;;
    macro_recap:EXT)    echo 1440;;
    macro_recap:OFF)    echo 0   ;;
    *)                  echo 0   ;;
  esac
}

slot_for() { # slot_for DOW HHMM → REG|EXT|OFF
  local dow=$1 hm=$((10#$2))
  if (( dow >= 6 )); then echo OFF; return; fi          # 주말
  if (( hm >= 930 && hm < 1600 )); then echo REG; return; fi
  if (( (hm >= 400 && hm < 930) || (hm >= 1600 && hm < 2000) )); then echo EXT; return; fi
  echo OFF
}

# 테스트 모드 — 예산·마지막 실행 파일을 건드리지 않고 간격만 확인
if [[ "${1:-}" == "--test" ]]; then
  s="$(slot_for "$3" "$4")"
  echo "$s $(interval_for "$2" "$s")"
  exit 0
fi

KIND="${1:-}"
[[ -n "$KIND" ]] || { echo "usage: gate.sh <kind>" >&2; exit 2; }

DOW="$(TZ=America/New_York date +%u)"
HM="$(TZ=America/New_York date +%H%M)"
DAY="$(TZ=America/New_York date +%Y%m%d)"
SLOT="$(slot_for "$DOW" "$HM")"
IVL="$(interval_for "$KIND" "$SLOT")"

# 이 구간에선 아예 안 돈다
(( IVL > 0 )) || exit 1

# ── 최소 간격 확인 ────────────────────────────────────
LASTF="$STATE/.last.$KIND"
NOW="$(date +%s)"
if [[ -f "$LASTF" ]]; then
  LAST="$(cat "$LASTF" 2>/dev/null || echo 0)"
  [[ "$LAST" =~ ^[0-9]+$ ]] || LAST=0
  (( NOW - LAST >= IVL * 60 )) || exit 1
fi

# ── 하루 총량 하드캡 ──────────────────────────────────
#  간격 계산이 틀려도 여기서 막힌다. 예산 파일은 ET 날짜로 갈린다.
CNTF="$STATE/.budget.$DAY"
USED="$(cat "$CNTF" 2>/dev/null || echo 0)"
[[ "$USED" =~ ^[0-9]+$ ]] || USED=0
if (( USED >= BUDGET )); then
  echo "$(date '+%F %T') [gate] $KIND 건너뜀 — 일일 예산 소진 ($USED/$BUDGET)" >> "$STATE/cron.log"
  exit 1
fi

# 통과 — 카운터와 마지막 실행 시각을 올린다
echo "$((USED + 1))" > "$CNTF"
echo "$NOW" > "$LASTF"
# 지난 날짜 카운터 정리 (7일치만)
find "$STATE" -maxdepth 1 -name '.budget.*' -mtime +7 -delete 2>/dev/null || true
echo "$(date '+%F %T') [gate] $KIND 허용 ($SLOT, ${IVL}분 간격, 예산 $((USED + 1))/$BUDGET)" >> "$STATE/cron.log"
exit 0
