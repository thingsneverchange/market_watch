import type { RequestHandler } from "./$types";
import { getMarketFocus } from "$lib/server/focus";
import { getFeed, fresh } from "$lib/server/marketfeed";
import { getQuotes, getCompanyNames } from "$lib/server/finnhub";
import { companyMatches } from "$lib/server/companyname";
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

  // ── 티커 대조 ──────────────────────────────────────
  // 티커가 붙은 항목에만 시세를 얹는다. 없으면 안 얹는다 — 엉뚱한 종목에 붙이면 오보다.
  //
  // ★ LLM 이 준 티커를 그대로 믿지 않는다. 실제로 "SPACEX SHARE UNLOCK"(비상장!) 에
  //   SPCX 라는 남의 종목이 붙어 −1.85% 가 방송됐다. 철자만 그럴듯하면 형식 검사는 통과한다.
  //   그래서 거래소 등록 상호를 받아 LLM 이 주장한 상호(co)와 대조하고,
  //   **다르거나 확인이 안 되면 티커를 버린다**. 그 항목은 시세 없는 주제 행으로 나간다.
  //   (항목 자체를 떨어뜨리지는 않는다 — 주제는 멀쩡한데 대표주만 틀린 경우가 많다)
  const claimed = items.filter((i) => i.ticker && i.co) as { ticker: string; co: string }[];
  const regNames = claimed.length
    ? await getCompanyNames([...new Set(claimed.map((i) => i.ticker))])
    : new Map<string, string | null>();

  const okTicker = new Map<string, string>(); // label 기준으로 "이 티커는 써도 된다"
  for (const i of items) {
    if (!i.ticker || !i.co) continue;
    if (companyMatches(i.co, regNames.get(i.ticker) ?? null)) okTicker.set(i.label, i.ticker);
    else console.warn(`[impact] 티커 폐기: ${i.label} — ${i.ticker} 는 "${regNames.get(i.ticker) ?? "확인 불가"}", LLM 주장은 "${i.co}"`);
  }

  const tickers = [...new Set(okTicker.values())];
  const px = new Map(
    (tickers.length ? await getQuotes(tickers, 150_000, true) : []).map((q) => [q.ticker, q.changePct])
  );

  return json({
    origin: "ai",
    live: marketState().open,
    benchPct: board.benchPct,
    names: items.slice(0, 5).map((i) => {
      const t = okTicker.get(i.label) ?? null;
      return {
        ticker: t ?? i.label,        // 티커가 없으면 주제 이름이 곧 그 자리다
        isTheme: !t,
        label: i.label,
        score: i.heat / 5,
        reason: i.why,
        hits: 0, earnDays: null, earnHour: "", themeFace: false,
        pct: t ? (px.get(t) ?? null) : null,
        rel: null
      };
    })
  });
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
