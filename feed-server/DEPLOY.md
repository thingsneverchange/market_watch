# market-feed 운영 메모 (실제 배포값)

## 어디에 뭐가 있나

| 항목 | 값 |
|---|---|
| 서버 | `165.232.146.7` (129.212.164.32 는 같은 머신의 플로팅 IP) |
| SSH | `ssh root@165.232.146.7` |
| 코드 | `/home/market-feed` (이 저장소 clone) |
| 앱 루트 | `/home/market-feed/feed-server` |
| PM2 앱 | `market-feed` ← themecloset-* 와 접두어가 다름 |
| 포트 | `6210` ← themecloset 은 6109(운영) / 5109(스테이징) |
| DB | `/home/market-feed/feed-server/data/feed.db` (SQLite, MySQL 안 씀) |
| 로그 | `/home/market-feed/feed-server/logs/` + `pm2 logs market-feed` |
| nginx | **안 씀** — 포트 직접 접속 |

## 접속

```bash
curl "http://165.232.146.7:6210/whoami"    # 내 IP 확인 (항상 열림)
curl "http://165.232.146.7:6210/health"    # 상태 (허용 IP 만)
```

## ⚠️ 이 서버에는 방화벽이 없다

`ufw` / `iptables` / `nft` 미설치, DigitalOcean 클라우드 방화벽도 없음.
임의 포트가 인터넷에 그대로 열립니다. 확인 결과 **MySQL 3306 도 전 세계에 열려 있습니다** (별도 사안).

따라서 **`MARKET_ALLOWED_IPS` 가 유일한 차단 지점**입니다.
검증된 동작: 허용목록에 없는 IP 는 **올바른 쓰기키를 가져도 404**.

## 집 IP 가 바뀌어 접속이 안 될 때

```bash
ssh root@165.232.146.7 '/home/market-feed/feed-server/deploy/allow-ip.sh auto'
```

SSH 로 접속해 온 현재 IP 를 자동으로 허용목록에 추가하고 재시작합니다.
현재 등록: `127.0.0.1`, `121.178.29.188`

목록을 통째로 교체하려면 `allow-ip.sh <IP> --replace`.

## 코드 갱신 (git pull 배포)

```bash
ssh root@165.232.146.7 '
  cd /home/market-feed && git pull &&
  cd feed-server && bash deploy/install.sh
'
```

`install.sh` 는 멱등입니다 — 여러 번 돌려도 `.env` 의 키와 허용목록을 덮어쓰지 않습니다.

## 키

서버 `.env`(권한 600)에서 발급됩니다. 맥의 두 곳에 나눠 넣습니다:

| 키 | 들어가는 곳 | 용도 |
|---|---|---|
| `MARKET_WRITE_SECRET` | `~/Desktop/market-feed/.env` | cron 이 판단을 POST |
| `MARKET_READ_KEY` | `~/Desktop/market_watch-main/.env` | 오버레이가 GET |

**오버레이에는 쓰기키를 넣지 마세요.** 읽기키가 새도 데이터를 덮어쓸 수 없는 게 이 분리의 목적입니다.

키를 다시 확인하려면:
```bash
ssh root@165.232.146.7 'grep -E "^MARKET_(WRITE_SECRET|READ_KEY)=" /home/market-feed/feed-server/.env'
```

## HTTP 평문에 대해

포트 직접 접속이라 키가 평문으로 오갑니다. IP 허용목록이 있어 공격자는 패킷을 가로채고 **동시에 IP 까지 위장**해야 하며, 데이터도 공개 뉴스 헤드라인이라 이 용도에는 수용 가능한 수준으로 판단했습니다. TLS 가 필요해지면 Cloudflare 나 nginx 를 앞에 두면 됩니다.

## 문제 생겼을 때

```bash
ssh root@165.232.146.7 'pm2 logs market-feed --lines 50 --nostream'
ssh root@165.232.146.7 'pm2 restart market-feed --update-env'
```

차단된 IP 는 로그에 `[market-feed] 차단된 IP: x.x.x.x` 로 남고,
`/health` 응답의 `recentDenied` 에도 최근 20건이 들어 있습니다.
