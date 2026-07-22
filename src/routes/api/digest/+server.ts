import type { RequestHandler } from "./$types";
import { getMarketNews } from "$lib/server/finnhub";
import { getFeed, fresh } from "$lib/server/marketfeed";

export const GET: RequestHandler = async () => {
  const [news, feed] = await Promise.all([getMarketNews(24), getFeed()]);
  const nowSec = Date.now() / 1000;

  // 예전에는 level 내림차순으로만 정렬해서 "LIVE HEADLINES" 상단에
  // 20시간 전 level 5 기사가 영구히 박제됐다.
  // 반대로 순수 시간순으로 바꾸면 상단 두 줄이 칼럼·잡기사로 채워진다(실측).
  // → 시간 감쇠 점수: 6시간마다 레벨 1씩 깎는다.
  const decay = (n: { level: number; epoch: number }) =>
    n.level - (nowSec - n.epoch) / 3600 / 6;
  const ranked = [...news].sort((a, b) => decay(b) - decay(a));
  const top = ranked[0];

  // ── TOP STORY ────────────────────────────────────────
  // 1순위: Claude Code 가 만든 판단 (신선할 때만)
  // 2순위: 키워드 규칙 기반 (기존 동작)
  // 어느 쪽인지 화면이 표시할 수 있도록 source 를 반드시 실어 보낸다.
  const ai = fresh(feed, "top_story");
  let driver;
  if (ai) {
    driver = {
      text: ai.payload.text,
      sentiment: ai.payload.sentiment,
      source: ai.payload.sources[0]?.title ?? "",
      url: ai.payload.sources[0]?.url ?? "",
      why: ai.payload.why,
      confidence: ai.payload.confidence,
      epoch: Math.floor(ai.generatedAt / 1000),
      origin: "ai" as const,
      noData: false
    };
  } else if (top) {
    driver = {
      text: top.title,
      sentiment: top.sentiment,
      source: top.source,
      url: top.url,
      why: "",
      confidence: "",
      epoch: top.epoch,
      origin: "rule" as const, // 인과를 계산하지 않은 키워드 규칙 결과
      noData: false
    };
  } else {
    driver = {
      text: "NO NEWS FEED", sentiment: "neu", source: "", url: "", why: "",
      confidence: "", epoch: 0, origin: "none" as const, noData: true
    };
  }

  // driver 로 쓴 기사는 리스트에서 제외 (같은 문장이 화면에 두 번 나오던 문제).
  // 7건 = 좌측 컬럼이 스크롤바 없이 담을 수 있는 실제 개수.
  const list = ranked.filter((n) => !top || n.id !== top.id).slice(0, 7);

  return new Response(JSON.stringify({ driver, news: list, serverNow: Math.floor(nowSec) }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
