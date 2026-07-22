import type { RequestHandler } from "./$types";
import { getMarketNews, getCompanyNews, WATCHLIST } from "$lib/server/finnhub";

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
  const items = merged
    .filter((n) => n.epoch > 0 && n.level >= 4 && !NOISE.test(n.title))
    .filter((n) => nowSec - n.epoch <= UPDATE_MAX_AGE)
    .sort((a, b) => b.epoch - a.epoch)
    .slice(0, 12)
    .map((n) => ({
      ...n,
      ageSec: nowSec - n.epoch,
      kind: nowSec - n.epoch <= BREAKING_MAX_AGE ? "breaking" : "update"
    }));

  return new Response(JSON.stringify({ breaking: items, serverNow: nowSec }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
