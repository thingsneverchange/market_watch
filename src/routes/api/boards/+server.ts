import type { RequestHandler } from "./$types";
import { getQuotes, INDEX_TICKERS, TAPE_TICKERS, type Quote } from "$lib/server/finnhub";

// ※ 라벨을 정직하게: QQQ 는 나스닥 종합지수(IXIC)가 아니라 나스닥100(NDX) 추종 ETF다.
//   예전에는 "NASDAQ" 이라 부르면서 옆 차트에는 IXIC 를 띄웠다 (같은 화면 안 서로 다른 지수).
const LABEL: Record<string, string> = {
  SPY: "S&P 500", QQQ: "NASDAQ 100", DIA: "DOW",
  NVDA: "NVDA", AAPL: "AAPL", MSFT: "MSFT"
};

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const GET: RequestHandler = async () => {
  // 유일 심볼만 1회 조회 후 분배.
  // 예전에는 INDEX / TAPE / WATCHLIST 를 따로 불러 NVDA·AAPL·MSFT 를 같은 tick 에 2~3번 발사했고,
  // movers(화면에 한 픽셀도 렌더되지 않는 죽은 패널)가 candle 6 + metric 6 을 추가로 태웠다.
  const ALL = [...new Set([...INDEX_TICKERS, ...TAPE_TICKERS])];
  const all = await getQuotes(ALL);
  const by = new Map(all.map((q) => [q.ticker, q]));

  const pick = (list: string[]) => list.map((t) => by.get(t)).filter((q): q is Quote => !!q);
  const idx = pick(INDEX_TICKERS);
  const tape = pick(TAPE_TICKERS);

  const top = idx.map((q) => ({
    k: LABEL[q.ticker] ?? q.ticker,
    v: fmt(q.price),
    pct: q.changePct
  }));

  const tapeRows = tape.map((q) => ({
    k: q.ticker,
    v: fmt(q.price),
    pct: q.changePct
  }));

  // 진짜 신선도 = 소스가 준 마지막 체결 시각의 최솟값.
  // 예전 화면은 "내가 fetch 한 시각"을 신선도라고 표시해서 어제 종가를 방금 갱신된 값으로 위장했다.
  const stamps = idx.map((q) => q.asOf).filter((x) => x > 0);
  const dataAsOf = stamps.length ? Math.min(...stamps) : null;

  // 응답에서 사라진 티커를 명시한다. 예전에는 조용히 배열에서 빠져 자리째 없어지고
  // 나머지가 왼쪽으로 밀렸다 (아무도 결측을 알 수 없었다).
  const missing = INDEX_TICKERS.filter((t) => !by.has(t)).map((t) => LABEL[t] ?? t);

  return new Response(JSON.stringify({ top, tape: tapeRows, dataAsOf, missing }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
