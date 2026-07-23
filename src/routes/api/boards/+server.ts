import type { RequestHandler } from "./$types";
import { getQuotes, INDEX_TICKERS, TAPE_TICKERS, type Quote } from "$lib/server/finnhub";
import { getCrossAssets, CROSS_ASSETS } from "$lib/server/crossasset";

// ※ 라벨을 정직하게: QQQ 는 나스닥 종합지수(IXIC)가 아니라 나스닥100(NDX) 추종 ETF다.
//   예전에는 "NASDAQ" 이라 부르면서 옆 차트에는 IXIC 를 띄웠다 (같은 화면 안 서로 다른 지수).
const LABEL: Record<string, string> = {
  SPY: "S&P 500", QQQ: "NASDAQ 100", DIA: "DOW", IWM: "RUSSELL 2000"
};

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const GET: RequestHandler = async () => {
  // 지수(Finnhub) 와 크로스에셋(Yahoo) 을 병렬로. 둘은 서로 다른 소스라 실패도 독립적이다.
  //  · 지수 3종 = 신선도 앵커 (장 마감 후엔 전일 종가로 정직하게 '고정')
  //  · 크로스에셋 4종 = SOXX/BTC/GOLD/OIL (밤·주말에도 살아 움직인다)
  const ALL = [...new Set([...INDEX_TICKERS, ...TAPE_TICKERS])];
  const [all, cross] = await Promise.all([getQuotes(ALL), getCrossAssets()]);
  const by = new Map(all.map((q) => [q.ticker, q]));

  const pick = (list: string[]) => list.map((t) => by.get(t)).filter((q): q is Quote => !!q);
  const idx = pick(INDEX_TICKERS);
  const tape = pick(TAPE_TICKERS);

  // ── 헤더 상단 스트립 = 지수 3종 + 크로스에셋 4종 ──
  const top = [
    ...idx.map((q) => ({ k: LABEL[q.ticker] ?? q.ticker, v: fmt(q.price), pct: q.changePct })),
    ...CROSS_ASSETS.map((a) => {
      const c = cross.get(a.key);
      return c ? { k: a.key, v: fmt(c.price), pct: c.changePct } : null;
    }).filter((x): x is { k: string; v: string; pct: number } => !!x)
  ];

  // ── 하단 테이프 = 대형주/워치리스트 + 크로스에셋 (다양성) ──
  const tapeRows = [
    ...tape.map((q) => ({ k: q.ticker, v: fmt(q.price), pct: q.changePct })),
    ...CROSS_ASSETS.map((a) => {
      const c = cross.get(a.key);
      return c ? { k: a.key, v: fmt(c.price), pct: c.changePct } : null;
    }).filter((x): x is { k: string; v: string; pct: number } => !!x)
  ];

  // ★ 진짜 신선도 = 주가지수(SPY/QQQ/DIA)가 준 마지막 체결 시각의 최솟값.
  //   크로스에셋(BTC 등)은 24시간 갱신되므로 여기 섞으면 장 마감 후에도 신선도 배지가
  //   영영 초록으로 남아 "지수 데이터가 최신"이라 거짓말한다 → 앵커에서 제외한다.
  const stamps = idx.map((q) => q.asOf).filter((x) => x > 0);
  const dataAsOf = stamps.length ? Math.min(...stamps) : null;

  // 응답에서 사라진 지수 슬롯을 명시한다 (자리째 사라져 나머지가 밀리던 문제 방지).
  const missing = INDEX_TICKERS.filter((t) => !by.has(t)).map((t) => LABEL[t] ?? t);

  return new Response(JSON.stringify({ top, tape: tapeRows, dataAsOf, missing }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
