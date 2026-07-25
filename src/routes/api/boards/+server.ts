import type { RequestHandler } from "./$types";
import { getQuotes, INDEX_TICKERS, TAPE_TICKERS, CROSS_ETFS, type Quote } from "$lib/server/finnhub";
import { getFmpQuotes } from "$lib/server/fmp";
import { getBtc } from "$lib/server/coingecko";
import { marketState } from "$lib/market-hours";

// ============================================================
//  헤더 스트립 + 하단 테이프
//
//  소스 배치는 **각 API 의 실제 무료 한도**에 맞춘 것이다 (실측 기준):
//   1) Finnhub — 60 req/min(≈8.6만/일). 넉넉하므로 **주 소스**.
//      US 주식/ETF 만 되고 확장시간엔 갱신 안 됨(전일 종가) → 그래서 원자재도 ETF 프록시(GLD/USO)로 받는다.
//   2) CoinGecko — 키 불필요, BTC 24시간. 주말·야간에 유일하게 살아 움직이는 슬롯.
//   3) FMP — **하루 250회뿐**. 45초 폴링엔 61배 초과해 쿼터가 즉시 말랐다(실측 "Limit Reach").
//      → 이제 "장 밖 보조"로만: ES 선물 + VIX, TTL 10분 + 일일 예산 하드캡.
//   Yahoo 는 데이터센터 IP 를 영구 차단해(맥·서버 모두 429) 서버 배포본에선 아예 못 쓴다 → 제거.
//
//  어느 소스가 죽어도 나머지로 화면이 유지되고, 전부 실패하면 "—" 로 결측을 정직하게 표시한다.
// ============================================================

const LABEL: Record<string, string> = {
  SPY: "S&P 500", QQQ: "NASDAQ 100", DIA: "DOW", IWM: "RUSSELL 2000"
};

// FMP 심볼 — 장 밖에만, 최소한으로 (일일 250회 한도)
const F_ES = "ESUSD";   // E-mini S&P 선물: 장 밖에도 거의 24시간 → "시장이 어디로 향하나"
const F_VIX = "^VIX";   // 공포지수

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
type Slot = { k: string; v: string; pct: number };

export const GET: RequestHandler = async () => {
  const regularOpen = marketState().open;

  const crossTickers = CROSS_ETFS.map((c) => c.ticker);
  const ALL = [...new Set([...INDEX_TICKERS, ...TAPE_TICKERS, ...crossTickers])];

  const [fin, btc, fmp] = await Promise.all([
    getQuotes(ALL),
    getBtc(),
    // 장 밖에만 FMP 를 쓴다. 장중엔 Finnhub 가 실시간이라 부를 이유가 없다(쿼터 절약).
    regularOpen ? Promise.resolve(new Map()) : getFmpQuotes([F_ES, F_VIX])
  ]);
  const by = new Map(fin.map((q) => [q.ticker, q]));
  const slot = (k: string, price: number, pct: number): Slot => ({ k, v: fmt(price), pct });

  // ── 지수 3슬롯 ──────────────────────────────
  const indexSlots: Slot[] = [];
  const es = fmp.get(F_ES);
  // 장 밖이고 ES 선물을 받았으면 첫 슬롯을 선물로 (현물은 전일 종가로 얼어 있다)
  if (!regularOpen && es) indexSlots.push(slot("S&P FUT", es.price, es.changePct));
  for (const t of ["SPY", "QQQ", "DIA"]) {
    if (!regularOpen && es && t === "SPY") continue; // 선물로 대체된 자리
    const q = by.get(t);
    if (q) indexSlots.push(slot(LABEL[t] ?? t, q.price, q.changePct));
  }

  // ── 크로스에셋 (SOXX·GOLD·OIL ETF + BTC + VIX) ──
  const crossSlots: Slot[] = [];
  for (const c of CROSS_ETFS) {
    const q = by.get(c.ticker);
    if (q) crossSlots.push(slot(c.key, q.price, q.changePct));
  }
  if (btc) crossSlots.push(slot("BTC", btc.price, btc.changePct));
  const vix = fmp.get(F_VIX);
  if (vix) crossSlots.push(slot("VIX", vix.price, vix.changePct));

  const top = [...indexSlots, ...crossSlots];

  // ── 하단 테이프 = 대형주/워치리스트 + 크로스에셋 ──
  const tape = TAPE_TICKERS.map((t) => by.get(t)).filter((q): q is Quote => !!q);
  const tapeRows = [
    ...tape.map((q) => ({ k: q.ticker, v: fmt(q.price), pct: q.changePct })),
    ...crossSlots
  ];

  // ★ 신선도 앵커 = 주가지수(Finnhub)가 준 마지막 체결 시각.
  //   BTC 처럼 24시간 갱신되는 자산을 섞으면 장 마감 후에도 배지가 초록으로 남아
  //   "지수 데이터가 최신"이라고 거짓말한다 → 앵커에서 제외한다.
  const stamps = ["SPY", "QQQ", "DIA"]
    .map((t) => by.get(t)?.asOf)
    .filter((x): x is number => typeof x === "number" && x > 0);
  const dataAsOf = stamps.length ? Math.min(...stamps) : null;

  const missing = ["SPY", "QQQ", "DIA"].filter((t) => !by.has(t)).map((t) => LABEL[t] ?? t);

  return new Response(
    JSON.stringify({
      top, tape: tapeRows, dataAsOf, missing,
      indexLabels: indexSlots.map((x) => x.k),
      crossLabels: crossSlots.map((x) => x.k),
      futures: !regularOpen && !!es
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
};
