# market-feed

Claude Code가 만든 마켓 판단(TOP STORY / NEXT KEY EVENT / 실적 해설)을 저장하고,
market_watch 오버레이가 읽어가는 작은 서비스입니다.

**의존성 0개** — `node:http` / `node:sqlite` / `node:crypto` 만 씁니다. `npm install` 필요 없습니다.

```
[내 맥] cron ──claude -p──▶ 판단 JSON ──POST(쓰기키)──▶ [서버] market-feed :6210 ──▶ SQLite
                                                                    │
[market_watch] ◀────────────────── GET(읽기키) ──────────────────────┘
```

---

## 왜 이런 구조인가

| 결정 | 이유 |
|---|---|
| **themecloset_builder 밖의 독립 앱** | 결제·스토어가 도는 프로덕션 앱을 건드리지 않는다. 이게 죽어도 매출에 영향 0. |
| **쓰기키 / 읽기키 분리** | 읽기키는 market_watch 서버가 가진다. 유출돼도 방송 화면 내용을 **덮어쓸 수는 없다.** |
| **`instances: 1` (cluster 아님)** | SQLite 쓰기는 cron 하나뿐. 워커를 늘릴 이유가 없고 WAL 경합도 사라진다. |
| **서버측 페이로드 검증** | 여기 들어오는 건 LLM 출력이고, 통과하면 곧바로 방송에 나간다. 형식이 어긋나면 **저장하지 않는다.** |
| **`generatedAt` 을 따로 받음** | "내가 받은 시각"이 아니라 "Claude가 만든 시각"이 진짜 신선도다. 낡으면 `stale: true` 로 표시하고 오버레이가 규칙기반으로 폴백한다. |

---

## API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/health` | 없음 | 상태 확인 (데이터 노출 없음) |
| GET | `/api/feed` | `MARKET_READ_KEY` | 현재 3종류 전부 + `ageSec` + `stale` |
| GET | `/api/feed/history/:kind` | `MARKET_READ_KEY` | 최근 이력 (기본 20건) |
| POST | `/api/feed/:kind` | `MARKET_WRITE_SECRET` | 판단 저장 (검증 실패 시 422) |

`kind` = `top_story` | `key_event` | `earnings_note`

인증은 `Authorization: Bearer <키>` 또는 `?key=<키>`.

### 신선도 기준

| kind | 이 나이를 넘으면 `stale: true` |
|---|---|
| `top_story` | 90분 |
| `key_event` | 18시간 |
| `earnings_note` | 48시간 |

`stale: true` 여도 데이터는 그대로 돌려줍니다 — **숨기지 않고 낡았다고 말합니다.**
폴백 여부는 market_watch가 결정합니다.

---

## 로컬 실행

```bash
cd ~/Desktop/market-feed
cp .env.example .env
# MARKET_WRITE_SECRET / MARKET_READ_KEY 를 서로 다른 값으로 채우기
#   openssl rand -hex 32
node --env-file=.env src/server.mjs

# 검증 (29개 테스트)
set -a; . ./.env; set +a
node scripts/smoke-test.mjs
```

---

## cron 설정 (내 맥)

### 1) claude CLI 설치 — **아직 안 돼 있습니다**

```bash
npm i -g @anthropic-ai/claude-code
which claude   # 경로 확인
```

### 2) 구독 토큰 발급 (추가 비용 0)

```bash
claude setup-token     # 브라우저 인증 → 1년짜리 토큰 출력
```

출력된 토큰을 `.env` 에 넣습니다:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
CLAUDE_BIN=/opt/homebrew/bin/claude       # which claude 결과
CLAUDE_MODEL=claude-opus-4-8              # 한도가 부담되면 claude-sonnet-5 로
```

> ⚠️ **`ANTHROPIC_API_KEY` 를 셸 프로파일에 export 하지 마세요.** 그게 설정돼 있으면
> 구독 로그인을 덮어쓰고(shadowing) 평소 대화형 Claude Code까지 종량 과금됩니다.
> API 키를 쓰실 거면 이 `.env` 안에만 넣으세요.

> ⚠️ **구독 토큰은 대화형 사용량과 같은 주간 한도를 공유합니다.** cron이 한도를 많이
> 먹으면 진짜님의 대화형 Claude Code가 막힐 수 있습니다. 그게 싫으면 API 키로 격리하세요.

### 3) crontab

```bash
crontab -e
```

```cron
*/30 * * * *  /Users/yongjulee/Desktop/market-feed/cron/update-feed.sh top_story
17 */6 * * *  /Users/yongjulee/Desktop/market-feed/cron/update-feed.sh key_event
0 7 * * *     /Users/yongjulee/Desktop/market-feed/cron/update-feed.sh earnings_note
```

> **맥이 잠자면 cron은 안 돕니다.** 상시 갱신이 필요하면
> 시스템 설정 → 배터리 → "디스플레이 꺼짐 시 자동 잠자기 방지"를 켜세요.

로그: `~/Desktop/market-feed/logs/cron.log`

수동 테스트:
```bash
./cron/update-feed.sh top_story
```

---

## 서버 배포 (themecloset 서버)

**아직 하지 마세요 — 로컬에서 충분히 돌려본 뒤에 하는 게 맞습니다.**

```bash
# 1. 서버에 코드 올리기 (node_modules 없음, 통째로 복사해도 가벼움)
rsync -av --exclude '.env' --exclude 'data' --exclude 'logs' \
  ~/Desktop/market-feed/ 서버:/home/market-feed/

# 2. 서버에서 .env 생성 (로컬 키를 재사용하지 말고 새로 발급)
ssh 서버
cd /home/market-feed
mkdir -p data logs
cat > .env <<EOF
PORT=6210
HOST=127.0.0.1
MARKET_DB_FILE=/home/market-feed/data/feed.db
MARKET_WRITE_SECRET=$(openssl rand -hex 32)
MARKET_READ_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env

# 3. PM2 등록 (themecloset-builder 와 별개 앱)
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 logs market-feed --lines 30

# 4. nginx — deploy/nginx.snippet.conf 의 location 블록을
#    themecloset.com 서버 블록 안에 붙여넣고
sudo nginx -t && sudo systemctl reload nginx
```

### 배포 후 확인

```bash
# 서버 안에서
curl -s localhost:6210/health

# 밖에서 (인증 없이 데이터가 새지 않는지)
curl -s https://themecloset.com/market-feed/api/feed          # → 401 이어야 정상
curl -s "https://themecloset.com/market-feed/api/feed?key=읽기키"  # → 200
```

### 배포 후 바꿔야 할 것

| 파일 | 바꿀 값 |
|---|---|
| `~/Desktop/market-feed/.env` (맥) | `MARKET_FEED_URL=https://themecloset.com/market-feed` + 서버의 **쓰기키** |
| `~/Desktop/market_watch-main/.env` | `MARKET_FEED_URL=https://themecloset.com/market-feed` + 서버의 **읽기키** |

> market_watch 의 `.env` 에는 **읽기키만** 넣으세요. 쓰기키를 넣을 이유가 전혀 없습니다.

---

## 화면에서 어떻게 보이나

| 상태 | TOP STORY 뱃지 | 동작 |
|---|---|---|
| AI 판단이 신선함 | `AI 판단` + `HIGH/MEDIUM/LOW` (파랑) | Claude 문장 + 근거 한 줄 표시 |
| AI 판단이 낡음(90분↑) / 피드 죽음 | `규칙기반` (회색) | 기존 키워드 규칙 결과로 자동 폴백 |
| 뉴스도 없음 | `—` | `NO NEWS FEED` |

**낡은 AI 판단을 새것처럼 보여주지 않습니다.** 이게 이 프로젝트 전체의 원칙입니다.
