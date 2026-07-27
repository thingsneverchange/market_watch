import type { RequestHandler } from "./$types";
import { getMarketFocus } from "$lib/server/focus";
import { getFeed, fresh } from "$lib/server/marketfeed";
import { getQuotes } from "$lib/server/finnhub";
import { marketState } from "$lib/market-hours";

// "지금 시장이 보고 있는 것".
//
// ★ 두 층으로 만든다:
//   1순위 — Claude 판단 (market_focus). 규칙으로는 못 잡는 **논쟁**을 고른다:
//           "메모리 사이클이 끝나는가", "스페이스엑스 상장설" 같은 것.
//   2순위 — 규칙 기반 (focus.ts). 뉴스 등장 × 실적 촉매 × 테마 × 규모·섹터.
//
// 왜 규칙만으로는 부족한가: 시총 × 실적임박 × 섹터로 줄 세우면 **어느 날이든
// 메가캡 목록이 그대로 나온다**(MSFT·AAPL·GOOGL·AMZN·META). 매일 똑같으면 정보가 없다.
// 반대로 LLM 만 믿으면 피드가 죽었을 때 화면이 빈다 → 규칙기반이 항상 뒤를 받친다.
export const GET: RequestHandler = async ({ url }) => {
  const themeKey = String(url.searchParams.get("theme") ?? "").toUpperCase().slice(0, 12);
  const [board, feed] = await Promise.all([getMarketFocus(themeKey, 5), getFeed()]);

  const ai = fresh(feed, "market_focus");
  const items = ai?.payload.items ?? [];
  if (!items.length) return json({ ...board, origin: "rule" });

  // 티커가 붙은 항목에만 시세를 얹는다. 없으면 안 얹는다 — 엉뚱한 종목에 붙이면 오보다.
  const tickers = [...new Set(items.map((i) => i.ticker).filter((t): t is string => !!t))];
  const px = new Map(
    (tickers.length ? await getQuotes(tickers, 150_000, true) : []).map((q) => [q.ticker, q.changePct])
  );

  return json({
    origin: "ai",
    live: marketState().open,
    benchPct: board.benchPct,
    names: items.slice(0, 5).map((i) => ({
      ticker: i.ticker ?? i.label,     // 티커가 없으면 주제 이름이 곧 그 자리다
      isTheme: !i.ticker,
      label: i.label,
      score: i.heat / 5,
      reason: i.why,
      hits: 0, earnDays: null, earnHour: "", themeFace: false,
      pct: i.ticker ? (px.get(i.ticker) ?? null) : null,
      rel: null
    }))
  });
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
