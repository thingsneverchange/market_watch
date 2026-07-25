import type { RequestHandler } from "./$types";
import { getFutures, type Timeframe } from "$lib/server/finviz";

// ============================================================
//  메인 차트용 선물 시계열
//
//  왜 자체 렌더인가 (TradingView 무료 임베드를 메인에서 뺀 이유):
//   1) 주말에 **완전히 빈 화면**이 된다. 실측으로 O∅ H∅ L∅ C∅ 를 반환하고
//      캔들이 하나도 안 그려졌다. 24시간 방송에서 화면 한가운데가 매주 이틀씩
//      검은 사각형이 된다는 뜻이다.
//   2) 무료 임베드는 애초에 NQ 같은 **선물을 못 그린다**. 정규장 QQQ 밖에 못 띄운다.
//   3) iframe 이 사라져 메모리·CPU 가 준다 (24시간 송출에서 중요).
//
//  Finviz 5분봉은 우리가 캐시로 들고 있으므로 주말·휴장에도 마지막 세션이 그대로 남는다.
//  → 화면이 비지 않는다.
// ============================================================

const TF: Record<string, Timeframe> = { m5: "m5", h1: "h1", d1: "d1" };

// 방송 화면에서 300 포인트는 과하다(선이 뭉갠다). 균등 샘플링하되 마지막 점은 보존한다.
function sample(arr: number[], n: number) {
  if (arr.length <= n) return { pts: arr, idx: arr.map((_, i) => i) };
  const step = (arr.length - 1) / (n - 1);
  const idx = Array.from({ length: n }, (_, i) => Math.round(i * step));
  return { pts: idx.map((i) => arr[i]), idx };
}

/**
 * 종가 시계열을 봉으로 묶는다.
 *
 * ※ 정직하게 밝혀둘 것: Finviz 무료 엔드포인트는 **봉별 OHLC 를 주지 않는다**.
 *   응답의 high/low 는 그날 전체의 고가·저가 하나뿐이고 시계열은 종가 배열이다.
 *   (finviz.com/api/quote.ashx 등 후보 엔드포인트 전부 404 로 확인)
 *   그래서 여기서 만드는 봉은 **5분 종가를 묶은 것**이다 —
 *   시가·종가는 정확하고, 꼬리(고가·저가)는 5분 종가 기준이라 실제보다 짧을 수 있다.
 *   화면에도 "5m closes" 라고 표기해서 진짜 틱 캔들인 척하지 않는다.
 *   진짜 틱 캔들은 정규장 TradingView 모드에서 나온다.
 */
function toCandles(closes: number[], per: number) {
  const out: { o: number; h: number; l: number; c: number }[] = [];
  for (let i = 0; i < closes.length; i += per) {
    const g = closes.slice(i, i + per);
    if (!g.length) continue;
    out.push({ o: g[0], h: Math.max(...g), l: Math.min(...g), c: g[g.length - 1] });
  }
  return out;
}

export const GET: RequestHandler = async ({ url }) => {
  const key = (url.searchParams.get("key") || "NQ").toUpperCase();
  const tf = TF[url.searchParams.get("tf") || "m5"] ?? "m5";
  const style = url.searchParams.get("style") === "candle" ? "candle" : "line";

  const map = await getFutures(tf);
  const q = map.get(key);

  if (!q || q.spark.length < 2) {
    return new Response(
      JSON.stringify({ ok: false, key, tf, reason: q ? "no series" : "unknown symbol" }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  }

  // 캔들은 60개 안팎이 방송 화면에서 가장 읽기 좋다 (220개면 몸통이 1px 이 된다)
  const PER = Math.max(1, Math.ceil(q.spark.length / 60));
  const candles = style === "candle" ? toCandles(q.spark, PER) : [];

  const { pts, idx } = sample(q.spark, 220);

  // 시간축 눈금은 원본 인덱스 기준이라 샘플링 후 위치로 옮겨야 한다.
  // (안 옮기면 "10AM" 라벨이 엉뚱한 x 좌표에 찍힌다)
  const marks: { at: number; label: string }[] = [];
  for (const [rawIdx, label] of Object.entries(q.marks)) {
    const target = Number(rawIdx);
    if (style === "candle") {
      // 캔들 모드에선 x축 단위가 봉이다
      marks.push({ at: Math.round(target / PER), label });
      continue;
    }
    let best = 0;
    for (let i = 1; i < idx.length; i++) {
      if (Math.abs(idx[i] - target) < Math.abs(idx[best] - target)) best = i;
    }
    marks.push({ at: best, label });
  }
  marks.sort((a, b) => a.at - b.at);

  return new Response(
    JSON.stringify({
      ok: true,
      key,
      tf,
      label: q.label,
      price: q.price,
      changePct: q.changePct,
      changeAbs: q.changeAbs,   // 포인트 등락 — "몇 포인트 빠졌나"가 %보다 직관적이다
      base: q.prevClose,   // 보합선 = 전일 정산가
      points: pts,
      candles,
      style,
      // 봉이 몇 분짜리인지 + 꼬리가 종가 기반이라는 사실을 화면이 표기할 수 있게 넘긴다
      candleMin: style === "candle" && tf === "m5" ? PER * 5 : null,
      marks,
      asOf: q.asOf
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
};
