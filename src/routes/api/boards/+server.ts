import type { RequestHandler } from "./$types";
import { getQuotes, INDEX_TICKERS, TAPE_TICKERS, type Quote } from "$lib/server/finnhub";
import { getCrossAssets, getIndexFutures } from "$lib/server/crossasset";
import { getFmpQuotes } from "$lib/server/fmp";
import { marketState } from "$lib/market-hours";

// ============================================================
//  헤더 스트립 + 하단 테이프
//
//  소스 우선순위 (실측 근거):
//   1) FMP — 키 기반이라 안정적이고, 무료 티어에서 **지수 원본**(^GSPC/^IXIC/^DJI)과
//      ES 선물·금·브렌트유·BTC 를 준다. ETF 프록시(SPY/QQQ/DIA)를 쓸 이유가 없어졌다.
//   2) Yahoo — FMP 무료가 막는 것(NQ/YM 선물, SOXX)만. 비공식이라 429 가 실재한다.
//   3) Finnhub — ETF/개별주 (테이프). 확장시간엔 갱신 안 됨(전일 종가).
//  어느 하나가 죽어도 나머지로 화면이 유지되고, 전부 실패하면 "—" 로 결측을 표시한다.
// ============================================================

const LABEL: Record<string, string> = {
  SPY: "S&P 500", QQQ: "NASDAQ 100", DIA: "DOW", IWM: "RUSSELL 2000"
};

// FMP 심볼 (무료 티어에서 열리는 것만)
const F_SPX = "^GSPC";   // S&P 500 지수 원본
const F_IXIC = "^IXIC";  // 나스닥 종합 — 계속 요청받던 IXIC
const F_DJI = "^DJI";    // 다우
const F_ES = "ESUSD";      // E-mini S&P 선물 (장 밖에도 거의 24시간)
const F_BTC = "BTCUSD";
const F_GOLD = "GCUSD";    // 금 선물
const F_OIL = "BZUSD";     // 브렌트유 (CLUSD=WTI 는 프리미엄)
const F_VIX = "^VIX";

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
type Slot = { k: string; v: string; pct: number };

export const GET: RequestHandler = async () => {
  const regularOpen = marketState().open;

  const fmpSyms = [F_SPX, F_IXIC, F_DJI, F_BTC, F_GOLD, F_OIL, F_VIX, ...(regularOpen ? [] : [F_ES])];
  const ALL = [...new Set([...INDEX_TICKERS, ...TAPE_TICKERS, "SOXX"])];

  const [fin, fmp, cross, futs] = await Promise.all([
    getQuotes(ALL),
    getFmpQuotes(fmpSyms),
    getCrossAssets(),                                        // Yahoo — SOXX 보강용
    regularOpen ? Promise.resolve(new Map()) : getIndexFutures() // Yahoo — NQ/YM 선물
  ]);
  const by = new Map(fin.map((q) => [q.ticker, q]));
  const slot = (k: string, price: number, pct: number): Slot => ({ k, v: fmt(price), pct });

  // ── 지수 3슬롯 ──────────────────────────────
  // 장중 → 지수 원본 / 장 밖 → 선물 (FMP 의 ES + Yahoo 의 NQ·YM, 없으면 지수로 폴백)
  const indexSlots: Slot[] = [];
  const fS = fmp.get(F_SPX), fN = fmp.get(F_IXIC), fD = fmp.get(F_DJI);
  const qSPY = by.get("SPY"), qQQQ = by.get("QQQ"), qDIA = by.get("DIA");

  if (regularOpen) {
    if (fS) indexSlots.push(slot("S&P 500", fS.price, fS.changePct));
    else if (qSPY) indexSlots.push(slot("S&P 500", qSPY.price, qSPY.changePct));
    if (fN) indexSlots.push(slot("NASDAQ", fN.price, fN.changePct));
    else if (qQQQ) indexSlots.push(slot("NASDAQ 100", qQQQ.price, qQQQ.changePct));
    if (fD) indexSlots.push(slot("DOW", fD.price, fD.changePct));
    else if (qDIA) indexSlots.push(slot("DOW", qDIA.price, qDIA.changePct));
  } else {
    const es = fmp.get(F_ES), nq = futs.get("NASDAQ FUT"), ym = futs.get("DOW FUT");
    if (es) indexSlots.push(slot("S&P FUT", es.price, es.changePct));
    else if (fS) indexSlots.push(slot("S&P 500", fS.price, fS.changePct));
    if (nq) indexSlots.push(slot("NASDAQ FUT", nq.price, nq.changePct));
    else if (fN) indexSlots.push(slot("NASDAQ", fN.price, fN.changePct));
    if (ym) indexSlots.push(slot("DOW FUT", ym.price, ym.changePct));
    else if (fD) indexSlots.push(slot("DOW", fD.price, fD.changePct));
  }

  // ── 크로스에셋 4슬롯 (SOXX·BTC·GOLD·OIL) ──────
  const crossSlots: Slot[] = [];
  const qSOXX = by.get("SOXX"), ySOXX = cross.get("SOXX");
  if (ySOXX) crossSlots.push(slot("SOXX", ySOXX.price, ySOXX.changePct));
  else if (qSOXX) crossSlots.push(slot("SOXX", qSOXX.price, qSOXX.changePct));

  const fB = fmp.get(F_BTC) ?? null, yB = cross.get("BTC");
  if (fB) crossSlots.push(slot("BTC", fB.price, fB.changePct));
  else if (yB) crossSlots.push(slot("BTC", yB.price, yB.changePct));

  const fG = fmp.get(F_GOLD) ?? null, yG = cross.get("GOLD");
  if (fG) crossSlots.push(slot("GOLD", fG.price, fG.changePct));
  else if (yG) crossSlots.push(slot("GOLD", yG.price, yG.changePct));

  const fO = fmp.get(F_OIL) ?? null, yO = cross.get("OIL");
  if (fO) crossSlots.push(slot("OIL", fO.price, fO.changePct));
  else if (yO) crossSlots.push(slot("OIL", yO.price, yO.changePct));

  const fV = fmp.get(F_VIX);
  if (fV) crossSlots.push(slot("VIX", fV.price, fV.changePct)); // 공포지수 — 감사에서 지적된 결측

  const top = [...indexSlots, ...crossSlots];

  // ── 하단 테이프 = 대형주/워치리스트 + 크로스에셋 ──
  const tape = TAPE_TICKERS.map((t) => by.get(t)).filter((q): q is Quote => !!q);
  const tapeRows = [
    ...tape.map((q) => ({ k: q.ticker, v: fmt(q.price), pct: q.changePct })),
    ...crossSlots
  ];

  // ★ 신선도 앵커 = 주가지수(FMP 우선, 없으면 Finnhub). 24시간 자산(BTC 등)은 제외한다 —
  //   섞으면 장 마감 후에도 배지가 초록으로 남아 "지수가 최신"이라 거짓말한다.
  const stamps = [fS?.asOf, fN?.asOf, fD?.asOf, ...(fS ? [] : [qSPY?.asOf, qQQQ?.asOf, qDIA?.asOf])]
    .filter((x): x is number => typeof x === "number" && x > 0);
  const dataAsOf = stamps.length ? Math.min(...stamps) : null;

  const indexLabels = indexSlots.map((x) => x.k);
  const missing = ["S&P 500", "NASDAQ", "DOW"].slice(indexSlots.length);

  return new Response(
    JSON.stringify({
      top, tape: tapeRows, dataAsOf, missing,
      indexLabels,
      crossLabels: crossSlots.map((x) => x.k),
      futures: !regularOpen && indexSlots.some((s) => s.k.endsWith("FUT"))
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
};
