import type { RequestHandler } from "./$types";
import { getMarketNews, getCompanyNews, WATCHLIST } from "$lib/server/finnhub";
import { classifyAlert } from "$lib/server/alertverify";
import { getMovers } from "$lib/server/movers";
import { futuresSession } from "$lib/market-hours";

// ============================================================
//  ★ 속보 사이렌이 **한 번도 울린 적이 없었다** — 원인은 로직이 아니라 소스다.
//
//  실측 (Finnhub general 피드 100건):
//    가장 최신 기사   256분(4.3시간) 전
//    중앙값          3,873분(2.7일) 전
//    45분 이내       **0건**
//  사이렌 조건이 `level≥4 AND 45분 이내` 인데 이 소스는 45분 이내 기사를 아예 주지 않는다.
//  조건이 구조적으로 도달 불가능했다.
//
//  임계값을 4시간으로 늘리는 건 답이 아니다 — 4시간 전 기사를 "속보"라 부르면 거짓이다.
//  대신 **진짜로 실시간인 신호**를 쓴다: Finviz 5분봉 z-score(movers.ts).
//  가격 급변은 뉴스보다 먼저 일어나고, 우리가 직접 측정하므로 지연이 5분 안쪽이다.
//  "왜 움직였는지"는 모르지만 "얼마나 이례적으로 움직였는지"는 정확히 말할 수 있다 —
//  그 사실만 방송한다. 원인을 지어내지 않는다.
// ============================================================

/** 이 배수 미만은 "평소 변동" 이라 방송할 사건이 아니다 */
const ALERT_Z = 3.5;
/** 통계적으로 이례적이어도 실제 폭이 작으면 화면에 띄울 게 없다 */
const ALERT_MIN_PCT = 0.35;
/** 같은 종목을 이 시간 안에 다시 울리지 않는다 (한 사건이 여러 번 쪼개져 울리는 것 방지) */
const ALERT_COOLDOWN_MS = 30 * 60_000;

const lastFired = new Map<string, number>();

// 실측된 문제:
//  · Finnhub general 피드의 기사 나이 중앙값이 31.9시간(최대 50.8h)인데 최신성 필터가 전혀 없었다.
//  · id 기반 dedupe 만 있어서 VICR 분기실적 하나가 응답 12칸 중 5칸을 점유했다.
//  · "Earnings Call Transcript" / "Should You Be Bullish on X?" 같은 사후 해설물이
//    scoreNews 의 맨토큰 earnings 로 level 4 가 되어 BREAKING 토스트를 띄웠다.

const BREAKING_MAX_AGE = 45 * 60;   // 이 안쪽만 빨강+사운드
const UPDATE_MAX_AGE = 6 * 3600;    // 여기까지는 무음 UPDATE

// 보도자료/오피니언/일정공지 — 속보가 아니다
const NOISE =
  /(earnings call (transcript|highlights)|announces timing|should (you|investors)|buy,? sell,? or hold|prediction:|why we keep|is (it|now) time to|things to watch|here'?s what)/i;

export const GET: RequestHandler = async () => {
  const [market, ...batches] = await Promise.all([
    getMarketNews(20),
    ...WATCHLIST.map((t) => getCompanyNews(t, 2))
  ]);
  const nowSec = Math.floor(Date.now() / 1000);

  // 1) id dedupe
  const seen = new Set<string>();
  let merged = [...market, ...batches.flat()].filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });

  // 2) 이벤트 클러스터 dedupe — id 가 달라도 "같은 종목 · 같은 ET 날짜"면 1건만 통과시킨다.
  const dayET = (e: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(e * 1000));
  const cluster = new Set<string>();
  merged = merged.filter((n) => {
    const k = n.ticker ? `${n.ticker}|${dayET(n.epoch)}` : `m|${n.id}`;
    if (cluster.has(k)) return false;
    cluster.add(k);
    return true;
  });

  // 3) 2단 등급. 하드 컷 하나만 두면 응답이 상시 빈 배열이 되어 기능이 죽으므로 등급으로 나눈다.
  const staged = merged
    .filter((n) => n.epoch > 0 && n.level >= 4 && !NOISE.test(n.title))
    .filter((n) => nowSec - n.epoch <= UPDATE_MAX_AGE)
    .sort((a, b) => b.epoch - a.epoch)
    .slice(0, 12)
    .map((n) => ({
      ...n,
      ageSec: nowSec - n.epoch,
      kind: nowSec - n.epoch <= BREAKING_MAX_AGE ? "breaking" : "update"
    }));

  // 4) 사이렌 게이트 — "breaking"(사이렌감)만 haiku 로 1회 검증한다.
  //    UPDATE(무음)는 그대로 통과. 검증기 미설정이면 게이트가 "off" 라 기존 동작.
  const items: typeof staged = [];
  for (const n of staged) {
    if (n.kind !== "breaking") { items.push(n); continue; }
    const gate = classifyAlert({ id: n.id, title: n.title, source: n.source, ageSec: n.ageSec });
    if (gate === "pending") continue;                       // 검증 끝날 때까지 보류 (다음 폴에 등장)
    if (gate === "noise") { items.push({ ...n, kind: "update" }); continue; } // 무음 강등
    items.push(n);                                          // off/ok → 사이렌 유지
  }

  // 5) ★ 시장 급변 — 이 방송에서 **실제로 실시간인 유일한 속보원**이다.
  //    측정값만 말한다. "왜" 는 모르므로 원인을 붙이지 않는다.
  //    휴장 중엔 "최근 30분"이 최근이 아니라 마지막 거래 30분이므로 아예 보지 않는다.
  if (futuresSession().open) {
    try {
      const movers = await getMovers();
      const now = Date.now();
      for (const m of movers) {
        if (m.z < ALERT_Z || Math.abs(m.recentPct) < ALERT_MIN_PCT) continue;
        // 한 사건이 여러 폴에 걸쳐 반복해서 울리지 않게 종목별 쿨다운
        if (now - (lastFired.get(m.key) ?? 0) < ALERT_COOLDOWN_MS) continue;
        lastFired.set(m.key, now);
        const dir = m.recentPct >= 0 ? "+" : "−";
        items.unshift({
          id: `mv:${m.key}:${Math.floor(now / ALERT_COOLDOWN_MS)}`,
          title: `${m.label} ${dir}${Math.abs(m.recentPct).toFixed(2)}% IN 30 MIN · ${m.z}× NORMAL`,
          source: "Market data",
          url: "",
          ticker: "",
          level: 5,
          sentiment: m.dir > 0 ? "pos" : "neg",
          matched: true,
          epoch: Math.floor(now / 1000),
          ageSec: 0,
          kind: "breaking"
        } as any);
      }
      // 쿨다운 기록 정리
      for (const [k, at] of lastFired) if (now - at > 6 * 3600_000) lastFired.delete(k);
    } catch { /* 급변 탐지가 실패해도 뉴스 속보는 그대로 나간다 */ }
  }

  return new Response(JSON.stringify({ breaking: items, serverNow: nowSec }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
