#!/usr/bin/env bash
# ============================================================
#  Claude Code 로 마켓 판단을 생성해 market-feed 에 밀어넣는다.
#
#  사용법:  ./update-feed.sh top_story|key_event|earnings_recap|market_brief|market_focus|live_videos|macro_recap
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
  # ※ `source .env` 를 쓰지 않는다.
  #    값에 공백이나 줄바꿈이 섞이면 bash 가 그 뒤를 **명령어로 실행**해버린다.
  #    (실제로 토큰이 두 줄로 잘려 들어가 "command not found" 가 났다)
  #    KEY=VALUE 만 읽고, 값은 그대로 export 한다.
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    [[ "$_line" =~ ^[[:space:]]*# ]] && continue
    [[ "$_line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$_line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      _k="${BASH_REMATCH[1]}"; _v="${BASH_REMATCH[2]}"
      # 감싼 따옴표만 제거
      [[ "$_v" == \"*\" && "$_v" == *\" ]] && _v="${_v:1:${#_v}-2}"
      [[ "$_v" == \'*\' && "$_v" == *\' ]] && _v="${_v:1:${#_v}-2}"
      export "$_k=$_v"
    else
      echo "⚠️  .env 형식이 아닌 줄 무시: ${_line:0:40}…" >&2
      echo "    (값에 줄바꿈이 섞였을 수 있습니다 — 한 줄로 이어 붙이세요)" >&2
    fi
  done < "$CONF"
  unset _line _k _v
fi

: "${MARKET_FEED_URL:=http://127.0.0.1:6210}"
# 기본 모델: 이 작업들(검색→선별→JSON)은 Sonnet 5 로 충분하다. Opus 는 과사양 + 구독 사용량을 몇 배 빨리 소모.
: "${CLAUDE_MODEL:=claude-sonnet-5}"
LOG_DIR="${MARKET_FEED_LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cron.log"

log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${KIND:-?}" "$*" >> "$LOG"; }
die() { log "ERROR: $*"; echo "ERROR: $*" >&2; exit 1; }

case "$KIND" in
  top_story|key_event|earnings_recap|market_brief|market_focus|live_videos|macro_recap) ;;
  *) die "사용법: $0 top_story|key_event|earnings_recap|market_brief|market_focus|live_videos|macro_recap" ;;
esac

# ── LLM 호출 게이트 ───────────────────────────────────
#  세션별 최소 간격 + 하루 총량 하드캡. 자세한 근거는 gate.sh 주석 참고.
#  (예전엔 게이트가 없어 새벽·주말에도 20분마다 돌며 하루 282회를 썼다)
#  --force 로 수동 실행 시엔 게이트를 건너뛴다.
if [[ "${2:-}" != "--force" ]]; then
  if ! "$HERE/gate.sh" "$KIND"; then
    log "게이트에서 건너뜀 (세션 간격 또는 일일 예산)"
    exit 0
  fi
fi

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
# cron 은 PATH 가 거의 비어 있다. .env 의 CLAUDE_BIN 을 우선 쓰고, 없으면 PATH 에서 찾는다.
CLAUDE="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
[[ -n "$CLAUDE" && -x "$CLAUDE" ]] || die \
  "claude CLI 를 찾을 수 없습니다. 설치: npm i -g @anthropic-ai/claude-code
   cron 은 PATH 가 비어 있으니 .env 에 절대경로를 넣으세요:  CLAUDE_BIN=$(command -v claude 2>/dev/null || echo /path/to/claude)"

if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  die "인증 정보가 없습니다.
   구독으로 쓰려면: claude setup-token 실행 후 .env 에 CLAUDE_CODE_OAUTH_TOKEN=... 저장
   API 키로 쓰려면: .env 에 ANTHROPIC_API_KEY=... 저장"
fi
[[ -n "${MARKET_WRITE_SECRET:-}" ]] || die "MARKET_WRITE_SECRET 이 .env 에 없습니다"

# ── 생성 ──────────────────────────────────────────────
# kind 별 모델 오버라이드: .env 에 CLAUDE_MODEL_MARKET_BRIEF=... 식으로 두면 그 kind 만 다른 모델.
KIND_VAR="CLAUDE_MODEL_$(printf '%s' "$KIND" | tr '[:lower:]' '[:upper:]')"
MODEL="${!KIND_VAR:-$CLAUDE_MODEL}"
log "생성 시작 (model=$MODEL)"
GENERATED_AT="$(node -e 'process.stdout.write(String(Date.now()))')"

RAW="$("$CLAUDE" -p "$(cat "$PROMPT_FILE")" \
        --model "$MODEL" \
        --allowed-tools "WebSearch,WebFetch" \
        2>>"$LOG")" || die "claude 실행 실패 (로그: $LOG)"

if [[ -z "${RAW//[[:space:]]/}" ]]; then
  die "claude 가 빈 응답을 반환했습니다"
fi

# ── JSON 추출 + 검증 후 전송 ──────────────────────────
# LLM 이 ```json 펜스나 앞뒤 설명을 붙이는 경우가 있어 관대하게 추출한다.
# 단, 추출 실패 시 **추측해서 보내지 않는다** — 실패로 끝낸다.
RESULT="$(RAW_TEXT="$RAW" KIND="$KIND" GEN_AT="$GENERATED_AT" MODEL="$MODEL" \
          node "$HERE/extract-and-post.mjs" 2>>"$LOG")" || die "추출/전송 실패 (로그: $LOG)"

log "성공: $RESULT"
echo "$RESULT"

# ============================================================
#  crontab  (crontab -e)
#
#  ★ 이제 **모든 kind 가 gate.sh 를 통과해야** 실제 LLM 호출이 일어난다.
#    그래서 cron 은 단순히 자주 두드리기만 하면 되고, "언제 얼마나" 는 게이트가 정한다.
#    (예전엔 cron 주기가 곧 호출 횟수였고, 세션을 안 봐서 하루 282회를 썼다)
#
#  */10 * * * * /home/market-feed/feed-server/cron/update-feed.sh top_story      >/dev/null 2>&1
#  */10 * * * * /home/market-feed/feed-server/cron/update-feed.sh market_brief   >/dev/null 2>&1
#  */10 * * * * /home/market-feed/feed-server/cron/update-feed.sh earnings_recap >/dev/null 2>&1
#  */10 * * * * /home/market-feed/feed-server/cron/update-feed.sh live_videos    >/dev/null 2>&1
#  */30 * * * * /home/market-feed/feed-server/cron/update-feed.sh key_event      >/dev/null 2>&1
#  */30 * * * * /home/market-feed/feed-server/cron/update-feed.sh macro_recap    >/dev/null 2>&1
#
#  예산 조정:  .env 에  DAILY_LLM_BUDGET=20   (기본 20)
#  수동 강제:  ./update-feed.sh top_story --force   ← 게이트 무시
#
#  예상 호출량:  평일 20회 / 주말 5회  (기존 282회/일)
