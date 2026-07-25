import type { RequestHandler } from "./$types";
import { getQuotes, INDEX_TICKERS, TAPE_TICKERS, type Quote } from "$lib/server/finnhub";
import { getFutures } from "$lib/server/finviz";
import { getBtc } from "$lib/server/coingecko";
import { marketState } from "$lib/market-hours";

// ============================================================
//  헤더 스트립 + 하단 테이프
//
//  소스 배치 (전부 실측으로 정해졌다):
//   1) Finviz  — **한 번의 요청으로 49개 선물/원자재** + 각 300포인트 스파크라인.
//      NQ(나스닥 선물)를 24시간 주는 **유일한 무료 경로**이고 서버 IP 에서도 200 이 온다.
//      → 선물·원자재·VIX·BTC 는 전부 여기서. 24시간 스트림의 핵심.
//   2) Finnhub — 60 req/min. US 주식/ETF 는 여기가 정확하고 빠르다(정규장 지수·테이프·SOXX).
//   3) CoinGecko — BTC 폴백 (키 불필요)
//
//  쓰지 않는 것:
//   · Yahoo — 데이터센터 IP 영구 차단 (맥·서버 모두 429). 배포본에선 불가
//   · FMP   — 무료 하루 250회. 폴링에 못 버티고 NQ/YM 은 프리미엄
// ============================================================

const LABEL: Record<string, string> = {
  SPY: "S&P 500", QQQ: "NASDAQ 100", DIA: "DOW", IWM: "RUSSELL 2000"
};

function fmt(n: number) {
  // 선물은 소수 둘째 자리까지가 과하다(28,306.5). 값 크기에 따라 자릿수를 맞춘다.
  const d = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 10 ? 2 : 4;
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
}
type Slot = { k: string; v: string; pct: number };

export const GET: RequestHandler = async () => {
  const regularOpen = marketState().open;

  const ALL = [...new Set([...INDEX_TICKERS, ...TAPE_TICKERS, "SOXX"])];
  const [fin, fut, btcFallback] = await Promise.all([
    getQuotes(ALL),
    getFutures(),
    getBtc()
  ]);
  const by = new Map(fin.map((q) => [q.ticker, q]));
  const slot = (k: string, price: number, pct: number): Slot => ({ k, v: fmt(price), pct });
  const F = (k: string) => fut.get(k);

  // ── 지수 3슬롯 ──────────────────────────────
  //  정규장 → 현물 지수(Finnhub, 실시간)
  //  장 밖  → **선물**(Finviz, 24시간). 현물은 전일 종가로 얼어 있어 아무 정보가 없다.
  const indexSlots: Slot[] = [];
  if (regularOpen) {
    for (const t of ["SPY", "QQQ", "DIA"]) {
      const q = by.get(t);
      if (q) indexSlots.push(slot(LABEL[t] ?? t, q.price, q.changePct));
    }
  } else {
    // 나스닥을 맨 앞에 — 이 방송이 가장 주시하는 지수다
    const pairs: [string, string, string][] = [
      ["NQ", "NASDAQ FUT", "QQQ"],
      ["ES", "S&P FUT", "SPY"],
      ["YM", "DOW FUT", "DIA"]
    ];
    for (const [fk, label, fallbackTicker] of pairs) {
      const f = F(fk);
      if (f) { indexSlots.push(slot(label, f.price, f.changePct)); continue; }
      const q = by.get(fallbackTicker); // 선물이 안 오면 현물(전일 종가)로라도
      if (q) indexSlots.push(slot(LABEL[fallbackTicker] ?? fallbackTicker, q.price, q.changePct));
    }
  }

  // ── 크로스에셋 ──────────────────────────────
  //  금·원유는 이제 **진짜 선물 가격**이다 (ETF 프록시 GLD/USO 가 아니라).
  const crossSlots: Slot[] = [];
  const qSOXX = by.get("SOXX");
  if (qSOXX) crossSlots.push(slot("SOXX", qSOXX.price, qSOXX.changePct));

  const gc = F("GC"); if (gc) crossSlots.push(slot("GOLD", gc.price, gc.changePct));
  const cl = F("CL"); if (cl) crossSlots.push(slot("OIL", cl.price, cl.changePct));

  const fb = F("BTC");
  if (fb) crossSlots.push(slot("BTC", fb.price, fb.changePct));
  else if (btcFallback) crossSlots.push(slot("BTC", btcFallback.price, btcFallback.changePct));

  const vx = F("VX"); if (vx) crossSlots.push(slot("VIX", vx.price, vx.changePct));

  const top = [...indexSlots, ...crossSlots];

  // ── 하단 테이프 = 대형주/워치리스트 + 크로스에셋 ──
  const tape = TAPE_TICKERS.map((t) => by.get(t)).filter((q): q is Quote => !!q);
  const tapeRows = [
    ...tape.map((q) => ({ k: q.ticker, v: fmt(q.price), pct: q.changePct })),
    ...crossSlots
  ];

  // ★ 신선도 앵커 = 주가지수(Finnhub)의 마지막 체결 시각.
  //   24시간 자산(선물·BTC)을 섞으면 장 마감 후에도 배지가 초록으로 남아
  //   "지수 데이터가 최신"이라 거짓말한다 → 앵커에서 제외한다.
  const stamps = ["SPY", "QQQ", "DIA"]
    .map((t) => by.get(t)?.asOf)
    .filter((x): x is number => typeof x === "number" && x > 0);
  const dataAsOf = stamps.length ? Math.min(...stamps) : null;

  const missing = ["SPY", "QQQ", "DIA"].filter((t) => !by.has(t)).map((t) => LABEL[t] ?? t);

  // ── 미니차트용 추이 ──────────────────────────
  //  TradingView 무료 임베드는 선물을 못 그린다 → Finviz 의 300포인트로 자체 렌더한다.
  //  포인트가 많으면 전송량만 늘고 화면에선 구분이 안 되므로 균등 샘플링으로 줄인다.
  const sample = (arr: number[], n = 80) => {
    if (arr.length <= n) return arr;
    const step = (arr.length - 1) / (n - 1);
    return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
  };
  const minis = [
    { key: "NQ", label: "NASDAQ FUT" },
    { key: "ES", label: "S&P FUT" },
    { key: "YM", label: "DOW FUT" }
  ].map(({ key, label }) => {
    const f = F(key);
    return f
      ? { key, label, pct: f.changePct, price: fmt(f.price), spark: sample(f.spark) }
      : { key, label, pct: 0, price: "—", spark: [] as number[] };
  });

  return new Response(
    JSON.stringify({
      top, tape: tapeRows, dataAsOf, missing,
      minis,
      indexLabels: indexSlots.map((x) => x.k),
      crossLabels: crossSlots.map((x) => x.k),
      futures: !regularOpen && indexSlots.some((s) => s.k.endsWith("FUT"))
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
};
