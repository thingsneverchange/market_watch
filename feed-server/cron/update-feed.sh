#!/usr/bin/env bash
# ============================================================
#  Claude Code 로 마켓 판단을 생성해 market-feed 에 밀어넣는다.
#
#  사용법:  ./update-feed.sh top_story|key_event|earnings_note
#  cron 예시는 이 파일 맨 아래 주석 참고.
# ============================================================
set -uo pipefail

KIND="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

# ── 설정 로드 ─────────────────────────────────────────
# cron 은 로그인 셸이 아니라 PATH·환경변수가 거의 비어 있다. 반드시 파일에서 읽는다.
CONF="${MARKET_FEED_ENV:-$ROOT/.env}"
if [[ -f "$CONF" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONF"
  set +a
fi

: "${MARKET_FEED_URL:=http://127.0.0.1:6210}"
: "${CLAUDE_MODEL:=claude-opus-4-8}"
LOG_DIR="${MARKET_FEED_LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cron.log"

log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${KIND:-?}" "$*" >> "$LOG"; }
die() { log "ERROR: $*"; echo "ERROR: $*" >&2; exit 1; }

case "$KIND" in
  top_story|key_event|earnings_note) ;;
  *) die "사용법: $0 top_story|key_event|earnings_note" ;;
esac

PROMPT_FILE="$HERE/prompts/$(echo "$KIND" | tr '_' '-').md"
[[ -f "$PROMPT_FILE" ]] || die "프롬프트 파일이 없습니다: $PROMPT_FILE"

# ── 중복 실행 방지 ────────────────────────────────────
# 앞선 실행이 아직 돌고 있으면 (웹 검색이 느릴 수 있다) 이번 회차는 건너뛴다.
LOCK="$LOG_DIR/.lock.$KIND"
exec 9>"$LOCK"
if ! flock -n 9 2>/dev/null; then
  # macOS 기본 bash 에는 flock 이 없을 수 있다 → mkdir 로 폴백
  if ! mkdir "$LOCK.d" 2>/dev/null; then
    log "이전 실행이 아직 진행 중 — 건너뜀"
    exit 0
  fi
  trap 'rmdir "$LOCK.d" 2>/dev/null || true' EXIT
fi

# ── 전제 조건 확인 ────────────────────────────────────
command -v claude >/dev/null 2>&1 || die \
  "claude CLI 를 찾을 수 없습니다. 설치: npm i -g @anthropic-ai/claude-code
   (cron 은 PATH 가 비어 있으니 .env 에 CLAUDE_BIN=/full/path/to/claude 를 넣거나 PATH 를 지정하세요)"

if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  die "인증 정보가 없습니다.
   구독으로 쓰려면: claude setup-token 실행 후 .env 에 CLAUDE_CODE_OAUTH_TOKEN=... 저장
   API 키로 쓰려면: .env 에 ANTHROPIC_API_KEY=... 저장"
fi
[[ -n "${MARKET_WRITE_SECRET:-}" ]] || die "MARKET_WRITE_SECRET 이 .env 에 없습니다"

# ── 생성 ──────────────────────────────────────────────
log "생성 시작 (model=$CLAUDE_MODEL)"
GENERATED_AT="$(node -e 'process.stdout.write(String(Date.now()))')"

RAW="$(claude -p "$(cat "$PROMPT_FILE")" \
        --model "$CLAUDE_MODEL" \
        --allowed-tools "WebSearch,WebFetch" \
        2>>"$LOG")" || die "claude 실행 실패 (로그: $LOG)"

if [[ -z "${RAW//[[:space:]]/}" ]]; then
  die "claude 가 빈 응답을 반환했습니다"
fi

# ── JSON 추출 + 검증 후 전송 ──────────────────────────
# LLM 이 ```json 펜스나 앞뒤 설명을 붙이는 경우가 있어 관대하게 추출한다.
# 단, 추출 실패 시 **추측해서 보내지 않는다** — 실패로 끝낸다.
RESULT="$(RAW_TEXT="$RAW" KIND="$KIND" GEN_AT="$GENERATED_AT" MODEL="$CLAUDE_MODEL" \
          node "$HERE/extract-and-post.mjs" 2>>"$LOG")" || die "추출/전송 실패 (로그: $LOG)"

log "성공: $RESULT"
echo "$RESULT"

# ============================================================
#  crontab 예시  (crontab -e)
#
#  # 30분마다 TOP STORY (미 정규장 시간대 위주로 돌리려면 시간 지정)
#  */30 * * * *  /Users/yongjulee/Desktop/market-feed/cron/update-feed.sh top_story
#
#  # 6시간마다 NEXT KEY EVENT
#  17 */6 * * *  /Users/yongjulee/Desktop/market-feed/cron/update-feed.sh key_event
#
#  # 매일 한국시간 오전 7시 실적 해설
#  0 7 * * *     /Users/yongjulee/Desktop/market-feed/cron/update-feed.sh earnings_note
#
#  ※ 맥이 잠자면 cron 은 안 돕니다. 상시 갱신이 필요하면
#     시스템 설정 > 배터리 > "디스플레이 꺼짐 시 자동 잠자기 방지" 를 켜세요.
# ============================================================
